// infra/TIMINGS.json — measured proving wall-clock, per circuit.
//
// PLAN-01 G1.2 exists to produce this file: PLAN-05's relayer is designed around
// the fact that proving is tens of seconds, so the relayer must return the eth
// tx hash immediately and prove asynchronously. That design needs a number from
// THIS machine and THIS stack, not the 25-40s figure carried in from elsewhere.

import * as fs from "node:fs";
import * as path from "node:path";

import { INFRA_DIR } from "./stack-env.ts";
import { currentStack } from "./deployments.ts";

export const TIMINGS_PATH = path.join(INFRA_DIR, "TIMINGS.json");

export interface Timing {
  /** managed-dir name of the contract. */
  contract: string;
  circuit: string;
  /** Wall clock from callTx invocation to finalized call result. */
  millis: number;
  /** What this call was measuring, e.g. "G1.2 secp256k1 verify". */
  note?: string;
  stack: string;
  measuredAt: string;
}

interface TimingsFile {
  _comment: string;
  timings: Timing[];
}

const EMPTY: TimingsFile = {
  _comment:
    "Measured prove+finalize wall-clock per circuit call on the persistent Part-0 stack. " +
    "Written by src/timings.ts. Input to PLAN-05's async relayer design; NOT a benchmark " +
    "suite — these are the real end-to-end latencies the gates observed.",
  timings: [],
};

function read(): TimingsFile {
  if (!fs.existsSync(TIMINGS_PATH)) return { ...EMPTY, timings: [] };
  const parsed = JSON.parse(fs.readFileSync(TIMINGS_PATH, "utf-8")) as TimingsFile;
  return { ...EMPTY, ...parsed, timings: parsed.timings ?? [] };
}

export function recordTiming(t: Omit<Timing, "stack" | "measuredAt">): Timing {
  const full: Timing = { ...t, stack: currentStack(), measuredAt: new Date().toISOString() };
  const file = read();
  file.timings.push(full);
  fs.writeFileSync(TIMINGS_PATH, `${JSON.stringify(file, null, 2)}\n`);
  return full;
}

export function allTimings(): Timing[] {
  return read().timings;
}

/** Time an async call and record how long it took. */
export async function timed<T>(
  meta: Omit<Timing, "millis" | "stack" | "measuredAt">,
  fn: () => Promise<T>,
): Promise<{ result: T; millis: number }> {
  const started = Date.now();
  const result = await fn();
  const millis = Date.now() - started;
  recordTiming({ ...meta, millis });
  console.log(
    `      ⏱ ${meta.contract}.${meta.circuit} proven+finalized in ${(millis / 1000).toFixed(1)}s`,
  );
  return { result, millis };
}
