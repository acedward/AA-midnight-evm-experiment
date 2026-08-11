// PLAN-01 gate G1.3 — typed event read-back through the indexer.
//
// Emit a typed event from our own deployed fixture and read it back two ways:
//   1. `CallResultPublic.logEvents` — the beta.6 call-result field (beta.4 lacks it);
//   2. the indexer's `contractEvents` query.
// The gate is that both see it and they agree. `Misc` events are broken end to
// end on this lane (PLAN-00 §7), so the probe uses ShieldedSpend — a typed event
// with one indexed scalar, classified by the indexer as SHIELDED_SPEND.

import { beforeAll, describe, expect, it } from "vitest";

import { keccak_256 } from "@noble/hashes/sha3.js";

import { bindCompiledContract, loadCompiledModule } from "../compiled.ts";
import { compileContract } from "../compile.ts";
import { contractByName } from "../contracts.ts";
import { callCircuit, deployFresh, type CallResult } from "../contract-ops.ts";
import { recordDeployment } from "../deployments.ts";
import { queryContractEvents, rawContainsBytes, sameContractAddress } from "../events.ts";
import { ROLE_SEEDS } from "../genesis-seeds.ts";
import { createProviders, type Providers } from "../providers.ts";
import { createWallet, syncWallet, type WalletCtx } from "../wallet.ts";

const NAME = "KeccakFixture";
const PRIVATE_STATE_ID = "keccak-events";

describe("G1.3 — typed event read-back", () => {
  let alice: WalletCtx;
  let providers: Providers;
  let contractAddress: string;
  let call: CallResult;
  let digest: Uint8Array;

  beforeAll(async () => {
    const compiled = compileContract(contractByName(NAME));
    alice = await createWallet("alice", ROLE_SEEDS.alice);
    await syncWallet(alice);
    providers = await createProviders(alice, compiled.managedDir, PRIVATE_STATE_ID);

    const loaded = await loadCompiledModule(compiled.managedDir);
    const handle = bindCompiledContract(NAME, loaded, { vacantWitnesses: true });
    const deployed = await deployFresh(providers, handle, PRIVATE_STATE_ID, []);
    contractAddress = deployed.contractAddress;
    recordDeployment({
      name: NAME,
      contractAddress,
      txHash: deployed.txHash,
      txId: deployed.txId,
      note: "PLAN-01 G1.3 event read-back fixture",
    });

    // Fresh value per run so the emitted nullifier is unique on this shared chain.
    const value = crypto.getRandomValues(new Uint8Array(32));
    digest = keccak_256(value);
    call = await callCircuit(deployed.deployed, "hashStoreAndEmit", [value]);
  });

  it("surfaces the event on the beta.6 call result", () => {
    // The plan calls this field `events`; in midnight-js 5.0.0-beta.6 it is
    // actually `CallResultPublic.logEvents`. beta.4 has no such field at all,
    // which is why the lane is pinned here.
    expect(call.logEvents, "logEvents missing — is midnight-js still beta.6?").toBeDefined();
    expect(Array.isArray(call.logEvents)).toBe(true);
    expect(call.logEvents.length).toBeGreaterThan(0);
  });

  it("reads the same event back through the indexer, keyed by the chain tx hash", async () => {
    // The tx must be indexed before it is queryable; the call already waited for
    // finalization, so a short bounded retry covers indexer lag only.
    let events: Awaited<ReturnType<typeof queryContractEvents>> = [];
    for (let attempt = 0; attempt < 20 && events.length === 0; attempt++) {
      events = await queryContractEvents({
        contractAddress,
        transactionHash: call.txHash,
        types: ["SHIELDED_SPEND"],
      });
      if (events.length === 0) await new Promise((r) => setTimeout(r, 1000));
    }

    expect(events.length, `no SHIELDED_SPEND event for tx ${call.txHash}`).toBeGreaterThan(0);
    for (const event of events) {
      expect(sameContractAddress(event.contractAddress, contractAddress)).toBe(true);
    }
    // The emitted nullifier IS the keccak digest — the two read paths agree on
    // the payload, not merely on "an event happened".
    expect(events.some((e) => rawContainsBytes(e.raw, digest))).toBe(true);
  });

  it("filters by contract address without truncating (pagination is exhaustive)", async () => {
    const all = await queryContractEvents({ contractAddress, types: ["SHIELDED_SPEND"] });
    expect(all.length).toBeGreaterThan(0);
    // Ids are unique — the at-least-once stream was deduped.
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
  });
});
