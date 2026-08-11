// Vendored from compact-end-2-end @ aa344546 (utils/genesis-seeds.ts), 2026-08-11.
// Copyright (C) Midnight Foundation — SPDX-License-Identifier: Apache-2.0
// Upstream: /Users/edwardalvarado/compact-end-2-end
// Local changes: external-network seed pooling dropped — this project only ever
// targets the local Part-0 stack, so there is exactly one seed source and no env
// override can redirect a role onto an unfunded wallet.

// The four wallet seeds the Midnight `undeployed` chainspec (loaded by
// CFG_PRESET=dev) gifts Night + Zswap + Dust at genesis. Documented in
// midnight-node/docs/configuration-guide.md. Order matters — each role gets the
// seed at the same index, so distinct roles always get distinct funded wallets.

import { NETWORK_ID } from "./endpoints.ts";

export const GENESIS_SEEDS = [
  "0000000000000000000000000000000000000000000000000000000000000001",
  "0000000000000000000000000000000000000000000000000000000000000002",
  "0000000000000000000000000000000000000000000000000000000000000003",
  "a51c86de32d0791f7cffc3bdff1abd9bb54987f0ed5effc30c936dddbb9afd9d530c8db445e4f2d3ea42a321b260e022aadf05987c9a67ec7b6b6ca1d0593ec9",
] as const;

/**
 * PLAN-00 §3.5 role convention for this project:
 *   alice (seed …0001) — deployer / token owner
 *   bob   (seed …0002) — RELAYER fee wallet (pays DUST for every relayed tx)
 * The remaining two are spare; PLAN-05 may claim one for a second relayer
 * instance (the V4 idempotence run).
 */
export const ROLE_SEEDS = {
  alice: GENESIS_SEEDS[0],
  bob: GENESIS_SEEDS[1],
  carol: GENESIS_SEEDS[2],
  dave: GENESIS_SEEDS[3],
} as const;

export type Role = keyof typeof ROLE_SEEDS;

export class InsufficientSeedsError extends Error {
  constructor(needed: number, available: number) {
    super(`needs ${needed} distinct funded wallets but the chainspec gifts only ${available}`);
    this.name = "InsufficientSeedsError";
  }
}

/** One distinct genesis seed per role, in order. */
export function assignGenesisSeeds(roles: readonly string[]): Record<string, { seedHex: string }> {
  if (NETWORK_ID !== "undeployed") {
    // A hosted network has no genesis gifts; PLAN-01 §"If targeting hosted
    // stagenet later" is explicit that this path is unbuilt (and unproven).
    throw new Error(
      `assignGenesisSeeds only supports the local undeployed devnet (STACK.env says ${NETWORK_ID})`,
    );
  }
  if (roles.length > GENESIS_SEEDS.length) {
    throw new InsufficientSeedsError(roles.length, GENESIS_SEEDS.length);
  }
  return Object.fromEntries(roles.map((r, i) => [r, { seedHex: GENESIS_SEEDS[i]! }]));
}
