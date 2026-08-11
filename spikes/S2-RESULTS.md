# S2 — hosted stagenet proving

**Status: NOT RUN, by decision.** Edward, 2026-08-11: *"it should eventually work; but by
default we want to target the local undeployed."* So stagenet gates nothing in v1 and this
spike stays unrun — but nothing may make it impossible, and what the plans owe instead is that
running S2 later costs a day rather than a rewrite (the four portability constraints in PLAN-02
§Questions Q7). What follows is the evidence gathered without deploying anything, and the exact
checklist for the day someone wants stagenet.

| | |
|---|---|
| Date | 2026-08-11 |
| Decision | local `undeployed` by default; stagenet eventual, not a v1 gate |
| Still needed to run it | a funded stagenet wallet |

## Why it is not run

The plan set as written targets the local Part-0 stack end to end. PLAN-00 §9.3's whole
acceptance run (V1–V6) is local; `src/genesis-seeds.ts` throws outright on any network id other
than `undeployed`, because a hosted network hands out no genesis gifts. Running S2 therefore is
not "point the tests at another URL" — it needs a funded wallet on a public network, which is a
provisioning decision (and a faucet request), not a test-harness change.

## What was established without deploying

The hosted endpoints are live and, importantly, on the **same protocol version as our local
stack**:

| Probe | Result |
|---|---|
| `POST https://rpc.stagenet.shielded.tools` → `system_version` | `2.0.0-d9729c13` |
| `POST https://indexer.stagenet.shielded.tools/api/v4/graphql` → `{ block { height protocolVersion } }` | height 469845, `protocolVersion` **2000000** |

`2000000` is the same protocol version our local `2.0.0-rc.4` node reports in finalized
transaction data (visible in every `FinalizedTxData` this plan's suites produced). So the
open question is narrower than "will anything work": the ledger generation matches, and what
remains genuinely unproven is the **verifier-key[v7] dispatch for keccak/secp under
`--feature-zkir-v3` on the hosted ledger `rc.3` build**, which no probe can answer without a
transaction.

## Runbook when stagenet becomes a target

1. **Provision a funded wallet.** A stagenet seed with tNIGHT, registered for DUST. Genesis
   seeds do not apply; `assignGenesisSeeds` must be bypassed, not "fixed" — its throw is a guard
   against silently running against an unfunded hosted wallet.
2. **Keep our own proof server.** There is no public prover for stagenet, and only
   `9.0.0-rc.5_experimental` can prove zkir-v3. The local proof server on `AA_PROOF_SERVER`
   works against a remote node — proving is a client-side service, it does not have to live
   near the chain.
3. **Point STACK.env at the hosted endpoints** in a separate profile (never overwrite the
   persistent local one — PLAN-01 Part 0: those addresses in `DEPLOYMENTS.json` only resolve
   against the chain that minted them; a hosted run needs its own `stack` key).
4. **Re-run the three G1.2 prove-cases** (`src/test/secp256k1.test.ts`) plus `S1CryptoRoot`
   (the crypto + CCC combination) against it. Those two together are the whole question:
   in-circuit keccak, ECDSA verify, and Ethereum-address derivation, with and without a
   cross-contract call.
5. **Expect the failure mode to be a verifier-key dispatch error at submission**, not a proving
   error — the proof server is ours and already known good; it is the hosted ledger's
   acceptance of a v3-proved transaction that is untested.
