// The compile pipeline: .compact -> contracts/managed/<name>/{contract,keys,zkir}.
//
// Modelled on compact-end-2-end @ aa344546 cases/harness/contracts.ts
// (`runCompactc`), reduced to the one runner mode this project needs (the pinned
// dockerized compiler) and hardened with the three rules PLAN-01 makes
// non-negotiable:
//
//   1. every contract compiles with --feature-zkir-v3 (the proof server we run
//      is the only one that can prove v3; the plain tag says "Unsupported ZKIR
//      version");
//   2. `ZKIR not found` on stderr is a HARD failure — compactc exits 0 having
//      silently skipped circuit compilation, so no verifier keys are generated
//      and the first deploy fails much later with an unrelated-looking error;
//   3. a callee's managed dir is named EXACTLY as the `contract` interface its
//      caller declares (case-sensitive — a Linux CI landmine), sits as a sibling
//      of the caller's managed dir, and is compiled BEFORE the caller. That name
//      is what pins the callee's verifier key into the caller's expectedVk.
//
// Circuit budget: <= 7 exported circuits per contract (deploy-tx verifier-key
// block-size limit, found empirically with 37).

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { REPO_ROOT } from "./stack-env.ts";

export const CONTRACTS_ROOT = path.join(REPO_ROOT, "contracts");
export const MANAGED_ROOT = path.join(CONTRACTS_ROOT, "managed");

interface Versions {
  compact: { compiler: string; features: string[]; maxExportedCircuits: number };
}

function versions(): Versions {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "versions.json"), "utf-8")) as Versions;
}

/** The pinned compactc image tag. infra/build-compact-image.sh builds it. */
export function compactImage(): string {
  return process.env.COMPACT_IMAGE ?? `compact-toolchain:${versions().compact.compiler}`;
}

export interface ContractSource {
  /** Source file relative to contracts/, e.g. "KeccakFixture.compact". */
  source: string;
  /**
   * Managed output directory name under contracts/managed/. For a CCC callee
   * this MUST equal the `contract` interface name its caller declares.
   */
  managedName: string;
  /** Extra compactc flags on top of the pinned feature flags. */
  extraFlags?: string[];
  /**
   * Evidence-backed exception to the repo's conservative default verifier-key
   * budget. The compiler still reports and enforces the explicit ceiling.
   */
  maxVerifierKeys?: number;
}

export interface CompileResult {
  managedName: string;
  managedDir: string;
  exportedCircuits: string[];
  durationMs: number;
}

function assertImageExists(image: string): void {
  const probe = spawnSync("docker", ["image", "inspect", image], { encoding: "utf-8" });
  if (probe.status !== 0) {
    throw new Error(
      `compactc image ${image} is not built. Run: ./infra/build-compact-image.sh`,
    );
  }
}

/**
 * Compile one contract. Array order is compile order — callees first.
 *
 * The whole contracts/ tree is bind-mounted at /work so a caller's managed dir
 * and its callees' managed dirs are siblings inside the container exactly as
 * they are on disk; that adjacency is how compactc resolves a `contract Foo`
 * interface to `managed/Foo`.
 */
export function compileContract(src: ContractSource): CompileResult {
  const image = compactImage();
  assertImageExists(image);

  const sourcePath = path.join(CONTRACTS_ROOT, src.source);
  if (!fs.existsSync(sourcePath)) throw new Error(`no such contract source: ${sourcePath}`);

  const managedRel = path.join("managed", src.managedName);
  const managedDir = path.join(CONTRACTS_ROOT, managedRel);
  const flags = [...versions().compact.features.map((f) => `--feature-${f}`), ...(src.extraFlags ?? [])];

  const started = Date.now();
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${CONTRACTS_ROOT}:/work`,
      image,
      // ENTRYPOINT is compactc itself — the upstream image wrapped the `compact`
      // version manager (`compact compile ...`), but that manager has no 0.33 RC
      // line, so this image installs the compiler binary directly.
      ...flags,
      `/work/${src.source}`,
      `/work/${managedRel}`,
    ],
    { encoding: "utf-8" },
  );
  const durationMs = Date.now() - started;

  const stderr = result.stderr ?? "";
  const stdout = result.stdout ?? "";

  // Hard guard: compactc can exit 0 having skipped circuit compilation.
  if (stderr.includes("ZKIR not found") || stdout.includes("ZKIR not found")) {
    throw new Error(
      `${src.source}: compactc skipped circuit compilation ("ZKIR not found") — ` +
        "no verifier keys were generated; the toolchain image is broken",
    );
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `compactc failed for ${src.source} (exit ${result.status})\n${stdout}\n${stderr}`,
    );
  }

  const exportedCircuits = readExportedCircuits(managedDir);
  const budget = src.maxVerifierKeys ?? versions().compact.maxExportedCircuits;
  if (exportedCircuits.length > budget) {
    throw new Error(
      `${src.source} exports ${exportedCircuits.length} circuits; the deploy-tx ` +
        `verifier-key block-size limit allows ${budget}. Split the contract.`,
    );
  }

  // A managed dir with no verifier keys means nothing provable was emitted.
  const keysDir = path.join(managedDir, "keys");
  if (!fs.existsSync(keysDir) || fs.readdirSync(keysDir).length === 0) {
    throw new Error(`${src.source}: compiled but produced no verifier keys in ${keysDir}`);
  }

  return { managedName: src.managedName, managedDir, exportedCircuits, durationMs };
}

/** Compile a whole call tree. Order is significant: callees BEFORE callers. */
export function compileAll(sources: readonly ContractSource[]): CompileResult[] {
  return sources.map((s) => compileContract(s));
}

/** Exported circuit names, read from the emitted verifier-key files. */
export function readExportedCircuits(managedDir: string): string[] {
  const keysDir = path.join(managedDir, "keys");
  if (!fs.existsSync(keysDir)) return [];
  return fs
    .readdirSync(keysDir)
    .filter((f) => f.endsWith(".verifier"))
    .map((f) => f.replace(/\.verifier$/, ""))
    .sort();
}

export function managedDirFor(managedName: string): string {
  return path.join(MANAGED_ROOT, managedName);
}

/** True if the artifact exists and is loadable. */
export function isCompiled(managedName: string): boolean {
  return fs.existsSync(path.join(managedDirFor(managedName), "contract", "index.cjs"))
    || fs.existsSync(path.join(managedDirFor(managedName), "contract", "index.js"));
}
