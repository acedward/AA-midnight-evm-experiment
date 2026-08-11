// MIDNIGHT_ACCOUNT_V1 — the TypeScript side of the frozen payload spec.
//
// The byte-exact specification is contracts/PAYLOAD.md (FROZEN). This module is
// one of its three implementations; the other two are the pure-circuit oracles
// on Account.compact (`computePayload` / `computeDigest`) and whatever an EVM
// wallet does to a 176-byte message under `personal_sign`. The G3.1 parity
// tests (src/test/account-payload.test.ts) hold all three to the same bytes —
// the anti-encoding-drift discipline PLAN-03 §5 carries from passport/PART-E.
//
// Any change here that moves a byte is a NEW payload version, never an edit.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

import { bytesToHex, hexToBytes } from "./hex.ts";
import type { AffinePoint, EcdsaScalars } from "./secp256k1-vectors.ts";
import { pubkeyPoint } from "./secp256k1-vectors.ts";

// ── Frozen constants (PAYLOAD.md — version the tag, never edit) ─────────────

export const PAYLOAD_VERSION = "MIDNIGHT_ACCOUNT_V1";
export const CHAIN_ID = 2400n;
export const PAYLOAD_LENGTH = 176;

/** keccak256("MIDNIGHT_ACCOUNT_V1" ‖ uint256_be(2400)) — the frozen value. */
export const DOMAIN_TAG_HEX = "6d70903b12a9880d4e1e038445929b286a9786f3451a8a43591be9821f1810fb";

/** `"\x19Ethereum Signed Message:\n176"` — 29 bytes, EIP-191 for a 176-byte message. */
export const EIP191_PREFIX_HEX = "19457468657265756d205369676e6564204d6573736167653a0a313736";

/** Operation selectors (byte 32). */
export const OP_TRANSFER = 0x01;
export const OP_APPROVE = 0x02; // reserved, not implemented in V1
export const OP_OWNER_OP = 0x03; // reserved, not implemented in V1

/** Field offsets, byte-exact per PAYLOAD.md. */
export const OFFSETS = {
  domainTag: [0, 32],
  op: [32, 33],
  token: [33, 65],
  account: [65, 97],
  from: [97, 117],
  to: [117, 149],
  nonce: [149, 157],
  amount: [157, 173],
  reserved: [173, 176],
} as const;

/** Recompute the domain tag from first principles (the drift guard uses this). */
export function computeDomainTag(chainId: bigint = CHAIN_ID): Uint8Array {
  const tag = new TextEncoder().encode(PAYLOAD_VERSION);
  const chain = uintToBe(chainId, 32);
  return keccak_256(concat(tag, chain));
}

// ── Field encoding helpers ──────────────────────────────────────────────────

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Big-endian fixed-width unsigned integer. Throws if the value does not fit. */
export function uintToBe(value: bigint, width: number): Uint8Array {
  if (value < 0n) throw new RangeError("negative value");
  const out = new Uint8Array(width);
  let v = value;
  for (let i = width - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new RangeError(`value does not fit in ${width} bytes`);
  return out;
}

/** A 20-byte eth address, zero-LEFT-padded to the 32-byte identity arm. */
export function padEthAddress(addr: Uint8Array | string): Uint8Array {
  const bytes = typeof addr === "string" ? hexToBytes(addr) : addr;
  if (bytes.length !== 20) throw new RangeError("eth address must be 20 bytes");
  const out = new Uint8Array(32);
  out.set(bytes, 12);
  return out;
}

function expectLength(name: string, bytes: Uint8Array, length: number): Uint8Array {
  if (bytes.length !== length) {
    throw new RangeError(`${name} must be ${length} bytes, got ${bytes.length}`);
  }
  return bytes;
}

// ── The builder ─────────────────────────────────────────────────────────────

export interface PayloadFields {
  /** Operation selector; V1 implements only OP_TRANSFER. */
  op: number;
  /** Token contract address, 32 bytes. */
  token: Uint8Array;
  /** Account contract address, 32 bytes. */
  account: Uint8Array;
  /** Owner eth address, 20 bytes — MUST equal address(pk) of the signer. */
  from: Uint8Array;
  /** Recipient identity, 32 bytes (left balance arm: padded eth addr / accountId). */
  to: Uint8Array;
  /** uint64 — client-side ordering + digest uniqueness (digest set is the replay authority). */
  nonce: bigint;
  /** uint128 — token amount. */
  amount: bigint;
}

/** Assemble the 176-byte MIDNIGHT_ACCOUNT_V1 message. */
export function buildPayload(fields: PayloadFields): Uint8Array {
  if (!Number.isInteger(fields.op) || fields.op < 0 || fields.op > 0xff) {
    throw new RangeError("op must be a single byte");
  }
  const payload = concat(
    hexToBytes(DOMAIN_TAG_HEX),
    Uint8Array.of(fields.op),
    expectLength("token", fields.token, 32),
    expectLength("account", fields.account, 32),
    expectLength("from", fields.from, 20),
    expectLength("to", fields.to, 32),
    uintToBe(fields.nonce, 8),
    uintToBe(fields.amount, 16),
    new Uint8Array(3), // reserved, MUST be zero
  );
  if (payload.length !== PAYLOAD_LENGTH) {
    throw new Error(`internal: built ${payload.length} bytes, spec says ${PAYLOAD_LENGTH}`);
  }
  return payload;
}

/** The EIP-191 digest — what `personal_sign` signs and the circuits recompute. */
export function eip191Digest(payload: Uint8Array): Uint8Array {
  expectLength("payload", payload, PAYLOAD_LENGTH);
  return keccak_256(concat(hexToBytes(EIP191_PREFIX_HEX), payload));
}

// ── Signing (the relayer/test stand-in for MetaMask) ────────────────────────

export interface SignedAccountPayload {
  fields: PayloadFields;
  payload: Uint8Array;
  digest: Uint8Array;
  sig: EcdsaScalars;
  pk: AffinePoint;
  /** Signer's eth address, `0x` + 40 hex — equals the payload's `from`. */
  ethAddr: string;
}

/** The eth address of a private key, as `personal_sign`'s account would be. */
export function ethAddressOfPriv(privHex: string): string {
  const uncompressed = secp256k1.getPublicKey(hexToBytes(privHex), false);
  return `0x${bytesToHex(keccak_256(uncompressed.slice(1)).slice(12))}`;
}

/**
 * Build and sign a payload the way MetaMask's `personal_sign` would: the
 * secp256k1 signature is over the EIP-191 keccak digest of the 176-byte
 * message. `from` defaults to the signing key's own address (the only value
 * that can pass the circuit's address bind).
 */
export function signAccountPayload(
  privHex: string,
  fields: Omit<PayloadFields, "from"> & { from?: Uint8Array },
): SignedAccountPayload {
  const from = fields.from ?? hexToBytes(ethAddressOfPriv(privHex));
  const full: PayloadFields = { ...fields, from };
  const payload = buildPayload(full);
  const digest = eip191Digest(payload);
  const signature = secp256k1.Signature.fromBytes(
    secp256k1.sign(digest, hexToBytes(privHex), { prehash: false }),
  );
  return {
    fields: full,
    payload,
    digest,
    sig: { r: signature.r, s: signature.s },
    pk: pubkeyPoint(privHex),
    ethAddr: ethAddressOfPriv(privHex),
  };
}
