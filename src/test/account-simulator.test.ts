// PLAN-03 gate G3.2 — the rejection matrix at layer 2 (simulator pattern).
//
// The 0.18-native driver (PLAN-04 §Test strategy): compiled artifacts run
// directly through `createConstructorContext` / `createCircuitContext`, no
// chain, no proof server, milliseconds per case. PLAN-04's TokenAA suite
// (G4.3) shares these cases against the OZ fork.
//
// What runs here and what cannot:
//   - Account.validate is a single-contract circuit — the whole matrix slice
//     that targets it (R4, R6, R2-via-digest) runs at this layer.
//   - MiniTokenAA.accountTransfer's checks 1–7 all fire BEFORE the CCC hop,
//     so every structural/crypto rejection (R3, R5, R8-shape, R10, R11,
//     reserved bytes, from-bind) is exercised here with the REAL frozen
//     payload. The hop itself and everything after it (account bind R9,
//     balance movement, griefing R14) need a second deployed contract and are
//     layer 3 — src/test/account-live.test.ts (G3.3–G3.6).
//
// In the simulator, kernel.self() is the context's contract address
// (dummyContractAddress), so payloads that must PASS the token bind are built
// against exactly that address; the wrong-token case uses any other bytes.

import { beforeAll, describe, expect, it } from "vitest";

import {
  createCircuitContext,
  createConstructorContext,
  dummyContractAddress,
  type ContractState,
} from "@midnight-ntwrk/compact-runtime";

import {
  OP_APPROVE,
  OP_TRANSFER,
  buildPayload,
  eip191Digest,
  ethAddressOfPriv,
  padEthAddress,
  signAccountPayload,
  type PayloadFields,
} from "../account-payload.ts";
import { loadCompiledModule, type LoadedCompiledModule } from "../compiled.ts";
import { compileContract } from "../compile.ts";
import { contractByName } from "../contracts.ts";
import { contractAddressBytes } from "../contract-ops.ts";
import { bytesToHex, hexToBytes } from "../hex.ts";
import { flipS } from "../secp256k1-vectors.ts";

const OWNER_PRIV = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const STRANGER_PRIV = "0000000000000000000000000000000000000000000000000000000000000abc";

let accountModule: LoadedCompiledModule;
let tokenModule: LoadedCompiledModule;

beforeAll(async () => {
  accountModule = await loadCompiledModule(compileContract(contractByName("Account")).managedDir);
  tokenModule = await loadCompiledModule(compileContract(contractByName("MiniTokenAA")).managedDir);
}, 900_000);

/** Fresh single-contract simulator state for a compiled module. */
async function simulate(
  loaded: LoadedCompiledModule,
  constructorArgs: readonly unknown[],
  firstCircuit: string,
) {
  const mod = loaded.module as unknown as {
    Contract: new (witnesses: Record<string, unknown>) => {
      initialState(ctx: unknown, ...args: unknown[]): Promise<{
        currentContractState: ContractState;
        currentPrivateState: unknown;
        currentZswapLocalState: { coinPublicKey: string };
      }>;
      circuits: Record<
        string,
        (ctx: unknown, ...args: unknown[]) => Promise<{ result: unknown; context: unknown }>
      >;
    };
    ledger(state: unknown): Record<string, any>;
  };
  const contract = new mod.Contract({});
  const initial = await contract.initialState(
    createConstructorContext({}, "0".repeat(64)),
    ...constructorArgs,
  );
  const context = createCircuitContext(
    firstCircuit,
    dummyContractAddress(),
    initial.currentZswapLocalState.coinPublicKey,
    initial.currentContractState,
    initial.currentPrivateState,
  );
  return { contract, context, ledger: mod.ledger };
}

type SimContext = { callContext: { circuitId: string; currentQueryContext: { state: unknown } } };

/** The simulator's own contract identity — what kernel.self() returns here. */
const SELF_BYTES = contractAddressBytes(String(dummyContractAddress()));

const OWNER_ADDR = hexToBytes(ethAddressOfPriv(OWNER_PRIV));

/** Payload fields that pass every structural check in the simulator. */
function passingFields(overrides: Partial<PayloadFields> = {}): Omit<PayloadFields, "from"> {
  return {
    op: OP_TRANSFER,
    token: SELF_BYTES,
    account: new Uint8Array(32).fill(0xbb), // never reached pre-hop
    to: padEthAddress(`0x${"cc".repeat(20)}`),
    nonce: 1n,
    amount: 500n,
    ...overrides,
  };
}

describe("G3.2 layer 2 — Account.validate (the callee, alone)", () => {
  const digestA = new Uint8Array(32).fill(0x11);
  const digestB = new Uint8Array(32).fill(0x22);

  it("binds signer→owner, consumes the digest, and attests kernel.self()", async () => {
    const sim = await simulate(accountModule, [OWNER_ADDR], "validate");
    const call = await sim.contract.circuits.validate!(sim.context, OWNER_ADDR, digestA);

    // The returned address is the contract's OWN identity — the value the
    // token root keys balances on (design rule 1).
    expect(bytesToHex((call.result as { bytes: Uint8Array }).bytes)).toBe(bytesToHex(SELF_BYTES));

    const ctx = call.context as SimContext;
    const ledger = sim.ledger(ctx.callContext.currentQueryContext.state);
    expect(ledger.consumedDigests.member(digestA)).toBe(true);
    expect(ledger.validateCount).toBe(1n);
    expect(bytesToHex(ledger.owner)).toBe(bytesToHex(OWNER_ADDR));
  });

  it("R6 — a consumed digest is refused on the second call", async () => {
    const sim = await simulate(accountModule, [OWNER_ADDR], "validate");
    const first = await sim.contract.circuits.validate!(sim.context, OWNER_ADDR, digestA);
    const ctx = first.context as SimContext;
    ctx.callContext.circuitId = "validate";
    await expect(sim.contract.circuits.validate!(ctx, OWNER_ADDR, digestA)).rejects.toThrow(
      /digest already consumed/,
    );
    // A different digest still passes — the set burned one entry, not the account.
    ctx.callContext.circuitId = "validate";
    await sim.contract.circuits.validate!(ctx, OWNER_ADDR, digestB);
  });

  it("R4 — a signer that is not the owner is refused, whatever the digest", async () => {
    const sim = await simulate(accountModule, [OWNER_ADDR], "validate");
    const stranger = hexToBytes(ethAddressOfPriv(STRANGER_PRIV));
    await expect(sim.contract.circuits.validate!(sim.context, stranger, digestA)).rejects.toThrow(
      /signer is not the account owner/,
    );
  });
});

describe("G3.2 layer 2 — MiniTokenAA.accountTransfer pre-hop checks (real frozen payload)", () => {
  // A dummy account handle: the rejects under test all abort BEFORE the hop,
  // so the reference is never dereferenced.
  const ACCOUNT_REF = { bytes: new Uint8Array(32).fill(0xbb) };

  async function callTransfer(payload: Uint8Array, sig: unknown, pk: unknown) {
    const sim = await simulate(tokenModule, [], "accountTransfer");
    return sim.contract.circuits.accountTransfer!(sim.context, ACCOUNT_REF, payload, sig, pk);
  }

  /** Sign fields with the owner key — valid crypto, so later checks are reached. */
  function signedPassing(overrides: Partial<PayloadFields> = {}) {
    return signAccountPayload(OWNER_PRIV, passingFields(overrides));
  }

  it("reserved bytes — a nonzero reserved byte is refused before anything else", async () => {
    const s = signedPassing();
    const tampered = Uint8Array.from(s.payload);
    tampered[174] = 0x01;
    await expect(callTransfer(tampered, s.sig, s.pk)).rejects.toThrow(/nonzero reserved bytes/);
  });

  it("R11 — a foreign domain tag (other chain/version) is refused", async () => {
    const s = signedPassing();
    const tampered = Uint8Array.from(s.payload);
    tampered[0]! ^= 0xff;
    await expect(callTransfer(tampered, s.sig, s.pk)).rejects.toThrow(/wrong domain tag/);
  });

  it("R10 — an APPROVE-op signature is refused on the transfer path", async () => {
    const s = signedPassing({ op: OP_APPROVE });
    await expect(callTransfer(s.payload, s.sig, s.pk)).rejects.toThrow(/wrong op selector/);
  });

  it("R8 (shape) — a payload bound to a DIFFERENT token address is refused", async () => {
    const s = signedPassing({ token: new Uint8Array(32).fill(0xee) });
    await expect(callTransfer(s.payload, s.sig, s.pk)).rejects.toThrow(/wrong token/);
  });

  it("R3 — a garbage signature is refused by the in-circuit verifier", async () => {
    const s = signedPassing();
    await expect(
      callTransfer(s.payload, { r: s.sig.r, s: s.sig.s ^ 1n }, s.pk),
    ).rejects.toThrow(/signature does not verify/);
  });

  it("R5 — tampering a signed field in transit invalidates the signature in-circuit", async () => {
    // Tamper fields that survive the structural checks (they sit after the
    // token bind in the check order), so the failure is the DIGEST mismatch.
    const s = signedPassing();
    for (const at of [100 /* from */, 120 /* to */, 152 /* nonce */, 160 /* amount */]) {
      const tampered = Uint8Array.from(s.payload);
      tampered[at]! ^= 0x01;
      await expect(callTransfer(tampered, s.sig, s.pk)).rejects.toThrow(
        /signature does not verify/,
      );
    }
  });

  it("R2 — the flipped-s twin passes the verifier; the DIGEST is what stays stable", async () => {
    // Malleability at layer 2: (r, n−s) must sail PAST every pre-hop check —
    // the failure, when it comes, is the un-simulatable hop against the dummy
    // reference, never a crypto/structural rejection. Replay keyed on
    // signature bytes would treat the twin as a fresh authorization; the
    // digest set does not, because the digest is unchanged.
    const s = signedPassing();
    expect(bytesToHex(eip191Digest(s.payload))).toBe(bytesToHex(s.digest));
    let message = "";
    try {
      await callTransfer(s.payload, flipS(s.sig), s.pk);
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toMatch(
      /signature does not verify|wrong|reserved|signer is not from/,
    );
  });

  it("from-bind — a valid signature whose key is not `from` is refused", async () => {
    // Signed by the stranger over a payload claiming from=owner: the signature
    // verifies, the address bind kills it (the check that makes an untrusted
    // pk argument sound).
    const s = signAccountPayload(STRANGER_PRIV, { ...passingFields(), from: OWNER_ADDR });
    await expect(callTransfer(s.payload, s.sig, s.pk)).rejects.toThrow(/signer is not from/);
  });

  it("mint — the right-arm ContractAddress balance key works standalone", async () => {
    const sim = await simulate(tokenModule, [], "mint");
    const accountAddr = new Uint8Array(32).fill(0xbb);
    const call = await sim.contract.circuits.mint!(sim.context, accountAddr, 1_000n);
    const ctx = call.context as SimContext;
    const ledger = sim.ledger(ctx.callContext.currentQueryContext.state);
    const entries = [...ledger.balances] as Array<
      readonly [{ is_left: boolean; right: { bytes: Uint8Array } }, bigint]
    >;
    expect(entries).toHaveLength(1);
    const [key, value] = entries[0]!;
    expect(key.is_left).toBe(false);
    expect(bytesToHex(key.right.bytes)).toBe(bytesToHex(accountAddr));
    expect(value).toBe(1_000n);
  });
});
