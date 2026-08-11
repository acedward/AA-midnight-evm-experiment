// Vendored from compact-end-2-end @ aa344546 (utils/providers.ts), 2026-08-11.
// Copyright (C) Midnight Foundation — SPDX-License-Identifier: Apache-2.0
// Upstream: /Users/edwardalvarado/compact-end-2-end
// Local changes: `import x = require()` replaced with ESM imports (Node type-stripping); endpoints from STACK.env.

// midnight-js provider plumbing scoped to one role wallet + one contract artifact.

import { createRequire } from "node:module";

import { setTimeout as delay } from "node:timers/promises";
import * as path from "node:path";

import * as Rx from "rxjs";

import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import {
  NodeZkConfigProvider,
  nodeZkConfigRegistry,
} from "@midnight-ntwrk/midnight-js-node-zk-config-provider";

import { ENDPOINTS } from "./endpoints.ts";
import type { WalletCtx } from "./wallet.ts";

// node-fetch v2 (via cross-fetch, the indexer provider's Apollo HttpLink transport)
// uses Node's http(s) globalAgent; on Node 24 its keep-alive sockets trigger the
// indexer's `Premature close`. Swap in keep-alive-off agents so finalization uses
// fresh sockets.
//
// It has to go through createRequire: an ESM namespace object is sealed, so
// `import * as http` + assignment throws "Cannot redefine property: globalAgent"
// at load time. Upstream wrote `import http = require("node:http")`, which is
// the same thing — but that syntax is a transform, which Node's type-stripping
// rejects. The CJS module object this returns is mutable.
const nodeRequire = createRequire(import.meta.url);
const http = nodeRequire("node:http") as typeof import("node:http");
const https = nodeRequire("node:https") as typeof import("node:https");
http.globalAgent = new http.Agent({ keepAlive: false });
https.globalAgent = new https.Agent({ keepAlive: false });

export interface Providers {
  privateStateProvider: ReturnType<typeof levelPrivateStateProvider>;
  publicDataProvider: ReturnType<typeof indexerPublicDataProvider>;
  zkConfigProvider: NodeZkConfigProvider<string>;
  proofProvider: ReturnType<typeof httpClientProofProvider>;
  walletProvider: unknown;
  midnightProvider: unknown;
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function dustFeeTimeoutMs(): number {
  const timeoutMs = Number(
    process.env.AA_DUST_FEE_TIMEOUT_MS ??
      process.env.AA_WALLET_FUND_TIMEOUT_MS ??
      "600000",
  );
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("AA_DUST_FEE_TIMEOUT_MS must be a positive number");
  }
  return timeoutMs;
}

async function waitForDustFeeBudget(
  ctx: WalletCtx,
  tx: Parameters<typeof ctx.wallet.estimateTransactionFee>[0],
  ttl: Date,
): Promise<void> {
  const deadline = Date.now() + dustFeeTimeoutMs();
  let waiting = false;
  for (;;) {
    try {
      await ctx.wallet.estimateTransactionFee(tx, ctx.dustSecretKey, { ttl });
      if (waiting) console.log(`      ✓ ${ctx.role} has enough DUST for the transaction fee`);
      return;
    } catch (error) {
      if (!/insufficient funds|could not balance dust/i.test(errorText(error))) throw error;
    }

    if (!waiting) {
      console.log(`      waiting for ${ctx.role} to generate enough DUST for the transaction ...`);
      waiting = true;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${ctx.role}: timed out waiting for enough DUST for the transaction fee`);
    }
    await delay(Math.min(5_000, deadline - Date.now()));
  }
}

/** Retry an indexer finalization wait the indexer drops mid-connection (`Premature close` — a known gap); logs each retry. */
function retryOnDrop<A extends unknown[], R>(
  name: string,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn(...args);
      } catch (e) {
        if (attempt > 3 || !/Premature close/.test(String(e))) throw e;
        console.warn(
          `      ⚠ indexer gap: ${name} dropped finalization wait (Premature close) — retry ${attempt}/3`,
        );
        await delay(Math.min(3000, 500 * attempt));
      }
    }
  };
}

export async function createProviders(
  ctx: WalletCtx,
  contractDir: string,
  privateStateId: string,
): Promise<Providers> {
  const state = await Rx.firstValueFrom(ctx.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  // wallet-sdk-facade >=5.0.0-beta.2 made SignSegment async-only (out-of-process
  // signers need it); wrap so the keystore's `this` binding is preserved.
  const signFn = (payload: Uint8Array) => ctx.unshieldedKeystore.signDataAsync(payload);

  const walletProvider = {
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx: unknown, ttl?: Date) {
      const transaction = tx as Parameters<typeof ctx.wallet.balanceUnboundTransaction>[0];
      const transactionTtl = ttl ?? new Date(Date.now() + 30 * 60 * 1000);
      await waitForDustFeeBudget(ctx, transaction, transactionTtl);
      const recipe = await ctx.wallet.balanceUnboundTransaction(
        transaction,
        { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
        { ttl: transactionTtl },
      );
      const signed = await ctx.wallet.signRecipe(recipe, signFn);
      return ctx.wallet.finalizeRecipe(signed);
    },
    submitTx: (tx: unknown) =>
      ctx.wallet.submitTransaction(
        tx as Parameters<typeof ctx.wallet.submitTransaction>[0],
      ) as unknown,
  };

  // Two roles, two abstractions: midnight-js deploy/make reads this contract's own
  // verifier keys by circuit id, so it needs the per-contract leaf provider over the
  // bundle dir. Proving a cross-contract call needs keys for the whole call tree, so the
  // proof provider gets a registry over the *artifact root* — the directory that holds
  // every compiled bundle, which is the parent of this contract's bundle dir. The
  // registry resolves each contract by verifier-key hash, so indexing siblings is safe.
  const zkConfigProvider = new NodeZkConfigProvider<string>(contractDir);
  const zkConfigRegistry = await nodeZkConfigRegistry(path.dirname(contractDir));
  // midnight-js 5.0.0-beta.6 added strength validation to the private-state
  // password (>= 3 of upper/lower/digit/special); beta.4 accepted anything, so
  // the upstream dev password now fails deploy with PasswordValidationError.
  const password = process.env.PRIVATE_STATE_PASSWORD ?? "Midnight-AA-dev-2026!";

  // Both submitTx finalizations wait on the indexer (watchFor*TxData). The
  // keep-alive fix above stops the `Premature close`; the retry stays as a
  // fast-fail diagnostic that surfaces any regression as an indexer gap.
  const pdp = indexerPublicDataProvider(ENDPOINTS.indexerHttp, ENDPOINTS.indexerWs);
  pdp.watchForTxData = retryOnDrop("watchForTxData", pdp.watchForTxData.bind(pdp));
  pdp.watchForDeployTxData = retryOnDrop(
    "watchForDeployTxData",
    pdp.watchForDeployTxData.bind(pdp),
  );

  return {
    privateStateProvider: levelPrivateStateProvider({
      midnightDbName: `midnight-level-db-${ctx.role}-${privateStateId}`,
      privateStateStoreName: privateStateId,
      privateStoragePasswordProvider: () => password,
      accountId: state.shielded.encryptionPublicKey.toHexString().slice(0, 16),
    }),
    publicDataProvider: pdp,
    zkConfigProvider,
    proofProvider: httpClientProofProvider(ENDPOINTS.proofServer, zkConfigRegistry),
    walletProvider,
    midnightProvider: walletProvider,
  };
}
