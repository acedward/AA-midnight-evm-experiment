// PLAN-00 §9.3 — the system-level acceptance runs V2 (demo loop), V3 (live
// rejection subset) and V4 (adversarial), in ONE pass on ONE set of fresh
// deployments against the persistent Part-0 stack (midnight-aa-36080, gen-2).
//
//   V2  deploy Account + TWO product TokenAA instances; mint on both;
//       personal_sign transfer on token A then token B THROUGH THE RELAYER
//       (sequential nonces, one digest space); balances via ledger read AND
//       Transfer events via the indexer; receipts via /status.
//   V3  on the V2 deployments, each rejected ON CHAIN (direct circuit calls,
//       the same call tree the relayer proves): replayed digest, flipped-s
//       (same digest), wrong owner key (both halves of the bind), cross-token
//       replay, cross-account replay (second Account deployed for this).
//   V4  (a) griefing containment: direct `validate` burns a signed digest →
//       the legit relay FAILS CLEANLY at the relayer → the re-signed op (new
//       nonce ⇒ new digest) lands.  (b) idempotence across relayer instances:
//       a SECOND RelayerCore (fresh process state, carol's fee wallet, same
//       DEPLOYMENTS registry) relays the tuple V2 already executed — same
//       eth tx hash back (it IS the digest), and the chain refuses a second
//       move; ledger totals and validateCount unchanged.
//
// Owner-key note (recorded in PLAN-00 §9 Questions): the V2 owner is the
// deterministic demo key. The committed real-MetaMask fixture
// (src/vectors/metamask-personal-sign-account.json, G5.4) is byte-parity
// evidence from a human-held throwaway key whose PRIVATE key is deliberately
// not committed (PLAN-05 Q3 standing rule) — it cannot sign fresh payloads
// for live contract addresses. Its parity is re-verified here instead.
//
// Evidence (tx hashes, blocks, rejection messages) is written to
// infra/VERIFICATION-EVIDENCE-v2v4.json for VERIFICATION.md (V6).

import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CompactTypeBytes,
  CompactTypeVector,
  persistentHash,
} from "@midnight-ntwrk/compact-runtime";

import {
  OP_TRANSFER,
  eip191Digest,
  ethAddressOfPriv,
  padEthAddress,
  signAccountPayload,
  type SignedAccountPayload,
} from "../account-payload.ts";
import {
  bindCompiledContract,
  loadCompiledModule,
  type LoadedCompiledModule,
  type Witnesses,
} from "../compiled.ts";
import { compileContract, managedDirFor } from "../compile.ts";
import { contractByName } from "../contracts.ts";
import {
  callCircuit,
  contractAddressBytes,
  deployFresh,
  readLedger,
  type CallResult,
  type DeployResult,
} from "../contract-ops.ts";
import { recordDeployment } from "../deployments.ts";
import { queryContractEvents, rawContainsBytes, sameContractAddress } from "../events.ts";
import { ROLE_SEEDS } from "../genesis-seeds.ts";
import { bytesToHex, hexToBytes } from "../hex.ts";
import { createProviders, type Providers } from "../providers.ts";
import { RelayerCore, type SubmissionState } from "../relayer/core.ts";
import { makeHttpServer, relayerPort } from "../relayer/server.ts";
import { flipS } from "../secp256k1-vectors.ts";
import { personalSign, tupleFromEthSignature } from "../signer.ts";
import { INFRA_DIR, REPO_ROOT } from "../stack-env.ts";
import { createWallet, syncWallet, type WalletCtx } from "../wallet.ts";

const OWNER_PRIV = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
// A second, unrelated key — the "wrong owner" of V3.
const EVE_PRIV = "6c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362319";
const RECIPIENT = padEthAddress(`0x${"cc".repeat(20)}`);
const TOKEN_OWNER_SK = new Uint8Array(32).fill(0x11);
const accountIdType = new CompactTypeVector(1, new CompactTypeBytes(32));

const EVIDENCE_PATH = path.join(INFRA_DIR, "VERIFICATION-EVIDENCE-v2v4.json");
const evidence: Array<Record<string, unknown>> = [];
function record(entry: Record<string, unknown>): void {
  evidence.push({ at: new Date().toISOString(), ...entry });
}

interface Fixture {
  providers: Providers;
  loaded: LoadedCompiledModule;
  deploy: DeployResult;
  addressBytes: Uint8Array;
}

interface AccountLedger {
  owner: Uint8Array;
  consumedDigests: { member(d: Uint8Array): boolean };
  validateCount: bigint;
}

interface TokenLedger {
  _balances: Iterable<readonly [unknown, bigint]>;
  _totalSupply: bigint;
  txCount: bigint;
}

function tokenWitnesses(): Witnesses {
  const witness = (context: unknown) =>
    [(context as { privateState: unknown }).privateState, TOKEN_OWNER_SK] as const;
  return { wit_OwnableSK: witness, wit_FungibleTokenSK: witness };
}

function tokenOwner() {
  return {
    is_left: true,
    left: persistentHash(accountIdType, [TOKEN_OWNER_SK]),
    right: { bytes: new Uint8Array(32) },
  };
}

function branchBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  return (value as { bytes: Uint8Array }).bytes;
}

function balance(ledger: TokenLedger, branch: "left" | "right", address: Uint8Array): bigint {
  for (const [rawKey, amount] of ledger._balances) {
    const key = rawKey as { is_left: boolean; left: unknown; right: unknown };
    if ((branch === "left") !== key.is_left) continue;
    if (bytesToHex(branchBytes(branch === "left" ? key.left : key.right)) === bytesToHex(address)) {
      return amount;
    }
  }
  return 0n;
}

let alice: WalletCtx;
let accountLoaded: LoadedCompiledModule;
let tokenLoaded: LoadedCompiledModule;
let account1: Fixture;
let account2: Fixture; // deployed lazily by V3e
let tokenA: Fixture;
let tokenB: Fixture;
let core: RelayerCore;
let core2: RelayerCore | undefined;
let server: http.Server;
let baseUrl: string;

async function deployFixture(
  managedName: "Account" | "TokenAA",
  args: readonly unknown[],
  note: string,
): Promise<Fixture> {
  const loaded = managedName === "Account" ? accountLoaded : tokenLoaded;
  const privateStateId = `${managedName}-v93-${Date.now()}`;
  const providers = await createProviders(alice, loaded.zkConfigPath, privateStateId);
  const handle = bindCompiledContract(
    managedName,
    loaded,
    managedName === "TokenAA" ? { witnesses: tokenWitnesses() } : { vacantWitnesses: true },
  );
  const deploy = await deployFresh(providers, handle, privateStateId, args);
  recordDeployment({
    name: managedName,
    contractAddress: deploy.contractAddress,
    txHash: deploy.txHash,
    txId: deploy.txId,
    note,
  });
  record({ v: "V2", step: `deploy ${note}`, contractAddress: deploy.contractAddress, txHash: deploy.txHash });
  console.log(`      deployed ${managedName} (${note}) at ${deploy.contractAddress}`);
  return { providers, loaded, deploy, addressBytes: contractAddressBytes(deploy.contractAddress) };
}

const accountLedgerOf = (f: Fixture) =>
  readLedger<AccountLedger>(f.providers, f.deploy.contractAddress, f.loaded.module);
const tokenLedgerOf = (f: Fixture) =>
  readLedger<TokenLedger>(f.providers, f.deploy.contractAddress, f.loaded.module);

/** MetaMask-shaped signed intent for (token, account) with an explicit nonce. */
function sign(token: Fixture, account: Fixture, nonce: bigint, amount: bigint, priv = OWNER_PRIV): SignedAccountPayload {
  return signAccountPayload(priv, {
    op: OP_TRANSFER,
    token: token.addressBytes,
    account: account.addressBytes,
    to: RECIPIENT,
    nonce,
    amount,
  });
}

/** The direct on-chain path — the exact call tree the relayer proves. */
const direct = (token: Fixture, account: Fixture, signed: SignedAccountPayload) =>
  callCircuit(token.deploy.deployed, "accountTransfer", [
    { bytes: account.addressBytes },
    signed.payload,
    signed.sig,
    signed.pk,
  ]);

async function postRelay(payload: Uint8Array, signature65: Uint8Array) {
  const res = await fetch(`${baseUrl}/relay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload: bytesToHex(payload), signature: bytesToHex(signature65) }),
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
    await delay(3_000);
  }
}

async function indexedTransferEvents(token: Fixture, txHash: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const events = await queryContractEvents({
      contractAddress: token.deploy.contractAddress,
      transactionHash: txHash,
      types: ["UNSHIELDED_SPEND", "UNSHIELDED_RECEIVE"],
    });
    if (events.length >= 2) return events;
    await delay(1_000);
  }
  return [];
}

beforeAll(async () => {
  compileContract(contractByName("Account"));
  compileContract(contractByName("TokenAA"));
  accountLoaded = await loadCompiledModule(managedDirFor("Account"));
  tokenLoaded = await loadCompiledModule(managedDirFor("TokenAA"));

  alice = await createWallet("alice", ROLE_SEEDS.alice);
  await syncWallet(alice);

  const ownerAddr = hexToBytes(ethAddressOfPriv(OWNER_PRIV));
  account1 = await deployFixture("Account", [ownerAddr], "V2 demo account");
  const constructorArgs = ["AA Token", "AAT", 18n, tokenOwner(), tokenOwner(), 0n] as const;
  tokenA = await deployFixture("TokenAA", constructorArgs, "V2 token A");
  tokenB = await deployFixture("TokenAA", constructorArgs, "V2 token B");

  await callCircuit(tokenA.deploy.deployed, "mintToAccountAddress", [account1.addressBytes, 10_000n]);
  await callCircuit(tokenB.deploy.deployed, "mintToAccountAddress", [account1.addressBytes, 10_000n]);
  record({ v: "V2", step: "mint 10000 on token A and token B to the account" });

  // The relayer: bob's fee wallet, attaches to BOTH tokens as a non-deployer.
  core = new RelayerCore({ role: "bob" });
  await core.start();
  await core.attachToken("TokenAA", { contractAddress: tokenA.deploy.contractAddress });
  await core.attachToken("TokenAA", { contractAddress: tokenB.deploy.contractAddress });

  server = makeHttpServer(core);
  const port = relayerPort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${port}`;
}, 1_800_000);

afterAll(async () => {
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify({ suite: "V2-V4", records: evidence }, null, 2)}\n`);
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await core?.stop();
  await core2?.stop();
  await alice?.wallet.stop().catch(() => {});
}, 120_000);

describe("V2 — the demo loop (Account + two TokenAA through the relayer)", () => {
  it("the committed real-MetaMask fixture still verifies through the same signer path", () => {
    const fixture = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "src", "vectors", "metamask-personal-sign-account.json"), "utf-8"),
    ) as { payloadHex: string; signatureHex: string; address: string };
    const payload = hexToBytes(fixture.payloadHex);
    const tuple = tupleFromEthSignature(payload, hexToBytes(fixture.signatureHex));
    expect(`0x${bytesToHex(tuple.signer)}`).toBe(fixture.address);
    expect(bytesToHex(tuple.digest)).toBe(bytesToHex(eip191Digest(payload)));
    record({ v: "V2", step: "G5.4 MetaMask fixture parity re-verified", address: fixture.address });
  });

  it("transfer on token A through the relayer — receipt, ledger read, indexer events", async () => {
    const signed = sign(tokenA, account1, 1n, 1_000n);
    const wire = personalSign(OWNER_PRIV, signed.payload);
    const { status, body } = await postRelay(signed.payload, wire);
    expect(status).toBe(200);
    const ethTxHash = body.ethTxHash as string;
    expect(ethTxHash).toBe(`0x${bytesToHex(signed.digest)}`);

    const state = await pollUntilTerminal(ethTxHash);
    expect(state.phase).toBe("confirmed");
    const receipt = state as Extract<SubmissionState, { phase: "confirmed" }>;
    expect(receipt.midnightTxHash).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.blockHeight).toBeGreaterThan(0);
    record({ v: "V2", step: "relayed transfer token A (nonce 1, 1000)", ethTxHash, ...receipt });

    const ledger = await tokenLedgerOf(tokenA);
    expect(balance(ledger, "right", account1.addressBytes)).toBe(9_000n);
    expect(balance(ledger, "left", RECIPIENT)).toBe(1_000n);

    const events = await indexedTransferEvents(tokenA, receipt.midnightTxHash);
    expect(events).toHaveLength(2);
    expect(events.every((e) => sameContractAddress(e.contractAddress, tokenA.deploy.contractAddress))).toBe(true);
    expect(events.some((e) => rawContainsBytes(e.raw, account1.addressBytes))).toBe(true);
    expect(events.some((e) => rawContainsBytes(e.raw, RECIPIENT))).toBe(true);

    const acct = await accountLedgerOf(account1);
    expect(acct.consumedDigests.member(signed.digest)).toBe(true);
    expect(acct.validateCount).toBe(1n);
    (globalThis as Record<string, unknown>).__v2TokenA = signed; // reused by V3/V4b
  }, 600_000);

  it("transfer on token B through the SAME relayer — sequential nonce, one digest space", async () => {
    const first = (globalThis as Record<string, unknown>).__v2TokenA as SignedAccountPayload;
    const signed = sign(tokenB, account1, 2n, 2_000n);
    const { status, body } = await postRelay(signed.payload, personalSign(OWNER_PRIV, signed.payload));
    expect(status).toBe(200);
    const state = await pollUntilTerminal(body.ethTxHash as string);
    expect(state.phase).toBe("confirmed");
    const receipt = state as Extract<SubmissionState, { phase: "confirmed" }>;
    record({ v: "V2", step: "relayed transfer token B (nonce 2, 2000)", ethTxHash: body.ethTxHash, ...receipt });

    const ledger = await tokenLedgerOf(tokenB);
    expect(balance(ledger, "right", account1.addressBytes)).toBe(8_000n);
    expect(balance(ledger, "left", RECIPIENT)).toBe(2_000n);

    const events = await indexedTransferEvents(tokenB, receipt.midnightTxHash);
    expect(events).toHaveLength(2);

    // ONE digest space: the account's set now holds both tokens' digests.
    const acct = await accountLedgerOf(account1);
    expect(acct.consumedDigests.member(first.digest)).toBe(true);
    expect(acct.consumedDigests.member(signed.digest)).toBe(true);
    expect(acct.validateCount).toBe(2n);
    (globalThis as Record<string, unknown>).__v2TokenB = signed;
  }, 600_000);
});

describe("V3 — live rejection subset, on the V2 deployments", () => {
  const firstTuple = () => (globalThis as Record<string, unknown>).__v2TokenA as SignedAccountPayload;

  it("R6 — replayed digest rejected on chain, no state change", async () => {
    await expect(direct(tokenA, account1, firstTuple())).rejects.toThrow(/digest already consumed/);
    expect(balance(await tokenLedgerOf(tokenA), "right", account1.addressBytes)).toBe(9_000n);
    record({ v: "V3", step: "R6 replayed digest", rejected: "Account: digest already consumed" });
  }, 300_000);

  it("R2 — flipped-s twin (same digest) rejected on chain", async () => {
    const twin = { ...firstTuple(), sig: flipS(firstTuple().sig) };
    await expect(direct(tokenA, account1, twin)).rejects.toThrow(/digest already consumed/);
    expect(balance(await tokenLedgerOf(tokenA), "right", account1.addressBytes)).toBe(9_000n);
    record({ v: "V3", step: "R2 flipped-s twin", rejected: "Account: digest already consumed" });
  }, 300_000);

  it("R4 — wrong owner key rejected on chain (both halves of the bind)", async () => {
    // (a) Eve signs as herself: passes the from-bind, dies at the Account owner check.
    const eveAsSelf = sign(tokenA, account1, 3n, 100n, EVE_PRIV);
    await expect(direct(tokenA, account1, eveAsSelf)).rejects.toThrow(/signer is not the account owner/);

    // (b) Eve signs a payload claiming from=owner: dies at the token's from-bind.
    const eveAsOwner = signAccountPayload(EVE_PRIV, {
      op: OP_TRANSFER,
      token: tokenA.addressBytes,
      account: account1.addressBytes,
      from: hexToBytes(ethAddressOfPriv(OWNER_PRIV)),
      to: RECIPIENT,
      nonce: 3n,
      amount: 100n,
    });
    await expect(direct(tokenA, account1, eveAsOwner)).rejects.toThrow(/signer is not from/);

    const ledger = await tokenLedgerOf(tokenA);
    expect(balance(ledger, "right", account1.addressBytes)).toBe(9_000n);
    expect((await accountLedgerOf(account1)).validateCount).toBe(2n);
    record({
      v: "V3",
      step: "R4 wrong owner key",
      rejected: ["Account: signer is not the account owner", "TokenAA: signer is not from"],
    });
  }, 300_000);

  it("R8 — cross-token replay rejected on chain", async () => {
    await expect(direct(tokenB, account1, firstTuple())).rejects.toThrow(/wrong token/);
    expect(balance(await tokenLedgerOf(tokenB), "right", account1.addressBytes)).toBe(8_000n);
    record({ v: "V3", step: "R8 cross-token replay", rejected: "TokenAA: wrong token" });
  }, 300_000);

  it("R9 — cross-account replay rejected on chain, atomically (second Account deployed)", async () => {
    account2 = await deployFixture(
      "Account",
      [hexToBytes(ethAddressOfPriv(OWNER_PRIV))],
      "V3 second account (cross-account replay)",
    );

    const bound = sign(tokenA, account1, 4n, 500n); // bound to account1
    await expect(direct(tokenA, account2, bound)).rejects.toThrow(/account mismatch/);

    // Atomicity: the failed root call reverted account2's digest insert.
    const acct2 = await accountLedgerOf(account2);
    expect(acct2.consumedDigests.member(bound.digest)).toBe(false);
    expect(acct2.validateCount).toBe(0n);

    // The intended relay still lands — nothing was burned by the attempt.
    const landed = await direct(tokenA, account1, bound);
    expect(balance(await tokenLedgerOf(tokenA), "right", account1.addressBytes)).toBe(8_500n);
    record({
      v: "V3",
      step: "R9 cross-account replay (rejected atomically; intended relay landed after)",
      rejected: "TokenAA: account mismatch",
      landedTxHash: (landed as CallResult).txHash,
      landedBlock: (landed as CallResult).blockHeight,
    });
  }, 600_000);
});

describe("V4 — adversarial", () => {
  it("V4a — griefing containment: validate burn → relay fails cleanly → re-sign succeeds", async () => {
    // The griefer observed the tuple and calls the PUBLIC validate directly.
    const griefed = sign(tokenA, account1, 5n, 700n);
    const burn = await callCircuit(account1.deploy.deployed, "validate", [
      hexToBytes(griefed.ethAddr),
      griefed.digest,
    ]);
    record({ v: "V4a", step: "direct validate burned the digest", txHash: (burn as CallResult).txHash });

    // The legit relay THROUGH THE RELAYER now fails cleanly, reason named.
    const { status, body } = await postRelay(griefed.payload, personalSign(OWNER_PRIV, griefed.payload));
    expect(status).toBe(200); // accepted at intake — failure is on chain
    const state = await pollUntilTerminal(body.ethTxHash as string);
    expect(state.phase).toBe("failed");
    expect((state as Extract<SubmissionState, { phase: "failed" }>).error).toMatch(
      /digest already consumed/,
    );
    expect(balance(await tokenLedgerOf(tokenA), "right", account1.addressBytes)).toBe(8_500n);
    record({ v: "V4a", step: "legit relay failed cleanly", ethTxHash: body.ethTxHash, error: "digest already consumed" });

    // Re-signed op (new nonce ⇒ new digest) recovers through the relayer.
    const resigned = sign(tokenA, account1, 6n, 700n);
    const retry = await postRelay(resigned.payload, personalSign(OWNER_PRIV, resigned.payload));
    expect(retry.status).toBe(200);
    const retryState = await pollUntilTerminal(retry.body.ethTxHash as string);
    expect(retryState.phase).toBe("confirmed");
    expect(balance(await tokenLedgerOf(tokenA), "right", account1.addressBytes)).toBe(7_800n);
    record({
      v: "V4a",
      step: "re-signed op landed (griefer denied ONE op, not the account)",
      ethTxHash: retry.body.ethTxHash,
      ...(retryState as Extract<SubmissionState, { phase: "confirmed" }>),
    });
  }, 900_000);

  it("V4b — a SECOND RelayerCore instance relays the already-executed tuple: same hash, no second move", async () => {
    const first = (globalThis as Record<string, unknown>).__v2TokenA as SignedAccountPayload;
    const before = await tokenLedgerOf(tokenA);
    const beforeBal = balance(before, "right", account1.addressBytes);
    const beforeCount = (await accountLedgerOf(account1)).validateCount;

    // Fresh instance, fresh in-memory state, its own fee wallet (carol),
    // same registry addresses — "anyone may relay".
    core2 = new RelayerCore({ role: "carol" });
    await core2.start();
    await core2.attachToken("TokenAA", { contractAddress: tokenA.deploy.contractAddress });

    const wire = personalSign(OWNER_PRIV, first.payload);
    const { ethTxHash } = core2.relay(bytesToHex(first.payload), bytesToHex(wire));
    // The eth-style hash IS the EIP-191 digest — identical across instances.
    expect(ethTxHash).toBe(`0x${bytesToHex(first.digest)}`);

    // The chain is the idempotence authority for a fresh instance: the digest
    // set refuses the second execution; nothing moves.
    const state = await core2.waitFor(ethTxHash);
    expect(state.phase).toBe("failed");
    expect((state as Extract<SubmissionState, { phase: "failed" }>).error).toMatch(
      /digest already consumed/,
    );

    const after = await tokenLedgerOf(tokenA);
    expect(balance(after, "right", account1.addressBytes)).toBe(beforeBal);
    expect((await accountLedgerOf(account1)).validateCount).toBe(beforeCount);

    // And the FIRST instance still answers with its cached confirmed receipt.
    const cached = await postRelay(first.payload, wire);
    expect(cached.status).toBe(200);
    expect(cached.body.ethTxHash).toBe(ethTxHash);
    expect((await pollUntilTerminal(ethTxHash, 10_000)).phase).toBe("confirmed");
    record({
      v: "V4b",
      step: "second RelayerCore relayed the executed tuple",
      ethTxHash,
      secondInstanceOutcome: "failed on chain: digest already consumed (no second proof-move)",
      firstInstanceOutcome: "cached confirmed receipt returned",
    });
  }, 600_000);
});
