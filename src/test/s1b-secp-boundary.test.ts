// PLAN-02 spike S1b — can secp256k1 types cross the cross-contract boundary?
//
// PLAN-00 §4 design rule 2 keeps the CCC boundary Bytes-only and all ECDSA work
// in the token root. The rule has a cost: the account cannot re-verify the
// signature for itself, so it trusts the root to have done it — the caveat in
// PLAN-03 §3. S1b asks whether the rule can be dropped.
//
// It cannot. A cross-contract call argument is desugared into a
// `transientCommit`, and the zkir backend has no native representation for secp
// atoms, so compiling the CALLER panics:
//
//   cannot convert Secp256k1Scalar to "Native"      (signature)
//   cannot convert Secp256k1Point  to "Native"      (public key)
//
// The callee compiles perfectly well — secp types are fine as ordinary exported
// circuit arguments. It is specifically carrying them ACROSS the boundary that
// has no lowering.
//
// This suite pins that. It is a NEGATIVE regression: if a future compiler adds
// the lowering, these expectations fail, and that failure is the signal that
// PLAN-03 §3's trust-the-root caveat can be removed.

import { describe, expect, it } from "vitest";

import { compileContract } from "../compile.ts";

describe("S1b — secp256k1 types across the CCC boundary", () => {
  it("a callee taking secp arguments compiles fine", () => {
    // Establishes that the failure below is about the boundary, not about secp
    // types in a circuit signature.
    const built = compileContract({
      source: "S1bSecpCallee.compact",
      managedName: "S1bSecpCallee",
    });
    expect(built.exportedCircuits).toEqual(["validateSigned"]);
  });

  it("a caller forwarding a SIGNATURE across the boundary crashes the zkir backend", () => {
    expect(() =>
      compileContract({ source: "S1bSecpRoot.compact", managedName: "S1bSecpRoot" }),
    ).toThrow(/cannot convert Secp256k1Scalar to .*Native/);
  });

  it("a caller forwarding only a PUBLIC KEY crashes it the same way", () => {
    // Narrows the finding: it is not the signature struct specifically. No secp
    // type at all can cross, so there is no reduced version of the design that
    // sneaks the public key through.
    compileContract({ source: "S1bPointCallee.compact", managedName: "S1bPointCallee" });
    expect(() =>
      compileContract({ source: "S1bPointRoot.compact", managedName: "S1bPointRoot" }),
    ).toThrow(/cannot convert Secp256k1Point to .*Native/);
  });
});
