// Vendored from compact-end-2-end @ aa344546 (utils/hex.ts), 2026-08-11.
// Copyright (C) Midnight Foundation — SPDX-License-Identifier: Apache-2.0
// Upstream: /Users/edwardalvarado/compact-end-2-end
// Local changes: none (verbatim).

import { Buffer } from "node:buffer";

export function hexToBytes32(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const buf = Buffer.from(clean, "hex");
  const out = new Uint8Array(32);
  out.set(buf.subarray(0, Math.min(32, buf.length)));
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const buf = Buffer.from(clean, "hex");
  return buf;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
