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
| `src/secp256k1-vectors.ts` | `cases/features/secp256k1/src/cases/{wycheproof,eth-address-vectors}.ts` | reduced to the vectors the prove-cases drive, then re-extended for PLAN-02 R15: strict-DER corpus loader, `signKeccakPayload`, `flipS` |
| `src/vectors/*.json` | `cases/features/secp256k1/src/cases/vectors/` | verbatim |
| `contracts/prove-*-secp256k1.compact` | `cases/features/secp256k1/contracts/` | verbatim |
| `contracts/KeccakFixture.compact` | modelled on `cases/features/keccak256/contracts/provable-keccak256.compact` | adds `callCount` and a typed-event circuit for G1.3 |
| `contracts/S1*.compact` (PLAN-02 spike S1/S1b) | shape modelled on `regression/contracts/cross-contract-calls/{write-then-read,callee-returned-contract}/` | original code — the upstream fixtures are zkir-v2 and carry no crypto; these are the zkir-v3 + secp/keccak combination S1 exists to test |
| `infra/docker-compose.yml` | `infra/docker-compose.yml` | host ports templated from STACK.env with no defaults; healthchecks; named volume for chain state; `restart: unless-stopped` |
| `infra/compact-toolchain.Dockerfile` | `infra/compact-toolchain.Dockerfile` | installs the pinned compactc release asset directly — the `compact` version manager does not publish the 0.33 line |

## Third-party test vectors

| File | Source | Notes |
|---|---|---|
| `src/vectors/keyaddrtest.json` | ethereum/tests, BasicTests | key → Ethereum address KATs |
| `src/vectors/ecdsa_secp256k1_sha256_bitcoin_test.json` | Project Wycheproof | secp256k1/SHA-256 ECDSA verification vectors |

`src/vectors/README.md` carries the upstream provenance notes verbatim.

## PLAN-04 token fork and OpenZeppelin modules

Vendored 2026-08-11 for PLAN-04 §1–2:

| This repo | Upstream | Revision | Local changes |
|---|---|---|---|
| `contracts/TokenAA.compact` | `/Users/edwardalvarado/midnight-evm-compat/compact-end-2-end/dapps/evm-erc20/contracts/EvmErc20.compact` | `88ad65d0e23b11352c1194210e03ff64923c1636` | Renamed; separate genesis recipient/admin; genesis left-arm guard; OZ Ownable initialization; owner-gated `mint`/`mintToEthAddress`; self `burn(value)` replaced by owner-gated `_burn(account,value)`. PLAN-04 §3–4 intentionally untouched. |
| `contracts/vendor/openzeppelin/access/Ownable.compact` | `/Users/edwardalvarado/compact-contracts/contracts/src/access/Ownable.compact` | clone pin `0e9d659084fe6579dd0ff9c49c17ae710dcca480`; body byte-identical to `v0.3.0-alpha.1` / `746724f880199197e4cceff95820181866abcecd` | provenance header only |
| `contracts/vendor/openzeppelin/utils/Utils.compact` | `/Users/edwardalvarado/compact-contracts/contracts/src/utils/Utils.compact` | clone pin `0e9d659084fe6579dd0ff9c49c17ae710dcca480`; body byte-identical to `v0.3.0-alpha.1` / `746724f880199197e4cceff95820181866abcecd` | provenance header only |
| `contracts/vendor/openzeppelin/LICENSE` | `/Users/edwardalvarado/compact-contracts/LICENSE` | clone pin `0e9d659084fe6579dd0ff9c49c17ae710dcca480` | none |

OpenZeppelin sources retain their MIT SPDX headers. The token fork retains its
Apache-2.0 header. The runtime-0.18 conformance adaptation is original test code
derived behaviorally from OpenZeppelin's `FungibleToken.test.ts`; it does not
copy the runtime-0.16 simulator implementation.

**Breaking-change warning:** this fork is not ABI/VK-compatible with upstream
EvmErc20. The constructor has a separate admin argument, generated witnesses
now require `wit_OwnableSK`, mint entry points reject non-owners, and
`burn(value)` is replaced by `_burn(account,value)`. Existing clients and proofs
must regenerate against TokenAA's artifact.

Not vendored — written for this repo: `contracts/S3PureBudget.compact`,
`contracts/S4*.compact`, `src/maintenance.ts`, `src/rejection-matrix.ts`, and the PLAN-02
suites under `src/test/`. `src/maintenance.ts` reimplements the update sequence that
`@midnight-ntwrk/compact-js`'s `ContractExecutable` performs, with the
`ContractOperationVersion` as a parameter — see `spikes/S4-RESULTS.md` for why the SDK path
cannot be used here.

## PLAN-05 relayer & signer port

Ported 2026-08-11 for PLAN-05 from `/Users/edwardalvarado/midnight-evm-compat/evm-relayer`
@ `3703317` (working clone: `/Users/edwardalvarado/todo/AA/experiments/evm-relayer`) —
PART-E, running live. Ports are BEHAVIORAL (rewritten against this repo's
vendored providers/contract-ops instead of evm-relayer's own submit plumbing),
not verbatim copies:

| This repo | Upstream shape | Local changes |
|---|---|---|
| `src/signer.ts` | `relayer/payload.ts` (EIP-191 digest, 65-byte split, noble recovery, flipS) | retargeted at the frozen 176-byte `MIDNIGHT_ACCOUNT_V1`; generic-length EIP-191; low-s normalization added; field parsing via PAYLOAD.md offsets |
| `src/relayer/core.ts` | `relayer/server.ts` `RelayerCore` (async queue, idempotence-per-digest, recover-and-bind before accept) | multi-token REGISTRY routed by the payload's token field; R7 nonce ordering; per-from rate limiting; no postgres tx_index (that was Part B's evm-rpc bridge); submits via this repo's `contract-ops.ts` |
| `src/relayer/server.ts` | `relayer/server.ts` `makeHttpServer` + `relayer/serve.ts` (CORS) | `/registry` route added; raw-tx path NOT ported (no relayer-attested circuit exists on the AA call tree — PLAN-05 §Questions) |
| `src/relayer/capture-fixture.ts` | `relayer/capture-fixture.ts` | 176-byte payload; verification through `src/signer.ts` before save |
| `src/vectors/metamask-personal-sign-part-e.json` | `circuits/test/fixtures/metamask-personal-sign.json` | vendored verbatim (a REAL MetaMask signature — see `src/vectors/README.md`) |
