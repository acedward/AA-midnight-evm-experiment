// infra/DEPLOYMENTS.json — the address registry for the persistent chain.
//
// The Part-0 stack is never torn down, so a contract deployed in PLAN-01 is
// still callable in PLAN-05. That is only useful if the addresses survive the
// process that created them, hence this file: every deploy appends
// {name, contractAddress, block, txHash, ...}, and findDeployed re-attaches from
// it. PLAN-00 §9.2 also makes it the relayer's routing source of truth.
//
// Entries are append-only and keyed by (name, stack). The stack key is the
// COMPOSE_PROJECT_NAME: if someone regenerates STACK.env (new ports, new chain),
// old addresses stay in the file but stop resolving, which is exactly the signal
// you want instead of a silent miss against a different chain.

import * as fs from "node:fs";

import { INFRA_DIR, requireStackVar } from "./stack-env.ts";
import * as path from "node:path";

export const DEPLOYMENTS_PATH = path.join(INFRA_DIR, "DEPLOYMENTS.json");

export interface DeploymentRecord {
  /** Logical name — the managed-dir name, e.g. "KeccakFixture", "Account". */
  name: string;
  contractAddress: string;
  txHash: string;
  txId?: string;
  block?: number;
  /** COMPOSE_PROJECT_NAME of the stack this address lives on. */
  stack: string;
  deployedAt: string;
  /** Free-form: which gate/plan created it. */
  note?: string;
  /**
   * Set when the chain GENERATION that minted this address was wiped (the
   * COMPOSE_PROJECT_NAME alone cannot tell generations apart — the 36080
   * window was regenerated in place, PLAN-05 Q2). An archived row is history,
   * not routing state: resolution helpers skip it.
   */
  archived?: string;
}

interface DeploymentsFile {
  _comment: string;
  deployments: DeploymentRecord[];
}

const EMPTY: DeploymentsFile = {
  _comment:
    "Append-only registry of contracts deployed on the persistent Part-0 stack. " +
    "Written by src/deployments.ts. `stack` is the COMPOSE_PROJECT_NAME — addresses " +
    "only resolve against the chain that minted them.",
  deployments: [],
};

function read(): DeploymentsFile {
  if (!fs.existsSync(DEPLOYMENTS_PATH)) return { ...EMPTY, deployments: [] };
  const parsed = JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, "utf-8")) as DeploymentsFile;
  return { ...EMPTY, ...parsed, deployments: parsed.deployments ?? [] };
}

function write(file: DeploymentsFile): void {
  fs.writeFileSync(DEPLOYMENTS_PATH, `${JSON.stringify(file, null, 2)}\n`);
}

export function currentStack(): string {
  return requireStackVar("COMPOSE_PROJECT_NAME");
}

/** Append a deployment. Never rewrites history — a redeploy adds a new row. */
export function recordDeployment(
  record: Omit<DeploymentRecord, "stack" | "deployedAt"> & Partial<Pick<DeploymentRecord, "stack">>,
): DeploymentRecord {
  const full: DeploymentRecord = {
    ...record,
    stack: record.stack ?? currentStack(),
    deployedAt: new Date().toISOString(),
  };
  const file = read();
  file.deployments.push(full);
  write(file);
  return full;
}

/** Every LIVE (non-archived) deployment of `name` on the current stack, newest last. */
export function deploymentsOf(name: string, stack = currentStack()): DeploymentRecord[] {
  return read().deployments.filter((d) => d.name === name && d.stack === stack && !d.archived);
}

/** The most recent address for `name` on this stack, or undefined. */
export function latestDeployment(name: string, stack = currentStack()): DeploymentRecord | undefined {
  return deploymentsOf(name, stack).at(-1);
}

export function allDeployments(): DeploymentRecord[] {
  return read().deployments;
}
