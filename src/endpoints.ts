// Service endpoints, resolved from infra/STACK.env only.
//
// Vendored in spirit from compact-end-2-end @ aa344546 utils/endpoints.ts, with
// the localhost fallbacks REMOVED: this project targets one persistent stack on
// generated ports, and a fallback would silently hit the proxied live stack
// (PLAN-01 Part 0 step 4).

import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

import { loadStackEnvIntoProcess, requireStackVar } from "./stack-env.ts";

loadStackEnvIntoProcess();

export const ENDPOINTS = {
  node: requireStackVar("AA_NODE_URL"),
  nodeWs: requireStackVar("AA_NODE_WS"),
  indexerHttp: requireStackVar("AA_INDEXER_HTTP"),
  indexerWs: requireStackVar("AA_INDEXER_WS"),
  proofServer: requireStackVar("AA_PROOF_SERVER"),
} as const;

export const NETWORK_ID = requireStackVar("MIDNIGHT_NETWORK_ID");

/** Must be called before any wallet/address work — address formats key off it. */
export function setNetwork(networkId: string = NETWORK_ID): void {
  setNetworkId(networkId);
}
