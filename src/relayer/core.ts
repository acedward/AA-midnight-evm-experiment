// PLAN-05 §2 — the relayer core, ported from evm-relayer @ 3703317
// (relayer/server.ts `RelayerCore`, PART-E, live) onto the account-abstraction
// call tree (token root `accountTransfer` → `Account.validate`).
//
// What carries over from PART-E: accept `(payload, 65-byte signature)`, recover
// + sanity-bind OFF-chain so garbage fails here instead of burning a proof,
// return the EIP-191 digest as the eth-style tx hash IMMEDIATELY, prove+submit
// on an async queue serialized over the single fee wallet, idempotent per
// digest. What changes for AA:
//
//   - multi-contract REGISTRY: the payload's `token` field (bytes 33..65)
//     routes to a registered contract + circuit — one relayer serves N tokens
//     against the same account space (infra/DEPLOYMENTS.json is the routing
//     source of truth, PLAN-00 §9.2);
//   - the account is NOT registered: `accountTransfer` takes the account as a
//     contract-ref argument built from the SIGNED payload's account field, and
//     the circuit's expectedVk pins the build (PLAN-00 §4 rule 4);
//   - nonce ORDERING lives here (rejection case R7, moved from PLAN-03): the
//     ledger is digest-set-only by frozen decision, so the relayer refuses
//     stale nonces per (account, from) — see `noncePolicy` below;
//   - no postgres tx_index: that was Part B's evm-rpc bridge; here /status
//     serves the digest → midnight-tx mapping directly;
//   - fees: the relayer wallet (bob, genesis-funded, DUST-registered) IS the
//     paymaster — `waitForDustFeeBudget` runs inside providers.balanceTx.
//
// Trust model (PLAN-05 §Security): this relayer can reorder, delay, drop, or
// grief-burn a digest it has seen. It can NOT forge operations, redirect funds,
// or alter amounts — every effect is bound by the user's signature and verified
// in-circuit. Rate limiting per source address contains submission spam.

import {
  DOMAIN_TAG_HEX,
  OP_TRANSFER,
  PAYLOAD_LENGTH,
  eip191Digest,
} from "../account-payload.ts";
import { bindCompiledContract, loadCompiledModule } from "../compiled.ts";
import { compileContract } from "../compile.ts";
import { contractByName } from "../contracts.ts";
import {
  callCircuit,
  findDeployed,
  type CallResult,
  type DeployedContractLike,
  type WitnessImpls,
} from "../contract-ops.ts";
import { latestDeployment } from "../deployments.ts";
import { ROLE_SEEDS } from "../genesis-seeds.ts";
import { bytesToHex, hexToBytes } from "../hex.ts";
import { createProviders, type Providers } from "../providers.ts";
import {
  parseAccountPayload,
  tupleFromEthSignature,
  type ParsedAccountPayload,
} from "../signer.ts";
import { createWallet, syncWallet, type WalletCtx } from "../wallet.ts";

export function jsonLog(module: string, event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), module, event, ...data }));
}

/** A refusal with an HTTP status — thrown by validation, before any proving. */
export class RelayError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

// ── Submission bookkeeping (PART-E shape, verbatim) ─────────────────────────

export type SubmissionState =
  | { phase: "queued" }
  | { phase: "submitting" }
  | {
      phase: "confirmed";
      midnightTxHash: string;
      midnightTxId: string;
      blockHeight: number;
      blockHash: string;
    }
  | { phase: "failed"; error: string };

interface Submission {
  ethTxHash: string; // 0x + digest hex
  token: string; // registered token address the payload routed to
  state: SubmissionState;
  done: Promise<void>;
}

// ── Token registry ───────────────────────────────────────────────────────────

export interface RegisteredToken {
  /** Managed-dir / logical name, e.g. "MiniTokenAA", "TokenAA". */
  name: string;
  /** 32-byte contract address, lowercase hex, no 0x. */
  contractAddress: string;
  /** The AA adapter circuit this token exposes. */
  circuit: string;
  deployed: DeployedContractLike;
  providers: Providers;
}

export interface AttachTokenOptions {
  /** Defaults to the latest DEPLOYMENTS.json row for `name` on this stack. */
  contractAddress?: string;
  circuit?: string;
  /** For tokens whose bindings declare witnesses (e.g. TokenAA's wit_OwnableSK). */
  witnesses?: WitnessImpls;
}

export interface RelayerCoreOptions {
  /** Fee-wallet role; bob is the PLAN-00 §3.5 relayer convention. */
  role?: "alice" | "bob" | "carol" | "dave";
  /** Non-duplicate relay attempts allowed per `from` address per minute. */
  rateLimitPerMinute?: number;
}

const RATE_WINDOW_MS = 60_000;

export class RelayerCore {
  private wallet?: WalletCtx;
  private registry = new Map<string, RegisteredToken>();
  private submissions = new Map<string, Submission>();
  private queue: Promise<void> = Promise.resolve();
  /** R7 state: (accountHex:fromHex) → highest nonce ACCEPTED for relay. */
  private acceptedNonces = new Map<string, bigint>();
  private rateWindow = new Map<string, number[]>();

  readonly role: NonNullable<RelayerCoreOptions["role"]>;
  readonly rateLimitPerMinute: number;

  constructor(opts: RelayerCoreOptions = {}) {
    this.role = opts.role ?? "bob";
    this.rateLimitPerMinute =
      opts.rateLimitPerMinute ?? Number(process.env.AA_RELAY_RATE_LIMIT ?? "30");
  }

  /** Start the fee wallet (genesis seed for `role`) and sync it. */
  async start(): Promise<void> {
    jsonLog("relayer", "starting", { role: this.role });
    this.wallet = await createWallet(this.role, ROLE_SEEDS[this.role]);
    await syncWallet(this.wallet);
    jsonLog("relayer", "started", { role: this.role });
  }

  async stop(): Promise<void> {
    await this.queue.catch(() => {});
    await this.wallet?.wallet.stop().catch(() => {});
  }

  /**
   * Register a token: compile its bundle, attach to the DEPLOYED instance as a
   * non-deployer via findDeployed (usdcx-proven: a third party can drive
   * witness-bearing circuits it didn't deploy when the args carry no secrets).
   */
  async attachToken(name: string, opts: AttachTokenOptions = {}): Promise<RegisteredToken> {
    if (!this.wallet) throw new Error("RelayerCore.start() must run before attachToken()");
    const contractAddress =
      opts.contractAddress ?? latestDeployment(name)?.contractAddress;
    if (!contractAddress) {
      throw new Error(`attachToken(${name}): no address given and none in DEPLOYMENTS.json`);
    }
    // The Account callee's bundle must exist next to the token's: the proof
    // provider resolves the WHOLE call tree by verifier-key hash from the
    // artifact root (the two-provider split, PLAN-02 Q1).
    compileContract(contractByName("Account"));
    const { managedDir } = compileContract(contractByName(name));
    const providers = await createProviders(this.wallet, managedDir, `relayer-${name}`);
    const loaded = await loadCompiledModule(managedDir);

    // Witness-bearing tokens (TokenAA declares wit_OwnableSK etc.): the
    // generated Contract constructor demands a function for EVERY declared
    // witness, and compact-js's vacant binding provides none. The relayer
    // holds no witness secrets by design — every relayed circuit carries its
    // authority in its arguments (usdcx precedent) — so any witness the
    // constructor names and the caller did not supply is stubbed with a
    // DENIER that throws if a circuit ever invokes it. Names are discovered
    // by retrying on the constructor's own error.
    const witnesses: WitnessImpls = { ...opts.witnesses };
    let deployed: DeployedContractLike;
    for (let attempt = 0; ; attempt++) {
      const handle = bindCompiledContract(
        name,
        loaded,
        Object.keys(witnesses).length > 0 ? { witnesses } : { vacantWitnesses: true },
      );
      try {
        deployed = await findDeployed(providers, handle, contractAddress, `relayer-${name}`);
        break;
      } catch (e) {
        const missing = /function-valued field named (\w+)/.exec(
          e instanceof Error ? e.message : String(e),
        )?.[1];
        if (!missing || witnesses[missing] || attempt >= 16) throw e;
        witnesses[missing] = () => {
          throw new Error(
            `relayer: witness ${missing} is not available — relayed circuits carry their authority in their arguments`,
          );
        };
      }
    }
    const registered: RegisteredToken = {
      name,
      contractAddress: contractAddress.toLowerCase().replace(/^0x/, ""),
      circuit: opts.circuit ?? "accountTransfer",
      deployed,
      providers,
    };
    this.registry.set(registered.contractAddress, registered);
    jsonLog("relayer", "token-registered", {
      name,
      contractAddress: registered.contractAddress,
      circuit: registered.circuit,
    });
    return registered;
  }

  tokens(): Array<Pick<RegisteredToken, "name" | "contractAddress" | "circuit">> {
    return [...this.registry.values()].map(({ name, contractAddress, circuit }) => ({
      name,
      contractAddress,
      circuit,
    }));
  }

  status(ethTxHash: string): SubmissionState | undefined {
    return this.submissions.get(ethTxHash.toLowerCase())?.state;
  }

  /** Wait until a submission reaches a terminal state (tests / drains). */
  async waitFor(ethTxHash: string): Promise<SubmissionState> {
    const sub = this.submissions.get(ethTxHash.toLowerCase());
    if (!sub) throw new Error(`unknown submission ${ethTxHash}`);
    await sub.done;
    return sub.state;
  }

  /**
   * POST /relay — the trustless personal_sign path. Validates everything that
   * can fail WITHOUT a proof, then returns the digest as the eth-style tx hash
   * and proves+submits async. Repeat submission of a digest (including its
   * flipped-s twin — same digest by construction) returns the prior result.
   */
  relay(payloadHex: string, signatureHex: string): { ethTxHash: string } {
    const payload = parseHex("payload", payloadHex);
    if (payload.length !== PAYLOAD_LENGTH) {
      throw new RelayError(400, "bad-payload", `payload must be ${PAYLOAD_LENGTH} bytes`);
    }
    const signature = parseHex("signature", signatureHex);
    if (signature.length !== 65) {
      throw new RelayError(400, "bad-signature", "signature must be 65 bytes (r||s||v)");
    }

    const fields = parseAccountPayload(payload);
    const ethTxHash = `0x${bytesToHex(eip191Digest(payload))}`;

    // Idempotence FIRST: a repeat (or the malleable twin) costs nothing and
    // never counts against the sender's rate budget.
    const existing = this.submissions.get(ethTxHash);
    if (existing) return { ethTxHash: existing.ethTxHash };

    this.checkRateLimit(bytesToHex(fields.from));
    this.checkStructure(fields);
    const token = this.registry.get(bytesToHex(fields.token));
    if (!token) {
      throw new RelayError(
        404,
        "unknown-token",
        `no registered contract at token address ${bytesToHex(fields.token)}`,
      );
    }

    // Recover + bind before accepting: a signature that cannot pass the
    // circuit's own from-bind is refused here, off-chain (PART-E discipline).
    const tuple = tupleFromEthSignature(payload, signature);
    if (bytesToHex(tuple.signer) !== bytesToHex(fields.from)) {
      throw new RelayError(
        400,
        "from-mismatch",
        "signature does not recover to payload.from",
      );
    }

    this.checkNonceOrder(fields);

    const submission: Submission = {
      ethTxHash,
      token: token.contractAddress,
      state: { phase: "queued" },
      done: Promise.resolve(),
    };
    this.submissions.set(ethTxHash, submission);

    // Serialize on the single fee wallet (concurrent dust spends from one
    // wallet are rejected by the node — PLAN-01 test discipline).
    submission.done = this.queue = this.queue
      .catch(() => {})
      .then(async () => {
        submission.state = { phase: "submitting" };
        jsonLog("relayer", "submitting", { ethTxHash, token: token.name });
        try {
          const res: CallResult = await callCircuit(token.deployed, token.circuit, [
            { bytes: fields.account },
            payload,
            tuple.sig,
            tuple.pk,
          ]);
          submission.state = {
            phase: "confirmed",
            midnightTxHash: res.txHash,
            midnightTxId: res.txId,
            blockHeight: res.blockHeight,
            blockHash: res.blockHash,
          };
          jsonLog("relayer", "confirmed", {
            ethTxHash,
            midnightTxHash: res.txHash,
            blockHeight: res.blockHeight,
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          submission.state = { phase: "failed", error: message };
          jsonLog("relayer", "failed", { ethTxHash, error: message });
        }
      });

    return { ethTxHash };
  }

  // ── Validation stages ──────────────────────────────────────────────────────

  /** Per-source sliding window; every NON-duplicate attempt counts. */
  private checkRateLimit(fromHex: string): void {
    const now = Date.now();
    const seen = (this.rateWindow.get(fromHex) ?? []).filter(
      (t) => now - t < RATE_WINDOW_MS,
    );
    if (seen.length >= this.rateLimitPerMinute) {
      this.rateWindow.set(fromHex, seen);
      throw new RelayError(
        429,
        "rate-limited",
        `more than ${this.rateLimitPerMinute} relay attempts from 0x${fromHex} in ${RATE_WINDOW_MS / 1000}s`,
      );
    }
    seen.push(now);
    this.rateWindow.set(fromHex, seen);
  }

  /** The cheap structural half of the circuit's own check chain. */
  private checkStructure(fields: ParsedAccountPayload): void {
    if (!fields.reserved.every((b) => b === 0)) {
      throw new RelayError(400, "bad-reserved", "reserved bytes 173..176 must be zero");
    }
    if (bytesToHex(fields.domainTag) !== DOMAIN_TAG_HEX) {
      throw new RelayError(400, "bad-domain-tag", "payload is not MIDNIGHT_ACCOUNT_V1/2400");
    }
    if (fields.op !== OP_TRANSFER) {
      throw new RelayError(400, "bad-op", `unsupported op 0x${fields.op.toString(16)} (V1 relays TRANSFER only)`);
    }
  }

  /**
   * R7 — relayer-side nonce ordering (the half PLAN-03 moved here). The ledger
   * replay authority is the digest set; the payload nonce orders intents.
   * Policy: per (account, from), a relay is accepted only with a nonce
   * STRICTLY ABOVE the highest nonce already accepted — accepted-at-intake, so
   * an intent that later fails on-chain still consumed its slot and the client
   * re-signs with a fresh nonce (the same recovery path as a griefed digest).
   */
  private checkNonceOrder(fields: ParsedAccountPayload): void {
    const key = `${bytesToHex(fields.account)}:${bytesToHex(fields.from)}`;
    const last = this.acceptedNonces.get(key);
    if (last !== undefined && fields.nonce <= last) {
      throw new RelayError(
        409,
        "stale-nonce",
        `nonce ${fields.nonce} is not above the last accepted nonce ${last} for this (account, from)`,
      );
    }
    this.acceptedNonces.set(key, fields.nonce);
  }
}

function parseHex(name: string, value: string): Uint8Array {
  const clean = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new RelayError(400, `bad-${name}`, `${name} must be even-length hex`);
  }
  return hexToBytes(clean);
}
