// Vendored from compact-end-2-end @ aa344546 (utils/wallet.ts), 2026-08-11.
// Copyright (C) Midnight Foundation — SPDX-License-Identifier: Apache-2.0
// Upstream: /Users/edwardalvarado/compact-end-2-end
// Local changes: endpoints come from STACK.env; network id read from STACK.env, not MIDNIGHT_NETWORK_ID guesswork.

// Wallet bootstrap + sync helpers shared by every example. Each example picks
// its own role labels — this module makes no assumption about how many wallets
// the example needs or what they're called.

import { Buffer } from "node:buffer";

import { WebSocket } from "ws";
import * as Rx from "rxjs";

import { getNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import * as ledger from "@midnightntwrk/ledger-v9";
import { WalletFacade } from "@midnightntwrk/wallet-sdk-facade";
import { DustWallet } from "@midnightntwrk/wallet-sdk-dust-wallet";
import { HDWallet, Roles } from "@midnightntwrk/wallet-sdk-hd";
import { ShieldedWallet } from "@midnightntwrk/wallet-sdk-shielded";
import {
  createKeystore,
  PublicKey,
  UnshieldedWallet,
} from "@midnightntwrk/wallet-sdk-unshielded-wallet";

import { ENDPOINTS, NETWORK_ID, setNetwork } from "./endpoints.ts";

// Address formats key off the network id; set it before any key derivation.
setNetwork();

// @ts-expect-error global polyfill for wallet sync over GraphQL subscriptions
globalThis.WebSocket = WebSocket;

// polkadot-js error-logs the wallet relay's internal subscribeRuntimeVersion
// teardown on every deliberate disconnect as "RPC-CORE: ... 1000:: Normal
// Closure". Code 1000 is a normal close — noise, not a failure — and the log is
// unconditional (no DEBUG/noErrorLog escape). Filed upstream:
// https://github.com/polkadot-js/api/issues/6271. Drop only that line; real relay
// errors (other close codes) still show.
const nativeConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const isRpcCoreNormalClosure =
    args.some((a) => typeof a === "string" && a.includes("RPC-CORE")) &&
    args.some((a) => typeof a === "string" && a.includes("1000:: Normal Closure"));
  if (isRpcCoreNormalClosure) return;
  nativeConsoleError(...args);
};

// Mirrors @midnightntwrk/wallet-sdk-abstractions' NoOpTransactionHistoryStorage:
// the wallet records tx-history lifecycle transitions through this, but the e2e
// suites don't use tx history (ledger + events are read from the indexer). Keep
// this in sync with the TransactionHistoryStorage interface across wallet-sdk
// bumps — beta.1 replaced the old upsert/delete/list/clear shape with got*.
const noopTxHistoryStorage = {
  gotPending: async () => undefined,
  gotFinalized: async () => undefined,
  gotRejected: async () => undefined,
  getAll: async () => [] as unknown[],
  get: async () => undefined,
  serialize: async () => "[]",
};

export interface WalletCtx {
  role: string;
  seedHex: string;
  wallet: WalletFacade;
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: ReturnType<typeof createKeystore>;
}

function deriveKeys(seedHex: string) {
  const hd = HDWallet.fromSeed(Buffer.from(seedHex, "hex"));
  if (hd.type !== "seedOk") throw new Error("invalid seed");
  const result = hd.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (result.type !== "keysDerived") throw new Error("key derivation failed");
  hd.hdWallet.clear();
  return result.keys;
}

export async function createWallet(role: string, seedHex: string): Promise<WalletCtx> {
  const keys = deriveKeys(seedHex);
  const networkId = getNetworkId();

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(
    { kind: "schnorr", secret: keys[Roles.NightExternal] },
    networkId,
  );

  // The local chainspec needs a conservative margin to avoid fee changes between
  // balancing and submission: the SDK default of 5 blows up as
  // `BalanceCheckOverspend` on the k=15 circuits this project proves (PLAN-01
  // §Provider assembly). On hosted networks 100 blocks would make a faucet-funded
  // wallet wait impractically long for DUST; 5 was verified against stagenet.
  const defaultFeeBlocksMargin = NETWORK_ID === "undeployed" ? "100" : "5";
  const feeBlocksMargin = Number(process.env.AA_FEE_BLOCKS_MARGIN ?? defaultFeeBlocksMargin);

  const configuration = {
    networkId,
    indexerClientConnection: {
      indexerHttpUrl: ENDPOINTS.indexerHttp,
      indexerWsUrl: ENDPOINTS.indexerWs,
    },
    provingServerUrl: new URL(ENDPOINTS.proofServer),
    relayURL: new URL(ENDPOINTS.nodeWs),
    costParameters: { feeBlocksMargin },
    txHistoryStorage: noopTxHistoryStorage,
  };

  const wallet: WalletFacade = await (
    WalletFacade as never as { init: (opts: unknown) => Promise<WalletFacade> }
  ).init({
    configuration,
    shielded: (cfg: unknown) =>
      ShieldedWallet(cfg as never).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (cfg: unknown) =>
      UnshieldedWallet(cfg as never).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (cfg: unknown) =>
      DustWallet(cfg as never).startWithSecretKey(
        dustSecretKey,
        ledger.LedgerParameters.initialParameters().dust,
      ),
  });

  await wallet.start(shieldedSecretKeys, dustSecretKey);
  return { role, seedHex, wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

export async function syncWallet(ctx: WalletCtx): Promise<void> {
  // throttleTime is load-bearing, not cosmetic: isSynced flaps true→false→true
  // early in sync (synced to a young chain, then re-syncing as blocks land).
  // Sampling every 5s waits for a STABLE synced state — by which point the
  // genesis dust UTXO is finalized + spendable, so the first deploy can pay
  // fees. Dropping it lets firstValueFrom grab the premature transient true
  // and the next tx fails with "could not balance dust".
  let lastState = "(no wallet state emitted)";
  await Rx.firstValueFrom(
    ctx.wallet.state().pipe(
      Rx.tap((s) => {
        lastState = describeWalletState(s);
      }),
      Rx.throttleTime(5_000),
      Rx.filter((s) => s.isSynced === true),
      Rx.timeout({
        first: Number(process.env.AA_WALLET_SYNC_TIMEOUT_MS ?? "120000"),
        with: () => {
          throw new Error(
            [
              `${ctx.role}: wallet did not reach isSynced=true`,
              `last state: ${lastState}`,
              `indexer ws: ${ENDPOINTS.indexerWs}`,
              `node: ${ENDPOINTS.node}`,
            ].join("\n"),
          );
        },
      }),
    ),
  );
}

function describeWalletState(state: unknown) {
  if (!state || typeof state !== "object") return String(state);
  const obj = state as Record<string, unknown>;
  return JSON.stringify({
    isSynced: obj.isSynced,
    blockHeight: obj.blockHeight,
    syncProgress: obj.syncProgress,
    dust: describeNested(obj.dust),
    shielded: describeNested(obj.shielded),
    unshielded: describeNested(obj.unshielded),
  });
}

function describeNested(value: unknown) {
  if (!value || typeof value !== "object") return value == null ? value : typeof value;
  const obj = value as Record<string, unknown>;
  return {
    keys: Object.keys(obj).sort().slice(0, 12),
  };
}

export async function snapshotBalances(ctx: WalletCtx) {
  const state = await Rx.firstValueFrom(ctx.wallet.state());
  const unshielded = Object.fromEntries(
    Object.entries(state.unshielded.balances as Record<string, bigint>),
  );
  const shielded = Object.fromEntries(
    Object.entries(state.shielded.balances as Record<string, bigint>),
  );
  const dust = state.dust.balance(new Date()).toString();
  return { unshielded, shielded, dust };
}

/** 32-byte unshielded user address — the value contracts see when a wallet calls a circuit. */
export function addressBytes(ctx: WalletCtx): Uint8Array {
  return ledger.encodeUserAddress(ctx.unshieldedKeystore.getAddress());
}
