# VERIFICATION.md — the conformance ledger (PLAN-00 §9.3 V6)

> Project `00001-midnight-aa` — EVM-signature account abstraction on Midnight 2.x.
> System-level verification executed 2026-08-12 (UTC) against the ONE persistent
> Part-0 stack `midnight-aa-36080`, **gen-2 chain** (the 36080 window was wiped
> and regenerated in place on 2026-08-11 ~23:00Z with Edward's approval —
> PLAN-05 Q2; gen-1 rows in `infra/DEPLOYMENTS.json` now carry an `archived`
> marking and never resolve).
>
> Machine-readable evidence for the V-runs:
> `infra/VERIFICATION-EVIDENCE-v2v4.json`, `infra/VERIFICATION-EVIDENCE-v5.json`.
> Per-call proving wall-clocks: `infra/TIMINGS.json`.

## How to read the evidence column

- **tx hashes / blocks** are on the gen-2 chain unless marked *(gen-1, wiped)*.
- Gates whose live evidence was minted by the wiped gen-1 chain are marked
  *"evidence: gen-1 chain (wiped) — re-proven by Vx on gen-2"*; the original
  pass stands in the plan text and the re-proof is what a verifier can check
  today.
- Suite counts of the form *n/n* were re-executed in the **V1 clean clone**
  on 2026-08-12 unless stated otherwise.

## Gate ledger

| Gate | Status | Evidence | Date |
|---|---|---|---|
| G1.0 | ✅ | Stack allocator + lifecycle: base port 36080 allocated on clean checkout, all four health probes green, genesis wallet paid a real DUST fee (PLAN-01 §Gates). Reuse re-proven by V1: `stack-up.sh` in the clone returned in 2 s with container IDs/CreatedAt unchanged; `stack-scripts.test.ts` guards green in the clone (part of 86/86). Original fee tx gen-1 (wiped) — fee path re-proven by every gen-2 deploy/call below. | 2026-08-11 / re-proven 2026-08-12 |
| G1.1 | ✅ | keccak256 in a proven circuit + registry + non-deployer `findDeployed` (`src/test/keccak-fixture.test.ts`; original rows gen-1, wiped). Re-proven on gen-2: every V2 `accountTransfer` proves `keccak256` over the 205-byte EIP-191 preimage in-circuit (e.g. midnight tx `bd8a77fb…` block 865); V5 re-attached non-deployer handles to all 12 live addresses. | 2026-08-11 / re-proven 2026-08-12 |
| G1.2 | ✅ | All three vendored secp256k1 prove-cases green; proving budget 24.0–30.7 s/call recorded in `infra/TIMINGS.json` (original deployments gen-1, wiped). Re-proven on gen-2: `secp256k1EcdsaVerify` + `secp256k1EthereumAddress` execute inside every V2/V3/V4/V5 proven `accountTransfer`. | 2026-08-11 / re-proven 2026-08-12 |
| G1.3 | ✅ | Typed events read back through BOTH `CallResultPublic.logEvents` and the indexer `contractEvents` query, agreeing (`src/test/events.test.ts`; gen-1). Re-proven on gen-2: V2 read `UnshieldedSpend`+`UnshieldedReceive` for both tokens through the indexer, filtered by contract address + tx hash (txs `bd8a77fb…`, `a17c5fce…`). | 2026-08-11 / re-proven 2026-08-12 |
| G2.1 | ✅ | Spike S1 = **GO**: zkir-v3 crypto + CCC in one proven circuit incl. the full `validate`-returns-`kernel.self()` account shape, 17/17 (`spikes/S1-RESULTS.md`; spike deployments gen-1, wiped). The architecture is re-proven by every gen-2 CCC proof (V2/V3/V4/V5). | 2026-08-11 |
| G2.2 | ✅ (was PARTIAL) | Rejection matrix layers 1+2: `rejection-matrix.test.ts` (layer 1 + matrix integrity), `account-payload.test.ts` (R5/R10/R11 payload binds), `account-simulator.test.ts` 12/12, `token-aa-conformance.test.ts` 26/26 — all green in the V1 clean clone (86/86 total). `pendingCases()` = ∅: all 15 R-cases name existing tests. | 2026-08-12 |
| G2.3 | ✅ (was PARTIAL) | R1/R6/R8 live: V3 re-proved R6 (`Account: digest already consumed`) and R8 (`TokenAA: wrong token`) on the V2 deployments; R1's balance+event halves are V2's ledger reads + indexer events. | 2026-08-12 |
| G2.4 | ✅ (was PARTIAL) | R14 + R9 live on the REAL Account/TokenAA (the gate's re-open condition): V4a griefing loop (burn tx `bd906535…` → clean failure → re-signed op confirmed block 895) and V3 R9 cross-account replay (`TokenAA: account mismatch`, atomic — no digest burned at account #2). | 2026-08-12 |
| G3.0 | ✅ | S1 GO verdict is the gate (see G2.1); S1-red contingency seam not needed, not built. | 2026-08-11 |
| G3.1 | ✅ | `contracts/PAYLOAD.md` frozen (`MIDNIGHT_ACCOUNT_V1`, 176 bytes); TS builder == pure-circuit oracle == fixture (`account-payload.test.ts`, green in V1 clone). | 2026-08-11 |
| G3.2 | ✅ | Simulator suite 12/12 (`account-simulator.test.ts`, green in V1 clone). | 2026-08-11 |
| G3.3 | ✅ | One proven `accountTransfer` E2E (original run gen-1, wiped — `account-live.test.ts` remains runnable). Re-proven on gen-2 by V2: relayed proven transfer, balances via ledger read, digest consumed, `validateCount` advanced (midnight tx `bd8a77fb…` block 865). | 2026-08-11 / re-proven 2026-08-12 |
| G3.4 | ✅ | Griefing containment R14 (gen-1 original). Re-proven on gen-2 by V4a — see G2.4. | 2026-08-11 / re-proven 2026-08-12 |
| G3.5 | ✅ | Cross-account replay rejected atomically (gen-1 original). Re-proven on gen-2 by V3 R9: rejection + no digest burned at account #2 + intended relay landed after (tx `c60bb244…` block 884). | 2026-08-11 / re-proven 2026-08-12 |
| G3.6 | ✅ | ONE account, TWO tokens, one digest/nonce space (gen-1 original, on MiniTokenAA). Re-proven on gen-2 by V2 with the PRODUCT TokenAA ×2: sequential nonces 1, 2 through one relayer, both digests in one consumed set, `validateCount` = 2. | 2026-08-11 / re-proven 2026-08-12 |
| G4.1 | ✅ | TokenAA fork compiles under 0.33.0-rc.2 `--feature-zkir-v3`; 13-key artifact loads; constructor works. Re-proven by V1 clone: `pnpm compile` all contracts in 258 s, artifact loaded by conformance suite. | 2026-08-11 / re-proven 2026-08-12 |
| G4.2 | ✅ | ERC20 conformance (runtime-0.18 simulator) 26/26 green in the V1 clean clone. | 2026-08-11 / re-proven 2026-08-12 |
| G4.3 | ✅ | Frozen-payload rejections on deployed TokenAA (original on PLAN-04's disposable incident stack). Re-proven on gen-2 by V3: replay, flipped-s (both `digest already consumed`), cross-token (`wrong token`) on the two V2 TokenAA instances. | 2026-08-11 / re-proven 2026-08-12 |
| G4.4 | ✅ | Two full 13-key TokenAA roots deployed live; proven `accountTransfer`; balances, supply and `UnshieldedSpend`+`UnshieldedReceive` via indexer (original: disposable stack). Re-proven on gen-2 by V2: tokens `d180827e…` and `f42385b2…`, transfers at blocks 865/873, 2 events each read back. | 2026-08-11 / re-proven 2026-08-12 |
| G4.5 | ✅ | Account→TokenAA CCC call tree, `validate`-returned ContractAddress as balance key, post-hop atomic rollback (original: disposable stack). Re-proven on gen-2: V2 (returned address keyed the debit), V3 R9 (callee digest write reverted when the root assert fails after the hop), V5 (call-tree proof post-restart). | 2026-08-11 / re-proven 2026-08-12 |
| G5.1 | ✅ | TS digest builder == `pureCircuits.computeDigest` (property test, `relayer-signer.test.ts` — green in V1 clone). | 2026-08-11 |
| G5.2 | ✅ | Fixture signature round-trip: noble-signed vector authorizes a pure-circuit eval (`relayer-signer.test.ts`, V1 clone). | 2026-08-11 |
| G5.3 | ✅ | Live relayer loop 6/6 on the gen-2 chain (commit `c48b356`; its Account/MiniTokenAA/TokenAA rows are LIVE gen-2 rows, all re-attached by V5). Re-proven end-to-end by V2 through-relayer transfers with receipts. | 2026-08-11 (gen-2) / re-proven 2026-08-12 |
| G5.4 | ✅ | Real-MetaMask `personal_sign` fixture over the frozen 176-byte payload, throwaway key `0xb57e…56c9` (commit `4eadc0c`), suite 11/11. Byte-parity re-verified inside the V2 run (recovery + digest parity through `src/signer.ts`). | 2026-08-11 / re-verified 2026-08-12 |
| V1 | ✅ | Clean clone → tracked file lists identical (only gitignored machine state absent; `infra/STACK.env` copied BEFORE stack-up, per §0 — no second stack). `pnpm install --frozen-lockfile` 3 s (warm store); `stack-up.sh` REUSED the running stack (2 s, container IDs/CreatedAt unchanged); `pnpm compile` all contracts 258 s; 7 non-live suites 86/86 in 214 s. Clone deleted after. Log: run of 2026-08-12T00:30–00:38Z. | 2026-08-12 |
| V2 | ✅ | Fresh Account `03de0ee9…` + TokenAA A `d180827e…` + TokenAA B `f42385b2…`; mint 10 000 each; personal_sign transfer A (nonce 1): eth `0x55f3bacd…` → midnight `bd8a77fb…` block 865; transfer B (nonce 2): eth `0x8dc7be4a…` → midnight `a17c5fce…` block 873 — one relayer, one digest space (`validateCount` 2, both digests in the set); balances via ledger read AND 2+2 Transfer events via indexer; receipts via `/status`. MetaMask fixture parity re-verified. | 2026-08-12 |
| V3 | ✅ | On the V2 deployments, all rejected ON CHAIN with no state change: replayed digest + flipped-s twin (`Account: digest already consumed`), wrong owner key both halves (`Account: signer is not the account owner`, `TokenAA: signer is not from`), cross-token (`TokenAA: wrong token`), cross-account with a second deployed Account `a58a17a5…` (`TokenAA: account mismatch`, atomic — intended relay landed after, tx `c60bb244…` block 884). | 2026-08-12 |
| V4 | ✅ | (a) Griefing: direct `validate` burned a signed digest (tx `bd906535…`) → legit relay FAILED CLEANLY at the relayer (`/status` phase `failed`, `digest already consumed`) → re-signed op (new nonce) confirmed (midnight `65cebe29…` block 895). (b) Idempotence: a SECOND `RelayerCore` (carol's fee wallet, same registry) relayed the executed tuple — same eth tx hash (it IS the digest), chain refused the second move (`digest already consumed`), balances and `validateCount` unchanged; first instance still served its cached confirmed receipt. | 2026-08-12 |
| V5 | ✅ | `docker compose restart` (compose project, NOT down) — restart returned in 1 s, all probes healthy in ~5 s, chain state preserved (block 1009 continuing). Gen-1 archive marking holds: 53 archived rows all predate the wipe, 0 unarchived pre-wipe rows. `findDeployed` re-attached to ALL 12 live (non-archived) gen-2 addresses (3× Account, 3× MiniTokenAA from G5.3, 2× G5.3 TokenAA, plus the 4 V2/V3 contracts). One more proven transfer on the V2 pair landed post-restart: tx `cab14129…` block 1050 (suite 3/3, `infra/VERIFICATION-EVIDENCE-v5.json`). | 2026-08-12 |
| V6 | ✅ | This file. No unticked mandatory gate remains. | 2026-08-12 |

## Open deviations (with owners)

1. **S2 — hosted stagenet proving: DEFERRED by decision** (PLAN-02 Q7, Edward,
   2026-08-11). Local `undeployed` stack is the v1 target; stagenet must stay
   *possible* (no hardcoded endpoints — grep-gated; STACK.env is a profile;
   the genesis-seed guard stays). The unproven remainder (verifier-key
   dispatch for zkir-v3 on the hosted ledger) surfaces at submission time;
   runbook in `spikes/S2-RESULTS.md`. **Owner:** whoever targets stagenet.
2. **Maintenance authority sits with the DEPLOYER's private-state store, not
   the EVM owner** (PLAN-02 Q6, accepted for the demo). If that store is
   lost, the account can never be upgraded. Fix is policy, not code:
   `ReplaceAuthority` to a governance key/committee AT DEPLOY TIME. **Owner:**
   pre-production checklist, before any account holds value.
3. **Linux case-sensitivity unverified.** The managed-dir naming rule
   (dir == `contract` interface name, case-sensitive) is load-bearing; every
   run so far was on macOS (case-insensitive APFS). **Owner:** first CI setup
   on a case-sensitive FS (PLAN-00 §9.2 flags it for CI).
4. **V2 owner key is the deterministic demo key, not the MetaMask fixture
   key.** The fixture's private key is a human-held throwaway and is
   deliberately NOT committed (PLAN-05 Q3 standing rule), so it cannot sign
   fresh payloads for live contract addresses. The real-wallet leg is G5.4's
   committed fixture, whose byte parity is re-verified inside the V2 suite.
   **Owner:** none needed — by design; a live demo with a human clicking
   MetaMask reproduces V2 with any key.
5. **Cross-instance relayer idempotence is chain-enforced, not
   receipt-shared.** A second `RelayerCore` returns the same eth tx hash
   (digest-derived) but holds no copy of the first instance's receipt
   (submissions are in-memory); the digest set guarantees at-most-once
   execution — the second attempt fails cleanly without moving funds and
   without burning a proof (the assert fires in local execution, ~70 ms).
   A shared receipt store is future work if multi-instance relaying is ever
   wanted. **Owner:** PLAN-05 successor, only if needed.
6. **gen-1 live evidence wiped** (PLAN-05 Q2 incident + approved regeneration).
   All 53 pre-23:00Z registry rows are archive-marked; every gate that lost
   live evidence is re-proven on gen-2 as mapped in the table (V2/V3/V4/V5).
   Root causes fixed in `infra/docker-compose.yml` (named indexer volume,
   `--state-pruning=archive`) — this V5 restart preserved the chain.
7. **vitest worker-RPC teardown artifact:** the V2–V4 run exits 1 despite
   10/10 tests passing — an unhandled `[vitest-worker]: Timeout calling
   "onTaskUpdate"` fired during teardown of the long-lived relayer/wallet
   handles. Test outcomes are unaffected (all ✓, evidence files written).
   **Owner:** cosmetic; revisit if it ever masks a real failure.
