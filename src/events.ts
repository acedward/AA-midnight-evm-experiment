// Vendored from compact-end-2-end @ aa344546 (utils/events.ts), 2026-08-11.
// Copyright (C) Midnight Foundation — SPDX-License-Identifier: Apache-2.0
// Upstream: /Users/edwardalvarado/compact-end-2-end
// Local changes: the type filter is a parameter instead of a hardcoded
// UNSHIELDED_SPEND/RECEIVE pair, and queries paginate (upstream took the
// indexer's default page of 100 and would silently truncate).
//
// On-chain contract-event (MIP-0002 `log`) read-back over the indexer GraphQL
// API. Events are read through the top-level `contractEvents(filter, limit,
// offset)` query; `ContractEventFilter` accepts `contractAddress`,
// `transactionHash`, and a `types` list of `ContractEventType`. Each
// `ContractEvent` carries the serialized event verbatim in `raw`
// (VersionedLogItem: [version][tag][payload]).
//
// Two facts that bite (PLAN-01 §Deploy/call/read/observe helpers):
//   - `transactionId` is an INDEXER ROW ID, not the chain tx hash. Never join on it.
//   - the stream is at-least-once; dedup by `id` and resume from `fromId: id + 1`.

import { Buffer } from "node:buffer";

import { ENDPOINTS } from "./endpoints.ts";

export type ContractEventType =
  | "SHIELDED_SPEND"
  | "SHIELDED_RECEIVE"
  | "SHIELDED_MINT"
  | "SHIELDED_BURN"
  | "UNSHIELDED_SPEND"
  | "UNSHIELDED_RECEIVE"
  | "UNSHIELDED_MINT"
  | "UNSHIELDED_BURN"
  | "PAUSED"
  | "UNPAUSED"
  | "MISC";

export interface ContractLogEvent {
  /** Indexer event id (unique, ascending) — the dedup + resume key. */
  id: number;
  /** Hex contract address that emitted the event. */
  contractAddress: string;
  /** Indexer ROW id for the transaction. NOT the chain tx hash. */
  transactionId: number;
  /** Hex-encoded serialized event — VersionedLogItem: [version][tag][payload]. */
  raw: string;
}

export interface EventQuery {
  contractAddress?: string;
  /** Chain transaction hash (the real one, from a CallResult). */
  transactionHash?: string;
  types?: readonly ContractEventType[];
  /** Hard cap across all pages; the indexer's own page size is 100. */
  maxEvents?: number;
}

const PAGE = 100;

const CONTRACT_EVENTS_QUERY = `
  query ContractLogEvents($filter: ContractEventFilter!, $limit: Int, $offset: Int) {
    contractEvents(filter: $filter, limit: $limit, offset: $offset) {
      id
      raw
      contractAddress
      transactionId
    }
  }
`;

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

async function post<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(ENDPOINTS.indexerHttp, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`indexer GraphQL HTTP ${res.status}`);
  const body = (await res.json()) as GraphQLResponse<T>;
  if (body.errors?.length) {
    throw new Error(`indexer rejected the query: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  if (!body.data) throw new Error("indexer returned no data");
  return body.data;
}

/**
 * All contract-log events matching the filter, paginated to exhaustion.
 *
 * Upstream issued a single unpaginated query, which the indexer answers with at
 * most 100 rows — silent truncation the caller cannot detect. Here the loop runs
 * until a short page comes back (or maxEvents is hit), and dedups by `id`
 * because the stream is at-least-once.
 */
export async function queryContractEvents(query: EventQuery): Promise<ContractLogEvent[]> {
  const filter: Record<string, unknown> = {};
  if (query.contractAddress) filter.contractAddress = query.contractAddress.replace(/^0x/, "");
  if (query.transactionHash) filter.transactionHash = query.transactionHash.replace(/^0x/, "");
  if (query.types?.length) filter.types = query.types;

  const cap = query.maxEvents ?? Number.POSITIVE_INFINITY;
  const seen = new Set<number>();
  const out: ContractLogEvent[] = [];

  for (let offset = 0; out.length < cap; offset += PAGE) {
    const data = await post<{ contractEvents: ContractLogEvent[] }>(CONTRACT_EVENTS_QUERY, {
      filter,
      limit: PAGE,
      offset,
    });
    const page = data.contractEvents ?? [];
    for (const event of page) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      out.push(event);
    }
    if (page.length < PAGE) break;
  }

  return out.slice(0, query.maxEvents ?? out.length);
}

/** Normalize + compare two hex contract addresses (0x-insensitive, case-insensitive). */
export function sameContractAddress(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/^0x/, "").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Peek at a serialized event's version + tag.
 * Layout (empirical, from live indexer raw bytes): ASCII prefix
 * `midnight:event[vN]:`, then the payload, ending `[..][circuit-name][0x04][tag][0x01]`.
 * Tag is read at the fixed offset len-2; replace with a real deserializer once
 * the ledger SDK exposes one.
 */
export function peekEventTag(raw: string): { version: number; tag: number } | null {
  const hex = raw.replace(/^0x/, "");
  const ascii = Buffer.from(hex, "hex").toString("latin1");
  const m = /^midnight:event\[v(\d+)\]:/.exec(ascii);
  if (!m || hex.length < 6) return null;
  return { version: Number(m[1]), tag: parseInt(hex.slice(-4, -2), 16) };
}

/** True if the serialized event body contains this 32-byte value (hex, no 0x). */
export function rawContainsBytes(raw: string, value: Uint8Array): boolean {
  const hex = raw.replace(/^0x/, "").toLowerCase();
  return hex.includes(Buffer.from(value).toString("hex").toLowerCase());
}
