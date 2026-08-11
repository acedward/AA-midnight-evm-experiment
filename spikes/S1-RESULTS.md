# S1 — zkir-v3 root + cross-contract call in one circuit

**Verdict: GO.** All three steps are green on the persistent Part-0 stack
(`midnight-aa-36080`). PLAN-00 §4's account-as-validator architecture is buildable as
specified; PLAN-03 and PLAN-04 are unblocked, and PLAN-03 §2's in-token contingency seam is
not needed.

| | | |
|---|---|---|
| Date | 2026-08-11 | |
| Stack | `midnight-aa-36080` | node 36080, indexer 36081/36082, proof server 36083 |
| Toolchain | compactc `0.33.0-rc.2`, `--feature-zkir-v3` | proof server `9.0.0-rc.5_experimental` |
| Evidence | `pnpm exec vitest run src/test/s1-ccc.test.ts` | 17/17 green |
| Sources | `contracts/S1{MinCallee,MinRoot,CryptoRoot,SelfCallee,SelfRoot}.compact` | |
| Timings | `infra/TIMINGS.json` (notes prefixed `S1`) | |
| Addresses | `infra/DEPLOYMENTS.json` | |

## The question

Every cross-contract-call fixture in `compact-end-2-end` is zkir-v2 — its case harness cannot
pass a compile flag to nested sources — and every zkir-v3 fixture makes no cross-contract
call. PLAN-00 §4 needs both in one circuit: a token root that runs keccak256 +
`secp256k1EcdsaVerify` + `secp256k1EthereumAddress` and then cross-calls an Account contract.
Source analysis found no failure mechanism, but zkir-v3 has a recent history of alignment bugs
(one of them, `secp256k1EthereumAddress` under zkir-v3, is why PLAN-01 had to move the compiler
pin to rc.2), so the combination was measured rather than argued.

## Step 1 — minimal Bytes<32> hop  ✅

`S1MinRoot.hop` → `S1MinCallee.note`, both compiled `--feature-zkir-v3`, Bytes<32>-only at the
boundary.

- Both sides compile with the zkir-v3 flag; verifier keys emitted for both.
- One PROVEN cross-contract transaction: **24.0 s**; a second hop **17.4 s**.
- The finalized call carries a two-entry call tree, callee first, root last — the direct
  evidence that a hop happened rather than the root doing the work itself.
- Both ledgers committed: root `lastEcho`, callee `lastTag`, both counters at 1, then 2.

**This is the gate.** It answers the architecture question: zkir-v3 lowering and the
`_experimental` proof server both handle a CCC call tree.

## Step 2 — the crypto load in the same circuit  ✅

`S1CryptoRoot.authorizedHop`: keccak256 digest → `secp256k1EcdsaVerify` →
`secp256k1EthereumAddress` → CCC hop, one proof, same callee as step 1 (so the crypto is the
only new variable).

- Compiles. Compile time jumps from ~2 s to **16.9 s** — the secp/keccak lowering, not the CCC.
- PROVEN in **29.4 s**. That is the number PLAN-04's adapter and PLAN-05's relayer budget
  against: the combined circuit costs ~5 s more than the crypto alone (G1.2 measured
  24.0–30.7 s for the same primitives with no hop).
- The in-circuit derived address equals the signing key's real Ethereum address, and the
  in-circuit keccak digest equals noble's `keccak_256` over the payload.
- Negative: a garbage `s` aborts with `signature does not verify` **and leaves the callee's
  state untouched** — the authorization assert runs before the hop, so a rejected call cannot
  drive callee state.
- `(r, n−s)` verifies exactly as `(r, s)` does, over the identical digest (**24.0 s**). The
  malleability PLAN-00 §3.3 warns about is real on this lane; replay protection keyed on
  signature bytes would be defeated by it, and one keyed on the digest is unaffected.

## Step 3 — the account-as-validator shape itself  ✅

`S1SelfRoot.accountCredit` verifies the signature, cross-calls `S1SelfCallee.validate(signer,
digest)`, and credits a balance keyed on the `ContractAddress` that `validate` returned from
`kernel.self()`.

- **A `ContractAddress` survives the CCC return boundary**, and it is the account's own
  address. PLAN-00 §4 design rule 1 works as specified: the root never receives the account
  address as an argument, it uses what the account returned from inside its own proof.
- The balance lands on the right arm of `Either<ZswapCoinPublicKey, ContractAddress>` — OZ's
  `FungibleToken` key shape, which PLAN-04 inherits unchanged.
- The callee's own ledger write (the consumed-digest `Set`, its counter) commits inside the
  root's transaction.
- PROVEN in **29.4 s** — no measurable cost over step 2 for the added ledger work.

Rejection cases proven live against this pair:

| Case | Result |
|---|---|
| R6 replayed digest | rejected `digest already consumed`; no balance moved |
| R2 flipped-s of a consumed signature | rejected `digest already consumed` — the digest set catches the malleable twin |
| R4 valid signature, wrong key | rejected `signer is not the account owner` (fails at the account, not the verifier) |
| R14 griefing | a direct `validate` call burns the digest (**18.5 s**); the relay then fails cleanly with the reason named; re-signing a fresh payload lands (**23.9 s**) |

R14 is the accepted risk of design rule 3, demonstrated rather than asserted: with no
`kernel.caller()` and no CCC-only circuits on this lane, `validate` is a public entry point,
and the worst an observer of `(payload, sig, pk)` achieves is denying one already-signed
operation.

## Proving budget (the fee/UX input)

| Call | Wall clock |
|---|---|
| minimal CCC hop | 24.0 s / 17.4 s |
| crypto + CCC hop | 29.4 s / 24.0 s |
| full account shape | 29.4 s / 23.9 s |
| direct `validate` (callee alone) | 18.5 s |

A cross-contract call adds no separate proving round: the whole tree is proven in one pass,
and the account-shaped call sits at the top of the range PLAN-01 G1.2 measured for the crypto
alone. **Rejected calls cost ~70 ms** — every assert fires during local circuit execution,
before anything reaches the proof server, so the negative half of the rejection matrix is
nearly free to run at layer 3.

## Corrections to the plan set

- **`/prove-tx` vs `/prove` is moot on this SDK.** PLAN-00 §4 rule 4 and PLAN-02's S1 build
  order both require the proof provider to use `/prove-tx` because `/prove` "hard-tags proofs
  V2". In midnight-js `5.0.0-beta.6`, `httpClientProofProvider` does not call `/prove-tx` at
  all — its own docs say so — and proves each circuit in the tree individually through
  `/check` + `/prove`, with key material supplied by the `ZKConfigRegistry`. zkir-v3 CCC
  proving works over that path, which the three steps above demonstrate. The rule as written
  describes an older client.
- **The `nestedContractSource` compile-flag gap does not apply here.** PLAN-02's harness note
  says to fork the upstream CCC case machinery and add a `compileFlags` param. This repo does
  not use that machinery: `src/compile.ts` applies the feature flags from `versions.json` to
  every contract in the manifest, so a CCC callee is compiled with `--feature-zkir-v3` by
  construction. The upstream gap is real (`flatContractSource` takes `compileFlags`,
  `nestedContractSource` does not) — it is simply not on our path.

## Carry-forward for PLAN-03/04

1. The managed-dir name must equal the `contract` interface name exactly. Verified only on
   macOS's case-insensitive filesystem — PLAN-00 §9.2's case-sensitive CI check still owes the
   real evidence.
2. `Map` reads are member-guarded (`balances.member(key) ? balances.lookup(key) : 0`); an
   unguarded lookup on an absent key aborts.
3. The root cannot compare the returned `ContractAddress` against the callee reference it
   holds — Compact relates handles and addresses in neither direction. The check that the
   returned address is the intended account is structurally impossible in-circuit and belongs
   in the test/relayer layer.
4. Argument shape for a contract reference: `{ bytes: Uint8Array(32) }`.
