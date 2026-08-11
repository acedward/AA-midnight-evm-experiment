# 00001-midnight-aa

EVM-signature account abstraction on Midnight 2.x. Implementation repo for the
plan set at `/Users/edwardalvarado/todo/AA/plans/` (start at `PLAN-00-MACRO.md`).

This repo contains **PLAN-01 — infrastructure & toolchain** and **PLAN-02 — de-risk
spikes & test strategy**. PLAN-03 onward add the Account contract, the token, and
the relayer.

PLAN-02's headline: **S1 is GO** — one `--feature-zkir-v3` circuit can carry
keccak + secp256k1 ECDSA verification *and* make a cross-contract call, and a
`ContractAddress` returned from the callee's `kernel.self()` survives the return
boundary, which is what the account-as-validator architecture rests on. Each
spike has a write-up in `spikes/`; read `spikes/S1-RESULTS.md` first.

## The stack is persistent. Do not tear it down.

One long-running local Midnight 2.x network backs every phase of the project.
Proof public params take minutes to download, a proof takes tens of seconds, and
contract addresses recorded in `infra/DEPLOYMENTS.json` are re-attached by later
plans against *this* chain. Restarting is expensive; wiping it is destructive.

```bash
./infra/stack-up.sh
```

Idempotent: if `infra/STACK.env` exists and the health probes pass, it reuses the
running stack and returns in about a second. Otherwise it allocates a fresh
10-port window and brings the network up.

```bash
./infra/stack-status.sh    # health + endpoints, changes nothing
./infra/stack-down.sh      # stop containers, KEEP chain state
./infra/stack-down.sh --wipe   # destroys chain state; asks you to type the project name
```

No test suite may call `stack-down.sh`.

## Ports are generated, never defaulted

`infra/STACK.env` is the single source of truth and is **gitignored** — a clean
checkout allocates a new window. There are no fallback ports anywhere in this
repo, and that is deliberate: on this machine a local proxy maps `9944 → 10000`
and `8088 → 10001` onto a different, live stack with a populated database. A
default would not fail; it would quietly succeed against the wrong chain.

The allocator picks a random base `P` in 10100–63990 whose whole `P..P+9` window
is free and clear of the reserved ranges (`10000–10030`, `12300–12599`, `9944`,
`8088`). Assignment: node `P`, indexer HTTP `P+1`, indexer WS `P+2`, proof server
`P+3`; `P+4..P+9` are held for PLAN-05's relayer and dashboard.

## Toolchain

```bash
pnpm install
./infra/build-compact-image.sh    # pinned compactc in a container (idempotent)
pnpm compile                      # contracts/*.compact -> contracts/managed/
pnpm test                         # all gates, against the running stack
```

Every pin lives in `versions.json`; nothing resolves `latest`. All contracts
compile with `--feature-zkir-v3`, which only
`proof-server:9.0.0-rc.5_experimental` can prove — the plain tag answers
"Unsupported ZKIR version".

Compile order in `src/contracts.ts` is significant: a cross-contract callee must
be compiled before its caller, and its managed directory must be named exactly
as the `contract` interface the caller declares (case-sensitive).

## Layout

| Path | What |
|---|---|
| `infra/` | compose file, lifecycle scripts, generated `STACK.env`, `DEPLOYMENTS.json`, `TIMINGS.json` |
| `contracts/` | `.compact` sources; `managed/` holds compiled artifacts (gitignored) |
| `src/` | provider assembly, wallet, compile pipeline, registries |
| `src/test/` | the verification gates for both plans |
| `spikes/` | PLAN-02 spike write-ups (S1, S1b, S2, S3, S4) — verdicts, evidence, carry-forward |
| `src/rejection-matrix.ts` | PLAN-02's rejection matrix as verified data, not a table |
| `src/maintenance.ts` | verifier-key rotation (the SDK's own helpers do not work on this lane) |
| `versions.json` | the machine-readable pin matrix |

Files under `src/` vendored from `compact-end-2-end` carry a header naming the
upstream revision and every local change.

Two spike contracts — `contracts/S1bSecpRoot.compact` and
`contracts/S1bPointRoot.compact` — **do not compile, deliberately**. They are the
evidence that no secp256k1 type can cross a cross-contract boundary, and
`src/test/s1b-secp-boundary.test.ts` asserts the exact backend panic, so a future
compiler that fixes it makes that suite go red. They are kept out of
`src/contracts.ts` so `pnpm compile` stays green.
