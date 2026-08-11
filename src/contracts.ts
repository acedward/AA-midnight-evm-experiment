// The contract manifest: what this repo compiles, and in what ORDER.
//
// Order is load-bearing, not cosmetic. A cross-contract call resolves its callee
// by looking for a sibling managed directory named exactly as the `contract`
// interface the caller declares, and the callee's verifier key is what gets
// pinned into the caller's expectedVk — so every callee must already be compiled
// when its caller is. Callees first, root last (PLAN-01 §Compile pipeline,
// PLAN-00 §9.2).

import type { ContractSource } from "./compile.ts";

export const CONTRACTS: readonly ContractSource[] = [
  // PLAN-01 toolchain canary (G1.1 keccak prove, G1.3 typed-event read-back).
  { source: "KeccakFixture.compact", managedName: "KeccakFixture" },

  // PLAN-01 G1.2: the three secp256k1 PROVE cases, vendored verbatim from
  // compact-end-2-end @ aa344546 cases/features/secp256k1/contracts/. They are
  // re-run here to time the primitives PLAN-03/04 build on against OUR proof
  // server — verify, in-circuit Ethereum-address derivation, and the full
  // recover + keccak256(x‖y)[12:] shape.
  { source: "prove-verify-secp256k1.compact", managedName: "prove-verify-secp256k1" },
  {
    source: "prove-ethereum-address-secp256k1.compact",
    managedName: "prove-ethereum-address-secp256k1",
  },
  {
    source: "prove-recover-address-secp256k1.compact",
    managedName: "prove-recover-address-secp256k1",
  },

  // PLAN-03 adds: { source: "Account.compact", managedName: "Account" }   <- CCC callee,
  //   the managed dir name MUST stay "Account" because PLAN-04's token declares
  //   `contract Account { ... }`.
  // PLAN-04 adds: { source: "TokenAA.compact", managedName: "TokenAA" }   <- CCC root, LAST.
];

export function contractByName(managedName: string): ContractSource {
  const found = CONTRACTS.find((c) => c.managedName === managedName);
  if (!found) throw new Error(`no contract named ${managedName} in the manifest`);
  return found;
}
