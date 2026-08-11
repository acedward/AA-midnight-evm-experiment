# S1b — secp256k1 types across the CCC boundary

**Verdict: RED, and the bytes-only rule stands.** No secp256k1 type can cross a cross-contract
call boundary on this compiler. PLAN-00 §4 design rule 2 is not a precaution any more — it is
the only thing that compiles. PLAN-03 §3's "the account trusts the root to have verified"
caveat stays in place.

| | |
|---|---|
| Date | 2026-08-11 |
| Toolchain | compactc `0.33.0-rc.2`, `--feature-zkir-v3` |
| Fixtures | `contracts/S1bSecpCallee.compact`, `S1bSecpRoot.compact`, `S1bPointCallee.compact`, `S1bPointRoot.compact` |
| Evidence | `pnpm exec vitest run src/test/s1b-secp-boundary.test.ts` — 3/3 green (a NEGATIVE regression) |

## What happens

A cross-contract call argument is desugared into a `transientCommit`, and the zkir backend has
no native representation for secp atoms. Compiling the **caller** panics:

```
thread 'main' panicked at midnight-proofs-0.8.1/src/dev/cost_model.rs:286:44:
called `Result::unwrap()` on an `Err` value:
  Synthesis("Relation::circuit error: Synthesis(\"cannot convert Secp256k1Scalar to \\\"Native\\\"\")")
Exception: zkir returned a non-zero exit status 101
```

Three facts, each from its own fixture:

1. **The callee compiles fine.** `S1bSecpCallee.validateSigned(digest, sig, pk)` — signature
   verification, address derivation, digest-set burn, all inside the account — builds and emits
   a verifier key. Secp types are unproblematic as ordinary exported-circuit arguments.
2. **Forwarding a signature crashes the caller**: `cannot convert Secp256k1Scalar to "Native"`.
3. **Forwarding only a public key crashes it identically**: `cannot convert Secp256k1Point to
   "Native"`. So this is not about the signature struct, and there is no reduced design that
   sneaks just the public key through for the account to re-derive the signer itself.

Note the failure mode: a Rust `unwrap()` panic in the cost model, not a diagnostic. It is
reported as `zkir returned a non-zero exit status 101` with no source location, which is worth
knowing — a plan that assumed a clean "unsupported type" error would misread this as a broken
toolchain.

## Consequence

The account cannot re-verify signatures for itself. The token root does the crypto and the
account trusts it, which means **the account's security depends on every token bound to it**
being an honest verifier. That is the caveat PLAN-03 §3 already carries, now with a reason that
is measured rather than assumed.

Mitigations available to PLAN-03/04, none requiring this to be fixed:

- the digest crossing the boundary is `keccak256` of the payload, and the payload binds the
  token's own address (`kernel.self()`), so a dishonest token can only ever burn digests for
  operations naming *itself*;
- the account's digest set makes any such burn single-use and visible.

`src/test/s1b-secp-boundary.test.ts` pins the panic as a negative regression: if a later
compiler adds the lowering, that suite goes red, and the red is the signal that the account can
be made self-sufficient.
