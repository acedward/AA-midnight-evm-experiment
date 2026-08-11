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
import {
  OP_APPROVE,
  OP_TRANSFER,
  padEthAddress,
  signAccountPayload,
  type PayloadFields,
} from "../account-payload.ts";
import { CONTRACTS_ROOT, managedDirFor, readExportedCircuits } from "../compile.ts";
import { contractAddressBytes } from "../contract-ops.ts";
import { flipS } from "../secp256k1-vectors.ts";

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
  readonly txCount: bigint;
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
      ["--experimental-strip-types", "src/compile-cli.ts", "Account", NAME],
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

class TokenSimulator {
  private context: any;
  readonly addressBytes: Uint8Array;
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
    const address = dummyContractAddress();
    this.addressBytes = contractAddressBytes(String(address));
    this.context = createCircuitContext(
      "totalSupply",
      address,
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
      "accountTransfer",
      "allowance",
      "approve",
      "balanceOf",
      "decimals",
      "mint",
      "mintToAccountAddress",
      "name",
      "symbol",
      "totalSupply",
      "transfer",
      "transferFrom",
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

  it("owner-gates mintToAccountAddress and stores a right-arm balance", async () => {
    const token = await TokenSimulator.create(0n);
    const accountAddress = new Uint8Array(32).fill(0x42);
    const target = contractAddress(accountAddress);

    await token.call(token.asOwner, "mintToAccountAddress", accountAddress, 90n);
    expect(token.ledger()._balances.lookup(target)).toBe(90n);
    expect(token.ledger()._totalSupply).toBe(90n);
    await token.rejects(
      token.asBob,
      "mintToAccountAddress",
      [accountAddress, 1n],
      /caller is not the owner/,
    );
    await token.rejects(
      token.asOwner,
      "mintToAccountAddress",
      [new Uint8Array(32), 1n],
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

describe("G4.3 — frozen Account payload rejection matrix in TokenAA", () => {
  const SIGNER_PRIV = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
  const STRANGER_PRIV = "0000000000000000000000000000000000000000000000000000000000000abc";
  const ACCOUNT_REF = { bytes: new Uint8Array(32).fill(0xbb) };

  function fields(
    token: TokenSimulator,
    overrides: Partial<PayloadFields> = {},
  ): Omit<PayloadFields, "from"> {
    return {
      op: OP_TRANSFER,
      token: token.addressBytes,
      account: ACCOUNT_REF.bytes,
      to: padEthAddress(`0x${"cc".repeat(20)}`),
      nonce: 1n,
      amount: 500n,
      ...overrides,
    };
  }

  const callTransfer = (token: TokenSimulator, payload: Uint8Array, sig: unknown, pk: unknown) =>
    token.call(token.asCarol, "accountTransfer", ACCOUNT_REF, payload, sig, pk);

  it("rejects nonzero reserved bytes, a foreign domain, and a non-transfer op in order", async () => {
    const token = await TokenSimulator.create(0n);
    const valid = signAccountPayload(SIGNER_PRIV, fields(token));

    const reserved = Uint8Array.from(valid.payload);
    reserved[174] = 1;
    await expect(callTransfer(token, reserved, valid.sig, valid.pk)).rejects.toThrow(
      /nonzero reserved bytes/,
    );

    const domain = Uint8Array.from(valid.payload);
    domain[0]! ^= 0xff;
    await expect(callTransfer(token, domain, valid.sig, valid.pk)).rejects.toThrow(
      /wrong domain tag/,
    );

    const approve = signAccountPayload(SIGNER_PRIV, fields(token, { op: OP_APPROVE }));
    await expect(callTransfer(token, approve.payload, approve.sig, approve.pk)).rejects.toThrow(
      /wrong op selector/,
    );
    expect(token.ledger().txCount).toBe(0n);
  });

  it("rejects a payload bound to another TokenAA instance before signature work", async () => {
    const token = await TokenSimulator.create(0n);
    const foreign = signAccountPayload(SIGNER_PRIV, {
      ...fields(token),
      token: new Uint8Array(32).fill(0xee),
    });
    await expect(callTransfer(token, foreign.payload, foreign.sig, foreign.pk)).rejects.toThrow(
      /wrong token/,
    );
  });

  it("rejects garbage signatures and every tampered signed field", async () => {
    const token = await TokenSimulator.create(0n);
    const valid = signAccountPayload(SIGNER_PRIV, fields(token));
    await expect(
      callTransfer(token, valid.payload, { r: valid.sig.r, s: valid.sig.s ^ 1n }, valid.pk),
    ).rejects.toThrow(/signature does not verify/);

    for (const at of [100, 120, 152, 160]) {
      const tampered = Uint8Array.from(valid.payload);
      tampered[at]! ^= 1;
      await expect(callTransfer(token, tampered, valid.sig, valid.pk)).rejects.toThrow(
        /signature does not verify/,
      );
    }
  });

  it("binds the supplied public key to payload.from", async () => {
    const token = await TokenSimulator.create(0n);
    const owner = signAccountPayload(SIGNER_PRIV, fields(token));
    const stranger = signAccountPayload(STRANGER_PRIV, {
      ...fields(token),
      from: owner.fields.from,
    });
    await expect(
      callTransfer(token, stranger.payload, stranger.sig, stranger.pk),
    ).rejects.toThrow(/signer is not from/);
  });

  it("accepts the flipped-s twin through every pre-hop check; replay is digest-owned", async () => {
    const token = await TokenSimulator.create(0n);
    const valid = signAccountPayload(SIGNER_PRIV, fields(token));
    let message = "";
    try {
      await callTransfer(token, valid.payload, flipS(valid.sig), valid.pk);
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toMatch(
      /signature does not verify|wrong token|wrong domain|wrong op|reserved|signer is not from/,
    );
    expect(token.ledger().txCount).toBe(0n);
  });
});
