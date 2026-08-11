// Vendored from compact-end-2-end @ aa344546 (utils/compiled.ts), 2026-08-11.
// Copyright (C) Midnight Foundation — SPDX-License-Identifier: Apache-2.0
// Upstream: /Users/edwardalvarado/compact-end-2-end
// Local changes: none (verbatim).
//
// Single owner of the compactc-generated-module seam: loading the emitted
// bindings, validating their structural shape once at this boundary, and
// binding them into a midnight-js CompiledContract. The SDK's generic
// Contract<C> types can't be satisfied by a dynamically-imported module, so
// every unknown/generic cast lives in bindCompiledContract and nowhere else.

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { CompiledContract } from "@midnight-ntwrk/compact-js";

export type Witnesses = Record<string, (...args: any[]) => unknown>;

/** The compactc-emitted bindings we use: a Contract class + a ledger() projector. */
export interface CompiledModule {
  Contract: new (...args: never[]) => unknown;
  ledger: (data: unknown) => unknown;
}

/** A validated compiled artifact: its zkConfig dir + structurally-checked module. */
export interface LoadedCompiledModule {
  zkConfigPath: string;
  module: CompiledModule;
}

/** Explicit witness binding: vacant or a concrete witness container. No default. */
export type WitnessMode = { vacantWitnesses: true } | { witnesses: Witnesses };

/** Opaque handle from bindCompiledContract — a midnight-js CompiledContract under the hood. */
export type CompiledContractHandle = { readonly __compiled: unique symbol };

/** Load + validate a compactc-compiled contract's TS bindings. Throws if not built yet. */
export async function loadCompiledModule(managedDir: string): Promise<LoadedCompiledModule> {
  const indexPath = path.join(managedDir, "contract", "index.js");
  if (!fs.existsSync(indexPath)) {
    throw new Error(`compiled contract not found: ${indexPath}`);
  }
  // Dynamic by necessity, not style: the path is a runtime value, the artifact
  // is compactc-generated after `vp check` runs, and for the gap dapps it never
  // exists — a static import would fail typecheck and crash them at module load.
  const module: unknown = await import(pathToFileURL(indexPath).href);
  return { zkConfigPath: managedDir, module: assertCompiledModule(indexPath, module) };
}

/** Bind a loaded artifact + witness mode into a midnight-js CompiledContract. */
export function bindCompiledContract(
  tag: string,
  loaded: LoadedCompiledModule,
  witnessMode: WitnessMode,
): CompiledContractHandle {
  const withW =
    "witnesses" in witnessMode
      ? (CompiledContract.withWitnesses as unknown as (w: unknown) => unknown)(
          assertWitnesses(tag, witnessMode.witnesses),
        )
      : CompiledContract.withVacantWitnesses;
  // SDK seam: make()/withWitnesses/withCompiledFileAssets are generic over
  // Contract<C>, which a dynamically-imported module can't supply statically.
  const make = CompiledContract.make as unknown as (
    tag: string,
    ctor: unknown,
  ) => { pipe: (...fs: unknown[]) => unknown };
  const withAssets = CompiledContract.withCompiledFileAssets as unknown as (p: string) => unknown;
  return make(tag, loaded.module.Contract).pipe(
    withW,
    withAssets(loaded.zkConfigPath),
  ) as CompiledContractHandle;
}

function assertCompiledModule(indexPath: string, module: unknown): CompiledModule {
  if (typeof module !== "object" || module === null) {
    throw new Error(`compiled module is not an object: ${indexPath}`);
  }
  const mod = module as { Contract?: unknown; ledger?: unknown };
  if (typeof mod.Contract !== "function") {
    throw new Error(`compiled module missing callable Contract export: ${indexPath}`);
  }
  if (typeof mod.ledger !== "function") {
    throw new Error(`compiled module missing callable ledger() export: ${indexPath}`);
  }
  return module as CompiledModule;
}

function assertWitnesses(tag: string, witnesses: unknown): Witnesses {
  if (typeof witnesses !== "object" || witnesses === null) {
    throw new Error(`witnesses must be an object (tag=${tag})`);
  }
  for (const [name, fn] of Object.entries(witnesses)) {
    if (typeof fn !== "function") {
      throw new Error(`witness "${name}" is not a function (tag=${tag})`);
    }
  }
  return witnesses as Witnesses;
}
