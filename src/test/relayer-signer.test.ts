// PLAN-05 gates G5.1 + G5.2 (and the self-unskipping half of G5.4) — the
// signer client, held to the same anti-drift discipline as the payload itself.
//
//   G5.1  the TS digest builder == the pure-circuit oracle for RANDOM payloads
//         (property test), and the generic EIP-191 + recovery mechanics ==
//         a REAL MetaMask signature (the vendored PART-E fixture).
//   G5.2  a noble-signed 65-byte wire signature round-trips through recovery
//         into a tuple that passes every off-circuit check the circuit
//         re-runs in-proof (verify, from-bind, digest equality) — including
//         its flipped-s twin and the low-s normalized form.
//   G5.4  same as G5.1's fixture leg but over the 176-byte MIDNIGHT_ACCOUNT_V1
//         payload — skips itself until src/relayer/capture-fixture.ts has
//         captured src/vectors/metamask-personal-sign-account.json.
//
// Plus the relayer's validation chain at layer 0 (no wallet, no stack): the
// refusals that must fire BEFORE anything is queued or proven.

import * as fs from "node:fs";
import * as path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { secp256k1 } from "@noble/curves/secp256k1.js";

import {
  DOMAIN_TAG_HEX,
  OP_TRANSFER,
  PAYLOAD_LENGTH,
  buildPayload,
  eip191Digest,
  ethAddressOfPriv,
  padEthAddress,
  signAccountPayload,
  type PayloadFields,
} from "../account-payload.ts";
import { loadCompiledModule } from "../compiled.ts";
import { compileContract } from "../compile.ts";
import { contractByName } from "../contracts.ts";
import { bytesToHex, hexToBytes } from "../hex.ts";
import { RelayerCore, RelayError } from "../relayer/core.ts";
import { flipS, type AffinePoint, type EcdsaScalars } from "../secp256k1-vectors.ts";
import {
  eip191DigestOf,
  ethAddressOfPk,
  normalizeLowS,
  parseAccountPayload,
  personalSign,
  tupleFromEthSignature,
} from "../signer.ts";
import { REPO_ROOT } from "../stack-env.ts";

const VECTORS_DIR = path.join(REPO_ROOT, "src", "vectors");
const PART_E_FIXTURE = path.join(VECTORS_DIR, "metamask-personal-sign-part-e.json");
const ACCOUNT_FIXTURE = path.join(VECTORS_DIR, "metamask-personal-sign-account.json");

const PRIV = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";

interface AccountPureCircuits {
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

// Deterministic PRNG (xorshift32) — a property test that reproduces.
function makeRng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>>= 0);
  };
  return {
    bytes(n: number): Uint8Array {
      return Uint8Array.from({ length: n }, () => next() & 0xff);
    },
    uint(bits: bigint): bigint {
      let v = 0n;
      for (let got = 0n; got < bits; got += 16n) v = (v << 16n) | BigInt(next() & 0xffff);
      return v & ((1n << bits) - 1n);
    },
  };
}

function randomFields(rng: ReturnType<typeof makeRng>): PayloadFields {
  return {
    op: Number(rng.uint(8n)),
    token: rng.bytes(32),
    account: rng.bytes(32),
    from: rng.bytes(20),
    to: rng.bytes(32),
    nonce: rng.uint(64n),
    amount: rng.uint(128n),
  };
}

function nobleVerify(sig: EcdsaScalars, digest: Uint8Array, pk: AffinePoint): boolean {
  const compact = new Uint8Array(64);
  compact.set(hexToBytes(sig.r.toString(16).padStart(64, "0")), 0);
  compact.set(hexToBytes(sig.s.toString(16).padStart(64, "0")), 32);
  return secp256k1.verify(compact, digest, secp256k1.Point.fromAffine(pk).toBytes(false), {
    lowS: false,
    prehash: false,
  });
}

describe("G5.1 — TS digest builder == pure-circuit oracle (property test)", () => {
  it("assembles and hashes 48 RANDOM payloads identically to the contract", () => {
    const rng = makeRng(0x5eed_5105);
    for (let i = 0; i < 48; i++) {
      const fields = randomFields(rng);
      const ts = buildPayload(fields);
      const oracle = pure.computePayload(
        Uint8Array.of(fields.op),
        fields.token,
        fields.account,
        fields.from,
        fields.to,
        fields.nonce,
        fields.amount,
      );
      expect(bytesToHex(oracle), `payload parity, iteration ${i}`).toBe(bytesToHex(ts));
      expect(bytesToHex(pure.computeDigest(ts)), `digest parity, iteration ${i}`).toBe(
        bytesToHex(eip191Digest(ts)),
      );
    }
  });

  it("the generic EIP-191 digest specializes to the frozen 176-byte one", () => {
    const signed = signAccountPayload(PRIV, {
      op: OP_TRANSFER,
      token: new Uint8Array(32).fill(0xaa),
      account: new Uint8Array(32).fill(0xbb),
      to: padEthAddress(`0x${"cc".repeat(20)}`),
      nonce: 7n,
      amount: 1_000_000n,
    });
    expect(bytesToHex(eip191DigestOf(signed.payload))).toBe(bytesToHex(signed.digest));
  });

  it("parseAccountPayload is buildPayload's inverse", () => {
    const rng = makeRng(0xdead_beef);
    const fields = randomFields(rng);
    const parsed = parseAccountPayload(buildPayload(fields));
    expect(bytesToHex(parsed.token)).toBe(bytesToHex(fields.token));
    expect(bytesToHex(parsed.account)).toBe(bytesToHex(fields.account));
    expect(bytesToHex(parsed.from)).toBe(bytesToHex(fields.from));
    expect(bytesToHex(parsed.to)).toBe(bytesToHex(fields.to));
    expect(parsed.op).toBe(fields.op);
    expect(parsed.nonce).toBe(fields.nonce);
    expect(parsed.amount).toBe(fields.amount);
    expect(bytesToHex(parsed.domainTag)).toBe(DOMAIN_TAG_HEX);
  });
});

describe("G5.1 — REAL MetaMask parity (the vendored PART-E fixture)", () => {
  // A signature an actual wallet produced (PART-E E-G2, one human click,
  // 128-byte MIDNIGHT_EVM_AUTH_V1 payload). If our generic EIP-191 framing or
  // recovery drifted by one byte, recovery would yield a DIFFERENT key and the
  // address check below would fail — no human click needed to re-prove it.
  const fixture = JSON.parse(fs.readFileSync(PART_E_FIXTURE, "utf-8")) as {
    payloadHex: string;
    signatureHex: string;
    address: string;
  };

  it("recovers the fixture's signer from the real signature (framing + recovery == MetaMask)", () => {
    const payload = hexToBytes(fixture.payloadHex);
    expect(payload).toHaveLength(128); // PART-E's format, not ours
    const tuple = tupleFromEthSignature(payload, hexToBytes(fixture.signatureHex));
    expect(`0x${bytesToHex(tuple.signer)}`).toBe(fixture.address.toLowerCase());
    expect(nobleVerify(tuple.sig, tuple.digest, tuple.pk)).toBe(true);
    // The known-good PART-E signer, pinned (PLAN-05 §1 fixture strategy).
    expect(fixture.address.toLowerCase()).toBe("0x5559080b33b673ded41b62ca23ca21b51bd8974a");
  });
});

describe("G5.2 — wire-signature round trip authorizes a pure-circuit eval", () => {
  const fields = {
    op: OP_TRANSFER,
    token: new Uint8Array(32).fill(0x11),
    account: new Uint8Array(32).fill(0x22),
    to: padEthAddress(`0x${"cc".repeat(20)}`),
    nonce: 42n,
    amount: 12_345n,
  };

  it("personal_sign wire form → recovery → every bind the circuit re-runs", () => {
    const from = hexToBytes(ethAddressOfPriv(PRIV));
    const payload = buildPayload({ ...fields, from });
    const signature65 = personalSign(PRIV, payload); // MetaMask stand-in (E-G2: byte-identical)
    expect(signature65).toHaveLength(65);
    expect([27, 28]).toContain(signature65[64]);

    const tuple = tupleFromEthSignature(payload, signature65);
    // from-bind: recovered key derives to the payload's from — via BOTH
    // implementations (TS and the contract's own pure oracle).
    expect(bytesToHex(tuple.signer)).toBe(bytesToHex(from));
    expect(bytesToHex(pure.signerAddress(tuple.pk))).toBe(bytesToHex(from));
    expect(bytesToHex(ethAddressOfPk(tuple.pk))).toBe(bytesToHex(from));
    // digest equality: what validate() will consume == what was signed.
    expect(bytesToHex(pure.computeDigest(payload))).toBe(bytesToHex(tuple.digest));
    // the signature verifies over that digest (lowS off — circuit semantics).
    expect(nobleVerify(tuple.sig, tuple.digest, tuple.pk)).toBe(true);
    // scalar parity with the frozen scalar-signing path (PLAN-03).
    const scalarSigned = signAccountPayload(PRIV, fields);
    expect(tuple.sig.r).toBe(scalarSigned.sig.r);
    expect(tuple.sig.s).toBe(scalarSigned.sig.s);
  });

  it("the flipped-s twin recovers to the SAME signer and the SAME digest (R2 at layer 0)", () => {
    const from = hexToBytes(ethAddressOfPriv(PRIV));
    const payload = buildPayload({ ...fields, from, nonce: 43n });
    const signature65 = personalSign(PRIV, payload);
    const tuple = tupleFromEthSignature(payload, signature65);

    const twinScalars = flipS(tuple.sig);
    const twin65 = new Uint8Array(65);
    twin65.set(hexToBytes(twinScalars.r.toString(16).padStart(64, "0")), 0);
    twin65.set(hexToBytes(twinScalars.s.toString(16).padStart(64, "0")), 32);
    twin65[64] = signature65[64] === 27 ? 28 : 27; // s-flip flips recovery parity

    const twin = tupleFromEthSignature(payload, twin65);
    expect(bytesToHex(twin.signer)).toBe(bytesToHex(from));
    expect(bytesToHex(twin.digest)).toBe(bytesToHex(tuple.digest)); // one digest, one replay key
    expect(nobleVerify(twin.sig, twin.digest, twin.pk)).toBe(true); // both twins verify in-circuit
  });

  it("normalizeLowS yields an equivalent signature (tidiness only, never load-bearing)", () => {
    const from = hexToBytes(ethAddressOfPriv(PRIV));
    // Scan nonces until the signature is HIGH-s so the normalization actually flips.
    for (let nonce = 100n; nonce < 200n; nonce++) {
      const payload = buildPayload({ ...fields, from, nonce });
      const wire = personalSign(PRIV, payload);
      const s = BigInt(`0x${bytesToHex(wire.slice(32, 64))}`);
      const normalized = normalizeLowS(wire);
      const tuple = tupleFromEthSignature(payload, normalized);
      expect(bytesToHex(tuple.signer)).toBe(bytesToHex(from));
      expect(nobleVerify(tuple.sig, tuple.digest, tuple.pk)).toBe(true);
      if (s > secp256k1.Point.Fn.ORDER >> 1n) return; // exercised the flip path — done
    }
    // noble signs low-s by default, so the flip path needs a manufactured twin.
    const payload = buildPayload({ ...fields, from, nonce: 999n });
    const wire = personalSign(PRIV, payload);
    const high = new Uint8Array(wire);
    const flipped = flipS({
      r: BigInt(`0x${bytesToHex(wire.slice(0, 32))}`),
      s: BigInt(`0x${bytesToHex(wire.slice(32, 64))}`),
    });
    high.set(hexToBytes(flipped.s.toString(16).padStart(64, "0")), 32);
    high[64] = wire[64] === 27 ? 28 : 27;
    expect(bytesToHex(normalizeLowS(high))).toBe(bytesToHex(wire)); // round-trips back to low-s
  });
});

describe("relayer validation chain at layer 0 (no wallet, no stack, no proof)", () => {
  function signedRelayArgs(overrides: Partial<PayloadFields> = {}) {
    const signed = signAccountPayload(PRIV, {
      op: OP_TRANSFER,
      token: new Uint8Array(32).fill(0xdd), // never registered
      account: new Uint8Array(32).fill(0x22),
      to: padEthAddress(`0x${"cc".repeat(20)}`),
      nonce: 1n,
      amount: 10n,
      ...overrides,
    });
    const signature65 = personalSign(PRIV, signed.payload);
    return { payloadHex: bytesToHex(signed.payload), signatureHex: bytesToHex(signature65) };
  }

  it("refuses wrong lengths, garbage hex, wrong domain tag, wrong op — before anything else", () => {
    const core = new RelayerCore();
    const good = signedRelayArgs();

    expect(() => core.relay("00".repeat(128), good.signatureHex)).toThrow(RelayError);
    expect(() => core.relay(good.payloadHex, "00".repeat(64))).toThrow(/65 bytes/);
    expect(() => core.relay("zz", good.signatureHex)).toThrow(/hex/);

    const wrongTag = hexToBytes(good.payloadHex);
    wrongTag[0]! ^= 0x01;
    expect(() => core.relay(bytesToHex(wrongTag), good.signatureHex)).toThrow(
      /not MIDNIGHT_ACCOUNT_V1/,
    );

    const wrongOp = hexToBytes(good.payloadHex);
    wrongOp[32] = 0x02;
    expect(() => core.relay(bytesToHex(wrongOp), good.signatureHex)).toThrow(/unsupported op/);

    const dirtyReserved = hexToBytes(good.payloadHex);
    dirtyReserved[175] = 0x01;
    expect(() => core.relay(bytesToHex(dirtyReserved), good.signatureHex)).toThrow(/reserved/);
  });

  it("refuses an unregistered token with 404, without running recovery", () => {
    const core = new RelayerCore();
    const args = signedRelayArgs();
    try {
      core.relay(args.payloadHex, args.signatureHex);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RelayError);
      expect((e as RelayError).httpStatus).toBe(404);
      expect((e as RelayError).code).toBe("unknown-token");
    }
  });

  it("rate-limits per source address; distinct sources have distinct budgets", () => {
    const core = new RelayerCore({ rateLimitPerMinute: 3 });
    for (let i = 0; i < 3; i++) {
      const args = signedRelayArgs({ nonce: BigInt(i) });
      expect(() => core.relay(args.payloadHex, args.signatureHex)).toThrow(/no registered contract/);
    }
    const fourth = signedRelayArgs({ nonce: 99n });
    try {
      core.relay(fourth.payloadHex, fourth.signatureHex);
      expect.unreachable("should have rate-limited");
    } catch (e) {
      expect((e as RelayError).httpStatus).toBe(429);
      expect((e as RelayError).code).toBe("rate-limited");
    }
    // A different signer still gets through to the registry check.
    const otherKey = "0000000000000000000000000000000000000000000000000000000000000042";
    const other = signAccountPayload(otherKey, {
      op: OP_TRANSFER,
      token: new Uint8Array(32).fill(0xdd),
      account: new Uint8Array(32).fill(0x22),
      to: padEthAddress(`0x${"cc".repeat(20)}`),
      nonce: 1n,
      amount: 10n,
    });
    const otherWire = personalSign(otherKey, other.payload);
    expect(() => core.relay(bytesToHex(other.payload), bytesToHex(otherWire))).toThrow(
      /no registered contract/,
    );
  });
});

describe.skipIf(!fs.existsSync(ACCOUNT_FIXTURE))(
  "G5.4 — REAL MetaMask signature over the 176-byte MIDNIGHT_ACCOUNT_V1 payload",
  () => {
    it("the captured fixture verifies through the whole off-circuit chain", () => {
      const fixture = JSON.parse(fs.readFileSync(ACCOUNT_FIXTURE, "utf-8")) as {
        payloadHex: string;
        signatureHex: string;
        address: string;
      };
      const payload = hexToBytes(fixture.payloadHex);
      expect(payload).toHaveLength(PAYLOAD_LENGTH);

      const fields = parseAccountPayload(payload);
      expect(bytesToHex(fields.domainTag)).toBe(DOMAIN_TAG_HEX);
      expect(fields.op).toBe(OP_TRANSFER);

      const tuple = tupleFromEthSignature(payload, hexToBytes(fixture.signatureHex));
      expect(`0x${bytesToHex(tuple.signer)}`).toBe(fixture.address.toLowerCase());
      expect(bytesToHex(fields.from)).toBe(bytesToHex(tuple.signer));
      expect(nobleVerify(tuple.sig, tuple.digest, tuple.pk)).toBe(true);
      // The contract's own oracles agree with what the wallet signed.
      expect(bytesToHex(pure.computeDigest(payload))).toBe(bytesToHex(tuple.digest));
      expect(bytesToHex(pure.signerAddress(tuple.pk))).toBe(bytesToHex(tuple.signer));
    });
  },
);
