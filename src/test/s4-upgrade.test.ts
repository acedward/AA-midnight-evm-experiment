// PLAN-02 spike S4 — can a deployed Account be upgraded?
//
// The account-as-validator architecture's generality claim is "auth policy in
// exactly one place". Verifier-key binding appears to undercut it: changing
// `Account.compact` changes its keys, a deployed contract's entry points are
// pinned to the keys it was deployed with, and every token bundle binds to those
// keys — so on the face of it, upgrading the account breaks every token against
// every deployed account at once.
//
// MIP-0003's escape hatch is that a contract's maintenance authority can ROTATE
// the verifier keys of a deployed contract. midnight-js 5.0.0-beta.6 exposes it,
// and `deployContract` quietly makes the deployer that authority: it generates a
// signing key and stores it in the private-state provider under the contract's
// address (committee of one, threshold 1).
//
// Five acts, against ONE root contract that is deployed once and never
// redeployed:
//   A. deploy account v1 + a root bound to it; prove one hop.
//   B. release v2 of the account bundle locally, on-chain key still v1 — what
//      stops the mismatch, and where?
//   C. the SDK's own rotation helper, which does not work here.
//   D. rotate the deployed account's key to v2.
//   E. a relayer restarted on the new bundle calls the SAME root again.
//
// Act E has to load the post-rotation bundles from a fresh path. That is a
// finding, not a workaround — see the comment on `publishFreshBundles`.

import { beforeAll, describe, expect, it } from "vitest";

import * as fs from "node:fs";
import * as path from "node:path";

import { submitRemoveVerifierKeyTx } from "@midnight-ntwrk/midnight-js-contracts";

import { bindCompiledContract, loadCompiledModule } from "../compiled.ts";
import { CONTRACTS_ROOT, compileContract } from "../compile.ts";
import {
  callCircuit,
  contractAddressBytes,
  deployFresh,
  findDeployed,
  readLedger,
  type DeployedContractLike,
} from "../contract-ops.ts";
import { recordDeployment } from "../deployments.ts";
import { ROLE_SEEDS } from "../genesis-seeds.ts";
import { bytesToHex } from "../hex.ts";
import { rotateVerifierKey } from "../maintenance.ts";
import { createProviders, type Providers } from "../providers.ts";
import { timed } from "../timings.ts";
import { createWallet, syncWallet, type WalletCtx } from "../wallet.ts";

const ACCOUNT = "S4Account";
const ROOT = "S4Root";
const DIGEST = new Uint8Array(32).fill(0xd4);

let alice: WalletCtx;
let accountAddress: string;
let rootAddress: string;
/** The root handle from act A — still bound to the v1 bundle in this process. */
let staleRoot: DeployedContractLike;

beforeAll(async () => {
  alice = await createWallet("alice", ROLE_SEEDS.alice);
  await syncWallet(alice);
}, 600_000);

/** Compile `source` into the managed dir `managedName` and return that dir. */
function compileAs(source: string, managedName: string): string {
  return compileContract({ source, managedName }).managedDir;
}

async function providersFor(managedName: string, managedDir: string): Promise<Providers> {
  return createProviders(alice, managedDir, managedName);
}

async function handleFor(managedName: string, managedDir: string) {
  const loaded = await loadCompiledModule(managedDir);
  return { loaded, handle: bindCompiledContract(managedName, loaded, { vacantWitnesses: true }) };
}

/** The verifier key a contract's entry point is pinned to ON CHAIN, hex. */
async function onChainVkHex(providers: Providers, address: string, circuitId: string) {
  const state = (await providers.publicDataProvider.queryContractState(address)) as unknown as {
    operation(id: string): { verifierKey: Uint8Array } | undefined;
  } | null;
  if (!state) throw new Error(`no contract state at ${address}`);
  const op = state.operation(circuitId);
  return op === undefined ? undefined : bytesToHex(op.verifierKey);
}

/** The verifier key in the LOCAL bundle, hex. */
async function localVkHex(providers: Providers, circuitId: string): Promise<string> {
  return bytesToHex(await providers.zkConfigProvider.getVerifierKey(circuitId));
}

/**
 * Republish the post-rotation bundles under a directory this process has never
 * imported from, preserving the sibling layout a caller needs (its generated
 * `index.js` resolves the callee as `../../<Interface>/contract/index.js`).
 *
 * This exists because of where the cross-contract interface guard lives:
 * `assertImplementationMatches` in `@midnight-ntwrk/compact-runtime` compares
 * `sha256(deployed verifier key)` against `expectedVk[circuitId]` read from the
 * CALLEE'S COMPILED MODULE. Node caches that module by URL, and recompiling the
 * file underneath does not evict it — so a process that ever loaded the v1
 * bundle keeps comparing against v1's hash forever. New paths mean new URLs mean
 * a genuinely fresh module, which is precisely the production situation being
 * modelled: a relayer RESTARTED on the newly released bundle.
 */
function publishFreshBundles(): string {
  const target = path.join(CONTRACTS_ROOT, "managed-s4-postrotation");
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const name of [ACCOUNT, ROOT]) {
    fs.cpSync(path.join(CONTRACTS_ROOT, "managed", name), path.join(target, name), {
      recursive: true,
    });
  }
  return target;
}

describe("S4 — upgrading a deployed account by rotating its verifier key", () => {
  let v1Vk: string;
  let v2Vk: string;

  it("A — deploys account v1 and a root bound to it, and proves one hop", async () => {
    const accountDir = compileAs("S4AccountV1.compact", ACCOUNT);
    const rootDir = compileAs("S4Root.compact", ROOT);

    const accountProviders = await providersFor(ACCOUNT, accountDir);
    const account = await handleFor(ACCOUNT, accountDir);
    const accountDeploy = await deployFresh(accountProviders, account.handle, ACCOUNT, []);
    accountAddress = accountDeploy.contractAddress;
    recordDeployment({
      name: ACCOUNT,
      contractAddress: accountAddress,
      txHash: accountDeploy.txHash,
      txId: accountDeploy.txId,
      note: "PLAN-02 S4 — account v1, verifier key rotated to v2 by this suite",
    });

    const rootProviders = await providersFor(ROOT, rootDir);
    const root = await handleFor(ROOT, rootDir);
    const rootDeploy = await deployFresh(rootProviders, root.handle, ROOT, [
      { bytes: contractAddressBytes(accountAddress) },
    ]);
    rootAddress = rootDeploy.contractAddress;
    staleRoot = rootDeploy.deployed;
    recordDeployment({
      name: ROOT,
      contractAddress: rootAddress,
      txHash: rootDeploy.txHash,
      txId: rootDeploy.txId,
      note: "PLAN-02 S4 — token-side root, deployed ONCE against account v1",
    });

    v1Vk = (await onChainVkHex(accountProviders, accountAddress, "validate"))!;
    // At deploy time the on-chain key is byte-identical to the compiled one.
    expect(v1Vk).toBe(await localVkHex(accountProviders, "validate"));

    await timed({ contract: ROOT, circuit: "hop", note: "S4 act A — hop against account v1" }, () =>
      callCircuit(rootDeploy.deployed, "hop", [DIGEST]),
    );

    const ledger = await readLedger<{ validateCount: bigint }>(
      accountProviders,
      accountAddress,
      account.loaded.module,
    );
    expect(ledger.validateCount).toBe(1n);
  });

  it("B — releases account v2 locally; the stale binding is refused with no transaction", async () => {
    // The local bundle is upgraded, nothing on chain has changed.
    const accountDir = compileAs("S4AccountV2.compact", ACCOUNT);
    const accountProviders = await providersFor(ACCOUNT, accountDir);
    v2Vk = await localVkHex(accountProviders, "validate");

    // One added constraint changes the key. That is the premise of the whole
    // problem: any policy change at all invalidates the binding.
    expect(v2Vk).not.toBe(v1Vk);
    expect(await onChainVkHex(accountProviders, accountAddress, "validate")).toBe(v1Vk);

    // Re-attach the root on fresh providers, so its proof registry indexes the
    // NEW artifact tree, and try the same hop.
    const rootDir = compileAs("S4Root.compact", ROOT);
    const rootProviders = await providersFor(ROOT, rootDir);
    const root = await handleFor(ROOT, rootDir);
    const attached = await findDeployed(rootProviders, root.handle, rootAddress, ROOT);

    // Refused locally, before any transaction is built or any fee is paid. The
    // guard here is the ZK artifact registry: it resolves a callee's proving key
    // by joining on the DEPLOYED verifier key, and a bundle that no longer
    // matches the chain simply does not resolve.
    await expect(callCircuit(attached, "hop", [DIGEST])).rejects.toThrow(
      /No ZK artifact bundle matches the deployed verifier key/,
    );
  });

  it("C — the SDK's own rotation helper FAILS: compact-js hardcodes the wrong key version", async () => {
    // A finding, not a detour. `submitRemoveVerifierKeyTx` is the documented way
    // to do this, and on a `--feature-zkir-v3` contract it does not work:
    // compact-js builds `new VerifierKeyRemove(id, new ContractOperationVersion('v3'))`,
    // the update matches no stored key, and the transaction comes back
    // FailFallible — included in a block, fee paid, nothing changed. PLAN-03
    // must not build an upgrade procedure on these functions as they stand.
    const accountDir = compileAs("S4AccountV2.compact", ACCOUNT);
    const accountProviders = await providersFor(ACCOUNT, accountDir);
    const account = await handleFor(ACCOUNT, accountDir);

    const outcome = await submitRemoveVerifierKeyTx(
      accountProviders as never,
      account.handle as never,
      accountAddress as never,
      "validate" as never,
    ).then(
      () => "succeeded",
      (e: { name?: string; finalizedTxData?: { status?: string } }) =>
        `${e.name}/${e.finalizedTxData?.status}`,
    );
    expect(outcome).toBe("RemoveVerifierKeyTxFailedError/FailFallible");

    // The key is untouched, which is what makes the failure safe rather than
    // destructive: a botched rotation attempt cannot brick the account.
    expect(await onChainVkHex(accountProviders, accountAddress, "validate")).toBe(v1Vk);
  });

  it("D — rotates the deployed account's verifier key to v2, atomically", async () => {
    const accountDir = compileAs("S4AccountV2.compact", ACCOUNT);
    const accountProviders = await providersFor(ACCOUNT, accountDir);

    // Remove + insert in ONE maintenance update, filed under `v4` — the version
    // a zkir-v3 contract's entry points are actually stored under. One update
    // rather than two also means the entry point is never absent: the SDK's
    // two-transaction sequence would leave a window in which every call fails.
    const newVk = await accountProviders.zkConfigProvider.getVerifierKey("validate");
    const result = (await rotateVerifierKey(
      accountProviders,
      accountAddress,
      "validate",
      newVk,
      "v4",
    )) as { status: string };
    expect(result.status).toBe("SucceedEntirely");
    expect(await onChainVkHex(accountProviders, accountAddress, "validate")).toBe(v2Vk);
  });

  it("D2 — a caller still holding the OLD bundle is locked out", async () => {
    // The other side of the guard, and the operational cost of the upgrade: once
    // rotated, processes running the previous release cannot call the account
    // until they are restarted on the new bundle. `staleRoot` is the act-A
    // handle, whose callee module is still v1 in this process's module cache.
    await expect(callCircuit(staleRoot, "hop", [DIGEST])).rejects.toThrow(
      /does not match the implementation the caller was compiled against/,
    );
  });

  it("E — a relayer restarted on the new bundle drives the SAME root, never redeployed", async () => {
    const freshRoot = publishFreshBundles();
    const rootDir = path.join(freshRoot, ROOT);
    const accountDir = path.join(freshRoot, ACCOUNT);

    const rootProviders = await providersFor(ROOT, rootDir);
    const root = await handleFor(ROOT, rootDir);
    const attached = await findDeployed(rootProviders, root.handle, rootAddress, ROOT);

    await timed(
      { contract: ROOT, circuit: "hop", note: "S4 act E — hop after rotating the account to v2" },
      () => callCircuit(attached, "hop", [new Uint8Array(32).fill(0xd5)]),
    );

    // The account's ledger survived the rotation: rotation swaps the proof
    // circuit, not the state. The counter continues from act A.
    const accountProviders = await providersFor(ACCOUNT, accountDir);
    const accountModule = await loadCompiledModule(accountDir);
    const ledger = await readLedger<{ validateCount: bigint }>(
      accountProviders,
      accountAddress,
      accountModule.module,
    );
    expect(ledger.validateCount).toBe(2n);

    // And the v2 rule — the constraint that made this an upgrade — is in force.
    await expect(callCircuit(attached, "hop", [new Uint8Array(32)])).rejects.toThrow(
      /digest must be non-zero/,
    );
  });
});
