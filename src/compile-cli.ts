// pnpm compile [managedName ...] — compile the manifest, callees first.

import { compileAll, compactImage } from "./compile.ts";
import { CONTRACTS, contractByName } from "./contracts.ts";

const requested = process.argv.slice(2);
const sources = requested.length > 0 ? requested.map(contractByName) : CONTRACTS;

console.log(`compactc image: ${compactImage()}`);
for (const result of compileAll(sources)) {
  console.log(
    `  ✓ ${result.managedName} (${(result.durationMs / 1000).toFixed(1)}s) ` +
      `exports [${result.exportedCircuits.join(", ")}] -> ${result.managedDir}`,
  );
}
