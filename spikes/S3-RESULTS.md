# S3 — do exported PURE circuits count against the verifier-key deploy budget?

**Answer: no. Pure circuits are free.** PLAN-03 can export as many digest oracles as it wants;
only circuits that touch ledger state consume the ~7-key deploy budget.

| | |
|---|---|
| Date | 2026-08-11 |
| Toolchain | compactc `0.33.0-rc.2`, `--feature-zkir-v3` |
| Fixture | `contracts/S3PureBudget.compact` — 10 exported circuits, 8 pure |
| Evidence | `pnpm exec vitest run src/test/s3-pure-budget.test.ts` — 4/4 green |

## What was measured

Three independent layers of evidence, because "pruned from the proof circuits" could plausibly
mean any of them:

1. **compactc output.** `keys/` holds exactly four files — `store.{prover,verifier}` and
   `storeVerified.{prover,verifier}` — and `zkir/` holds only those two circuits' `.zkir`/
   `.bzkir`. The eight pure circuits are never lowered to a proof circuit at all, so they cost
   nothing at proving time either, not just at deploy time.
2. **The generated bindings.** They land in `PureCircuits` as ordinary synchronous JS
   functions (no context, no provider, no chain), while `ImpureCircuits`/`ProvableCircuits`
   hold only the two. `expectedVk` — the record a CCC caller binds against — likewise has two
   entries, so a pure circuit cannot perturb a caller's verifier-key binding.
3. **A real deploy.** The budget is a deploy-transaction block-size limit, so the complete
   answer is a deploy that lands. It did, and a subsequent `storeVerified` call proved in
   **29.4 s** — the same cost as the equivalent circuit in a contract with no pure circuits at
   all (S1 step 2's 29.4 s).

## Why it matters for PLAN-03

The oracles in the fixture are the ones the payload spec actually needs, not filler:
`digestOf`/`digestOf64`/`digestOf128` (the digest a TS builder must reproduce), `addressOf`
(owner identity), `verifyOf` (the verifier, callable off-chain), `reverse32` (the endianness
trap), `padAddress` (OZ's left-arm balance key), `pointXBigEndian`. All eight are already
checked against noble and the ethereum/tests KATs in the same suite — that is the
encoding-drift guard from this plan's test strategy, working at layer 1 with no chain.

## Incidental finding

**`reverseBytes32` is not a stdlib circuit on this compiler tag**, despite being named in
PLAN-02's encoding-drift notes as though it were: `unbound identifier reverseBytes32`. Every
contract that needs it defines it locally, as `prove-recover-address-secp256k1.compact` does.
PLAN-03/04 must carry their own copy (an unexported helper circuit, which emits no verifier key
of its own — also confirmed here).
