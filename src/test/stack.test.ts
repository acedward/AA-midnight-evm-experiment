// PLAN-01 gate G1.0 — the FIRST test of the project.
//
// The stack must already be up (infra/stack-up.sh). This suite asserts the
// contract that every later phase depends on: generated ports in STACK.env, all
// three services answering on them, and a genesis wallet that syncs and pays a
// real DUST fee on this chain.

import { describe, expect, it, beforeAll } from "vitest";

import { ENDPOINTS, NETWORK_ID } from "../endpoints.ts";
import { stackEnv } from "../stack-env.ts";
import { ROLE_SEEDS } from "../genesis-seeds.ts";
import { createWallet, syncWallet, type WalletCtx } from "../wallet.ts";
import { dustBalance, payOneFee, unshieldedAddress } from "../fee.ts";

const EXCLUDED: ReadonlyArray<readonly [number, number]> = [
  [10000, 10030], // live evm-compat stack (populated DB — do not touch)
  [12300, 12599], // midnight-ref-ai matrix slots
  [9944, 9944], // proxied onto the live stack
  [8088, 8088], // proxied onto the live stack
];

describe("G1.0 — persistent Part-0 stack", () => {
  const env = stackEnv();

  it("allocated ports above 10000, outside every reserved range", () => {
    const base = Number(env.AA_BASE_PORT);
    expect(base).toBeGreaterThanOrEqual(10100);
    expect(base).toBeLessThanOrEqual(63990);

    const ports = [
      Number(env.AA_NODE_PORT),
      Number(env.AA_INDEXER_HTTP_PORT),
      Number(env.AA_INDEXER_WS_PORT),
      Number(env.AA_PROOF_SERVER_PORT),
    ];
    expect(ports).toEqual([base, base + 1, base + 2, base + 3]);

    // The whole reserved window P..P+9, not just the four we publish: PLAN-01
    // hands P+4..P+9 to PLAN-05, so those must be clear of the hazards too.
    for (let p = base; p < base + 10; p++) {
      for (const [lo, hi] of EXCLUDED) {
        expect(p >= lo && p <= hi, `port ${p} lands in reserved range ${lo}-${hi}`).toBe(false);
      }
    }
  });

  it("names the stack after its port window and targets the local devnet", () => {
    expect(env.COMPOSE_PROJECT_NAME).toBe(`midnight-aa-${env.AA_BASE_PORT}`);
    expect(NETWORK_ID).toBe("undeployed");
    expect(env.MIDNIGHT_NETWORK_ID).toBe("undeployed");
  });

  it("pins images from versions.json — never a floating tag", () => {
    expect(env.AA_NODE_IMAGE).toBe("midnightntwrk/midnight-node:2.0.0-rc.4");
    // The plain proof-server tag answers "Unsupported ZKIR version" for zkir-v3.
    expect(env.AA_PROOF_SERVER_IMAGE).toBe(
      "midnightntwrk/proof-server:9.0.0-rc.5_experimental",
    );
    // A stock indexer release does not serve contractEvents/fieldPrefixes.
    expect(env.AA_INDEXER_IMAGE).toContain("bridge-and-events");
    for (const image of [env.AA_NODE_IMAGE, env.AA_INDEXER_IMAGE, env.AA_PROOF_SERVER_IMAGE]) {
      expect(image).not.toMatch(/:latest$/);
    }
  });

  it("node RPC answers and the chain is producing blocks", async () => {
    const res = await fetch(ENDPOINTS.node, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "chain_getHeader", params: [] }),
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { result?: { number?: string } };
    const height = Number.parseInt(body.result?.number ?? "0x0", 16);
    expect(height).toBeGreaterThan(0);
  });

  it("indexer serves GraphQL v4 on its generated port", async () => {
    const res = await fetch(ENDPOINTS.indexerHttp, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "query { __typename }" }),
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { data?: { __typename?: string }; errors?: unknown[] };
    expect(body.errors ?? []).toHaveLength(0);
    expect(body.data?.__typename).toBeTruthy();
  });

  it("indexer serves the events API this project depends on", async () => {
    // G1.3 reads typed events through contractEvents; assert the schema exposes
    // it now, so a wrong indexer image fails here instead of three plans later.
    const res = await fetch(ENDPOINTS.indexerHttp, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "query { __type(name: \"Query\") { fields { name } } }",
      }),
    });
    const body = (await res.json()) as {
      data?: { __type?: { fields?: { name: string }[] } };
    };
    const fields = (body.data?.__type?.fields ?? []).map((f) => f.name);
    expect(fields).toContain("contractEvents");
  });

  it("proof server is the _experimental build and is healthy", async () => {
    const res = await fetch(`${ENDPOINTS.proofServer}/health`);
    expect(res.ok).toBe(true);
  });
});

describe("G1.0c — a wallet syncs and pays one fee", () => {
  let alice: WalletCtx;

  beforeAll(async () => {
    alice = await createWallet("alice", ROLE_SEEDS.alice);
    await syncWallet(alice);
  });

  it("syncs a genesis wallet with spendable DUST", async () => {
    const dust = await dustBalance(alice);
    expect(dust).toBeGreaterThan(0n);
  });

  it("pays a real DUST fee for a NIGHT transfer to a fresh recipient", async () => {
    // Fresh recipient per run — the chain is persistent and shared.
    const recipientSeed = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    const recipient = await createWallet("recipient", recipientSeed);

    const result = await payOneFee(alice, await unshieldedAddress(recipient));

    expect(result.txId).toBeTruthy();
    expect(result.feePaid).toBeGreaterThan(0n);
  });
});
