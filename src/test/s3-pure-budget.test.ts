// PLAN-02 spike S3 — are exported PURE circuits free of the verifier-key budget?
//
// A contract may ship at most ~7 verifier keys before its deploy transaction
// exceeds the block-size limit (PLAN-00 §7). PLAN-03 wants a family of exported
// pure "digest oracle" circuits so the TS payload builder can be checked against
// the contract's own encoding — the encoding-drift guard this plan requires. If
// each oracle burned a budget slot, the Account contract would have to ration
// them against its real entry points.
//
// `contracts/S3PureBudget.compact` is deliberately over budget on paper: ten
// exported circuits, eight of them pure. The evidence is in three layers —
// what compactc emits, what the bindings expose, and whether the thing actually
// deploys.

import { beforeAll, describe, expect, it } from "vitest";

import * as fs from "node:fs";
import * as path from "node:path";

import { keccak_256 } from "@noble/hashes/sha3.js";

import { bindCompiledContract, loadCompiledModule } from "../compiled.ts";
import { CONTRACTS_ROOT, compileContract } from "../compile.ts";
import { contractByName } from "../contracts.ts";
import { callCircuit, deployFresh } from "../contract-ops.ts";
import { recordDeployment } from "../deployments.ts";
import { ROLE_SEEDS } from "../genesis-seeds.ts";
import { bytesToHex, hexToBytes } from "../hex.ts";
import { createProviders } from "../providers.ts";
import { loadAddressVectors, signKeccakPayload } from "../secp256k1-vectors.ts";
import { timed } from "../timings.ts";
import { createWallet, syncWallet, type WalletCtx } from "../wallet.ts";

const MANAGED_NAME = "S3PureBudget";

/** The names in `export circuit <name>(` — pure and provable alike. */
function exportedCircuitNames(source: string): string[] {
  const text = fs.readFileSync(path.join(CONTRACTS_ROOT, source), "utf-8");
  return [...text.matchAll(/^export circuit (\w+)/gm)].map((m) => m[1]!);
}

interface PureCircuits {
  digestOf(value: Uint8Array): Uint8Array;
  digestOf64(value: Uint8Array): Uint8Array;
  addressOf(pk: { x: bigint; y: bigint; identity: boolean }): Uint8Array;
  verifyOf(
    digest: Uint8Array,
    sig: { r: bigint; s: bigint },
    pk: { x: bigint; y: bigint; identity: boolean },
  ): boolean;
  reverse32(value: Uint8Array): Uint8Array;
  padAddress(addr: Uint8Array): Uint8Array;
}

let alice: WalletCtx;
let managedDir: string;
let pure: PureCircuits;
let expectedVk: Record<string, string>;

beforeAll(async () => {
  managedDir = compileContract(contractByName(MANAGED_NAME)).managedDir;
  const loaded = await loadCompiledModule(managedDir);
  const mod = loaded.module as unknown as {
    pureCircuits: PureCircuits;
    expectedVk: Record<string, string>;
  };
  pure = mod.pureCircuits;
  expectedVk = mod.expectedVk;

  alice = await createWallet("alice", ROLE_SEEDS.alice);
  await syncWallet(alice);
}, 900_000);

describe("S3 — pure circuits and the verifier-key deploy budget", () => {
  it("exports 10 circuits but emits only the 2 provable verifier keys", () => {
    const exported = exportedCircuitNames("S3PureBudget.compact");
    expect(exported).toHaveLength(10);

    // compile.ts derives "exported circuits" from the emitted .verifier files —
    // which is the number that actually matters, and it counts 2.
    const keys = fs.readdirSync(path.join(managedDir, "keys")).sort();
    expect(keys).toEqual([
      "store.prover",
      "store.verifier",
      "storeVerified.prover",
      "storeVerified.verifier",
    ]);

    // No zkir either: the eight pure circuits are never lowered to a proof
    // circuit at all, so they cost nothing at proving time either.
    const zkir = fs.readdirSync(path.join(managedDir, "zkir")).sort();
    expect(zkir).toEqual(["store.bzkir", "store.zkir", "storeVerified.bzkir", "storeVerified.zkir"]);

    // expectedVk is what a CCC caller binds against — also only the provable two.
    expect(Object.keys(expectedVk).sort()).toEqual(["store", "storeVerified"]);
  });

  it("exposes the 8 pure circuits as synchronous off-chain functions", () => {
    // No context, no provider, no chain: a pure circuit is computed by the
    // Compact JS runtime. That is what makes it a viable oracle for the layer-1
    // fast loop the test strategy is built on.
    for (const name of [
      "digestOf",
      "digestOf64",
      "digestOf128",
      "addressOf",
      "verifyOf",
      "reverse32",
      "padAddress",
      "pointXBigEndian",
    ]) {
      expect(typeof (pure as unknown as Record<string, unknown>)[name], name).toBe("function");
    }
  });

  it("the oracles agree with noble — the encoding-drift guard in miniature", () => {
    // This is the mechanism PLAN-03's payload spec is protected by: the contract
    // computes the digest one way, TS computes it another, and a test says they
    // are the same bytes.
    const value = Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 3) & 0xff);
    expect(bytesToHex(pure.digestOf(value))).toBe(bytesToHex(keccak_256(value)));

    const wide = Uint8Array.from({ length: 64 }, (_, i) => (i * 5 + 1) & 0xff);
    expect(bytesToHex(pure.digestOf64(wide))).toBe(bytesToHex(keccak_256(wide)));

    // Identity: the in-circuit derivation against the ethereum/tests KATs.
    for (const vector of loadAddressVectors()) {
      expect(`0x${bytesToHex(pure.addressOf(vector.point))}`, `seed=${vector.seed}`).toBe(
        vector.ethAddr,
      );
    }

    // Verification, both verdicts.
    const signed = signKeccakPayload(
      "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
      value,
    );
    expect(pure.verifyOf(signed.digest, signed.sig, signed.pk)).toBe(true);
    expect(pure.verifyOf(signed.digest, { r: signed.sig.r, s: signed.sig.s ^ 1n }, signed.pk)).toBe(
      false,
    );

    // The endianness trap, stated as a test rather than a comment.
    const ascending = Uint8Array.from({ length: 32 }, (_, i) => i);
    expect([...pure.reverse32(ascending)]).toEqual([...ascending].reverse());

    // OZ's left-arm key shape: 20-byte address, zero-padded to 32 on the LEFT.
    const addr = hexToBytes(signed.ethAddr);
    const padded = pure.padAddress(addr);
    expect(padded).toHaveLength(32);
    expect([...padded.slice(0, 12)]).toEqual(new Array(12).fill(0));
    expect(bytesToHex(padded.slice(12))).toBe(bytesToHex(addr));
  });

  it("DEPLOYS — the ten-circuit contract fits in a deploy transaction", async () => {
    // The budget is a deploy-transaction block-size limit, so the only complete
    // answer is a deploy that lands.
    const providers = await createProviders(alice, managedDir, MANAGED_NAME);
    const loaded = await loadCompiledModule(managedDir);
    const handle = bindCompiledContract(MANAGED_NAME, loaded, { vacantWitnesses: true });
    const deployed = await deployFresh(providers, handle, MANAGED_NAME, []);
    recordDeployment({
      name: MANAGED_NAME,
      contractAddress: deployed.contractAddress,
      txHash: deployed.txHash,
      txId: deployed.txId,
      note: "PLAN-02 S3 — 10 exported circuits (8 pure), 2 verifier keys",
    });
    expect(deployed.contractAddress).toMatch(/^[0-9a-f]{64}$/);

    // And it still proves: the pure circuits neither block nor slow the real one.
    const signed = signKeccakPayload(
      "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
      new Uint8Array(32).fill(0x7f),
    );
    const { result: call } = await timed(
      {
        contract: MANAGED_NAME,
        circuit: "storeVerified",
        note: "S3 — provable call on a contract carrying 8 pure circuits",
      },
      () =>
        callCircuit(deployed.deployed, "storeVerified", [signed.payload, signed.sig, signed.pk]),
    );
    expect(`0x${bytesToHex(call.result as Uint8Array)}`).toBe(signed.ethAddr);
  });
});
