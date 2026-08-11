// Vendored from compact-end-2-end @ aa344546 (utils/contract-ops.ts), 2026-08-11.
// Copyright (C) Midnight Foundation — SPDX-License-Identifier: Apache-2.0
// Upstream: /Users/edwardalvarado/compact-end-2-end
// Local changes: none (verbatim).
//
// One implementation of deploy / call / read, shared by every dapp + probe so
// they can't drift. Module loading + SDK binding live in compiled.ts; this
// file consumes the validated shapes it produces and casts only at the
// documented SDK deploy seam.

import { Buffer } from "node:buffer";

import { deployContract, findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";

import type { CompiledContractHandle, CompiledModule } from "./compiled.ts";
import { bytesToHex } from "./hex.ts";
import type { Providers } from "./providers.ts";

/** One contract in a call tree: its address + post-call state. Callees precede the root. */
export interface TreeCall {
  contractAddress: string;
  public: { contractState: unknown };
}

/** Finalized call-tx data a deployed circuit returns: a narrowed mirror of the SDK's `FinalizedCallTxData`, keeping opaque ZK/state values as `unknown`. */
export interface CallTxData {
  public: {
    txId: string;
    txHash: string;
    blockHash: string;
    blockHeight: number;
    status: unknown;
    nextContractState: unknown;
    fees: { paidFees: string; estimatedFees: string };
    /**
     * MIP-0002 contract log events emitted during circuit execution. This is
     * the beta.6 addition PLAN-01 pins the lane for (beta.4 has no such field).
     * NOTE the name: it is `logEvents`, not `events` — and it is the single
     * execution-wide list across the WHOLE call tree, in emission order, each
     * entry tagged with its emitting contract's address. A per-contract view is
     * a filter over that address, which matters from PLAN-03 on (CCC callee
     * events arrive here too). Carried RAW; decode with `ContractLog.decodeAll`.
     */
    logEvents?: readonly unknown[];
  };
  private: { result: unknown };
  calls?: readonly TreeCall[];
}

type CircuitFn = (...args: unknown[]) => Promise<CallTxData>;

/** A deployed contract: deploy tx data + callTx[circuit] to submit proven calls. */
export interface DeployedContractLike {
  deployTxData: { public: { contractAddress: string; txId: string; txHash: string } };
  callTx: Record<string, CircuitFn>;
}

/**
 * A witness implementation, in the compact-js shape:
 * `(context, ...args) => [nextPrivateState, value]`. Most dapps have no
 * witnesses and rely on the vacant default; pass these only for contracts whose
 * circuits read `witness` inputs (e.g. usdcx's `receiveAndMint`). The returned
 * `value` must be the runtime representation of the declared witness type
 * (`Bytes<N>` → `Uint8Array`, `Uint<N>` → `bigint`, structs → nested objects).
 */
export type WitnessImpl = (context: unknown, ...args: unknown[]) => readonly [unknown, unknown];
export type WitnessImpls = Record<string, WitnessImpl>;

export interface DeployResult {
  contractAddress: string;
  txId: string;
  txHash: string;
  deployed: DeployedContractLike;
}

export interface CallResult {
  txId: string;
  txHash: string;
  blockHash: string;
  blockHeight: number;
  result: unknown;
  fees: { paidFees: string; estimatedFees: string };
  // Post-call state + on-chain status, straight from the node — lets a caller
  // verify the call applied without depending on the indexer.
  status: unknown;
  nextContractState: unknown;
  /** MIP-0002 log events from the whole call tree (beta.6+). See CallTxData. */
  logEvents: readonly unknown[];
  // The whole call tree's post-call states (callees precede the root). Present
  // for cross-contract calls; lets a caller read callee states the root's
  // nextContractState doesn't carry.
  calls?: readonly TreeCall[] | undefined;
}

export function contractAddressBytes(contractAddress: string): Uint8Array {
  const clean = contractAddress.replace(/^0x/, "");
  const buf = Buffer.from(clean, "hex");
  if (buf.length !== 32) {
    throw new Error(`contract address must be 32 bytes, got ${buf.length}: ${contractAddress}`);
  }
  return new Uint8Array(buf);
}

/** Deploy a fresh instance with constructor args and an empty private state. */
export async function deployFresh(
  providers: Providers,
  compiledContract: CompiledContractHandle,
  privateStateId: string,
  args: readonly unknown[],
): Promise<DeployResult> {
  const deploy = deployContract as unknown as (
    p: Providers,
    opts: unknown,
  ) => Promise<DeployedContractLike>;
  try {
    const deployed = await deploy(providers, {
      compiledContract,
      privateStateId,
      initialPrivateState: {},
      args,
    });
    const pub = deployed.deployTxData.public;
    return { contractAddress: pub.contractAddress, txId: pub.txId, txHash: pub.txHash, deployed };
  } catch (e) {
    throw new Error(`deploy(${privateStateId}) failed: ${causeChain(e)}`, { cause: e });
  }
}

/**
 * Attach to an already-deployed contract by address, so a wallet that did NOT
 * deploy it (e.g. a relayer) can submit calls. The `compiledContract` should
 * carry the witness bindings needed by the circuits being called.
 */
export async function findDeployed(
  providers: Providers,
  compiledContract: CompiledContractHandle,
  contractAddress: string,
  privateStateId: string,
): Promise<DeployedContractLike> {
  const find = findDeployedContract as unknown as (
    p: Providers,
    opts: unknown,
  ) => Promise<DeployedContractLike>;
  try {
    return await find(providers, {
      compiledContract,
      contractAddress,
      privateStateId,
      initialPrivateState: {},
    });
  } catch (e) {
    throw new Error(`findDeployed(${contractAddress}) failed: ${causeChain(e)}`, { cause: e });
  }
}

/** Submit a call to `circuitId` on a deployed (or found) contract handle. */
export async function callCircuit(
  deployed: DeployedContractLike,
  circuitId: string,
  args: readonly unknown[],
): Promise<CallResult> {
  const fn = deployed.callTx[circuitId];
  if (!fn) throw new Error(`callTx.${circuitId} not exposed by deployed contract`);
  try {
    const res = await fn(...args);
    return {
      txId: res.public.txId,
      txHash: res.public.txHash,
      blockHash: res.public.blockHash,
      blockHeight: res.public.blockHeight,
      result: res.private.result,
      status: res.public.status,
      nextContractState: res.public.nextContractState,
      logEvents: res.public.logEvents ?? [],
      fees: res.public.fees,
      calls: res.calls,
    };
  } catch (e) {
    throw new Error(`callTx.${circuitId} failed: ${causeChain(e)}`, { cause: e });
  }
}

/** Indexer-read the contract state, project it through the compiled bindings' ledger() view. */
export async function readLedger<L>(
  providers: Providers,
  contractAddress: string,
  contractModule: CompiledModule,
  blockHash?: string,
): Promise<L> {
  const config = blockHash === undefined ? undefined : { type: "blockHash" as const, blockHash };
  const state = await providers.publicDataProvider.queryContractState(contractAddress, config);
  if (!state) throw new Error(`no contract state at ${contractAddress}`);
  return contractModule.ledger(state.data) as L;
}

/** Project an in-hand contract state (e.g. a call's nextContractState) through the bindings' ledger() view — no indexer. */
export function decodeLedger<L>(contractModule: CompiledModule, state: unknown): L {
  return contractModule.ledger(state) as L;
}

/** Log every (address → value) entry of a ledger map verbatim, addresses hex-encoded — raw state, no labels. */
export function logBalances(
  label: string,
  balances: Iterable<readonly [Uint8Array, bigint]>,
): void {
  const entries = [...balances];
  console.log(`         ${label} (${entries.length} entries):`);
  for (const [address, value] of entries) {
    console.log(`           ${bytesToHex(address)} = ${value}`);
  }
}

/** Flatten an error's message/cause chain into one readable string. */
function causeChain(e: unknown): string {
  const chain: string[] = [];
  let cur: unknown = e;
  while (cur && typeof cur === "object" && "message" in cur) {
    chain.push(String((cur as { message: unknown }).message));
    cur = (cur as { cause?: unknown }).cause;
  }
  return chain.join(" <- ");
}
