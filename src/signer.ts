// PLAN-05 §1 — the EVM signer client: the wire between `personal_sign` and the
// circuit argument tuple.
//
// Ported in mechanics from evm-relayer @ 3703317 (relayer/payload.ts, PART-E,
// live) onto the frozen MIDNIGHT_ACCOUNT_V1 payload (contracts/PAYLOAD.md,
// src/account-payload.ts — PLAN-03, byte-frozen). The split of labor:
//
//   - account-payload.ts owns the 176-byte payload bytes and scalar signing
//     (frozen with PLAN-03 — nothing here may move a byte);
//   - this module owns the WIRE forms an EVM wallet actually produces and the
//     relayer actually receives: the 65-byte `r‖s‖v` signature, off-circuit
//     public-key recovery, low-s normalization, and payload field parsing.
//
// Recovery follows PART-E pattern (a), soundness-equal to in-circuit ecrecover:
// the recovered pk is an UNTRUSTED circuit argument — a forged pk fails
// `secp256k1EcdsaVerify`, a valid-but-foreign pk fails the `from` address bind.
// `prehash: false` everywhere: the EIP-191 keccak digest IS the signed message.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

import {
  OFFSETS,
  PAYLOAD_LENGTH,
  eip191Digest,
  type PayloadFields,
} from "./account-payload.ts";
import { bytesToHex, hexToBytes } from "./hex.ts";
import { SECP256K1_N, type AffinePoint, type EcdsaScalars } from "./secp256k1-vectors.ts";

// ── Generic EIP-191 mechanics (any message length) ──────────────────────────
//
// The 176-byte digest lives in account-payload.ts. This generic form exists so
// the PART-E real-MetaMask fixture (128-byte MIDNIGHT_EVM_AUTH_V1) can pin the
// framing + recovery mechanics to a signature a REAL wallet produced — the
// byte-parity evidence G5.1 wants without a fresh human click.

/** `keccak256("\x19Ethereum Signed Message:\n" + ascii(len) + message)`. */
export function eip191DigestOf(message: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length}`);
  const preimage = new Uint8Array(prefix.length + message.length);
  preimage.set(prefix, 0);
  preimage.set(message, prefix.length);
  return keccak_256(preimage);
}

// ── The 65-byte wire signature ───────────────────────────────────────────────

/**
 * Sign `message` exactly as MetaMask `personal_sign` does, returning the wire
 * form: `r‖s‖v`, v ∈ {27, 28}. Deterministic (RFC 6979) — byte-identical to
 * MetaMask's output for the same key and message (proven in PART-E E-G2).
 */
export function personalSign(privHex: string, message: Uint8Array): Uint8Array {
  const digest = eip191DigestOf(message);
  const sig = secp256k1.Signature.fromBytes(
    secp256k1.sign(digest, hexToBytes(privHex), { prehash: false, format: "recovered" }),
    "recovered",
  );
  const out = new Uint8Array(65);
  out.set(hexToBytes(sig.r.toString(16).padStart(64, "0")), 0);
  out.set(hexToBytes(sig.s.toString(16).padStart(64, "0")), 32);
  out[64] = 27 + (sig.recovery ?? 0);
  return out;
}

/**
 * Normalize a wire signature to low-s. Tidiness for clients ONLY — the circuit
 * accepts both twins and replay-protects on the digest, never on signature
 * bytes (PLAN-00 §3.3); nothing may RELY on this being applied.
 */
export function normalizeLowS(signature65: Uint8Array): Uint8Array {
  const { r, s, recovery } = splitSignature(signature65);
  if (s <= SECP256K1_N >> 1n) return Uint8Array.from(signature65);
  const out = new Uint8Array(65);
  out.set(hexToBytes(r.toString(16).padStart(64, "0")), 0);
  out.set(hexToBytes((SECP256K1_N - s).toString(16).padStart(64, "0")), 32);
  out[64] = 27 + (recovery ^ 1); // flipping s flips the recovered point's parity
  return out;
}

function splitSignature(signature65: Uint8Array): { r: bigint; s: bigint; recovery: number } {
  if (signature65.length !== 65) {
    throw new RangeError(`signature must be 65 bytes (r||s||v), got ${signature65.length}`);
  }
  const r = BigInt(`0x${bytesToHex(signature65.slice(0, 32))}`);
  const s = BigInt(`0x${bytesToHex(signature65.slice(32, 64))}`);
  // MetaMask emits v ∈ {27, 28} for personal_sign; accept raw 0/1 too.
  const v = signature65[64]!;
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) throw new RangeError(`invalid recovery byte ${v}`);
  return { r, s, recovery };
}

// ── Recovery: wire signature → circuit argument tuple ───────────────────────

export interface AuthTuple {
  /** The signed message, verbatim. */
  payload: Uint8Array;
  /** EIP-191 digest of `payload` — the replay key and the eth-style tx hash. */
  digest: Uint8Array;
  /** Circuit argument: `Secp256k1EcdsaSignature { r, s }`. */
  sig: EcdsaScalars;
  /** Circuit argument: the recovered public key, UNTRUSTED by construction. */
  pk: AffinePoint;
  /** `keccak(pk.x‖pk.y)[12:]` — must equal the payload's `from` field. */
  signer: Uint8Array;
}

/**
 * Turn a message + 65-byte wallet signature into the circuit argument tuple:
 * recover the public key off-circuit (noble, over the EIP-191 digest), derive
 * the signer address. Works for any fixed-width message; the MIDNIGHT_ACCOUNT_V1
 * field binding is `parseAccountPayload` + the caller's `from` check.
 */
export function tupleFromEthSignature(message: Uint8Array, signature65: Uint8Array): AuthTuple {
  const { r, s, recovery } = splitSignature(signature65);
  const digest = eip191DigestOf(message);
  const point = new secp256k1.Signature(r, s, recovery).recoverPublicKey(digest).toAffine();
  const pk: AffinePoint = { x: point.x, y: point.y, identity: false };
  return { payload: message, digest, sig: { r, s }, pk, signer: ethAddressOfPk(pk) };
}

/** The Ethereum address of an affine public key: `keccak256(x_be ‖ y_be)[12:]`. */
export function ethAddressOfPk(pk: AffinePoint): Uint8Array {
  const uncompressed = new Uint8Array(64);
  uncompressed.set(hexToBytes(pk.x.toString(16).padStart(64, "0")), 0);
  uncompressed.set(hexToBytes(pk.y.toString(16).padStart(64, "0")), 32);
  return keccak_256(uncompressed).slice(12);
}

// ── MIDNIGHT_ACCOUNT_V1 field parsing (offsets from the frozen spec) ─────────

export interface ParsedAccountPayload extends PayloadFields {
  domainTag: Uint8Array;
  reserved: Uint8Array;
}

/** Split a 176-byte payload into its named fields — the builder's inverse. */
export function parseAccountPayload(payload: Uint8Array): ParsedAccountPayload {
  if (payload.length !== PAYLOAD_LENGTH) {
    throw new RangeError(`payload must be ${PAYLOAD_LENGTH} bytes, got ${payload.length}`);
  }
  const field = (name: keyof typeof OFFSETS) =>
    payload.slice(OFFSETS[name][0], OFFSETS[name][1]);
  return {
    domainTag: field("domainTag"),
    op: payload[OFFSETS.op[0]]!,
    token: field("token"),
    account: field("account"),
    from: field("from"),
    to: field("to"),
    nonce: BigInt(`0x${bytesToHex(field("nonce"))}`),
    amount: BigInt(`0x${bytesToHex(field("amount"))}`),
    reserved: field("reserved"),
  };
}

/** Convenience: the 176-byte digest via the frozen path (account-payload.ts). */
export { eip191Digest };
