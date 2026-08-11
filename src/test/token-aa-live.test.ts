// PLAN-04 gates G4.3–G4.5 — the product TokenAA, live.
//
// Deploys the frozen Account callee and TWO full OZ TokenAA roots, funds the
// Account right arm through the owner-gated deposit circuit, proves the CCC
// adapter, verifies replay/cross-token/rollback behavior, and reads both
// transfer events back through the indexer.

import { setTimeout as delay } from "node:timers/promises";

import { beforeAll, describe, expect, it } from "vitest";

import {
  CompactTypeBytes,
  CompactTypeVector,
  persistentHash,
} from "@midnight-ntwrk/compact-runtime";

import {
  OP_TRANSFER,
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
import {
  queryContractEvents,
  rawContainsBytes,
  sameContractAddress,
  type ContractLogEvent,
} from "../events.ts";
import { bytesToHex, hexToBytes } from "../hex.ts";
import { createProviders, type Providers } from "../providers.ts";
import { flipS } from "../secp256k1-vectors.ts";
import { createWallet, syncWallet, type WalletCtx } from "../wallet.ts";

const OWNER_PRIV = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const RECIPIENT = padEthAddress(`0x${"cc".repeat(20)}`);
const TOKEN_OWNER_SK = new Uint8Array(32).fill(0x11);
const accountIdType = new CompactTypeVector(1, new CompactTypeBytes(32));

let alice: WalletCtx;
let accountLoaded: LoadedCompiledModule;
let tokenLoaded: LoadedCompiledModule;

beforeAll(async () => {
  if (process.env.TOKEN_AA_LIVE_USE_PRECOMPILED !== "1") {
    compileContract(contractByName("Account"));
    compileContract(contractByName("TokenAA"));
  }
  accountLoaded = await loadCompiledModule(managedDirFor("Account"));
  tokenLoaded = await loadCompiledModule(managedDirFor("TokenAA"));
  alice = await createWallet("alice-token-aa", process.env.TOKEN_AA_LIVE_SEED ?? "01".padStart(64, "0"));
  await syncWallet(alice);
}, 900_000);

interface Fixture {
  providers: Providers;
  loaded: LoadedCompiledModule;
  deploy: DeployResult;
  addressBytes: Uint8Array;
}

interface TokenLedger {
  _balances: Iterable<readonly [unknown, bigint]>;
  _totalSupply: bigint;
  txCount: bigint;
}

interface AccountLedger {
  consumedDigests: { member(digest: Uint8Array): boolean };
  validateCount: bigint;
}

function tokenWitnesses(): Witnesses {
  const witness = (context: unknown) => [
    (context as { privateState: unknown }).privateState,
    TOKEN_OWNER_SK,
  ] as const;
  return { wit_OwnableSK: witness, wit_FungibleTokenSK: witness };
}

function user(bytes: Uint8Array) {
  return {
    is_left: true,
    left: bytes,
    right: { bytes: new Uint8Array(32) },
  };
}

function tokenOwner(): ReturnType<typeof user> {
  return user(persistentHash(accountIdType, [TOKEN_OWNER_SK]));
}

async function deployFixture(
  managedName: "Account" | "TokenAA",
  loaded: LoadedCompiledModule,
  args: readonly unknown[],
  suffix: string,
): Promise<Fixture> {
  const privateStateId = `${managedName}-plan04-${suffix}-${Date.now()}`;
  const providers = await createProviders(alice, loaded.zkConfigPath, privateStateId);
  const handle = bindCompiledContract(
    managedName,
    loaded,
    managedName === "TokenAA" ? { witnesses: tokenWitnesses() } : { vacantWitnesses: true },
  );
  const deploy = await deployFresh(providers, handle, privateStateId, args);
  console.log(`      deployed ${managedName} at ${deploy.contractAddress}`);
  return {
    providers,
    loaded,
    deploy,
    addressBytes: contractAddressBytes(deploy.contractAddress),
  };
}

function contractRef(fixture: Fixture): { bytes: Uint8Array } {
  return { bytes: fixture.addressBytes };
}

function branchBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  return (value as { bytes: Uint8Array }).bytes;
}

function balance(
  ledger: TokenLedger,
  branch: "left" | "right",
  address: Uint8Array,
): bigint {
  for (const [rawKey, amount] of ledger._balances) {
    const key = rawKey as { is_left: boolean; left: unknown; right: unknown };
    if ((branch === "left") !== key.is_left) continue;
    const candidate = branchBytes(branch === "left" ? key.left : key.right);
    if (bytesToHex(candidate) === bytesToHex(address)) return amount;
  }
  return 0n;
}

async function indexedTransferEvents(
  token: Fixture,
  txHash: string,
): Promise<ContractLogEvent[]> {
  for (let attempt = 0; attempt < 15; attempt += 1) {
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

describe("PLAN-04 live — TokenAA + Account", () => {
  let account: Fixture;
  let tokenA: Fixture;
  let tokenB: Fixture;
  let first: SignedAccountPayload;
  let firstCall: CallResult;
  let nextNonce = 0n;

  const tokenLedger = (fixture: Fixture) =>
    readLedger<TokenLedger>(
      fixture.providers,
      fixture.deploy.contractAddress,
      fixture.loaded.module,
    );
  const accountLedger = () =>
    readLedger<AccountLedger>(
      account.providers,
      account.deploy.contractAddress,
      account.loaded.module,
    );

  function sign(token: Fixture, amount: bigint, to = RECIPIENT): SignedAccountPayload {
    return signAccountPayload(OWNER_PRIV, {
      op: OP_TRANSFER,
      token: token.addressBytes,
      account: account.addressBytes,
      to,
      nonce: nextNonce++,
      amount,
    });
  }

  const relay = (token: Fixture, signed: SignedAccountPayload) =>
    callCircuit(token.deploy.deployed, "accountTransfer", [
      contractRef(account),
      signed.payload,
      signed.sig,
      signed.pk,
    ]);

  it("deploys one Account and two 13-verifier-key TokenAA instances", async () => {
    account = await deployFixture(
      "Account",
      accountLoaded,
      [hexToBytes(ethAddressOfPriv(OWNER_PRIV))],
      "account",
    );
    const constructorArgs = ["AA Token", "AAT", 18n, tokenOwner(), tokenOwner(), 0n] as const;
    tokenA = await deployFixture("TokenAA", tokenLoaded, constructorArgs, "token-a");
    tokenB = await deployFixture("TokenAA", tokenLoaded, constructorArgs, "token-b");
  }, 900_000);

  it("owner-gated deposits fund the Account right arm on both tokens", async () => {
    await callCircuit(tokenA.deploy.deployed, "mintToAccountAddress", [
      account.addressBytes,
      10_000n,
    ]);
    await callCircuit(tokenB.deploy.deployed, "mintToAccountAddress", [
      account.addressBytes,
      10_000n,
    ]);

    for (const token of [tokenA, tokenB]) {
      const ledger = await tokenLedger(token);
      expect(balance(ledger, "right", account.addressBytes)).toBe(10_000n);
      expect(ledger._totalSupply).toBe(10_000n);
    }
  }, 900_000);

  it("G4.5 — proves accountTransfer and moves OZ balances through the CCC call tree", async () => {
    first = sign(tokenA, 1_000n);
    firstCall = await relay(tokenA, first);

    expect(bytesToHex((firstCall.result as { bytes: Uint8Array }).bytes)).toBe(
      bytesToHex(account.addressBytes),
    );
    expect(firstCall.calls?.map((entry) => entry.contractAddress)).toEqual([
      account.deploy.contractAddress,
      tokenA.deploy.contractAddress,
    ]);

    const ledger = await tokenLedger(tokenA);
    expect(balance(ledger, "right", account.addressBytes)).toBe(9_000n);
    expect(balance(ledger, "left", RECIPIENT)).toBe(1_000n);
    expect(ledger._totalSupply).toBe(10_000n);
    expect(ledger.txCount).toBe(1n);
    expect((await accountLedger()).consumedDigests.member(first.digest)).toBe(true);
  }, 900_000);

  it("G4.4 — exposes spend+receive in the call result and indexer", async () => {
    expect(firstCall.logEvents).toHaveLength(2);
    const events = await indexedTransferEvents(tokenA, firstCall.txHash);
    expect(events).toHaveLength(2);
    expect(events.every((event) => sameContractAddress(
      event.contractAddress,
      tokenA.deploy.contractAddress,
    ))).toBe(true);
    expect(events.some((event) => rawContainsBytes(event.raw, account.addressBytes))).toBe(true);
    expect(events.some((event) => rawContainsBytes(event.raw, RECIPIENT))).toBe(true);
  }, 120_000);

  it("G4.3 — replay/flipped-s and cross-token replay are inert", async () => {
    await expect(relay(tokenA, first)).rejects.toThrow(/digest already consumed/);
    await expect(relay(tokenA, { ...first, sig: flipS(first.sig) })).rejects.toThrow(
      /digest already consumed/,
    );
    await expect(relay(tokenB, first)).rejects.toThrow(/wrong token/);

    expect(balance(await tokenLedger(tokenA), "right", account.addressBytes)).toBe(9_000n);
    expect(balance(await tokenLedger(tokenB), "right", account.addressBytes)).toBe(10_000n);
  }, 900_000);

  it("post-hop failure rolls back Account replay state and the same signature lands after funding", async () => {
    const onceUnderfunded = sign(tokenB, 50_000n);
    await expect(relay(tokenB, onceUnderfunded)).rejects.toThrow(/insufficient balance/);
    expect((await accountLedger()).consumedDigests.member(onceUnderfunded.digest)).toBe(false);

    await callCircuit(tokenB.deploy.deployed, "mintToAccountAddress", [
      account.addressBytes,
      100_000n,
    ]);
    await relay(tokenB, onceUnderfunded);
    const ledger = await tokenLedger(tokenB);
    expect(balance(ledger, "right", account.addressBytes)).toBe(60_000n);
    expect(balance(ledger, "left", RECIPIENT)).toBe(50_000n);
    expect(ledger._totalSupply).toBe(110_000n);
    expect((await accountLedger()).consumedDigests.member(onceUnderfunded.digest)).toBe(true);
  }, 900_000);

  it("a zero recipient is rejected after the Account hop without burning its digest", async () => {
    const zeroRecipient = sign(tokenA, 1n, new Uint8Array(32));
    await expect(relay(tokenA, zeroRecipient)).rejects.toThrow(/invalid receiver/);
    expect((await accountLedger()).consumedDigests.member(zeroRecipient.digest)).toBe(false);
    expect(balance(await tokenLedger(tokenA), "right", account.addressBytes)).toBe(9_000n);
  }, 900_000);
});
