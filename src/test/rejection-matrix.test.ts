// PLAN-02 §Test strategy — layer 1, and the matrix's own integrity check.
//
// Two jobs in one suite.
//
// 1. **Keep the matrix honest.** `src/rejection-matrix.ts` is the specification;
//    a table that claims coverage it does not have is worse than no table. Every
//    case marked covered must name a test that exists, verbatim, in a file that
//    exists. Every uncovered case must name the plan that will close it.
//
// 2. **Run every case whose subject already exists**, at layer 1 — pure circuits
//    plus noble, no chain, no proof server, a few hundred milliseconds. R2, R3,
//    R12 and R15 need only a verifier, which `S3PureBudget`'s pure oracles give
//    us; the rest need PLAN-03's payload or PLAN-04's token and are asserted at
//    layers 2/3 by those plans.
//
// The oracles here are the same mechanism PLAN-03's encoding-drift guard uses:
// the contract computes a digest one way, TypeScript computes it another, and a
// test says they are the same bytes.

import { beforeAll, describe, expect, it } from "vitest";

import * as fs from "node:fs";
import * as path from "node:path";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

import { loadCompiledModule } from "../compiled.ts";
import { compileContract } from "../compile.ts";
import { contractByName } from "../contracts.ts";
import { bytesToHex } from "../hex.ts";
import { REJECTION_MATRIX, pendingCases } from "../rejection-matrix.ts";
import {
  SECP256K1_N,
  flipS,
  loadWycheproofCases,
  signKeccakPayload,
  type AffinePoint,
  type EcdsaScalars,
} from "../secp256k1-vectors.ts";
import { REPO_ROOT } from "../stack-env.ts";

interface PureCircuits {
  digestOf(value: Uint8Array): Uint8Array;
  digestOf64(value: Uint8Array): Uint8Array;
  digestOf128(value: Uint8Array): Uint8Array;
  addressOf(pk: AffinePoint): Uint8Array;
  verifyOf(digest: Uint8Array, sig: EcdsaScalars, pk: AffinePoint): boolean;
}

let pure: PureCircuits;

beforeAll(async () => {
  // The oracles live on the S3 fixture; PLAN-03's Account will export its own.
  const { managedDir } = compileContract(contractByName("S3PureBudget"));
  const loaded = await loadCompiledModule(managedDir);
  pure = (loaded.module as unknown as { pureCircuits: PureCircuits }).pureCircuits;
}, 600_000);

const SPIKE_PRIV = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";

/**
 * The reference verdict, held to the SAME rule as the circuit.
 *
 * `lowS: false` because the primitive under test enforces no low-s policy — with
 * the default, every malleable-but-valid vector would read as a disagreement
 * (see R2). Out-of-range scalars throw here too; a throw is a rejection.
 */
function nobleVerify(sig: EcdsaScalars, digest: Uint8Array, pk: AffinePoint): boolean {
  try {
    // Compact 64-byte (r‖s), big-endian. A scalar too large to fit 32 bytes
    // throws here, which is the correct verdict for those corpus entries.
    const compact = new Uint8Array(64);
    compact.set(scalarTo32(sig.r), 0);
    compact.set(scalarTo32(sig.s), 32);
    return secp256k1.verify(compact, digest, secp256k1.Point.fromAffine(pk).toBytes(false), {
      lowS: false,
      prehash: false,
    });
  } catch {
    return false;
  }
}

function scalarTo32(value: bigint): Uint8Array {
  const hex = value.toString(16);
  if (value < 0n || hex.length > 64) throw new RangeError("scalar does not fit in 32 bytes");
  return Uint8Array.from(
    hex.padStart(64, "0").match(/../g)!.map((byte) => parseInt(byte, 16)),
  );
}

/**
 * Run the in-circuit verifier, mapping an argument-boundary rejection to `false`.
 *
 * Out-of-range scalars (0, or ≥ n) are refused by the `Secp256k1Scalar`
 * conversion before the circuit body runs. For this comparison a throw and a
 * `false` are the same verdict — "this signature is not valid" — and collapsing
 * them is what lets the corpus be driven end to end rather than pre-filtered.
 */
function verifyOrReject(digest: Uint8Array, sig: EcdsaScalars, pk: AffinePoint): boolean {
  try {
    return pure.verifyOf(digest, sig, pk);
  } catch {
    return false;
  }
}

describe("the rejection matrix is an honest description of what is tested", () => {
  it("has all 15 cases, uniquely numbered", () => {
    expect(REJECTION_MATRIX).toHaveLength(15);
    const ids = REJECTION_MATRIX.map((c) => c.id);
    expect(new Set(ids).size).toBe(15);
    expect(ids).toEqual(Array.from({ length: 15 }, (_, i) => `R${i + 1}`));
  });

  it("every claimed coverage points at a test that actually exists", () => {
    for (const rejection of REJECTION_MATRIX) {
      for (const covered of rejection.covered) {
        const file = path.join(REPO_ROOT, covered.file);
        expect(fs.existsSync(file), `${rejection.id}: no such file ${covered.file}`).toBe(true);
        const source = fs.readFileSync(file, "utf-8");
        expect(
          source.includes(covered.test),
          `${rejection.id}: ${covered.file} has no test titled "${covered.test}"`,
        ).toBe(true);
      }
    }
  });

  it("every uncovered case names the plan that will close it", () => {
    for (const rejection of pendingCases()) {
      expect(rejection.blockedBy, `${rejection.id} is uncovered and unassigned`).toBeTruthy();
      expect(rejection.gate).toMatch(/^G2\.\d$/);
    }
    // Visible in the run, so the hole is impossible to forget.
    console.log(
      `      ${pendingCases().length} of 15 cases await their subject:\n` +
        pendingCases()
          .map((c) => `        ${c.id} ${c.title} — ${c.blockedBy}`)
          .join("\n"),
    );
  });
});

describe("layer 1 — the cases whose subject already exists", () => {
  it("R15 — the in-circuit verifier agrees with noble", () => {
    const cases = loadWycheproofCases();
    expect(cases.length).toBeGreaterThan(400);

    const driven = cases.filter((c) => c.sig !== undefined);
    const disagreements: string[] = [];
    let agreedValid = 0;
    let agreedInvalid = 0;

    for (const c of driven) {
      const circuit = verifyOrReject(c.e, c.sig!, c.pk);
      // `lowS: false` because the primitive under test has no low-s rule — the
      // reference has to be held to the same rule, or every malleable-but-valid
      // vector reads as a disagreement (see R2).
      const noble = nobleVerify(c.sig!, c.e, c.pk);

      if (circuit !== noble) {
        disagreements.push(
          `tcId ${c.tcId} (${c.comment}) [${c.flags.join(",")}]: circuit=${circuit} noble=${noble}`,
        );
      } else if (circuit) {
        agreedValid += 1;
      } else {
        agreedInvalid += 1;
      }
    }

    console.log(
      `      Wycheproof: ${driven.length} of ${cases.length} cases driven ` +
        `(${cases.length - driven.length} skipped — non-canonical DER, which the circuit ` +
        `never sees); ${agreedValid} agreed valid, ${agreedInvalid} agreed invalid`,
    );
    expect(disagreements, disagreements.slice(0, 10).join("\n")).toEqual([]);
    // A verifier that rejects everything would also produce zero disagreements
    // on the invalid cases alone; the corpus has to exercise both verdicts.
    expect(agreedValid).toBeGreaterThan(0);
    expect(agreedInvalid).toBeGreaterThan(0);
  });

  it("R15b — the corpus's own verdicts are matched, with ONE deliberate carve-out", () => {
    // Independent of the reference implementation: for every DER-canonical case,
    // Wycheproof's own expected result must be what the circuit says.
    //
    // One class is carved out, structurally rather than by tcId. This corpus is
    // the *bitcoin* variant, so it applies Bitcoin's low-s policy and marks a
    // mathematically valid high-s signature `invalid`. `secp256k1EcdsaVerify`
    // implements no such policy, deliberately (PLAN-00 §3.3: replay protection
    // keys on the digest precisely because malleability is not prevented). A
    // carve-out only counts if the signature really is high-s AND the circuit
    // really accepts it — anything else is a genuine mismatch.
    const halfN = SECP256K1_N / 2n;
    const mismatches: string[] = [];
    const lowSCarveOuts: number[] = [];

    for (const c of loadWycheproofCases()) {
      if (c.sig === undefined) continue;
      const circuit = verifyOrReject(c.e, c.sig, c.pk);
      if (circuit === c.expectedValid) continue;
      if (!c.expectedValid && circuit && c.sig.s > halfN) {
        lowSCarveOuts.push(c.tcId);
        continue;
      }
      mismatches.push(
        `tcId ${c.tcId} (${c.comment}) [${c.flags.join(",")}]: circuit=${circuit} expected=${c.expectedValid}`,
      );
    }

    console.log(
      `      Wycheproof verdicts matched; ${lowSCarveOuts.length} low-s policy carve-out(s): ` +
        `tcId ${lowSCarveOuts.join(", ")}`,
    );
    expect(mismatches, mismatches.slice(0, 10).join("\n")).toEqual([]);
    // The carve-out must stay a handful of known cases, not a growing escape
    // hatch that quietly absorbs real disagreements.
    expect(lowSCarveOuts.length).toBeLessThanOrEqual(2);
  });

  it("R2 — malleability is real at layer 1", () => {
    // The fact the whole replay design rests on, asserted where it is cheapest.
    const signed = signKeccakPayload(SPIKE_PRIV, new Uint8Array(32).fill(0x2a));
    const twin = flipS(signed.sig);

    expect(pure.verifyOf(signed.digest, signed.sig, signed.pk)).toBe(true);
    expect(pure.verifyOf(signed.digest, twin, signed.pk)).toBe(true);
    expect(twin.s).not.toBe(signed.sig.s);
    expect(twin.s + signed.sig.s).toBe(SECP256K1_N);
    // Same digest, two signatures: replay protection must key on the left side.
    expect(bytesToHex(signed.digest)).toBe(bytesToHex(keccak_256(signed.payload)));
  });

  it("R3 — a mutated signature is rejected at layer 1", () => {
    const signed = signKeccakPayload(SPIKE_PRIV, new Uint8Array(32).fill(0x2b));
    expect(verifyOrReject(signed.digest, { r: signed.sig.r, s: signed.sig.s ^ 1n }, signed.pk)).toBe(
      false,
    );
    expect(verifyOrReject(signed.digest, { r: signed.sig.r ^ 1n, s: signed.sig.s }, signed.pk)).toBe(
      false,
    );
    // A different message under the same signature — the tamper R5 generalizes.
    const other = keccak_256(new Uint8Array(32).fill(0x2c));
    expect(verifyOrReject(other, signed.sig, signed.pk)).toBe(false);
  });

  it("R12 — the identity point is refused", () => {
    const signed = signKeccakPayload(SPIKE_PRIV, new Uint8Array(32).fill(0x2d));
    const identity: AffinePoint = { x: 0n, y: 0n, identity: true };
    expect(verifyOrReject(signed.digest, signed.sig, identity)).toBe(false);
    // And a zero point that does not declare itself the identity is refused too.
    expect(verifyOrReject(signed.digest, signed.sig, { x: 0n, y: 0n, identity: false })).toBe(false);
  });
});

describe("encoding-drift guards", () => {
  it("the in-circuit digest equals the TypeScript one for random values", () => {
    // The property test PLAN-02 asks for, over the oracles that exist today.
    // PLAN-03 swaps `digestOf` for the real MIDNIGHT_ACCOUNT_V1 builder and the
    // shape of this test does not change.
    for (let i = 0; i < 64; i += 1) {
      const width = [32, 64, 128][i % 3]!;
      const value = Uint8Array.from({ length: width }, (_, j) => (i * 31 + j * 7) & 0xff);
      const inCircuit =
        width === 32
          ? pure.digestOf(value)
          : width === 64
            ? pure.digestOf64(value)
            : pure.digestOf128(value);
      expect(bytesToHex(inCircuit), `width=${width} i=${i}`).toBe(bytesToHex(keccak_256(value)));
    }
  });

  it("address derivation agrees with keccak(x_be‖y_be)[12:] for random keys", () => {
    for (let i = 1; i <= 16; i += 1) {
      const priv = new Uint8Array(32);
      priv[31] = i;
      priv[0] = i * 3;
      const uncompressed = secp256k1.getPublicKey(priv, false);
      const expected = keccak_256(uncompressed.slice(1)).slice(12);
      const point: AffinePoint = {
        x: BigInt(`0x${bytesToHex(uncompressed.slice(1, 33))}`),
        y: BigInt(`0x${bytesToHex(uncompressed.slice(33, 65))}`),
        identity: false,
      };
      expect(bytesToHex(pure.addressOf(point))).toBe(bytesToHex(expected));
    }
  });
});
