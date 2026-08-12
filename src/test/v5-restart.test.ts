// PLAN-00 §9.3 V5 — restart resilience.
//
// The restart itself happens OUTSIDE this suite (`docker compose … restart` on
// the compose project — never `down`), followed by infra/stack-status.sh until
// healthy. This suite is the after-the-restart half, and it is deliberately
// restart-agnostic: everything here must hold on any healthy stack, so the
// suite can also run standalone as a registry-integrity check.
//
//   1. The DEPLOYMENTS.json archive marking holds: the 36080 port window was
//      wiped and regenerated in place on 2026-08-11 (PLAN-05 Q2), so gen-1
//      rows — addresses minted by the wiped chain — must carry `archived` and
//      every live row must postdate the wipe. COMPOSE_PROJECT_NAME alone
//      cannot tell the generations apart; the marking is the quarantine.
//   2. `findDeployed` re-attaches to EVERY live (non-archived, current-stack)
//      address — the relayer's restart path, for every contract at once.
//      Archived addresses are proven dead-and-skipped, not silently ignored:
//      resolution helpers exclude them (src/deployments.ts).
//   3. One more proven transfer on the V2 demo pair lands after the restart.
//
// Evidence goes to infra/VERIFICATION-EVIDENCE-v5.json.

import * as fs from "node:fs";
import * as path from "node:path";

import { beforeAll, afterAll, describe, expect, it } from "vitest";

import {
  OP_TRANSFER,
  ethAddressOfPriv,
  padEthAddress,
  signAccountPayload,
} from "../account-payload.ts";
import { bindCompiledContract, loadCompiledModule, type LoadedCompiledModule, type Witnesses } from "../compiled.ts";
import { compileContract, managedDirFor } from "../compile.ts";
import { contractByName } from "../contracts.ts";
import {
  callCircuit,
  contractAddressBytes,
  findDeployed,
  readLedger,
  type CallResult,
  type DeployedContractLike,
} from "../contract-ops.ts";
import { allDeployments, currentStack, type DeploymentRecord } from "../deployments.ts";
import { ROLE_SEEDS } from "../genesis-seeds.ts";
import { bytesToHex, hexToBytes } from "../hex.ts";
import { createProviders, type Providers } from "../providers.ts";
import { INFRA_DIR } from "../stack-env.ts";
import { createWallet, syncWallet, type WalletCtx } from "../wallet.ts";

const OWNER_PRIV = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const RECIPIENT = padEthAddress(`0x${"cc".repeat(20)}`);
// PLAN-05 Q2: the persistent 36080 stack was wiped and regenerated (fresh
// genesis) with Edward's approval; every address minted before this instant
// is gen-1 and dead by design.
const WIPE_CUTOFF = Date.parse("2026-08-11T23:00:00Z");

const EVIDENCE_PATH = path.join(INFRA_DIR, "VERIFICATION-EVIDENCE-v5.json");
const evidence: Array<Record<string, unknown>> = [];
const record = (entry: Record<string, unknown>) =>
  evidence.push({ at: new Date().toISOString(), ...entry });

let alice: WalletCtx;
let rows: DeploymentRecord[];
let live: DeploymentRecord[];
let archivedRows: DeploymentRecord[];
const loadedByName = new Map<string, LoadedCompiledModule>();

/** Deniers for witness-bearing tokens — the relayer's own restart posture. */
function denierWitnesses(names: readonly string[]): Witnesses {
  return Object.fromEntries(
    names.map((name) => [
      name,
      () => {
        throw new Error(`${name} is not available to a re-attaching third party`);
      },
    ]),
  );
}

const BINDINGS: Record<string, { witnesses?: readonly string[] }> = {
  Account: {},
  MiniTokenAA: {},
  TokenAA: { witnesses: ["wit_OwnableSK", "wit_FungibleTokenSK"] },
};

beforeAll(async () => {
  rows = allDeployments().filter((d) => d.stack === currentStack());
  live = rows.filter((d) => !d.archived);
  archivedRows = rows.filter((d) => Boolean(d.archived));

  // Compile every bundle named by a live row (Account first — CCC callee rule).
  compileContract(contractByName("Account"));
  for (const name of new Set(live.map((d) => d.name))) {
    if (name !== "Account") compileContract(contractByName(name));
    loadedByName.set(name, await loadCompiledModule(managedDirFor(name)));
  }

  alice = await createWallet("alice", ROLE_SEEDS.alice);
  await syncWallet(alice);
}, 1_200_000);

afterAll(async () => {
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify({ suite: "V5", records: evidence }, null, 2)}\n`);
  await alice?.wallet.stop().catch(() => {});
}, 60_000);

describe("V5 — restart resilience (run after `docker compose restart`)", () => {
  it("the gen-1 archive marking holds — wiped addresses are quarantined", () => {
    expect(rows.length).toBeGreaterThan(0);
    // Every archived row predates the wipe; every live row postdates it.
    for (const row of archivedRows) {
      expect(Date.parse(row.deployedAt)).toBeLessThan(WIPE_CUTOFF);
    }
    for (const row of live) {
      expect(Date.parse(row.deployedAt)).toBeGreaterThan(WIPE_CUTOFF);
    }
    // And nothing pre-wipe escaped the marking.
    expect(rows.filter((d) => Date.parse(d.deployedAt) < WIPE_CUTOFF && !d.archived)).toEqual([]);
    record({
      v: "V5",
      step: "archive marking",
      archivedGen1Rows: archivedRows.length,
      liveGen2Rows: live.length,
    });
  });

  it("findDeployed re-attaches to EVERY live address in DEPLOYMENTS.json", async () => {
    const unique = new Map<string, DeploymentRecord>();
    for (const row of live) unique.set(row.contractAddress, row);

    let reattached = 0;
    for (const row of unique.values()) {
      const binding = BINDINGS[row.name];
      if (!binding) throw new Error(`no binding recipe for ${row.name}`);
      const loaded = loadedByName.get(row.name)!;
      const providers = await createProviders(
        alice,
        loaded.zkConfigPath,
        `v5-reattach-${row.contractAddress.slice(0, 8)}`,
      );
      const handle = bindCompiledContract(
        row.name,
        loaded,
        binding.witnesses ? { witnesses: denierWitnesses(binding.witnesses) } : { vacantWitnesses: true },
      );
      const deployed: DeployedContractLike = await findDeployed(
        providers,
        handle,
        row.contractAddress,
        `v5-reattach-${row.contractAddress.slice(0, 8)}`,
      );
      expect(deployed.deployTxData.public.contractAddress).toBe(row.contractAddress);
      reattached += 1;
      console.log(`      re-attached ${row.name} at ${row.contractAddress}`);
    }
    expect(reattached).toBe(unique.size);
    record({ v: "V5", step: "re-attach", reattached, uniqueLiveAddresses: unique.size });
  }, 1_200_000);

  it("one more proven transfer lands on the V2 demo pair", async () => {
    const accountRow = live.findLast((d) => d.note === "V2 demo account");
    const tokenRow = live.findLast((d) => d.note === "V2 token A");
    expect(accountRow).toBeDefined();
    expect(tokenRow).toBeDefined();

    const tokenLoaded = loadedByName.get("TokenAA")!;
    const accountLoaded = loadedByName.get("Account")!;
    const providers = await createProviders(alice, tokenLoaded.zkConfigPath, `v5-transfer-${Date.now()}`);
    const handle = bindCompiledContract("TokenAA", tokenLoaded, {
      witnesses: denierWitnesses(["wit_OwnableSK", "wit_FungibleTokenSK"]),
    });
    const token = await findDeployed(providers, handle, tokenRow!.contractAddress, `v5-transfer-${Date.now()}`);
    const accountAddressBytes = contractAddressBytes(accountRow!.contractAddress);
    const tokenAddressBytes = contractAddressBytes(tokenRow!.contractAddress);

    interface TokenLedger {
      _balances: Iterable<readonly [unknown, bigint]>;
    }
    const balanceOf = async (): Promise<bigint> => {
      const ledger = await readLedger<TokenLedger>(providers, tokenRow!.contractAddress, tokenLoaded.module);
      for (const [rawKey, amount] of ledger._balances) {
        const key = rawKey as { is_left: boolean; right: { bytes: Uint8Array } };
        if (!key.is_left && bytesToHex(key.right.bytes) === bytesToHex(accountAddressBytes)) return amount;
      }
      return 0n;
    };

    const before = await balanceOf();
    expect(before).toBeGreaterThanOrEqual(50n);

    // Unique nonce ⇒ unique digest; ordering is relayer-side and not in play.
    const signed = signAccountPayload(OWNER_PRIV, {
      op: OP_TRANSFER,
      token: tokenAddressBytes,
      account: accountAddressBytes,
      to: RECIPIENT,
      nonce: BigInt(Date.now()),
      amount: 50n,
    });
    const call: CallResult = await callCircuit(token, "accountTransfer", [
      { bytes: accountAddressBytes },
      signed.payload,
      signed.sig,
      signed.pk,
    ]);
    expect(call.blockHeight).toBeGreaterThan(0);
    expect(await balanceOf()).toBe(before - 50n);

    // The account callee answered inside the call tree — proof that the
    // re-attached CCC pair (token root + account callee) works post-restart.
    expect(bytesToHex((call.result as { bytes: Uint8Array }).bytes)).toBe(
      bytesToHex(accountAddressBytes),
    );
    record({
      v: "V5",
      step: "post-restart proven transfer (V2 pair)",
      txHash: call.txHash,
      blockHeight: call.blockHeight,
      account: accountRow!.contractAddress,
      token: tokenRow!.contractAddress,
    });
    console.log(`      post-restart transfer: ${call.txHash} (block ${call.blockHeight})`);
  }, 900_000);
});
