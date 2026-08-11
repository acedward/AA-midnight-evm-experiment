# S4 — account upgrade path via the contract maintenance authority

**Answer: YES, with conditions.** A deployed account's verifier key can be rotated, and a token
root bound to that account keeps working **without being redeployed**. An account upgrade is a
bundle release plus one rotation per deployed account — not a token redeployment. The
conditions are real and belong in PLAN-03's design, not in a footnote.

| | |
|---|---|
| Date | 2026-08-11 |
| Fixtures | `contracts/S4AccountV1.compact`, `S4AccountV2.compact` (one added constraint), `S4Root.compact` |
| Helper | `src/maintenance.ts` — version-parameterized rotation |
| Evidence | `pnpm exec vitest run src/test/s4-upgrade.test.ts` — 6/6 green |

## What was done

v1 and v2 of the account differ by exactly one added constraint in `validate` — same signature,
same ledger layout, different proof circuit and therefore a different verifier key. A root
contract was deployed **once**, against v1, and never redeployed. Then: release v2 locally,
rotate the deployed account's key, restart on the new bundle, call the same root again.

| Act | Result |
|---|---|
| A — deploy account v1 + root; prove a hop | green (17.3 s); on-chain key is byte-identical to the compiled `validate.verifier` |
| B — release v2 locally, chain still v1 | the hop is **refused locally, no transaction, no fee**: `ZKArtifactNotFoundError: No ZK artifact bundle matches the deployed verifier key` |
| C — rotate via the SDK helper | **fails** — `RemoveVerifierKeyTxFailedError` / `FailFallible`; on-chain key untouched |
| D — rotate via one maintenance update, version `v4` | `SucceedEntirely`; on-chain key is now v2's |
| D2 — call from a process still holding the v1 bundle | refused: `does not match the implementation the caller was compiled against` |
| E — restart on the new bundle, call the SAME root | green (17.2 s); account `validateCount` continues 1 → 2; the new v2 constraint is enforced |

## The four conditions

**1. The SDK's rotation helpers do not work on this lane.**
`submitRemoveVerifierKeyTx` / `submitInsertVerifierKeyTx` route through compact-js's
`ContractExecutable`, which hardcodes `new ContractOperationVersion('v3')` for both the remove
and the insert. A contract compiled with `--feature-zkir-v3` files its entry points under
**`v4`**, so the SDK's update matches nothing: the transaction is included in a block, the fee
is paid, and nothing changes (`FailFallible`). It is at least safe — a failed attempt cannot
brick the account — but it is silent unless the caller inspects the status.
`src/maintenance.ts` does what compact-js does with the version as an argument; everything else
(signature over `MaintenanceUpdate.dataToSign`, authority counter read from the deployed state,
signature index 0, intent assembly) is the same sequence.

**2. Rotate in ONE maintenance update.**
`MaintenanceUpdate` takes a list, so `[VerifierKeyRemove, VerifierKeyInsert]` is atomic. The
SDK's two-transaction sequence leaves the entry point with no key between them — a window in
which every call to the account fails. `rotateVerifierKey` does both in one update.

**3. Every caller process must be restarted on the new bundle — that is a coordinated release,
not a hot swap.**
There are two independent client-side guards, and both refuse before a transaction exists:
- the **ZK artifact registry** resolves a callee's proving key by joining on the *deployed*
  verifier key, so a stale local bundle simply does not resolve (act B);
- **`assertImplementationMatches`** in `@midnight-ntwrk/compact-runtime` compares
  `sha256(deployed verifier key)` against `expectedVk[circuitId]` read from the *callee's
  compiled module* (act D2).

The second one has a sharp operational edge: the caller's generated `index.js` imports its
callee by relative path (`../../Account/contract/index.js`), and **Node caches that module by
URL for the life of the process**. Recompiling the file underneath does not evict it, so a
long-running relayer that once loaded the old bundle keeps comparing against the old hash
forever. Act E models the fix the way production must do it — a restart on a newly published
bundle path.

The upside of the same guard: an old release cannot silently call a rotated account. It fails
loudly, locally, and for free.

**4. The maintenance authority is the DEPLOYER's Midnight key, not the account owner's Ethereum
key.** `deployContract` generates a Schnorr signing key, stores it in the private-state provider
under the contract's address, and sets the on-chain authority to `committee: [that key],
threshold: 1, counter: 0`. Consequences PLAN-03 must decide on:

- Upgrade rights belong to whoever deployed the account, not to the EVM owner who controls it.
  The plan's premise that "MIP-0003 lets an ECDSA key hold a `ContractMaintenanceAuthority`" is
  not what happens by default here — the committee entry is `{tag: 'schnorr', …}`.
- **The authority key lives in the deployer's private-state store.** Lose that store and the
  account is frozen at its current code forever. It is not derived from the wallet seed.
- `ReplaceAuthority` exists (and midnight-js exposes `submitReplaceAuthorityTx`) to hand the
  authority to another key — a governance key or a threshold committee. Untested here; it is
  the obvious follow-up if PLAN-03 wants upgrades to be anything other than
  deployer-unilateral.

## What this means for PLAN-03/04

The generality claim survives, restated precisely: **an account upgrade is a bundle release
plus one rotation per deployed account, coordinated with a restart of every caller process. The
token is never redeployed and account state is never lost.** The fallback the plan carried —
"account code is frozen; upgrades = versioned interface (`AccountV2`) + new token deployments" —
is not needed.

**Decided 2026-08-11 (Edward): accepted as-is for the demo.** One operator deploys every
account, nothing needs to outlive the laptop, and the authority question is not worth solving
now. The warning stands on the record here, in PLAN-02 §Questions Q6, and in PLAN-03 §6:
upgrade rights belong to whoever deployed the account rather than to the EVM owner, and losing
the deployer's private-state store freezes that account's code forever — no seed phrase
recovers it. The fix, when this stops being a demo, is a policy rather than a code change:
exercise `ReplaceAuthority` at deploy time to hand the authority to a governance key or a
threshold committee, before any account holds value.
