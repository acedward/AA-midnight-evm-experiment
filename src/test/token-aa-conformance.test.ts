// PLAN-04 §1–2 — TokenAA simulator conformance on compact-runtime 0.18.
//
// This deliberately drives compactc's emitted artifact directly. OpenZeppelin's
// own simulator package hard-pins runtime 0.16, so it cannot share the beta.6
// ledger/runtime instance used by this repo.

import { beforeAll, describe, expect, it } from "vitest";

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  CompactTypeBytes,
  CompactTypeVector,
  createCircuitContext,
  createConstructorContext,
  dummyContractAddress,
  persistentHash,
} from "@midnight-ntwrk/compact-runtime";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

import { CONTRACTS_ROOT, managedDirFor, readExportedCircuits } from "../compile.ts";

const NAME = "TokenAA";
const OWNER_SK = new Uint8Array(32).fill(0x11);
const BOB_SK = new Uint8Array(32).fill(0x22);
const CAROL_SK = new Uint8Array(32).fill(0x33);
const MAX_UINT128 = (1n << 128n) - 1n;

interface Account {
  is_left: boolean;
  left: Uint8Array;
  right: { bytes: Uint8Array };
}

interface WitnessContext {
  privateState: unknown;
}

interface TokenWitnesses {
  wit_OwnableSK(context: WitnessContext): [unknown, Uint8Array];
  wit_FungibleTokenSK(context: WitnessContext): [unknown, Uint8Array];
}

interface CircuitResult {
  context: any;
  result: unknown;
}

interface TokenContract {
  circuits: Record<
    string,
    (context: any, ...args: readonly unknown[]) => Promise<CircuitResult>
  >;
  initialState(
    context: unknown,
    name: string,
    symbol: string,
    decimals: bigint,
    initialSupplyRecipient: Account,
    initialOwner: Account,
    initialSupply: bigint,
  ): Promise<any>;
}

interface TokenModule {
  Contract: new (witnesses: TokenWitnesses) => TokenContract;
  expectedVk: Record<string, string>;
  ledger(state: unknown): TokenLedger;
}

interface TokenLedger {
  readonly _isInitialized: boolean;
  readonly _name: string;
  readonly _symbol: string;
  readonly _decimals: bigint;
  readonly _totalSupply: bigint;
  _balances: { member(account: Account): boolean; lookup(account: Account): bigint };
  _allowances: {
    member(owner: Account): boolean;
    lookup(owner: Account): { member(spender: Account): boolean; lookup(spender: Account): bigint };
  };
  _ethNonces: { member(address: Uint8Array): boolean; lookup(address: Uint8Array): bigint };
}

const accountIdType = new CompactTypeVector(1, new CompactTypeBytes(32));
let module: TokenModule;
let seedCounter = 0;

async function compileTokenArtifact(): Promise<string> {
  const repoRoot = path.dirname(CONTRACTS_ROOT);
  if (process.env.TOKEN_AA_USE_PRECOMPILED === "1") {
    const managedDir = managedDirFor(NAME);
    if (!fs.existsSync(path.join(managedDir, "contract", "index.js"))) {
      throw new Error("TOKEN_AA_USE_PRECOMPILED=1 but TokenAA/index.js is missing");
    }
    return managedDir;
  }
  await new Promise<void>((resolve, reject) => {
    // Keep compactc's roughly two-minute synchronous compiler in a child process so
    // Vitest's worker RPC heartbeat is not starved while the gate compiles.
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "src/compile-cli.ts", NAME],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`TokenAA compile failed (exit ${code})\n${stdout}\n${stderr}`));
    });
  });
  return managedDirFor(NAME);
}

function accountId(secretKey: Uint8Array): Uint8Array {
  return persistentHash(accountIdType, [secretKey]);
}

function user(id: Uint8Array, inactiveRight = new Uint8Array(32)): Account {
  return { is_left: true, left: id, right: { bytes: inactiveRight } };
}

function contractAddress(bytes: Uint8Array): Account {
  return { is_left: false, left: new Uint8Array(32), right: { bytes } };
}

function witnesses(fungibleTokenSK: Uint8Array, ownableSK = fungibleTokenSK): TokenWitnesses {
  return {
    wit_OwnableSK: (context) => [context.privateState, ownableSK],
    wit_FungibleTokenSK: (context) => [context.privateState, fungibleTokenSK],
  };
}

function nextSeed(): string {
  seedCounter += 1;
  return seedCounter.toString(16).padStart(64, "0");
}

function beBytes(value: bigint, width: number): Uint8Array {
  const out = new Uint8Array(width);
  let remaining = value;
  for (let i = width - 1; i >= 0; i -= 1) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

function legacyDomainTag(): Uint8Array {
  const preimage = new Uint8Array(52);
  preimage.set(new TextEncoder().encode("MIDNIGHT_EVM_AUTH_V1"));
  preimage.set(beBytes(2_400n, 32), 20);
  return keccak_256(preimage);
}

function legacyPayload(
  from: Uint8Array,
  to: Uint8Array,
  amount: bigint,
  nonce: bigint,
): Uint8Array {
  const payload = new Uint8Array(128);
  payload.set(legacyDomainTag());
  payload.set(from, 32);
  payload.set(to, 52);
  payload.set(beBytes(amount, 16), 72);
  payload.set(beBytes(nonce, 16), 88);
  return payload;
}

function signLegacyPayload(payload: Uint8Array, privateKey: Uint8Array) {
  const prefix = new TextEncoder().encode("\x19Ethereum Signed Message:\n128");
  const preimage = new Uint8Array(prefix.length + payload.length);
  preimage.set(prefix);
  preimage.set(payload, prefix.length);
  const digest = keccak_256(preimage);
  const signature = secp256k1.Signature.fromBytes(
    secp256k1.sign(digest, privateKey, { prehash: false, format: "recovered" }),
    "recovered",
  );
  const point = secp256k1.Point.fromBytes(secp256k1.getPublicKey(privateKey, false)).toAffine();
  return { sig: { r: signature.r, s: signature.s }, pk: { x: point.x, y: point.y } };
}

function ethereumAddress(privateKey: Uint8Array): Uint8Array {
  return keccak_256(secp256k1.getPublicKey(privateKey, false).slice(1)).slice(12);
}

function ethAccount(address: Uint8Array): Account {
  const padded = new Uint8Array(32);
  padded.set(address, 12);
  return user(padded);
}

class TokenSimulator {
  private context: any;
  readonly owner = user(accountId(OWNER_SK));
  readonly bob = user(accountId(BOB_SK));
  readonly carol = user(accountId(CAROL_SK));
  readonly asOwner: TokenContract;
  readonly asBob: TokenContract;
  readonly asCarol: TokenContract;

  private constructor(initial: any) {
    this.asOwner = new module.Contract(witnesses(OWNER_SK));
    this.asBob = new module.Contract(witnesses(BOB_SK));
    this.asCarol = new module.Contract(witnesses(CAROL_SK));
    this.context = createCircuitContext(
      "totalSupply",
      dummyContractAddress(),
      initial.currentZswapLocalState.coinPublicKey,
      initial.currentContractState,
      initial.currentPrivateState,
    );
  }

  static async create(
    initialSupply = 1_000n,
    initialSupplyRecipient?: Account,
    initialOwner?: Account,
  ): Promise<TokenSimulator> {
    const owner = user(accountId(OWNER_SK));
    const ownerContract = new module.Contract(witnesses(OWNER_SK));
    const initial = await ownerContract.initialState(
      createConstructorContext({}, nextSeed()),
      "AA Token",
      "AAT",
      18n,
      initialSupplyRecipient ?? owner,
      initialOwner ?? owner,
      initialSupply,
    );
    return new TokenSimulator(initial);
  }

  async call(
    contract: TokenContract,
    circuit: string,
    ...args: readonly unknown[]
  ): Promise<unknown> {
    this.context.callContext.circuitId = circuit;
    const result = await contract.circuits[circuit]!(this.context, ...args);
    this.context = result.context;
    return result.result;
  }

  async rejects(
    contract: TokenContract,
    circuit: string,
    args: readonly unknown[],
    message: RegExp,
  ): Promise<void> {
    this.context.callContext.circuitId = circuit;
    await expect(contract.circuits[circuit]!(this.context, ...args)).rejects.toThrow(message);
  }

  ledger(): TokenLedger {
    return module.ledger(this.context.callContext.currentQueryContext.state);
  }
}

beforeAll(async () => {
  const managedDir = await compileTokenArtifact();
  expect(readExportedCircuits(managedDir)).toHaveLength(13);

  const indexPath = path.join(managedDir, "contract", "index.js");
  module = (await import(pathToFileURL(indexPath).href)) as TokenModule;
}, 900_000);

describe("G4.1 — TokenAA 0.33 artifact", () => {
  it("loads all expected verifier keys and constructs initialized metadata/state", async () => {
    expect(Object.keys(module.expectedVk).sort()).toEqual([
      "_burn",
      "allowance",
      "approve",
      "balanceOf",
      "decimals",
      "mint",
      "mintToEthAddress",
      "name",
      "symbol",
      "totalSupply",
      "transfer",
      "transferFrom",
      "transferWithEthSig",
    ]);

    const token = await TokenSimulator.create();
    expect(token.ledger()._isInitialized).toBe(true);
    expect(token.ledger()._name).toBe("AA Token");
    expect(token.ledger()._symbol).toBe("AAT");
    expect(token.ledger()._decimals).toBe(18n);
    expect(token.ledger()._totalSupply).toBe(1_000n);
    expect(token.ledger()._balances.lookup(token.owner)).toBe(1_000n);

    expect(await token.call(token.asOwner, "name")).toBe("AA Token");
    expect(await token.call(token.asOwner, "symbol")).toBe("AAT");
    expect(await token.call(token.asOwner, "decimals")).toBe(18n);
    expect(await token.call(token.asOwner, "totalSupply")).toBe(1_000n);
  });

  it("keeps genesis supply recipient and Ownable administrator independent", async () => {
    const bob = user(accountId(BOB_SK));
    const token = await TokenSimulator.create(100n, bob);
    expect(await token.call(token.asOwner, "balanceOf", bob)).toBe(100n);
    expect(await token.call(token.asOwner, "balanceOf", token.owner)).toBe(0n);
    await token.call(token.asOwner, "mint", bob, 1n);
    await token.rejects(token.asBob, "mint", [bob, 1n], /caller is not the owner/);
    expect(await token.call(token.asOwner, "balanceOf", bob)).toBe(101n);
  });

  it("rejects invalid genesis recipients and invalid Ownable administrators", async () => {
    const owner = user(accountId(OWNER_SK));
    const constructor = new module.Contract(witnesses(OWNER_SK));
    const construct = (recipient: Account, initialOwner: Account) =>
      constructor.initialState(
        createConstructorContext({}, nextSeed()),
        "AA Token",
        "AAT",
        18n,
        recipient,
        initialOwner,
        1n,
      );

    await expect(construct(user(new Uint8Array(32)), owner)).rejects.toThrow(/invalid receiver/);
    await expect(
      construct(contractAddress(new Uint8Array(32).fill(0x44)), owner),
    ).rejects.toThrow(/unsafe transfer/);
    await expect(construct(owner, user(new Uint8Array(32)))).rejects.toThrow(
      /invalid initial owner/,
    );
    await expect(
      construct(owner, contractAddress(new Uint8Array(32).fill(0x55))),
    ).rejects.toThrow(/unsafe ownership transfer/);
  });

  it("keeps all balance writes in constructor/_update and emits only outside them", () => {
    const source = fs.readFileSync(path.join(CONTRACTS_ROOT, "TokenAA.compact"), "utf-8");
    const updateStart = source.indexOf("circuit _update(");
    const constructorStart = source.indexOf("constructor(");
    const firstExport = source.indexOf("export circuit name(");
    expect(updateStart).toBeGreaterThan(firstExport);

    const beforeUpdate = source.slice(0, updateStart);
    const update = source.slice(updateStart);
    expect(beforeUpdate.match(/_balances\.insert/g)).toHaveLength(1);
    expect(update.match(/_balances\.insert/g)).toHaveLength(3);
    expect(source.slice(constructorStart, firstExport)).not.toContain("emit(");
    expect(update).not.toContain("emit(");
  });
});

describe("G4.2 — ERC20 conformance", () => {
  it("returns zero for absent balances and allowances", async () => {
    const token = await TokenSimulator.create();
    expect(await token.call(token.asOwner, "balanceOf", token.bob)).toBe(0n);
    expect(await token.call(token.asOwner, "allowance", token.owner, token.bob)).toBe(0n);
  });

  it("transfers, returns true, preserves supply, and supports zero-value transfers", async () => {
    const token = await TokenSimulator.create();
    expect(await token.call(token.asOwner, "transfer", token.bob, 250n)).toBe(true);
    expect(await token.call(token.asOwner, "transfer", token.bob, 0n)).toBe(true);
    expect(token.ledger()._balances.lookup(token.owner)).toBe(750n);
    expect(token.ledger()._balances.lookup(token.bob)).toBe(250n);
    expect(token.ledger()._totalSupply).toBe(1_000n);
  });

  it("supports self-transfer and transferring the full balance", async () => {
    const token = await TokenSimulator.create();
    await token.call(token.asOwner, "transfer", token.owner, 200n);
    expect(token.ledger()._balances.lookup(token.owner)).toBe(1_000n);
    await token.call(token.asOwner, "transfer", token.bob, 1_000n);
    expect(token.ledger()._balances.lookup(token.owner)).toBe(0n);
    expect(token.ledger()._balances.lookup(token.bob)).toBe(1_000n);
    expect(token.ledger()._totalSupply).toBe(1_000n);
  });

  it("rejects insufficient balance, zero receiver, and unsafe contract receiver", async () => {
    const token = await TokenSimulator.create();
    await token.rejects(token.asOwner, "transfer", [token.bob, 1_001n], /insufficient balance/);
    await token.rejects(
      token.asOwner,
      "transfer",
      [user(new Uint8Array(32)), 1n],
      /invalid receiver/,
    );
    await token.rejects(
      token.asOwner,
      "transfer",
      [contractAddress(new Uint8Array(32).fill(0x44)), 1n],
      /unsafe transfer/,
    );
    expect(token.ledger()._balances.lookup(token.owner)).toBe(1_000n);
  });

  it("approves, overwrites, clears, and rejects a zero spender", async () => {
    const token = await TokenSimulator.create();
    expect(await token.call(token.asOwner, "approve", token.bob, 300n)).toBe(true);
    expect(await token.call(token.asOwner, "allowance", token.owner, token.bob)).toBe(300n);
    expect(await token.call(token.asOwner, "approve", token.bob, 125n)).toBe(true);
    expect(await token.call(token.asOwner, "allowance", token.owner, token.bob)).toBe(125n);
    expect(await token.call(token.asOwner, "approve", token.bob, 0n)).toBe(true);
    expect(await token.call(token.asOwner, "allowance", token.owner, token.bob)).toBe(0n);
    await token.rejects(
      token.asOwner,
      "approve",
      [user(new Uint8Array(32)), 1n],
      /invalid spender/,
    );
  });

  it("keeps allowances for different spenders isolated", async () => {
    const token = await TokenSimulator.create();
    await token.call(token.asOwner, "approve", token.bob, 10n);
    await token.call(token.asOwner, "approve", token.carol, 20n);
    expect(await token.call(token.asOwner, "allowance", token.owner, token.bob)).toBe(10n);
    expect(await token.call(token.asOwner, "allowance", token.owner, token.carol)).toBe(20n);
  });

  it("transferFrom spends allowance and updates both balances", async () => {
    const token = await TokenSimulator.create();
    await token.call(token.asOwner, "approve", token.bob, 300n);
    expect(await token.call(token.asBob, "transferFrom", token.owner, token.carol, 125n)).toBe(
      true,
    );
    expect(token.ledger()._balances.lookup(token.owner)).toBe(875n);
    expect(token.ledger()._balances.lookup(token.carol)).toBe(125n);
    expect(await token.call(token.asOwner, "allowance", token.owner, token.bob)).toBe(175n);
  });

  it("transferFrom rejects insufficient allowance without changing balances", async () => {
    const token = await TokenSimulator.create();
    await token.call(token.asOwner, "approve", token.bob, 50n);
    await token.rejects(
      token.asBob,
      "transferFrom",
      [token.owner, token.carol, 51n],
      /insufficient allowance/,
    );
    expect(token.ledger()._balances.lookup(token.owner)).toBe(1_000n);
    expect(await token.call(token.asOwner, "allowance", token.owner, token.bob)).toBe(50n);
  });

  it("transferFrom failures roll back a previously spent allowance", async () => {
    const token = await TokenSimulator.create();
    await token.call(token.asOwner, "approve", token.bob, 200n);
    await token.call(token.asOwner, "transfer", token.carol, 900n);
    await token.rejects(
      token.asBob,
      "transferFrom",
      [token.owner, token.carol, 200n],
      /insufficient balance/,
    );
    expect(await token.call(token.asOwner, "allowance", token.owner, token.bob)).toBe(200n);

    await token.rejects(
      token.asBob,
      "transferFrom",
      [token.owner, user(new Uint8Array(32)), 1n],
      /invalid receiver/,
    );
    expect(await token.call(token.asOwner, "allowance", token.owner, token.bob)).toBe(200n);
  });

  it("allows a zero-value transferFrom without an allowance but still rejects zero sender", async () => {
    const token = await TokenSimulator.create();
    expect(await token.call(token.asBob, "transferFrom", token.owner, token.carol, 0n)).toBe(true);
    expect(await token.call(token.asOwner, "allowance", token.owner, token.bob)).toBe(0n);
    await token.rejects(
      token.asBob,
      "transferFrom",
      [user(new Uint8Array(32)), token.carol, 0n],
      /invalid sender/,
    );
  });

  it("transferFrom preserves MAX_UINT128 infinite allowance", async () => {
    const token = await TokenSimulator.create();
    await token.call(token.asOwner, "approve", token.bob, MAX_UINT128);
    await token.call(token.asBob, "transferFrom", token.owner, token.carol, 10n);
    expect(await token.call(token.asOwner, "allowance", token.owner, token.bob)).toBe(MAX_UINT128);
  });

  it("canonicalizes inactive Either branches for balances and allowances", async () => {
    const token = await TokenSimulator.create();
    const noisyOwner = user(token.owner.left, new Uint8Array(32).fill(0xaa));
    const noisyBob = user(token.bob.left, new Uint8Array(32).fill(0xbb));
    expect(await token.call(token.asOwner, "balanceOf", noisyOwner)).toBe(1_000n);
    await token.call(token.asOwner, "transfer", noisyBob, 25n);
    await token.call(token.asOwner, "approve", noisyBob, 40n);
    expect(await token.call(token.asOwner, "balanceOf", token.bob)).toBe(25n);
    expect(await token.call(token.asOwner, "allowance", token.owner, token.bob)).toBe(40n);
  });

  it("allows only the owner to mint and rejects overflow/invalid targets", async () => {
    const token = await TokenSimulator.create(1n);
    await token.call(token.asOwner, "mint", token.bob, 50n);
    expect(token.ledger()._balances.lookup(token.bob)).toBe(50n);
    expect(token.ledger()._totalSupply).toBe(51n);

    await token.rejects(token.asBob, "mint", [token.bob, 1n], /caller is not the owner/);
    await token.rejects(token.asOwner, "mint", [token.bob, MAX_UINT128], /arithmetic overflow/);
    await token.rejects(
      token.asOwner,
      "mint",
      [user(new Uint8Array(32)), 1n],
      /invalid receiver/,
    );
    await token.rejects(
      token.asOwner,
      "mint",
      [contractAddress(new Uint8Array(32).fill(0x55)), 1n],
      /unsafe transfer/,
    );
  });

  it("owner-gates mintToEthAddress and stores the zero-left-padded identity", async () => {
    const token = await TokenSimulator.create(0n);
    const ethAddress = new Uint8Array(20).fill(0x42);
    const padded = new Uint8Array(32);
    padded.set(ethAddress, 12);

    await token.call(token.asOwner, "mintToEthAddress", ethAddress, 90n);
    expect(token.ledger()._balances.lookup(user(padded))).toBe(90n);
    await token.rejects(
      token.asBob,
      "mintToEthAddress",
      [ethAddress, 1n],
      /caller is not the owner/,
    );
    await token.rejects(
      token.asOwner,
      "mintToEthAddress",
      [new Uint8Array(20), 1n],
      /invalid receiver/,
    );
  });

  it("owner-gated _burn burns an arbitrary account and lowers supply", async () => {
    const token = await TokenSimulator.create();
    await token.call(token.asOwner, "mint", token.bob, 50n);
    await token.call(token.asOwner, "_burn", token.bob, 20n);
    expect(token.ledger()._balances.lookup(token.bob)).toBe(30n);
    expect(token.ledger()._totalSupply).toBe(1_030n);
  });

  it("_burn accepts zero value and canonicalizes the source", async () => {
    const token = await TokenSimulator.create();
    await token.call(token.asOwner, "mint", token.bob, 10n);
    const noisyBob = user(token.bob.left, new Uint8Array(32).fill(0xcc));
    await token.call(token.asOwner, "_burn", noisyBob, 0n);
    await token.call(token.asOwner, "_burn", noisyBob, 1n);
    expect(token.ledger()._balances.lookup(token.bob)).toBe(9n);
    expect(token.ledger()._totalSupply).toBe(1_009n);
  });

  it("_burn rejects non-owner, zero sender, and insufficient balance", async () => {
    const token = await TokenSimulator.create();
    await token.rejects(token.asBob, "_burn", [token.owner, 1n], /caller is not the owner/);
    await token.rejects(
      token.asOwner,
      "_burn",
      [user(new Uint8Array(32)), 1n],
      /invalid sender/,
    );
    await token.rejects(
      token.asOwner,
      "_burn",
      [token.bob, 1n],
      /insufficient balance/,
    );
    expect(token.ledger()._totalSupply).toBe(1_000n);
  });
});

describe("PLAN-04 §2 — retained legacy EthAuth seam (not G4.3)", () => {
  it("accepts a valid relayed transfer and rejects replay, wrong nonce, and signer mismatch", async () => {
    const token = await TokenSimulator.create(0n);
    const signerKey = new Uint8Array(32).fill(0x42);
    const from = ethereumAddress(signerKey);
    const to = new Uint8Array(20).fill(0xb0);

    await token.call(token.asOwner, "mintToEthAddress", from, 100n);
    const payload = legacyPayload(from, to, 60n, 0n);
    const signed = signLegacyPayload(payload, signerKey);
    await token.call(token.asCarol, "transferWithEthSig", payload, signed.sig, signed.pk);

    expect(token.ledger()._balances.lookup(ethAccount(from))).toBe(40n);
    expect(token.ledger()._balances.lookup(ethAccount(to))).toBe(60n);
    expect(token.ledger()._ethNonces.lookup(from)).toBe(1n);

    await token.rejects(
      token.asCarol,
      "transferWithEthSig",
      [payload, signed.sig, signed.pk],
      /digest already consumed/,
    );

    const wrongNonce = legacyPayload(from, to, 1n, 5n);
    const wrongNonceSig = signLegacyPayload(wrongNonce, signerKey);
    await token.rejects(
      token.asCarol,
      "transferWithEthSig",
      [wrongNonce, wrongNonceSig.sig, wrongNonceSig.pk],
      /wrong nonce/,
    );

    const wrongFrom = legacyPayload(to, from, 1n, 0n);
    const wrongFromSig = signLegacyPayload(wrongFrom, signerKey);
    await token.rejects(
      token.asCarol,
      "transferWithEthSig",
      [wrongFrom, wrongFromSig.sig, wrongFromSig.pk],
      /signer is not from/,
    );
  });
});
