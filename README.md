# 00001-midnight-aa

EVM-signature account abstraction on Midnight 2.x. Implementation repo for the
plan set at `/Users/edwardalvarado/todo/AA/plans/` (start at `PLAN-00-MACRO.md`).

This repo currently contains **PLAN-01 — infrastructure & toolchain**. PLAN-02
onward add spikes, the Account contract, the token, and the relayer.

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
| `src/test/` | the PLAN-01 verification gates |
| `versions.json` | the machine-readable pin matrix |

Files under `src/` vendored from `compact-end-2-end` carry a header naming the
upstream revision and every local change.
