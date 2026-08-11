// Verifier-key rotation for a deployed contract — PLAN-02 spike S4.
//
// midnight-js 5.0.0-beta.6 ships `submitRemoveVerifierKeyTx` /
// `submitInsertVerifierKeyTx`, and they are the right shape, but they route
// through compact-js's `ContractExecutable`, which hardcodes
// `new ContractOperationVersion('v3')` for both the remove and the insert. A
// contract compiled with `--feature-zkir-v3` does not store its keys under that
// version, so the SDK path submits a maintenance update that touches nothing and
// the transaction comes back `FailFallible`.
//
// This module does what compact-js does, one parameter richer: the
// `ContractOperationVersion` is an argument. Everything else — the signature over
// `MaintenanceUpdate.dataToSign`, the authority counter read from the deployed
// state, signature index 0, the intent/transaction assembly — is the same
// sequence, so a rotation done here is a rotation the SDK would do if the
// version were not pinned.
//
// The signing key is the maintenance authority. `deployContract` generates one
// per contract and stores it in the private-state provider under the contract's
// address, which makes the deployer the sole committee member (threshold 1).

import {
  ContractOperationVersion,
  ContractOperationVersionedVerifierKey,
  Intent,
  MaintenanceUpdate,
  Transaction,
  VerifierKeyInsert,
  VerifierKeyRemove,
  signData,
  type SingleUpdate,
} from "@midnightntwrk/ledger-v9";
import { getNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

import type { Providers } from "./providers.ts";

/** The proving-system version a contract's entry points are filed under. */
export type OperationVersion = "v3" | "v4";

/** compact-js signs at index 0; the committee is the single deploying key. */
const SIGNATURE_INDEX = 0n;

const ttlOneHour = (): Date => new Date(Date.now() + 60 * 60 * 1000);

interface OnChainState {
  operation(id: string): { verifierKey: Uint8Array } | undefined;
  operations(): (string | Uint8Array)[];
  maintenanceAuthority: { counter: bigint; threshold: number };
}

async function contractState(providers: Providers, address: string): Promise<OnChainState> {
  const state = (await providers.publicDataProvider.queryContractState(
    address,
  )) as unknown as OnChainState | null;
  if (!state) throw new Error(`no contract state at ${address}`);
  return state;
}

/** The verifier key an entry point is pinned to ON CHAIN, or undefined if it has none. */
export async function onChainVerifierKey(
  providers: Providers,
  address: string,
  circuitId: string,
): Promise<Uint8Array | undefined> {
  return (await contractState(providers, address)).operation(circuitId)?.verifierKey;
}

/**
 * Sign and submit one maintenance update against `address`.
 *
 * Returns the finalized transaction data. A maintenance update carries no ZK
 * proof, but it still goes through `proveTx` — the transaction has to leave the
 * unproven state before it can be balanced — and then through the wallet's
 * normal balance/submit path, so it pays a DUST fee like any other transaction.
 */
export async function submitMaintenanceUpdate(
  providers: Providers,
  address: string,
  updates: SingleUpdate[],
): Promise<unknown> {
  const state = await contractState(providers, address);
  const signingKey = await (
    providers.privateStateProvider as unknown as {
      getSigningKey(a: string): Promise<unknown>;
    }
  ).getSigningKey(address);
  if (!signingKey) {
    throw new Error(
      `no maintenance signing key stored for ${address} — this process did not deploy it`,
    );
  }

  // ledger-v9's ContractAddress is the plain hex string, not a {bytes} struct —
  // that shape is the Compact circuit-argument representation.
  const update = new MaintenanceUpdate(address, updates, state.maintenanceAuthority.counter);
  const signed = update.addSignature(
    SIGNATURE_INDEX,
    signData(signingKey as never, update.dataToSign),
  );

  const unproven = Transaction.fromParts(
    getNetworkId(),
    undefined,
    undefined,
    Intent.new(ttlOneHour()).addMaintenanceUpdate(signed),
  );

  const proofProvider = providers.proofProvider as unknown as {
    proveTx(tx: unknown): Promise<unknown>;
  };
  const wallet = providers.walletProvider as unknown as {
    balanceTx(tx: unknown, ttl?: Date): Promise<unknown>;
    submitTx(tx: unknown): Promise<string>;
  };
  const proven = await proofProvider.proveTx(unproven);
  const balanced = await wallet.balanceTx(proven);
  const txId = await wallet.submitTx(balanced);
  return providers.publicDataProvider.watchForTxData(txId);
}

/**
 * Rotate one entry point's verifier key: remove the old, insert the new, in ONE
 * maintenance update.
 *
 * Doing both in a single update matters operationally. The SDK's two-call
 * sequence leaves the contract with no key for that entry point between the two
 * transactions — a window in which every call to it fails. One update is atomic:
 * the entry point is never absent.
 */
export async function rotateVerifierKey(
  providers: Providers,
  address: string,
  circuitId: string,
  newVerifierKey: Uint8Array,
  version: OperationVersion,
): Promise<unknown> {
  return submitMaintenanceUpdate(providers, address, [
    new VerifierKeyRemove(circuitId, new ContractOperationVersion(version)),
    new VerifierKeyInsert(
      circuitId,
      new ContractOperationVersionedVerifierKey(version, newVerifierKey),
    ),
  ]);
}
