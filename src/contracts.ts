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

  // PLAN-02 spike S1 — the architecture gate: zkir-v3 crypto AND a cross-contract
  // call in one circuit. Three steps, each its own contract pair so every step
  // stays independently reproducible. Callees FIRST in each pair.
  { source: "S1MinCallee.compact", managedName: "S1MinCallee" },
  { source: "S1MinRoot.compact", managedName: "S1MinRoot" },
  // Step 2 reuses the step-1 callee, so the crypto in the root is the only
  // variable between the two steps.
  { source: "S1CryptoRoot.compact", managedName: "S1CryptoRoot" },
  // Step 3: the account-as-validator shape itself — a callee that returns
  // kernel.self() and burns digests, a root that keys balances on what came back.
  { source: "S1SelfCallee.compact", managedName: "S1SelfCallee" },
  { source: "S1SelfRoot.compact", managedName: "S1SelfRoot" },

  // PLAN-02 spike S1b — secp types ACROSS the CCC boundary. NOT in the build:
  // the callers (`S1bSecpRoot.compact`, `S1bPointRoot.compact`) do not compile,
  // by design. They are kept as executable evidence for PLAN-00 §4 design rule 2
  // and are driven by src/test/s1b-secp-boundary.test.ts, which asserts the
  // exact backend panic — so the day a compiler release fixes it, that test goes
  // red and the bytes-only rule can be revisited.

  // PLAN-02 spike S3 — 10 exported circuits, 8 of them pure. Compiles only if
  // pure circuits emit no verifier key (the budget guard counts .verifier files).
  { source: "S3PureBudget.compact", managedName: "S3PureBudget" },

  // PLAN-02 spike S4 — the account upgrade path. V1 and V2 are the SAME contract
  // one constraint apart and compile to the SAME managed dir (`S4Account`), so
  // the spike can swap the local bundle under a deployed contract and try to
  // rotate its verifier key. The manifest lists v1: a full `pnpm compile` leaves
  // the tree in the v1 state, and the S4 suite compiles v2 over it on demand.
  { source: "S4AccountV1.compact", managedName: "S4Account" },
  { source: "S4Root.compact", managedName: "S4Root" },

  // PLAN-03 — the AA core (CCC callee). The managed dir name MUST stay
  // "Account": it is the `contract Account { ... }` interface name every token
  // root declares (MiniTokenAA below, PLAN-04 §4's TokenAA later), and the
  // name is case-sensitive on Linux CI. Compiled BEFORE any root that binds it.
  { source: "Account.compact", managedName: "Account" },
  // PLAN-03's token-root harness over the frozen payload (gates G3.2–G3.6) —
  // the accountTransfer check chain PLAN-04 ports verbatim in front of OZ's
  // _update. NOT the product token.
  { source: "MiniTokenAA.compact", managedName: "MiniTokenAA" },

  // PLAN-04 §1–2 — the 0.33 EvmErc20 fork plus OZ Ownable supply control.
  // The upstream 13-key token has already been deployed live on this compiler
  // lane. Keep the exception explicit so the repo-wide conservative default
  // remains 7; G4.4 must still prove the restored bundle deploys locally.
  // PLAN-04 §4 will extend this entry after PLAN-03's frozen-interface handoff.
  {
    source: "TokenAA.compact",
    managedName: "TokenAA",
    maxVerifierKeys: 13,
  },
];

export function contractByName(managedName: string): ContractSource {
  const found = CONTRACTS.find((c) => c.managedName === managedName);
  if (!found) throw new Error(`no contract named ${managedName} in the manifest`);
  return found;
}
