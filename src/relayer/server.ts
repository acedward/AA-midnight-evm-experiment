// PLAN-05 §2 — the relayer's HTTP surface, ported from evm-relayer @ 3703317
// (relayer/server.ts makeHttpServer + relayer/serve.ts CORS), account-mode:
//
//   POST /relay { payload: hex176, signature: hex65 }  — trustless personal_sign path
//   GET  /status/<0xdigest>                            — relayer-side submission state
//   GET  /registry                                     — registered tokens (routing table)
//   GET  /health
//
// A relay returns the EIP-191 digest as the eth tx hash IMMEDIATELY (proving is
// ~25–80 s on this stack — infra/TIMINGS.json — longer than any wallet's
// patience) and proves/submits async; poll /status until terminal. `?wait=1`
// on /relay blocks until terminal — test convenience only.
//
// PART-E's raw-tx path (eth_sendRawTransaction, relayer-attested) is NOT
// ported: every registered AA circuit verifies the user signature in-circuit,
// and no relayer-attested circuit exists on the account call tree — a
// deliberate scope fence (PLAN-00 §8), recorded in PLAN-05 §Questions.
//
// Run:  node --experimental-strip-types src/relayer/server.ts
// Env:  AA_RELAY_PORT  (default AA_BASE_PORT+4 — the STACK.env reserved block)
//       AA_RELAY_TOKENS (comma-separated managed names; default MiniTokenAA)
//       AA_RELAY_RATE_LIMIT (per-from attempts/minute; default 30)

import * as http from "node:http";
import * as path from "node:path";

import { requireStackVar } from "../stack-env.ts";
import { jsonLog, RelayerCore, RelayError } from "./core.ts";

export function relayerPort(): number {
  return Number(process.env.AA_RELAY_PORT ?? Number(requireStackVar("AA_BASE_PORT")) + 4);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export function makeHttpServer(core: RelayerCore): http.Server {
  return http.createServer(async (req, res) => {
    // Permissive CORS: the capture/demo pages fetch this relayer cross-origin.
    // Dev service on localhost only — never expose beyond loopback.
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "POST, GET, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const send = (code: number, data: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    try {
      const url = new URL(req.url ?? "/", "http://relay");
      if (req.method === "GET" && url.pathname === "/health") {
        return send(200, { status: "ok", role: core.role, tokens: core.tokens() });
      }
      if (req.method === "GET" && url.pathname === "/registry") {
        return send(200, { tokens: core.tokens() });
      }
      if (req.method === "GET" && url.pathname.startsWith("/status/")) {
        const state = core.status(url.pathname.slice("/status/".length));
        return state ? send(200, state) : send(404, { error: "unknown tx hash" });
      }
      if (req.method === "POST" && url.pathname === "/relay") {
        const body = JSON.parse(await readBody(req)) as {
          payload?: string;
          signature?: string;
        };
        if (typeof body.payload !== "string" || typeof body.signature !== "string") {
          return send(400, { error: "expected { payload, signature }" });
        }
        const result = core.relay(body.payload, body.signature);
        if (url.searchParams.get("wait") === "1") {
          const state = await core.waitFor(result.ethTxHash);
          return send(200, { ...result, state });
        }
        return send(200, result);
      }
      return send(404, { error: "not found" });
    } catch (e) {
      if (e instanceof RelayError) {
        return send(e.httpStatus, { code: e.code, error: e.message });
      }
      jsonLog("relayer", "http-error", { error: e instanceof Error ? e.message : String(e) });
      return send(500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
}

const isMain =
  process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (isMain) {
  const core = new RelayerCore();
  await core.start();
  for (const name of (process.env.AA_RELAY_TOKENS ?? "MiniTokenAA").split(",")) {
    await core.attachToken(name.trim());
  }
  const port = relayerPort();
  makeHttpServer(core).listen(port, "127.0.0.1", () => {
    jsonLog("relayer", "listening", { port, url: `http://127.0.0.1:${port}` });
  });
}
