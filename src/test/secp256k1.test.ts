// PLAN-01 gate G1.2 — re-run the secp256k1 PROVE cases against OUR stack and
// record the wall-clock.
//
// These three circuits are the exact primitives the whole project rests on
// (PLAN-00 §2): raw ECDSA verify, in-circuit Ethereum-address derivation, and
// the recover + keccak256(x‖y)[12:] shape. They are proven upstream; what is NOT
// yet known is how they behave on the stack we just built, and how long a proof
// takes here — which is the input to PLAN-05's "return the tx hash immediately,
// prove asynchronously" design.
//
// Every measured call is appended to infra/TIMINGS.json.

import { beforeAll, describe, expect, it } from "vitest";

import { bindCompiledContract, loadCompiledModule } from "../compiled.ts";
import { compileContract } from "../compile.ts";
import { contractByName } from "../contracts.ts";
import { callCircuit, deployFresh, readLedger } from "../contract-ops.ts";
import { recordDeployment } from "../deployments.ts";
import { ROLE_SEEDS } from "../genesis-seeds.ts";
import { bytesToHex } from "../hex.ts";
import { createProviders, type Providers } from "../providers.ts";
import {
  largeXCoordinateVector,
  loadAddressVectors,
  recoveryVector,
} from "../secp256k1-vectors.ts";
import { allTimings, timed } from "../timings.ts";
import { createWallet, syncWallet, type WalletCtx } from "../wallet.ts";

let alice: WalletCtx;

beforeAll(async () => {
  alice = await createWallet("alice", ROLE_SEEDS.alice);
  await syncWallet(alice);
});

/** Compile + deploy one of the prove-case contracts, ready to call. */
async function deployCase(name: string) {
  const compiled = compileContract(contractByName(name));
  const providers: Providers = await createProviders(alice, compiled.managedDir, name);
  const loaded = await loadCompiledModule(compiled.managedDir);
  const handle = bindCompiledContract(name, loaded, { vacantWitnesses: true });
  const deployed = await deployFresh(providers, handle, name, []);
  recordDeployment({
    name,
    contractAddress: deployed.contractAddress,
    txHash: deployed.txHash,
    txId: deployed.txId,
    note: "PLAN-01 G1.2 secp256k1 prove-case",
  });
  return { providers, loaded, deployed };
}

/** `0x` + 40 hex, from the Bytes<20> a circuit returns or stores. */
function addressHex(value: Uint8Array): string {
  return `0x${bytesToHex(value)}`;
}

describe("G1.2 — secp256k1 prove-cases on our stack", () => {
  it("proves raw ECDSA verify (Wycheproof large-x-coordinate vector)", async () => {
    const vector = largeXCoordinateVector();
    const { providers, loaded, deployed } = await deployCase("prove-verify-secp256k1");

    const { result: call } = await timed(
      {
        contract: "prove-verify-secp256k1",
        circuit: "verifyAndStore",
        note: `G1.2 Wycheproof tcId ${vector.tcId} (${vector.comment})`,
      },
      () => callCircuit(deployed.deployed, "verifyAndStore", [vector.e, vector.sig, vector.pk]),
    );

    // The circuit's own verdict...
    expect(call.result).toBe(true);
    // ...and the same verdict read back off-chain from public state.
    const ledger = await readLedger<{ lastVerified: boolean }>(
      providers,
      deployed.contractAddress,
      loaded.module,
    );
    expect(ledger.lastVerified).toBe(true);
  });

  it("proves in-circuit Ethereum-address derivation against ethereum/tests KATs", async () => {
    const vectors = loadAddressVectors();
    expect(vectors.length).toBeGreaterThan(0);

    const { providers, loaded, deployed } = await deployCase(
      "prove-ethereum-address-secp256k1",
    );

    for (const vector of vectors) {
      const { result: call } = await timed(
        {
          contract: "prove-ethereum-address-secp256k1",
          circuit: "storeEthereumAddress",
          note: `G1.2 eth-address KAT seed=${vector.seed}`,
        },
        () => callCircuit(deployed.deployed, "storeEthereumAddress", [vector.point]),
      );

      expect(addressHex(call.result as Uint8Array), `seed=${vector.seed}`).toBe(vector.ethAddr);

      const ledger = await readLedger<{ lastAddr: Uint8Array }>(
        providers,
        deployed.contractAddress,
        loaded.module,
      );
      expect(addressHex(ledger.lastAddr), `indexed lastAddr seed=${vector.seed}`).toBe(
        vector.ethAddr,
      );
    }
  });

  it("proves recover + keccak256(x‖y)[12:] — the usdcx-shaped circuit", async () => {
    const vector = recoveryVector();
    const { providers, loaded, deployed } = await deployCase(
      "prove-recover-address-secp256k1",
    );

    const { result: call } = await timed(
      {
        contract: "prove-recover-address-secp256k1",
        circuit: "recoverAddr",
        note: "G1.2 recover + eth-address derivation",
      },
      () => callCircuit(deployed.deployed, "recoverAddr", [vector.msgHash, vector.sig]),
    );

    expect(addressHex(call.result as Uint8Array)).toBe(vector.ethAddr);

    const ledger = await readLedger<{ lastAddr: Uint8Array }>(
      providers,
      deployed.contractAddress,
      loaded.module,
    );
    expect(addressHex(ledger.lastAddr)).toBe(vector.ethAddr);
  });

  it("recorded a proving budget for PLAN-05", () => {
    const measured = allTimings().filter((t) => t.note?.startsWith("G1.2"));
    expect(measured.length).toBeGreaterThanOrEqual(4);

    const slowest = Math.max(...measured.map((t) => t.millis));
    const fastest = Math.min(...measured.map((t) => t.millis));
    console.log(
      `      proving budget: ${(fastest / 1000).toFixed(1)}s .. ${(slowest / 1000).toFixed(1)}s ` +
        `across ${measured.length} proven calls`,
    );
    // The whole reason PLAN-05 is async: a proof is seconds, not milliseconds.
    // If this ever drops below a second the relayer design can be revisited.
    expect(slowest).toBeGreaterThan(1000);
  });
});
