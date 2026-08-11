# 00001-midnight-aa

EVM-signature account abstraction on Midnight 2.x. Implementation repo for the
plan set at `/Users/edwardalvarado/todo/AA/plans/` (start at `PLAN-00-MACRO.md`).

This repo contains **PLAN-01 — infrastructure & toolchain**, **PLAN-02 — de-risk
spikes & test strategy**, **PLAN-03 — the Account contract + frozen payload**,
the completed **PLAN-04** OZ TokenAA fork + `accountTransfer` adapter, and
**PLAN-05 — the signer client & relayer**.

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

> **2026-08-11 incident:** Docker disk exhaustion stopped the node long enough
> for the non-archive chain to prune state needed by a restarted indexer. Node
> chain data and proof params are preserved, but the persistent indexer cannot
> recover without the explicit human-gated reset in PLAN-05 Q2. PLAN-04's live
> gate used and tore down an isolated random-port stack; it did not overwrite
> `STACK.env` or record disposable addresses.

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

## PLAN-04: TokenAA + Account adapter

`contracts/TokenAA.compact` is the pinned EvmErc20 fork with OpenZeppelin
`Ownable` vendored under `contracts/vendor/openzeppelin/`. Genesis supply and
the immutable supply administrator are separate constructor roles. `mint`,
`mintToAccountAddress`, and `_burn(account,value)` require the Ownable
secret-key witness; ordinary transfer and allowance paths remain
holder-authorized. Generic `mint(left(paddedEthAddress), value)` still covers
Ethereum-shaped identities.

`accountTransfer(account, payload, sig, pk)` uses PLAN-03's frozen
`MIDNIGHT_ACCOUNT_V1` 176-byte payload. It binds domain, op, token address,
signer, Account address, recipient, nonce, and amount; calls
`Account.validate(signer,digest)`; then debits the returned ContractAddress's
right-arm balance through OZ `_update`. Account owns the digest replay set;
TokenAA owns balances and emits `UnshieldedSpend` + `UnshieldedReceive`.

The focused runtime-0.18 conformance gate is:

```bash
pnpm exec vitest run src/test/token-aa-conformance.test.ts --reporter=verbose
```

It compiles Account before TokenAA in the pinned Docker compiler and then drives
the emitted artifact directly. The focused suite is 26/26, including the
frozen-payload rejection matrix. The live gate is:

```bash
TOKEN_AA_LIVE_USE_PRECOMPILED=1 pnpm exec vitest run src/test/token-aa-live.test.ts
```

That suite deploys one Account and two full 13-verifier-key TokenAA instances,
proves the CCC transfer, checks cross-token/replay/flipped-s rejection and
post-hop rollback, and reads both transfer events back through the indexer.

**Breaking change from upstream EvmErc20:** the constructor gains a distinct
admin argument, witness bindings gain `wit_OwnableSK`, mint entry points are
restricted, and `burn(value)` becomes owner-only `_burn(account,value)`.
The unsafe legacy `transferWithEthSig` circuit is replaced by `accountTransfer`,
and the redundant `mintToEthAddress` convenience is replaced by
`mintToAccountAddress`, keeping the deployed surface at 13 verifier keys.
Regenerate clients/proofs; old circuit arguments and verifier keys are not
interchangeable.

## PLAN-05: signer client & relayer

`src/signer.ts` is the EVM-wallet seam: EIP-191 framing, the 65-byte `r‖s‖v`
wire signature, off-circuit public-key recovery (noble, `prehash: false`), and
low-s normalization (tidiness only — the circuits accept both twins and replay
on the digest). `src/relayer/` is the PART-E `RelayerCore` ported to the AA
call tree:

```bash
node --experimental-strip-types src/relayer/server.ts   # port AA_BASE_PORT+4
```

`POST /relay {payload, signature}` validates everything provable-off-chain
(structure, registry routing by the payload's token field, recovery + from
bind, R7 nonce ordering, per-from rate limit), returns the EIP-191 digest as
the eth-style tx hash immediately, and proves+submits on an async queue —
idempotent per digest, so the flipped-s twin and every retry return the prior
result. The relayer's wallet (bob) is the paymaster; there is no other fee
path. Registered tokens attach as a NON-deployer via `findDeployed`, routed
from `infra/DEPLOYMENTS.json`.

Gates: G5.1/G5.2 (`src/test/relayer-signer.test.ts`, no stack needed beyond
the compiler) and G5.3 (`src/test/relayer-live.test.ts`, live loop over HTTP
against the persistent stack). G5.4 captures a real MetaMask signature over
the 176-byte payload via `src/relayer/capture-fixture.ts` (one human click);
its suite un-skips itself once the fixture exists.

Two spike contracts — `contracts/S1bSecpRoot.compact` and
`contracts/S1bPointRoot.compact` — **do not compile, deliberately**. They are the
evidence that no secp256k1 type can cross a cross-contract boundary, and
`src/test/s1b-secp-boundary.test.ts` asserts the exact backend panic, so a future
compiler that fixes it makes that suite go red. They are kept out of
`src/contracts.ts` so `pnpm compile` stays green.
