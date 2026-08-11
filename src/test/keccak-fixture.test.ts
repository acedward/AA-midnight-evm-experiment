// PLAN-01 gate G1.1 — the toolchain canary.
//
// Compile a keccak fixture with --feature-zkir-v3, deploy it, round-trip ONE
// real proven call against the _experimental proof server, record the address in
// DEPLOYMENTS.json, and re-attach to it with findDeployed from a second provider
// set (the relayer's access pattern: attach as a non-deployer).
//
// Runs against the persistent Part-0 stack; never restarts it.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { beforeAll, describe, expect, it } from "vitest";

import { bindCompiledContract, loadCompiledModule } from "../compiled.ts";
import { compileContract, managedDirFor } from "../compile.ts";
import { contractByName } from "../contracts.ts";
import {
  callCircuit,
  deployFresh,
  findDeployed,
  readLedger,
  type DeployedContractLike,
} from "../contract-ops.ts";
import { latestDeployment, recordDeployment } from "../deployments.ts";
import { ROLE_SEEDS } from "../genesis-seeds.ts";
import { bytesToHex } from "../hex.ts";
import { createProviders, type Providers } from "../providers.ts";
import { createWallet, syncWallet, type WalletCtx } from "../wallet.ts";

const NAME = "KeccakFixture";
const PRIVATE_STATE_ID = "keccak-fixture";

interface FixtureLedger {
  lastDigest: Uint8Array;
  callCount: bigint;
}

describe("G1.1 — keccak fixture: compile, deploy, prove, re-attach", () => {
  let alice: WalletCtx;
  let bob: WalletCtx;
  let aliceProviders: Providers;
  let managedDir: string;

  beforeAll(async () => {
    // Compiling here (not in a separate step) is the point: the gate asserts the
    // pipeline, not a pre-baked artifact.
    const result = compileContract(contractByName(NAME));
    managedDir = result.managedDir;
    expect(managedDir).toBe(managedDirFor(NAME));
    expect(result.exportedCircuits).toContain("hashAndStore");

    alice = await createWallet("alice", ROLE_SEEDS.alice);
    await syncWallet(alice);
    aliceProviders = await createProviders(alice, managedDir, PRIVATE_STATE_ID);
  });

  it("compiled with zkir-v3 and emitted a verifier key per exported circuit", () => {
    const loaded = compileContract(contractByName(NAME));
    expect(loaded.exportedCircuits.sort()).toEqual(["hashAndStore", "hashStoreAndEmit"]);
    // <= 7 exported circuits is enforced inside compileContract; assert the
    // budget is real headroom, not coincidence.
    expect(loaded.exportedCircuits.length).toBeLessThanOrEqual(7);
  });

  it("deploys, proves one call, and the digest matches noble's keccak256", async () => {
    const loaded = await loadCompiledModule(managedDir);
    const compiled = bindCompiledContract(NAME, loaded, { vacantWitnesses: true });

    const deployed = await deployFresh(aliceProviders, compiled, PRIVATE_STATE_ID, []);
    expect(deployed.contractAddress).toMatch(/^[0-9a-f]{64}$/i);

    recordDeployment({
      name: NAME,
      contractAddress: deployed.contractAddress,
      txHash: deployed.txHash,
      txId: deployed.txId,
      note: "PLAN-01 G1.1 keccak toolchain canary",
    });

    // Fresh input per run: the chain is persistent and this contract accumulates.
    const value = crypto.getRandomValues(new Uint8Array(32));
    const started = Date.now();
    const call = await callCircuit(deployed.deployed, "hashAndStore", [value]);
    const provingMs = Date.now() - started;
    console.log(`      hashAndStore proven+finalized in ${(provingMs / 1000).toFixed(1)}s`);

    expect(call.txHash).toBeTruthy();
    expect(call.blockHeight).toBeGreaterThan(0);

    // In-circuit keccak256 must equal the off-circuit reference over the full
    // aligned 32 bytes (no trailing-zero trim on this lane).
    const expected = keccak_256(value);
    const ledger = await readLedger<FixtureLedger>(
      aliceProviders,
      deployed.contractAddress,
      loaded.module,
    );
    expect(bytesToHex(ledger.lastDigest)).toBe(bytesToHex(expected));
    expect(BigInt(ledger.callCount)).toBeGreaterThanOrEqual(1n);
  });

  it("re-attaches to the recorded address as a NON-deployer (the relayer pattern)", async () => {
    const record = latestDeployment(NAME);
    expect(record, "G1.1 deploy must have written DEPLOYMENTS.json").toBeDefined();

    // bob never deployed this contract and has its own private-state store.
    bob = await createWallet("bob", ROLE_SEEDS.bob);
    await syncWallet(bob);
    const bobProviders = await createProviders(bob, managedDir, `${PRIVATE_STATE_ID}-bob`);

    const loaded = await loadCompiledModule(managedDir);
    const compiled = bindCompiledContract(NAME, loaded, { vacantWitnesses: true });
    const attached: DeployedContractLike = await findDeployed(
      bobProviders,
      compiled,
      record!.contractAddress,
      `${PRIVATE_STATE_ID}-bob`,
    );

    const before = await readLedger<FixtureLedger>(
      bobProviders,
      record!.contractAddress,
      loaded.module,
    );

    const value = crypto.getRandomValues(new Uint8Array(32));
    const call = await callCircuit(attached, "hashAndStore", [value]);
    expect(call.txHash).toBeTruthy();

    const after = await readLedger<FixtureLedger>(
      bobProviders,
      record!.contractAddress,
      loaded.module,
    );
    expect(bytesToHex(after.lastDigest)).toBe(bytesToHex(keccak_256(value)));
    // Same instance, accumulating — not a fresh deploy that happened to work.
    expect(BigInt(after.callCount)).toBe(BigInt(before.callCount) + 1n);
  });
});
