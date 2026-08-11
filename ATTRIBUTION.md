# Attribution

This repo deliberately reuses proven code. Every vendored file carries a header
naming its upstream revision and every local change; this file is the index.
PLAN-00 §9.1 requires it to stay accurate through the final merge phase.

## compact-end-2-end

Upstream: `/Users/edwardalvarado/compact-end-2-end` @ `aa344546edb71a88dddcdd82f28998480df279e9`
("feat: add opaque equality runtime test case (#77)"), vendored 2026-08-11.
Copyright (C) Midnight Foundation — SPDX-License-Identifier: Apache-2.0.
Working clone for reference: `/Users/edwardalvarado/todo/AA/experiments/compact-end-2-end`.

| This repo | Upstream path | Local changes |
|---|---|---|
| `src/compiled.ts` | `utils/compiled.ts` | none (verbatim) |
| `src/contract-ops.ts` | `utils/contract-ops.ts` | `CallResult` now carries `logEvents` (the beta.6 field) |
| `src/hex.ts` | `utils/hex.ts` | none (verbatim) |
| `src/wallet.ts` | `utils/wallet.ts` | endpoints + network id come from `infra/STACK.env`; `AA_`-prefixed env vars |
| `src/providers.ts` | `utils/providers.ts` | `createRequire` instead of `import x = require()` (Node type-stripping); beta.6-compliant private-state password; `AA_`-prefixed env vars |
| `src/genesis-seeds.ts` | `utils/genesis-seeds.ts` | external-network seed pooling dropped; adds the project's role→seed map |
| `src/events.ts` | `utils/events.ts` | event type filter is a parameter; queries paginate to exhaustion instead of taking the indexer's default page of 100 |
| `src/endpoints.ts` | `utils/endpoints.ts` | localhost fallbacks REMOVED — no defaults, ever |
| `src/compile.ts` | `cases/harness/contracts.ts` (`runCompactc`) | reduced to the one dockerized runner mode; adds the circuit-budget and empty-verifier-key checks |
| `src/secp256k1-vectors.ts` | `cases/features/secp256k1/src/cases/{wycheproof,eth-address-vectors}.ts` | reduced to the vectors the three prove-cases drive |
| `src/vectors/*.json` | `cases/features/secp256k1/src/cases/vectors/` | verbatim |
| `contracts/prove-*-secp256k1.compact` | `cases/features/secp256k1/contracts/` | verbatim |
| `contracts/KeccakFixture.compact` | modelled on `cases/features/keccak256/contracts/provable-keccak256.compact` | adds `callCount` and a typed-event circuit for G1.3 |
| `infra/docker-compose.yml` | `infra/docker-compose.yml` | host ports templated from STACK.env with no defaults; healthchecks; named volume for chain state; `restart: unless-stopped` |
| `infra/compact-toolchain.Dockerfile` | `infra/compact-toolchain.Dockerfile` | installs the pinned compactc release asset directly — the `compact` version manager does not publish the 0.33 line |

## Third-party test vectors

| File | Source | Notes |
|---|---|---|
| `src/vectors/keyaddrtest.json` | ethereum/tests, BasicTests | key → Ethereum address KATs |
| `src/vectors/ecdsa_secp256k1_sha256_bitcoin_test.json` | Project Wycheproof | secp256k1/SHA-256 ECDSA verification vectors |

`src/vectors/README.md` carries the upstream provenance notes verbatim.

## Still to vendor (later plans)

PLAN-04 forks `EvmErc20.compact` from
`/Users/edwardalvarado/midnight-evm-compat/compact-end-2-end` @ `feat/evm-token-ethauth`
and the OpenZeppelin modules from `/Users/edwardalvarado/compact-contracts`;
PLAN-05 ports `RelayerCore` from `/Users/edwardalvarado/midnight-evm-compat/evm-relayer`.
Record their commit hashes here when they land.
