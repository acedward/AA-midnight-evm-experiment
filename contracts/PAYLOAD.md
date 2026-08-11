# Account payload encoding — MIDNIGHT_ACCOUNT_V1 (FROZEN 2026-08-11)

Byte-exact spec for the message an EVM wallet signs via `personal_sign` and the
account-abstraction call tree (token root → `Account.validate`) verifies.
**Any byte change here is a NEW version (`MIDNIGHT_ACCOUNT_V2`) — never edit.**
Circuit (`Account.compact`, `MiniTokenAA.compact`, PLAN-04's `TokenAA`),
TS builder (`src/account-payload.ts`), and tests must stay byte-identical;
`src/test/account-payload.test.ts` (gate G3.1) enforces the three-way parity.

Extends PART-E's frozen `MIDNIGHT_EVM_AUTH_V1`
(`/Users/edwardalvarado/midnight-evm-compat/evm-relayer/circuits/PAYLOAD.md`)
with the operation selector, token address, and account address, so one
signature can never cross ops, tokens, accounts, or chains.

## Message (176 bytes, big-endian, fixed-width)

Spec-freeze decisions (PLAN-03 §1 delegated them to the executing agent;
recorded here per the PART-E precedent):

- **Total width 176 bytes** — the "widen" option. `amount` is a 16-byte
  `uint128` appended after `nonce`; 3 reserved zero bytes square the total to
  176 = 16 × 11. All draft offsets up to byte 157 are unchanged.
- **The PLAN-03 draft's prefix math was wrong and is corrected here**: the
  EIP-191 prefix for a 3-digit message length is **29 bytes**, not 31 (PART-E
  precedent: 128-byte message → 157-byte preimage). For 176 the preimage is
  **205 bytes**, not 191.
- **Replay authority = the consumed-digest set, ONLY** (the plan's stated
  default after the S1 review). There is no ledger nonce and `validate` takes
  no nonce argument: with `validate` a public entry point (no
  `kernel.caller()` on this lane), any strictly-sequential ledger nonce adds a
  griefing vector (garbage-digest nonce bumps) the digest set doesn't have.
  The payload `nonce` is still signed — it makes otherwise-identical intents
  hash to distinct digests and gives clients/relayers an ordering handle —
  but ordering is enforced off-chain (PLAN-05).

| bytes      | field     | encoding                                                            |
| ---------- | --------- | ------------------------------------------------------------------- |
| 0 .. 32    | domainTag | `keccak256("MIDNIGHT_ACCOUNT_V1" ‖ uint256_be(chainId=2400))`       |
| 32 .. 33   | op        | operation selector: `0x01` TRANSFER (`0x02` APPROVE, `0x03` OWNER_OP reserved, unimplemented in V1; high bits reserved for a recipient-type tag) |
| 33 .. 65   | token     | Midnight contract address of the token (32 bytes)                   |
| 65 .. 97   | account   | Midnight contract address of the account (32 bytes)                 |
| 97 .. 117  | from      | 20-byte eth address; MUST equal `secp256k1EthereumAddress(pk)`      |
| 117 .. 149 | to        | recipient identity (32 bytes): zero-left-padded eth address or OZ accountId, credited on the LEFT balance arm in V1 |
| 149 .. 157 | nonce     | `uint64` big-endian; digest uniqueness + client-side ordering (see decision above) |
| 157 .. 173 | amount    | `uint128` big-endian                                                |
| 173 .. 176 | reserved  | 3 × `0x00`; circuit asserts each byte is zero                       |

Constants for chainId **2400** (the lane's EVM-compat chain id, PART-E
convention):

```
domainTag = 0x6d70903b12a9880d4e1e038445929b286a9786f3451a8a43591be9821f1810fb
          = keccak256(ascii"MIDNIGHT_ACCOUNT_V1" ‖ 0x…0960 (32-byte BE 2400))
```

## EIP-191 framing (what is actually keccak-hashed)

`personal_sign` of a 176-byte message hashes:

```
preimage = "\x19Ethereum Signed Message:\n176" ‖ message      (29 + 176 = 205 bytes)
digest   = keccak256(preimage)                                 (32 bytes)
prefix hex = 19457468657265756d205369676e6564204d6573736167653a0a313736
```

The prefix is a compile-time constant in the circuits (`Bytes<29>`); the
in-circuit preimage is the constant-size 205-byte concatenation hashed with
`keccak256<Bytes<205>>`.

## Binding properties (each has a rejection-matrix case)

The signature covers ALL fields. The digest therefore binds:

| dimension       | field(s)         | rejection case | enforced by                                 |
| --------------- | ---------------- | -------------- | ------------------------------------------- |
| chain + version | domainTag        | R11            | root asserts bytes 0..32 == constant        |
| operation       | op               | R10            | root asserts `op == 0x01` on the transfer path |
| token           | token            | R8             | root asserts bytes 33..65 == `kernel.self().bytes` |
| account         | account          | R9             | root asserts bytes 65..97 == the `ContractAddress` **returned** by `validate` (`kernel.self()` inside the account's own proof — the handle is never trusted) |
| owner           | from             | R4             | root asserts `secp256k1EthereumAddress(pk) == from`; account asserts `signer == owner` |
| single use      | digest (all bytes) | R6, R2       | account's `consumedDigests` set — malleability-proof: `(r,s)` and `(r,n−s)` share one digest |
| any field       | (each)           | R5             | tampering any byte changes the digest; the signature no longer verifies |

## Signature & public key transport

Same as PART-E (pattern (a), recorded there): the relayer computes the digest,
recovers `pk` off-circuit, and submits `(payload, {r, s}, {x, y})`. The pk is
an UNTRUSTED circuit argument — a forged pk fails `secp256k1EcdsaVerify`, a
valid-but-foreign pk fails the `from` address bind. All crypto runs in the
TOKEN ROOT; only `(signer, digest)` bytes cross the CCC boundary (S1b: secp
types across the boundary crash the zkir backend — compiler-enforced rule).

## Known-answer vector (fixture-frozen; asserted by G3.1 tests)

```
priv    = 4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318
from    = 0x2c7536e3605d9c16a7a3d7b1898e529396a65c23
op      = 0x01 (TRANSFER)
token   = 0xaa × 32
account = 0xbb × 32
to      = 0x000000000000000000000000 ‖ 0xcc × 20   (padded eth address)
nonce   = 7
amount  = 1000000

payload =
6d70903b12a9880d4e1e038445929b286a9786f3451a8a43591be9821f1810fb01aaaaaaaaaa
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbb
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2c7536e3605d9c16a7a3d7b1898e529396
a65c23000000000000000000000000cccccccccccccccccccccccccccccccccccccccc000000
0000000007000000000000000000000000000f4240000000

digest  = 799396dce9e909121f8bd1cbb44fd41a9d1e0b03122bb63d85f8de8ae5b80111
sig.r   = ef3d7a3cea6a873e1c907689b299269f40e99e22afcac4118c7c6bb48b45c1c2
sig.s   = 21b11b0579e3c951c1b27440ccf8a9404c66fbe2e247e7eec6fc5b30762a545e
```

## What the circuits enforce (the accountTransfer check chain)

In the token root (`MiniTokenAA.accountTransfer`; PLAN-04's `TokenAA` ports
this verbatim in front of OZ `_update`):

1. `payload[173..176] == 0` (reserved zero),
2. `payload[0..32] == domainTag` (chain + version bind),
3. `payload[32] == 0x01` (op bind),
4. `payload[33..65] == kernel.self().bytes` (token bind),
5. `digest = keccak256(prefix ‖ payload)` (EIP-191, in-circuit),
6. `secp256k1EcdsaVerify(digest, sig, pk)`,
7. `secp256k1EthereumAddress(pk) == payload.from` (owner key bind),
8. `validated = account.validate(from, digest)` (the CCC hop),
9. `validated.bytes == payload.account` (account bind — against the RETURNED address),
10. balance movement keyed by `validated` (right arm), credit to `to` (left arm).

In the account (`Account.validate`):

1. `signer == owner`,
2. `digest ∉ consumedDigests`, then insert (single use).

Every assert aborts the WHOLE transaction atomically — a rejected root call
reverts the account's digest insert too (S1 step 2/3, proven live).
