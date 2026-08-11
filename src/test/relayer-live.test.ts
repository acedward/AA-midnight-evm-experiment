// PLAN-05 gate G5.3 — the live loop on the persistent Part-0 stack
// (midnight-aa-36080), driven the way MetaMask would drive it: over HTTP.
//
//   deploy (alice) → mint → personal_sign (owner key, wire form) →
//   POST /relay → eth-style tx hash back IMMEDIATELY → async prove+submit →
//   /status flips to confirmed → balance moved, digest consumed.
//
// Roles are the PLAN-00 §3.5 split, for real: alice DEPLOYS the contracts and
// funds the account; the relayer runs on BOB's fee wallet and attaches to
// contracts it did NOT deploy (findDeployed — the non-deployer property this
// gate also proves). The owner "wallet" is the demo key; G5.4 swaps in a real
// MetaMask signature.
//
// Also live here:
//   - idempotence: a repeat POST /relay AND the flipped-s twin return the
//     prior result — no second proof, no second move (R6/R2 at the relayer);
//   - R7: an out-of-order nonce is refused with 409 stale-nonce, BEFORE any
//     proving (the relayer-side ordering PLAN-03 moved here);
//   - routing: a payload for an unregistered token is refused with 404.
//
// The Transfer-event leg (PLAN-05 Q4 retarget): MiniTokenAA emits no events,
// so the final block registers PLAN-04's product TokenAA as a SECOND token on
// the same relayer — one registry, two tokens, one account digest space — and
// reads the OZ spend+receive events back through the indexer.

import * as http from "node:http";

import {
  CompactTypeBytes,
  CompactTypeVector,
  persistentHash,
} from "@midnight-ntwrk/compact-runtime";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  OP_TRANSFER,
  buildPayload,
  ethAddressOfPriv,
  padEthAddress,
} from "../account-payload.ts";
import { bindCompiledContract, loadCompiledModule } from "../compiled.ts";
import { compileContract } from "../compile.ts";
import { contractByName } from "../contracts.ts";
import {
  callCircuit,
  contractAddressBytes,
  deployFresh,
  readLedger,
  type DeployResult,
} from "../contract-ops.ts";
import { recordDeployment } from "../deployments.ts";
import { queryContractEvents, rawContainsBytes, sameContractAddress } from "../events.ts";
import { ROLE_SEEDS } from "../genesis-seeds.ts";
import { bytesToHex, hexToBytes } from "../hex.ts";
import { createProviders, type Providers } from "../providers.ts";
import { RelayerCore, type SubmissionState } from "../relayer/core.ts";
import { makeHttpServer, relayerPort } from "../relayer/server.ts";
import { personalSign } from "../signer.ts";
import { timed } from "../timings.ts";
import { createWallet, syncWallet, type WalletCtx } from "../wallet.ts";
import type { LoadedCompiledModule } from "../compiled.ts";

const OWNER_PRIV = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const RECIPIENT = padEthAddress(`0x${"cc".repeat(20)}`);

interface Fixture {
  providers: Providers;
  loaded: LoadedCompiledModule;
  deploy: DeployResult;
  addressBytes: Uint8Array;
}

interface AccountLedger {
  owner: Uint8Array;
  consumedDigests: { member: (d: Uint8Array) => boolean };
  validateCount: bigint;
}

interface TokenLedger {
  balances: Iterable<readonly [unknown, bigint]>;
  txCount: bigint;
}

function accountBalance(ledger: TokenLedger, addressBytes: Uint8Array): bigint {
  for (const [key, value] of ledger.balances) {
    const either = key as { is_left: boolean; right?: { bytes: Uint8Array } };
    if (!either.is_left && bytesToHex(either.right!.bytes) === bytesToHex(addressBytes)) {
      return value;
    }
  }
  return 0n;
}

function identityBalance(ledger: TokenLedger, identity: Uint8Array): bigint {
  for (const [key, value] of ledger.balances) {
    const either = key as { is_left: boolean; left?: { bytes: Uint8Array } };
    if (either.is_left && bytesToHex(either.left!.bytes) === bytesToHex(identity)) {
      return value;
    }
  }
  return 0n;
}

let alice: WalletCtx;
let account: Fixture;
let token: Fixture;
let core: RelayerCore;
let server: http.Server;
let baseUrl: string;

async function deployAs(alice: WalletCtx, managedName: string, args: readonly unknown[], note: string): Promise<Fixture> {
  const { managedDir } = compileContract(contractByName(managedName));
  const providers = await createProviders(alice, managedDir, managedName);
  const loaded = await loadCompiledModule(managedDir);
  const handle = bindCompiledContract(managedName, loaded, { vacantWitnesses: true });
  const deploy = await deployFresh(providers, handle, managedName, args);
  recordDeployment({
    name: managedName,
    contractAddress: deploy.contractAddress,
    txHash: deploy.txHash,
    txId: deploy.txId,
    note,
  });
  console.log(`      deployed ${managedName} at ${deploy.contractAddress}`);
  return { providers, loaded, deploy, addressBytes: contractAddressBytes(deploy.contractAddress) };
}

// ── The HTTP client half (what a dapp page / MetaMask flow runs) ────────────

async function postRelay(payload: Uint8Array, signature65: Uint8Array) {
  const res = await fetch(`${baseUrl}/relay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      payload: bytesToHex(payload),
      signature: bytesToHex(signature65),
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function pollUntilTerminal(ethTxHash: string, timeoutMs = 420_000): Promise<SubmissionState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${baseUrl}/status/${ethTxHash}`);
    expect(res.status).toBe(200);
    const state = (await res.json()) as SubmissionState;
    if (state.phase === "confirmed" || state.phase === "failed") return state;
    if (Date.now() >= deadline) throw new Error(`still ${state.phase} after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

function signTransfer(nonce: bigint, amount: bigint, tokenAddr = token.addressBytes) {
  const payload = buildPayload({
    op: OP_TRANSFER,
    token: tokenAddr,
    account: account.addressBytes,
    from: hexToBytes(ethAddressOfPriv(OWNER_PRIV)),
    to: RECIPIENT,
    nonce,
    amount,
  });
  return { payload, signature65: personalSign(OWNER_PRIV, payload) };
}

beforeAll(async () => {
  // alice: deployer + funder (proven pattern from PLAN-03's live suite).
  alice = await createWallet("alice", ROLE_SEEDS.alice);
  await syncWallet(alice);
  const ownerAddr = hexToBytes(ethAddressOfPriv(OWNER_PRIV));
  account = await deployAs(alice, "Account", [ownerAddr], "PLAN-05 G5.3 account");
  token = await deployAs(alice, "MiniTokenAA", [], "PLAN-05 G5.3 token");
  await timed(
    { contract: "MiniTokenAA", circuit: "mint", note: "G5.3 — fund the account" },
    () => callCircuit(token.deploy.deployed, "mint", [account.addressBytes, 10_000n]),
  );

  // bob: the relayer — starts its own fee wallet, attaches as a NON-deployer.
  core = new RelayerCore({ role: "bob" });
  await core.start();
  await core.attachToken("MiniTokenAA", { contractAddress: token.deploy.contractAddress });

  const port = relayerPort();
  server = makeHttpServer(core);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${port}`;
}, 900_000);

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await core?.stop();
  await alice?.wallet.stop().catch(() => {});
}, 120_000);

describe("PLAN-05 live — the relayer on the persistent stack (G5.3)", () => {
  // Filled by the G5.3 test; the idempotence test replays it.
  const relayed = {} as { payload: Uint8Array; signature65: Uint8Array; ethTxHash: string };

  it("health + registry route by the deployed token address", async () => {
    const health = (await (await fetch(`${baseUrl}/health`)).json()) as {
      status: string;
      tokens: Array<{ name: string; contractAddress: string; circuit: string }>;
    };
    expect(health.status).toBe("ok");
    expect(health.tokens).toEqual([
      {
        name: "MiniTokenAA",
        contractAddress: token.deploy.contractAddress.toLowerCase().replace(/^0x/, ""),
        circuit: "accountTransfer",
      },
    ]);
  });

  it("G5.3 — mint → personal_sign → POST /relay → proven transfer → balance read", async () => {
    const { payload, signature65 } = signTransfer(1n, 1_000n);
    Object.assign(relayed, { payload, signature65 });

    const t0 = Date.now();
    const { status, body } = await postRelay(payload, signature65);
    const acceptMs = Date.now() - t0;
    expect(status).toBe(200);
    const ethTxHash = body.ethTxHash as string;
    relayed.ethTxHash = ethTxHash;
    // The eth-style hash IS the EIP-191 digest, returned before any proving.
    expect(ethTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(acceptMs).toBeLessThan(5_000);

    const early = await fetch(`${baseUrl}/status/${ethTxHash}`);
    expect(["queued", "submitting"]).toContain(
      ((await early.json()) as SubmissionState).phase,
    );

    const state = await pollUntilTerminal(ethTxHash);
    expect(state.phase).toBe("confirmed");
    const confirmed = state as Extract<SubmissionState, { phase: "confirmed" }>;
    expect(confirmed.midnightTxHash).toMatch(/^[0-9a-f]{64}$/);
    expect(confirmed.blockHeight).toBeGreaterThan(0);
    console.log(
      `      relayed: eth ${relayed.ethTxHash} -> midnight ${confirmed.midnightTxHash} (block ${confirmed.blockHeight})`,
    );

    // Balances moved, keyed by the validate-returned address; digest consumed.
    const ledger = await readLedger<TokenLedger>(
      token.providers,
      token.deploy.contractAddress,
      token.loaded.module,
    );
    expect(accountBalance(ledger, account.addressBytes)).toBe(9_000n);
    expect(identityBalance(ledger, RECIPIENT)).toBe(1_000n);

    const acct = await readLedger<AccountLedger>(
      account.providers,
      account.deploy.contractAddress,
      account.loaded.module,
    );
    const digest = hexToBytes(relayed.ethTxHash);
    expect(acct.consumedDigests.member(digest)).toBe(true);
    expect(acct.validateCount).toBe(1n);
  }, 600_000);

  it("duplicate relay returns the prior result — no second proof, no second move", async () => {
    const { status, body } = await postRelay(relayed.payload, relayed.signature65);
    expect(status).toBe(200);
    expect(body.ethTxHash).toBe(relayed.ethTxHash);
    // Already terminal — the duplicate did not re-enter the queue.
    const state = await pollUntilTerminal(relayed.ethTxHash, 10_000);
    expect(state.phase).toBe("confirmed");

    // The flipped-s twin is the SAME digest — idempotent too (R2 at the relayer).
    const twin = new Uint8Array(relayed.signature65);
    const s = BigInt(`0x${bytesToHex(twin.slice(32, 64))}`);
    const { secp256k1 } = await import("@noble/curves/secp256k1.js");
    const flipped = secp256k1.Point.Fn.ORDER - s;
    twin.set(hexToBytes(flipped.toString(16).padStart(64, "0")), 32);
    twin[64] = twin[64] === 27 ? 28 : 27;
    const twinRes = await postRelay(relayed.payload, twin);
    expect(twinRes.status).toBe(200);
    expect(twinRes.body.ethTxHash).toBe(relayed.ethTxHash);

    const ledger = await readLedger<TokenLedger>(
      token.providers,
      token.deploy.contractAddress,
      token.loaded.module,
    );
    expect(accountBalance(ledger, account.addressBytes)).toBe(9_000n); // unchanged
    const acct = await readLedger<AccountLedger>(
      account.providers,
      account.deploy.contractAddress,
      account.loaded.module,
    );
    expect(acct.validateCount).toBe(1n); // no second validate ran
  }, 120_000);

  it("R7 — an out-of-order nonce is refused with 409, before any proving", async () => {
    const stale = signTransfer(0n, 500n); // nonce 0 < accepted nonce 1
    const { status, body } = await postRelay(stale.payload, stale.signature65);
    expect(status).toBe(409);
    expect(body.code).toBe("stale-nonce");
  });

  it("routing — a payload for an unregistered token is refused with 404", async () => {
    const foreign = signTransfer(2n, 500n, new Uint8Array(32).fill(0xdd));
    const { status, body } = await postRelay(foreign.payload, foreign.signature65);
    expect(status).toBe(404);
    expect(body.code).toBe("unknown-token");
  });

  // ── Q4 retarget: the product TokenAA as a SECOND registered token ─────────

  it("G5.3 event leg — TokenAA joins the registry; relayed transfer emits spend+receive", async () => {
    // Deploy PLAN-04's TokenAA (owner-gated witnesses held by alice, the
    // deployer) and fund the SAME account — one digest space across tokens.
    const TOKEN_OWNER_SK = new Uint8Array(32).fill(0x11);
    const accountIdType = new CompactTypeVector(1, new CompactTypeBytes(32));
    const witness = (context: unknown) =>
      [(context as { privateState: unknown }).privateState, TOKEN_OWNER_SK] as const;
    const ownerId = {
      is_left: true,
      left: persistentHash(accountIdType, [TOKEN_OWNER_SK]),
      right: { bytes: new Uint8Array(32) },
    };

    const { managedDir } = compileContract(contractByName("TokenAA"));
    const providers = await createProviders(alice, managedDir, `TokenAA-plan05-${Date.now()}`);
    const loaded = await loadCompiledModule(managedDir);
    const handle = bindCompiledContract("TokenAA", loaded, {
      witnesses: { wit_OwnableSK: witness, wit_FungibleTokenSK: witness },
    });
    const deploy = await deployFresh(providers, handle, "TokenAA-plan05", [
      "AA Token",
      "AAT",
      18n,
      ownerId,
      ownerId,
      0n,
    ]);
    recordDeployment({
      name: "TokenAA",
      contractAddress: deploy.contractAddress,
      txHash: deploy.txHash,
      txId: deploy.txId,
      note: "PLAN-05 G5.3 event leg (Q4 retarget)",
    });
    await callCircuit(deploy.deployed, "mintToAccountAddress", [account.addressBytes, 5_000n]);

    // The relayer (bob) attaches as a non-deployer with VACANT witnesses —
    // accountTransfer carries all its authority in its arguments.
    await core.attachToken("TokenAA", { contractAddress: deploy.contractAddress });
    const registry = (await (await fetch(`${baseUrl}/registry`)).json()) as {
      tokens: Array<{ name: string }>;
    };
    expect(registry.tokens.map((t) => t.name).sort()).toEqual(["MiniTokenAA", "TokenAA"]);

    // Same (account, from) nonce sequence continues across tokens (R7 space).
    const { payload, signature65 } = signTransfer(10n, 750n, contractAddressBytes(deploy.contractAddress));
    const { status, body } = await postRelay(payload, signature65);
    expect(status).toBe(200);
    const state = await pollUntilTerminal(body.ethTxHash as string);
    expect(state.phase).toBe("confirmed");
    const confirmed = state as Extract<SubmissionState, { phase: "confirmed" }>;

    // Balances through OZ bookkeeping…
    const ledger = await readLedger<{
      _balances: Iterable<readonly [unknown, bigint]>;
    }>(providers, deploy.contractAddress, loaded.module);
    let accountBal = 0n;
    let recipientBal = 0n;
    for (const [rawKey, amount] of ledger._balances) {
      const key = rawKey as {
        is_left: boolean;
        left: Uint8Array | { bytes: Uint8Array };
        right: { bytes: Uint8Array };
      };
      if (!key.is_left && bytesToHex(key.right.bytes) === bytesToHex(account.addressBytes)) {
        accountBal = amount;
      }
      const leftBytes = key.left instanceof Uint8Array ? key.left : key.left?.bytes;
      if (key.is_left && leftBytes && bytesToHex(leftBytes) === bytesToHex(RECIPIENT)) {
        recipientBal = amount;
      }
    }
    expect(accountBal).toBe(4_250n);
    expect(recipientBal).toBe(750n);

    // …and the Transfer events, read back through the indexer (G5.3's event leg).
    let events: Awaited<ReturnType<typeof queryContractEvents>> = [];
    for (let attempt = 0; attempt < 15 && events.length < 2; attempt++) {
      events = await queryContractEvents({
        contractAddress: deploy.contractAddress,
        transactionHash: confirmed.midnightTxHash,
        types: ["UNSHIELDED_SPEND", "UNSHIELDED_RECEIVE"],
      });
      if (events.length < 2) await new Promise((r) => setTimeout(r, 1_000));
    }
    expect(events).toHaveLength(2);
    expect(
      events.every((e) => sameContractAddress(e.contractAddress, deploy.contractAddress)),
    ).toBe(true);
    expect(events.some((e) => rawContainsBytes(e.raw, account.addressBytes))).toBe(true);
    expect(events.some((e) => rawContainsBytes(e.raw, RECIPIENT))).toBe(true);
  }, 600_000);
});
