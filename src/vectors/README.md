<!--
This file is part of compact-end-2-end.
Copyright (C) Midnight Foundation
SPDX-License-Identifier: Apache-2.0
-->

# Vendored test vectors

## `ecdsa_secp256k1_sha256_bitcoin_test.json`

Project Wycheproof ECDSA / secp256k1 / SHA-256 **Bitcoin** verification vectors,
vendored verbatim from the community-maintained C2SP fork.

| field              | value                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| Source             | https://github.com/C2SP/wycheproof/blob/main/testvectors_v1/ecdsa_secp256k1_sha256_bitcoin_test.json |
| Upstream commit    | `e0df04e0c033f2d25c5051dd06230336c7822358` (2025-10-07)                                              |
| `generatorVersion` | `0.9rc5`                                                                                             |
| `numberOfTests`    | 463 (162 `valid`, 301 `invalid`) across 99 groups                                                    |
| SHA-256            | `27c848b8cfa4e3f3bfbda27971542dd9b827e393842d5549fdfdf1923771c756`                                   |
| Schema             | `ecdsa_bitcoin_verify_schema.json` (group `type: EcdsaBitcoinVerify`)                                |
| License            | Apache-2.0 (Project Wycheproof)                                                                      |

Each group fixes one secp256k1 public key (`publicKey.uncompressed` = `04 ‖ wx ‖ wy`);
each test is `{ tcId, comment, flags[], msg, sig, result }`, where `sig` is the
DER `SEQUENCE { INTEGER r, INTEGER s }`, `msg` is the raw message, and the signed
digest is `e = SHA-256(msg)` (single SHA-256 — "bitcoin" refers to low-s
enforcement, not double hashing).

The vectors are consumed by [`../wycheproof.ts`](../wycheproof.ts). To refresh,
re-download from the URL above and update the commit / SHA-256 row.

## `keyaddrtest.json`

Canonical secp256k1 key → Ethereum address vectors, vendored verbatim from the
official Ethereum consensus-test suite.

| field   | value                                                                      |
| ------- | -------------------------------------------------------------------------- |
| Source  | https://github.com/ethereum/tests/blob/develop/BasicTests/keyaddrtest.json |
| SHA-256 | `a1259937aa93b5e9e2682159f380b8d596f91b360a207fe8e95da829a26004d2`         |
| License | MIT (ethereum/tests)                                                       |
| Entries | 2 (`seed`s `cow`, `horse`)                                                 |

Each entry is `{ seed, key, addr, sig_of_emptystring{v,r,s} }`, where `key` is the
32-byte private scalar (`= keccak256(seed)`, brain-wallet style), `addr` is the
real Ethereum address `keccak256(x_be ‖ y_be)[12:32)`, and `sig_of_emptystring` is
an ECDSA signature over `keccak256("")` (`r`/`s` as decimal, `v` ∈ {27,28}).

Consumed by [`../pure/ethereum-address-kat.ts`](../pure/ethereum-address-kat.ts):
`secp256k1-std-eth-address-kat` holds the stdlib `secp256k1EthereumAddress` (a
non-Ethereum encoding) to `addr`, which it does NOT match — an expected failure
that surfaces the divergence (caught and logged so the case stays green). To
refresh, re-download from the URL above and update the SHA-256 row.

## `metamask-personal-sign-part-e.json`

A REAL MetaMask `personal_sign` signature over PART-E's frozen 128-byte
`MIDNIGHT_EVM_AUTH_V1` payload, vendored verbatim from the live evm-relayer
project (captured there by a human click through
`relayer/capture-fixture.ts`).

| field   | value                                                                              |
| ------- | ----------------------------------------------------------------------------------- |
| Source  | `/Users/edwardalvarado/midnight-evm-compat/evm-relayer` `circuits/test/fixtures/metamask-personal-sign.json` |
| Revision| `3703317` (clone: `todo/AA/experiments/evm-relayer`)                                |
| Signer  | `0x5559080b33b673ded41b62ca23ca21b51bd8974a` (throwaway key, PART-E E-G2)           |

Consumed by `src/test/relayer-signer.test.ts` (gate G5.1): it pins THIS repo's
generic EIP-191 framing + off-circuit recovery (`src/signer.ts`) to bytes a
real wallet produced, with no human click in the loop. The payload is PART-E's
128-byte format, NOT `MIDNIGHT_ACCOUNT_V1` — only the mechanics are shared.

## `metamask-personal-sign-account.json` (captured, not vendored)

The SAME real-wallet evidence for the frozen 176-byte `MIDNIGHT_ACCOUNT_V1`
payload — gate G5.4. Captured locally (one human click) by
`src/relayer/capture-fixture.ts`; the G5.4 suite in
`src/test/relayer-signer.test.ts` skips itself until this file exists.
