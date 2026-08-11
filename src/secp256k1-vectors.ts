// Known-answer vectors for the G1.2 secp256k1 prove-cases.
//
// Reduced from compact-end-2-end @ aa344546
// cases/features/secp256k1/src/cases/{wycheproof.ts,eth-address-vectors.ts} to
// the two vector sets the three prove-cases actually drive. The upstream file
// also classifies the whole Wycheproof corpus (DER-parse skips, low-s
// malleability carve-outs); that classification is a property of the corpus, not
// of our stack, so re-running it here would prove nothing new — G1.2 re-runs the
// PROVE cases to time them against OUR proof server.
//
// Vector provenance (src/vectors/README.md carries the upstream notes):
//   keyaddrtest.json                        ethereum/tests BasicTests key->address
//   ecdsa_secp256k1_sha256_bitcoin_test.json  Project Wycheproof secp256k1/SHA-256

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

import { bytesToHex, hexToBytes } from "./hex.ts";

const VECTORS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "vectors");

/** The runtime shape of a Compact `Secp256k1Point` circuit argument. */
export interface AffinePoint {
  readonly x: bigint;
  readonly y: bigint;
  readonly identity: boolean;
}

export interface EcdsaScalars {
  readonly r: bigint;
  readonly s: bigint;
}

// ── ethereum/tests key -> address ──────────────────────────────────────────

interface KeyAddrEntry {
  seed: string;
  key: string;
  addr: string;
}

export interface AddressVector {
  seed: string;
  point: AffinePoint;
  /** The vector's real Ethereum address, `0x` + 40 hex. */
  ethAddr: string;
  privHex: string;
}

/** Affine `{x, y}` public key for a 32-byte private scalar (hex). */
export function pubkeyPoint(privHex: string): AffinePoint {
  const uncompressed = secp256k1.getPublicKey(hexToBytes(privHex), false); // 04 ‖ x_be ‖ y_be
  return {
    x: BigInt(`0x${bytesToHex(uncompressed.slice(1, 33))}`),
    y: BigInt(`0x${bytesToHex(uncompressed.slice(33, 65))}`),
    identity: false,
  };
}

export function loadAddressVectors(): AddressVector[] {
  const raw = JSON.parse(
    fs.readFileSync(path.join(VECTORS_DIR, "keyaddrtest.json"), "utf-8"),
  ) as KeyAddrEntry[];
  return raw.map((e) => ({
    seed: e.seed,
    point: pubkeyPoint(e.key),
    ethAddr: `0x${e.addr.toLowerCase()}`,
    privHex: e.key,
  }));
}

// ── Wycheproof: the one vector the verify prove-case drives ─────────────────

interface WycheproofTest {
  tcId: number;
  comment: string;
  msg: string;
  sig: string;
  result: "valid" | "invalid";
}

interface WycheproofGroup {
  publicKey: { wx: string; wy: string };
  tests: WycheproofTest[];
}

export interface VerifyVector {
  tcId: number;
  comment: string;
  /** Signed digest e = SHA-256(msg), big-endian, 32 bytes. */
  e: Uint8Array;
  sig: EcdsaScalars;
  pk: AffinePoint;
  expectedValid: boolean;
}

/**
 * `k*G has a large x-coordinate` (tcId 346): a VALID signature whose
 * verification point R = u1*G + u2*pk has x > n, so r == R.x - n. It is the
 * vector that exercises the in-circuit modular reduction of the recomputed
 * x-coordinate — the reason the primitive reduces instead of comparing the raw
 * field element. Upstream drives exactly this one in the verify prove-case.
 */
export const LARGE_X_COMMENT = "k*G has a large x-coordinate";

function parseDerInteger(bytes: Uint8Array, offset: number): [bigint, number] {
  if (bytes[offset] !== 0x02) throw new Error(`expected INTEGER tag at ${offset}`);
  const len = bytes[offset + 1]!;
  if (len > 0x7f) throw new Error("long-form length is not strict DER here");
  const slice = bytes.subarray(offset + 2, offset + 2 + len);
  return [BigInt(`0x${bytesToHex(slice)}`), offset + 2 + len];
}

function parseDerSignature(hex: string): EcdsaScalars {
  const bytes = hexToBytes(hex);
  if (bytes[0] !== 0x30) throw new Error("expected SEQUENCE");
  const [r, next] = parseDerInteger(bytes, 2);
  const [s] = parseDerInteger(bytes, next);
  return { r, s };
}

export function largeXCoordinateVector(): VerifyVector {
  const root = JSON.parse(
    fs.readFileSync(path.join(VECTORS_DIR, "ecdsa_secp256k1_sha256_bitcoin_test.json"), "utf-8"),
  ) as { testGroups: WycheproofGroup[] };

  for (const group of root.testGroups) {
    for (const test of group.tests) {
      if (test.comment !== LARGE_X_COMMENT) continue;
      if (test.result !== "valid") {
        throw new Error(`"${LARGE_X_COMMENT}" (tcId ${test.tcId}) is not a valid signature`);
      }
      return {
        tcId: test.tcId,
        comment: test.comment,
        e: sha256(hexToBytes(test.msg)),
        sig: parseDerSignature(test.sig),
        pk: {
          x: BigInt(`0x${group.publicKey.wx.replace(/^0x/, "")}`),
          y: BigInt(`0x${group.publicKey.wy.replace(/^0x/, "")}`),
          identity: false,
        },
        expectedValid: true,
      };
    }
  }
  throw new Error(`no "${LARGE_X_COMMENT}" vector in the Wycheproof corpus`);
}

// ── recovery: a signature plus its R point ─────────────────────────────────

export interface RecoveryVector {
  /** Big-endian 32-byte digest that was signed. */
  msgHash: Uint8Array;
  /** `{r, s, R}` — the Compact `Secp256k1EcdsaSignatureWithRecovery` shape. */
  sig: { r: bigint; s: bigint; R: { x: bigint; y: bigint } };
  /** Expected Ethereum address of the signer, `0x` + 40 hex. */
  ethAddr: string;
}

function ethAddressOf(privateKey: Uint8Array): Uint8Array {
  return keccak_256(secp256k1.getPublicKey(privateKey, false).slice(1)).slice(12);
}

/**
 * The recover prove-case's deterministic vector, identical to upstream's
 * `buildRecoverVector`: private key 42, a fixed big-endian digest.
 *
 * R (the nonce commitment) is supplied by the prover off-circuit — the circuit
 * re-binds it by asserting `R.x == r`, which avoids an in-circuit square
 * root/liftX. Lifting R from `r` + the recovery parity bit (0x02 even-y,
 * 0x03 odd-y) is exactly that off-circuit step.
 */
export function recoveryVector(): RecoveryVector {
  const privateKey = new Uint8Array(32);
  privateKey[31] = 0x2a;
  const msgHash = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff);

  const signature = secp256k1.Signature.fromBytes(
    secp256k1.sign(msgHash, privateKey, { prehash: false, format: "recovered" }),
    "recovered",
  );
  const prefix = signature.recovery === 0 ? "02" : "03";
  const R = secp256k1.Point.fromHex(prefix + signature.r.toString(16).padStart(64, "0")).toAffine();

  return {
    msgHash,
    sig: { r: signature.r, s: signature.s, R: { x: R.x, y: R.y } },
    ethAddr: `0x${bytesToHex(ethAddressOf(privateKey))}`,
  };
}
