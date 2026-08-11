// The one place STACK.env is read. Nothing else in this repo may name a port.
//
// PLAN-01 Part 0 / PLAN-00 §7 (PART-E Q4): on this machine a local proxy maps
// 9944 -> 10000 and 8088 -> 10001 onto somebody else's LIVE stack with a
// populated DB. A default port here would not fail — it would silently succeed
// against the wrong chain. So there are no defaults: a missing STACK.env, or a
// missing key inside it, throws.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const INFRA_DIR = path.join(REPO_ROOT, "infra");
export const STACK_ENV_PATH = path.join(INFRA_DIR, "STACK.env");

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return out;
}

let cached: Record<string, string> | undefined;

/** The generated stack description. Throws (never guesses) if it is missing. */
export function stackEnv(): Record<string, string> {
  if (cached) return cached;
  if (!fs.existsSync(STACK_ENV_PATH)) {
    throw new Error(
      `${STACK_ENV_PATH} does not exist — run infra/stack-up.sh first.\n` +
        "There is deliberately no default port: the defaults (9944/8088/6300) are a proxy " +
        "onto another live stack on this machine.",
    );
  }
  cached = parseEnvFile(fs.readFileSync(STACK_ENV_PATH, "utf-8"));
  return cached;
}

export function requireStackVar(name: string): string {
  const value = process.env[name] ?? stackEnv()[name];
  if (!value) throw new Error(`${name} is not set in ${STACK_ENV_PATH}`);
  return value;
}

/** Push STACK.env into process.env (for libraries that read env directly). */
export function loadStackEnvIntoProcess(): void {
  for (const [key, value] of Object.entries(stackEnv())) {
    process.env[key] ??= value;
  }
  // The wallet/provider stack keys off this; `undeployed` selects the local
  // devnet address format and the genesis-funded seeds.
  process.env.MIDNIGHT_NETWORK_ID ??= requireStackVar("MIDNIGHT_NETWORK_ID");
}
