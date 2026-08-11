// PLAN-03 gate G3.1 — the frozen payload, held to three-way parity at layer 1.
//
// contracts/PAYLOAD.md is the specification; this suite is what "frozen" means
// operationally. Three implementations of MIDNIGHT_ACCOUNT_V1 must produce the
// same bytes:
//
//   1. the TS builder (src/account-payload.ts) — what the relayer/signer uses,
//   2. the pure-circuit oracles on Account.compact (`computePayload`,
//      `computeDigest`) — the contract's own statement of the encoding,
//      called via `pureCircuits` with zero proofs (spike S3),
//   3. the fixture-frozen known-answer vector in PAYLOAD.md — so a coordinated
//      drift of builder AND oracle still fails loudly (PART-E precedent).
//
// Plus the per-field binding half of the rejection matrix that lives at this
// layer: tampering ANY field changes the digest, so the original signature no
// longer verifies (R5) — the property every cross-scope rejection (R8–R11)
// ultimately rests on.

import { beforeAll, describe, expect, it } from "vitest";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

import {
  CHAIN_ID,
  DOMAIN_TAG_HEX,
  EIP191_PREFIX_HEX,
  OFFSETS,
  OP_TRANSFER,
  PAYLOAD_LENGTH,
  buildPayload,
  computeDomainTag,
  eip191Digest,
  ethAddressOfPriv,
  padEthAddress,
  signAccountPayload,
} from "../account-payload.ts";
import { loadCompiledModule } from "../compiled.ts";
import { compileContract } from "../compile.ts";
import { contractByName } from "../contracts.ts";
import { bytesToHex, hexToBytes } from "../hex.ts";
import type { AffinePoint, EcdsaScalars } from "../secp256k1-vectors.ts";

interface AccountPureCircuits {
  payloadDomainTag(): Uint8Array;
  computePayload(
    op: Uint8Array,
    token: Uint8Array,
    account: Uint8Array,
    fromAddr: Uint8Array,
    to: Uint8Array,
    nonce: bigint,
    amount: bigint,
  ): Uint8Array;
  computeDigest(payload: Uint8Array): Uint8Array;
  signerAddress(pk: AffinePoint): Uint8Array;
}

let pure: AccountPureCircuits;

beforeAll(async () => {
  const { managedDir } = compileContract(contractByName("Account"));
  const loaded = await loadCompiledModule(managedDir);
  pure = (loaded.module as unknown as { pureCircuits: AccountPureCircuits }).pureCircuits;
}, 600_000);

const PRIV = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";

/** The PAYLOAD.md known-answer vector, verbatim. */
const KAT = {
  from: "0x2c7536e3605d9c16a7a3d7b1898e529396a65c23",
  fields: {
    op: OP_TRANSFER,
    token: new Uint8Array(32).fill(0xaa),
    account: new Uint8Array(32).fill(0xbb),
    to: padEthAddress(`0x${"cc".repeat(20)}`),
    nonce: 7n,
    amount: 1_000_000n,
  },
  payload:
    "6d70903b12a9880d4e1e038445929b286a9786f3451a8a43591be9821f1810fb01aaaaaaaaaa" +
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbb" +
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2c7536e3605d9c16a7a3d7b1898e529396" +
    "a65c23000000000000000000000000cccccccccccccccccccccccccccccccccccccccc000000" +
    "0000000007000000000000000000000000000f4240000000",
  digest: "799396dce9e909121f8bd1cbb44fd41a9d1e0b03122bb63d85f8de8ae5b80111",
  sigR: "ef3d7a3cea6a873e1c907689b299269f40e99e22afcac4118c7c6bb48b45c1c2",
  sigS: "21b11b0579e3c951c1b27440ccf8a9404c66fbe2e247e7eec6fc5b30762a545e",
};

/** A second, non-KAT field set — edge values the KAT doesn't exercise. */
const EDGE_FIELDS = {
  op: OP_TRANSFER,
  token: Uint8Array.from({ length: 32 }, (_, i) => i),
  account: Uint8Array.from({ length: 32 }, (_, i) => 255 - i),
  to: new Uint8Array(32).fill(0x01),
  nonce: 0xffff_ffff_ffff_ffffn, // uint64 max
  amount: (1n << 128n) - 1n, // uint128 max
};

function nobleVerify(sig: EcdsaScalars, digest: Uint8Array, pk: AffinePoint): boolean {
  const compact = new Uint8Array(64);
  compact.set(hexToBytes(sig.r.toString(16).padStart(64, "0")), 0);
  compact.set(hexToBytes(sig.s.toString(16).padStart(64, "0")), 32);
  return secp256k1.verify(compact, digest, secp256k1.Point.fromAffine(pk).toBytes(false), {
    lowS: false,
    prehash: false,
  });
}

describe("G3.1 — frozen constants", () => {
  it("the domain tag is keccak256(version ‖ chainId), and the frozen hex matches", () => {
    expect(CHAIN_ID).toBe(2400n);
    expect(bytesToHex(computeDomainTag())).toBe(DOMAIN_TAG_HEX);
  });

  it("the EIP-191 prefix is the 29-byte \\x19…\\n176 constant", () => {
    const prefix = hexToBytes(EIP191_PREFIX_HEX);
    expect(prefix).toHaveLength(29);
    expect(new TextDecoder().decode(prefix)).toBe("\x19Ethereum Signed Message:\n176");
  });

  it("the contract's own domain tag agrees (oracle == TS constant)", () => {
    expect(bytesToHex(pure.payloadDomainTag())).toBe(DOMAIN_TAG_HEX);
  });
});

describe("G3.1 — three-way payload parity (builder == oracle == fixture)", () => {
  it("the TS builder reproduces the PAYLOAD.md known-answer vector byte for byte", () => {
    const signed = signAccountPayload(PRIV, KAT.fields);
    expect(signed.ethAddr).toBe(KAT.from);
    expect(bytesToHex(signed.payload)).toBe(KAT.payload);
    expect(bytesToHex(signed.digest)).toBe(KAT.digest);
    // Deterministic (RFC 6979) signing — the fixture pins the exact scalars.
    expect(signed.sig.r.toString(16)).toBe(KAT.sigR);
    expect(signed.sig.s.toString(16)).toBe(KAT.sigS);
  });

  it("the pure-circuit oracle assembles the SAME bytes from the same fields", () => {
    for (const fields of [KAT.fields, EDGE_FIELDS]) {
      const ts = buildPayload({ ...fields, from: hexToBytes(ethAddressOfPriv(PRIV)) });
      const oracle = pure.computePayload(
        Uint8Array.of(fields.op),
        fields.token,
        fields.account,
        hexToBytes(ethAddressOfPriv(PRIV)),
        fields.to,
        fields.nonce,
        fields.amount,
      );
      expect(bytesToHex(oracle)).toBe(bytesToHex(ts));
    }
  });

  it("the pure-circuit digest equals the TS EIP-191 digest equals raw keccak", () => {
    for (const fields of [KAT.fields, EDGE_FIELDS]) {
      const payload = buildPayload({ ...fields, from: hexToBytes(ethAddressOfPriv(PRIV)) });
      const ts = eip191Digest(payload);
      expect(bytesToHex(pure.computeDigest(payload))).toBe(bytesToHex(ts));
      // First principles: the framing really is prefix ‖ message, nothing else.
      const preimage = new Uint8Array([...hexToBytes(EIP191_PREFIX_HEX), ...payload]);
      expect(preimage).toHaveLength(205);
      expect(bytesToHex(keccak_256(preimage))).toBe(bytesToHex(ts));
    }
  });

  it("the oracle's address derivation matches the TS signer address", () => {
    const signed = signAccountPayload(PRIV, KAT.fields);
    expect(`0x${bytesToHex(pure.signerAddress(signed.pk))}`).toBe(signed.ethAddr);
  });
});

describe("R5 — per-field binding at layer 1 (tamper each field, one at a time)", () => {
  // Every field, including each reserved byte: flip one byte inside the field,
  // and the digest must change — which is exactly why the original signature
  // stops verifying. A field this test could NOT catch would be a field the
  // signature does not cover, i.e. a forgeable field.
  const signed = signAccountPayload(PRIV, KAT.fields);

  for (const [field, [start, end]] of Object.entries(OFFSETS)) {
    it(`tampering '${field}' (bytes ${start}..${end}) changes the digest and kills the signature`, () => {
      for (const at of [start, end - 1]) {
        const tampered = Uint8Array.from(signed.payload);
        tampered[at]! ^= 0x01;
        const digest = eip191Digest(tampered);
        expect(bytesToHex(digest)).not.toBe(bytesToHex(signed.digest));
        expect(nobleVerify(signed.sig, digest, signed.pk)).toBe(false);
      }
    });
  }

  it("the payload is exactly 176 bytes — a length change is a version change", () => {
    expect(signed.payload).toHaveLength(PAYLOAD_LENGTH);
    expect(PAYLOAD_LENGTH).toBe(176);
  });
});
