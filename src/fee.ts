// One fee-paying transaction, end to end: balance -> sign -> finalize -> submit.
//
// This is the smallest thing that proves the whole wallet/DUST path against the
// Part-0 stack without needing a compiled contract, so PLAN-01 gate G1.0's
// "a wallet syncs and pays one fee" can be asserted before anything is compiled.
// PLAN-05's relayer pays fees the same way (there is no DUST paymaster).

import * as Rx from "rxjs";

import * as ledger from "@midnightntwrk/ledger-v9";
import type { UnshieldedAddress } from "@midnightntwrk/wallet-sdk-address-format";

import type { WalletCtx } from "./wallet.ts";

export interface FeePaidResult {
  txId: string;
  feePaid: bigint;
  dustBefore: bigint;
  dustAfter: bigint;
}

/** Current DUST balance (the fee currency) for a synced wallet. */
export async function dustBalance(ctx: WalletCtx): Promise<bigint> {
  const state = await Rx.firstValueFrom(ctx.wallet.state());
  return BigInt(state.dust.balance(new Date()));
}

/**
 * The wallet's unshielded (NIGHT) address as an `UnshieldedAddress`.
 *
 * NOT `keystore.getAddress()` — that returns a `UserAddress` hex string, and
 * `transferTransaction` reads `receiverAddress.data` (a Buffer), so passing the
 * keystore value fails deep inside the SDK with "Cannot read properties of
 * undefined (reading 'toString')".
 */
export async function unshieldedAddress(ctx: WalletCtx): Promise<UnshieldedAddress> {
  const state = await Rx.firstValueFrom(ctx.wallet.state());
  return state.unshielded.address;
}

/**
 * Send `amount` NIGHT to `recipient` and pay the DUST fee for it.
 *
 * Fresh recipients per run, deliberately: the Part-0 stack is persistent and
 * shared, so any fixed recipient accumulates balances across every phase and
 * turns balance assertions into flaky nonsense (PLAN-01 §"Carried test
 * discipline").
 */
export async function payOneFee(
  ctx: WalletCtx,
  recipient: UnshieldedAddress,
  amount = 1n,
): Promise<FeePaidResult> {
  const dustBefore = await dustBalance(ctx);
  const ttl = new Date(Date.now() + 30 * 60 * 1000);

  const recipe = await ctx.wallet.transferTransaction(
    [
      {
        type: "unshielded",
        outputs: [{ type: ledger.nativeToken().raw, receiverAddress: recipient, amount }],
      },
    ],
    { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
    { ttl, payFees: true },
  );

  // `calculateTransactionFee`, NOT `estimateTransactionFee`.
  //
  // HAZARD (measured on this lane, wallet-sdk-facade 5.0.0-beta.2): calling
  // `estimateTransactionFee` on a recipe that was already built with
  // `payFees: true` never resolves — it hangs indefinitely without touching the
  // node, indexer, or proof server. `estimateTransactionFee` is the right call
  // for an UNBALANCED transaction (that is how src/providers.ts uses it, inside
  // waitForDustFeeBudget); here the fee is already balanced in, so the plain
  // per-transaction calculation is both correct and terminating.
  const feePaid = await ctx.wallet.calculateTransactionFee(recipe.transaction);

  // signDataAsync is async-only from wallet-sdk-facade 5.0.0-beta.2 onward;
  // wrap so the keystore keeps its `this` binding.
  const signed = await ctx.wallet.signRecipe(recipe, (payload: Uint8Array) =>
    ctx.unshieldedKeystore.signDataAsync(payload),
  );
  const finalized = await ctx.wallet.finalizeRecipe(signed);
  const txId = await ctx.wallet.submitTransaction(finalized);

  return { txId, feePaid, dustBefore, dustAfter: await dustBalance(ctx) };
}
