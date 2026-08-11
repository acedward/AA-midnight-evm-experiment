// PLAN-02 spike S1 — THE architecture gate.
//
// One question: can a circuit compiled with `--feature-zkir-v3` also make a
// cross-contract call? PLAN-00 §4's account-as-validator design is a token root
// that does keccak + secp256k1 ECDSA in-circuit and then cross-calls an Account
// contract. No fixture anywhere combines those: every CCC fixture in
// compact-end-2-end is zkir-v2 (its case harness cannot pass a compile flag to
// nested sources), and every zkir-v3 fixture makes no CCC.
//
// Three steps, escalating, each with its own contract pair so a failure names
// its own cause:
//   1. minimal Bytes<32>-only hop            — is the combination buildable at all?
//   2. keccak + ECDSA verify + eth-address in the ROOT, alongside the hop
//                                            — usdcx's proven crypto shape plus a CCC
//   3. callee returns kernel.self(), writes its own digest set; root asserts on
//      the returned address                  — the account-as-validator shape itself
//
// GO/NO-GO: if step 1 fails, it fails in zkir-v3 lowering or at the proof
// server, and the account architecture waits for upstream (PLAN-03 §2's in-token
// contingency seam is unaffected). Every proven call is timed into
// infra/TIMINGS.json — those wall-clocks are the fee/UX budget input.

import { beforeAll, describe, expect, it } from "vitest";

import { bindCompiledContract, loadCompiledModule } from "../compiled.ts";
import { compileContract } from "../compile.ts";
import { contractByName } from "../contracts.ts";
import {
  callCircuit,
  contractAddressBytes,
  deployFresh,
  readLedger,
  type CallResult,
  type DeployResult,
} from "../contract-ops.ts";
import { flipS, signKeccakPayload } from "../secp256k1-vectors.ts";
import { recordDeployment } from "../deployments.ts";
import { ROLE_SEEDS } from "../genesis-seeds.ts";
import { bytesToHex, hexToBytes } from "../hex.ts";
import { createProviders, type Providers } from "../providers.ts";
import { timed } from "../timings.ts";
import { createWallet, syncWallet, type WalletCtx } from "../wallet.ts";
import type { LoadedCompiledModule } from "../compiled.ts";

let alice: WalletCtx;

beforeAll(async () => {
  alice = await createWallet("alice", ROLE_SEEDS.alice);
  await syncWallet(alice);
}, 600_000);

interface Fixture {
  providers: Providers;
  loaded: LoadedCompiledModule;
  deploy: DeployResult;
}

/**
 * Compile + deploy one spike contract.
 *
 * The providers are built over THIS contract's managed dir, which is what
 * midnight-js reads verifier keys from for deploy/make. The proof provider
 * inside them is a registry over the artifact ROOT (providers.ts does the
 * dirname), and that is the part CCC depends on: proving a call tree needs the
 * keys of every contract in it, resolved by verifier-key hash.
 */
async function deploySpike(
  managedName: string,
  args: readonly unknown[],
  note: string,
): Promise<Fixture> {
  const { managedDir } = compileContract(contractByName(managedName));
  const providers = await createProviders(alice, managedDir, managedName);
  const loaded = await loadCompiledModule(managedDir);
  const handle = bindCompiledContract(managedName, loaded, { vacantWitnesses: true });
  const deploy = await deployFresh(providers, handle, managedName, args);
  recordDeployment({
    name: managedName,
    contractAddress: deploy.contractAddress,
    txHash: deploy.txHash,
    txId: deploy.txId,
    note,
  });
  console.log(`      deployed ${managedName} at ${deploy.contractAddress}`);
  return { providers, loaded, deploy };
}

/** A contract reference constructor/circuit argument: `{ bytes: Uint8Array(32) }`. */
function contractRefArg(address: string): { bytes: Uint8Array } {
  return { bytes: contractAddressBytes(address) };
}

/** The addresses a finalized call touched, callees first, root last. */
function callTreeAddresses(call: CallResult): string[] {
  return (call.calls ?? []).map((c) => c.contractAddress);
}

const TAG_A = new Uint8Array(32).fill(0xa1);
const TAG_B = new Uint8Array(32).fill(0xb2);

// A spike key, not a fixture identity: PLAN-03 freezes the real payload and
// PLAN-05 owns the MetaMask capture. Any 32-byte scalar does here.
const SPIKE_PRIV = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";

describe("S1 step 1 — a zkir-v3 circuit that makes a cross-contract call", () => {
  let callee: Fixture;
  let root: Fixture;

  it("compiles both sides of the call tree with --feature-zkir-v3", () => {
    // The compile itself is a result: the flag comes from versions.json and is
    // applied to every contract in this repo, so a zkir-v3 lowering failure on a
    // CCC caller would surface right here, before any chain work.
    const calleeBuild = compileContract(contractByName("S1MinCallee"));
    const rootBuild = compileContract(contractByName("S1MinRoot"));
    expect(calleeBuild.exportedCircuits).toEqual(["note"]);
    expect(rootBuild.exportedCircuits).toEqual(["hop"]);
  });

  it("deploys the callee, then the root bound to it", async () => {
    callee = await deploySpike("S1MinCallee", [], "PLAN-02 S1 step 1 CCC callee");
    root = await deploySpike(
      "S1MinRoot",
      [contractRefArg(callee.deploy.contractAddress)],
      "PLAN-02 S1 step 1 CCC root",
    );

    // The constructor stored the reference `hop` dispatches through, so the hop
    // below is provably aimed at the callee deployed above and not at some other
    // instance left over from an earlier run on this persistent chain.
    const ledger = await readLedger<{ callee: { bytes: Uint8Array } }>(
      root.providers,
      root.deploy.contractAddress,
      root.loaded.module,
    );
    expect(bytesToHex(ledger.callee.bytes)).toBe(
      bytesToHex(contractAddressBytes(callee.deploy.contractAddress)),
    );
  });

  it("PROVES one CCC transaction end to end", async () => {
    const { result: call } = await timed(
      { contract: "S1MinRoot", circuit: "hop", note: "S1 step 1 — minimal zkir-v3 CCC hop" },
      () => callCircuit(root.deploy.deployed, "hop", [TAG_A]),
    );

    // The root's in-circuit assert already checked the echo; this checks the
    // value made it back out to the caller as the circuit's return.
    expect(bytesToHex(call.result as Uint8Array)).toBe(bytesToHex(TAG_A));

    // A CCC transaction carries the whole call tree: callees first, root last.
    // Two entries is the direct evidence that a cross-contract call happened
    // rather than the root quietly doing the work itself.
    const tree = callTreeAddresses(call);
    expect(tree).toHaveLength(2);
    expect(tree[0]).toBe(callee.deploy.contractAddress);
    expect(tree[1]).toBe(root.deploy.contractAddress);
  });

  it("committed BOTH sides of the tree to public state", async () => {
    // The in-transaction hop is not enough on its own: the callee's write has to
    // be what commits, atomically with the root's.
    const rootLedger = await readLedger<{ lastEcho: Uint8Array; hopCount: bigint }>(
      root.providers,
      root.deploy.contractAddress,
      root.loaded.module,
    );
    expect(bytesToHex(rootLedger.lastEcho)).toBe(bytesToHex(TAG_A));
    expect(rootLedger.hopCount).toBe(1n);

    const calleeLedger = await readLedger<{ lastTag: Uint8Array; hopCount: bigint }>(
      callee.providers,
      callee.deploy.contractAddress,
      callee.loaded.module,
    );
    expect(bytesToHex(calleeLedger.lastTag)).toBe(bytesToHex(TAG_A));
    expect(calleeLedger.hopCount).toBe(1n);
  });

  it("accumulates across transactions (a second hop advances both counters)", async () => {
    await timed(
      { contract: "S1MinRoot", circuit: "hop", note: "S1 step 1 — second hop (state accumulation)" },
      () => callCircuit(root.deploy.deployed, "hop", [TAG_B]),
    );

    const calleeLedger = await readLedger<{ lastTag: Uint8Array; hopCount: bigint }>(
      callee.providers,
      callee.deploy.contractAddress,
      callee.loaded.module,
    );
    expect(bytesToHex(calleeLedger.lastTag)).toBe(bytesToHex(TAG_B));
    expect(calleeLedger.hopCount).toBe(2n);
  });
});

describe("S1 step 2 — zkir-v3 crypto AND a cross-contract call in ONE circuit", () => {
  // The combination PLAN-00 §2 lists as the one UNPROVEN requirement. The root
  // runs usdcx's proven crypto shape (keccak256 digest -> secp256k1EcdsaVerify ->
  // secp256k1EthereumAddress) and then hops to the step-1 callee, all inside one
  // proof. The callee is unchanged from step 1, so the crypto is the only new
  // variable.
  let callee: Fixture;
  let root: Fixture;

  const signed = signKeccakPayload(SPIKE_PRIV, new Uint8Array(32).fill(0x5e));

  it("compiles a circuit holding both the secp/keccak load and a CCC hop", () => {
    const build = compileContract(contractByName("S1CryptoRoot"));
    expect(build.exportedCircuits).toEqual(["authorizedHop"]);
  });

  it("deploys the crypto root against the step-1 callee", async () => {
    callee = await deploySpike("S1MinCallee", [], "PLAN-02 S1 step 2 CCC callee");
    root = await deploySpike(
      "S1CryptoRoot",
      [contractRefArg(callee.deploy.contractAddress)],
      "PLAN-02 S1 step 2 crypto root",
    );
  });

  it("PROVES keccak + ECDSA verify + address derivation + the hop in one tx", async () => {
    const { result: call } = await timed(
      {
        contract: "S1CryptoRoot",
        circuit: "authorizedHop",
        note: "S1 step 2 — keccak + secp256k1 verify + eth-address + CCC hop",
      },
      () => callCircuit(root.deploy.deployed, "authorizedHop", [signed.payload, signed.sig, signed.pk]),
    );

    // The address the circuit derived in-circuit from the untrusted public key
    // argument is the real Ethereum address of the signing key — the binding
    // PLAN-00 §3.4 rests owner identity on.
    expect(`0x${bytesToHex(call.result as Uint8Array)}`).toBe(signed.ethAddr);

    const tree = callTreeAddresses(call);
    expect(tree).toEqual([callee.deploy.contractAddress, root.deploy.contractAddress]);

    // The digest that crossed the boundary is keccak256 of the payload, computed
    // in-circuit and agreeing with noble's.
    const calleeLedger = await readLedger<{ lastTag: Uint8Array }>(
      callee.providers,
      callee.deploy.contractAddress,
      callee.loaded.module,
    );
    expect(bytesToHex(calleeLedger.lastTag)).toBe(bytesToHex(signed.digest));

    const rootLedger = await readLedger<{ lastDigest: Uint8Array; lastSigner: Uint8Array }>(
      root.providers,
      root.deploy.contractAddress,
      root.loaded.module,
    );
    expect(bytesToHex(rootLedger.lastDigest)).toBe(bytesToHex(signed.digest));
    expect(`0x${bytesToHex(rootLedger.lastSigner)}`).toBe(signed.ethAddr);
  });

  it("rejects a garbage signature and leaves the CALLEE untouched", async () => {
    // Rejection-matrix R3 at the CCC boundary. The point is not just that the
    // call fails: the authorization assert runs BEFORE the hop, so a rejected
    // call must not leave a committed write on the callee either. Without this,
    // an attacker could drive callee state through a root that fails afterwards.
    const before = await readLedger<{ hopCount: bigint }>(
      callee.providers,
      callee.deploy.contractAddress,
      callee.loaded.module,
    );

    const garbage = { r: signed.sig.r, s: signed.sig.s ^ 1n };
    await expect(
      callCircuit(root.deploy.deployed, "authorizedHop", [signed.payload, garbage, signed.pk]),
    ).rejects.toThrow(/signature does not verify/);

    const after = await readLedger<{ hopCount: bigint }>(
      callee.providers,
      callee.deploy.contractAddress,
      callee.loaded.module,
    );
    expect(after.hopCount).toBe(before.hopCount);
  });

  it("accepts the flipped-s twin — malleability is real, so replay must key on the digest", async () => {
    // Rejection-matrix R2. `secp256k1EcdsaVerify` enforces no low-s rule, so
    // (r, n-s) verifies exactly as (r, s) does. What matters for PLAN-00 §3.3 is
    // that the DIGEST is identical across the two: replay protection keyed on
    // the digest is unaffected by malleability, and one keyed on signature bytes
    // would be trivially defeated here.
    const { result: call } = await timed(
      {
        contract: "S1CryptoRoot",
        circuit: "authorizedHop",
        note: "S1 step 2 — flipped-s twin (R2 malleability)",
      },
      () =>
        callCircuit(root.deploy.deployed, "authorizedHop", [
          signed.payload,
          flipS(signed.sig),
          signed.pk,
        ]),
    );

    expect(`0x${bytesToHex(call.result as Uint8Array)}`).toBe(signed.ethAddr);

    const rootLedger = await readLedger<{ lastDigest: Uint8Array }>(
      root.providers,
      root.deploy.contractAddress,
      root.loaded.module,
    );
    // THE assertion: same digest, different signature bytes.
    expect(bytesToHex(rootLedger.lastDigest)).toBe(bytesToHex(signed.digest));
  });
});

describe("S1 step 3 — the account-as-validator shape end to end", () => {
  // PLAN-00 §4 in miniature: the account returns kernel.self() across the CCC
  // return boundary, burns the digest in its own ledger, and the token keys the
  // balance on the address that came back. Everything PLAN-03 and PLAN-04 build
  // depends on this working; nothing anywhere covers it.
  let account: Fixture;
  let root: Fixture;

  const owner = signKeccakPayload(SPIKE_PRIV, new Uint8Array(32).fill(0x01));
  const stranger = signKeccakPayload(
    "0000000000000000000000000000000000000000000000000000000000000abc",
    new Uint8Array(32).fill(0x02),
  );
  const CREDIT = 1_000n;

  /** The 20-byte owner argument, from an `0x`-prefixed address. */
  function ownerArg(ethAddr: string): Uint8Array {
    return hexToBytes(ethAddr);
  }

  /**
   * The right (ContractAddress) arm of an `Either` map key, hex-encoded.
   * The runtime shape is `{is_left, left, right}`; only the discriminant and the
   * arm actually taken carry meaning.
   */
  function rightArmHex(key: unknown): string | undefined {
    const either = key as { is_left?: boolean; right?: { bytes?: Uint8Array } };
    if (either.is_left !== false) return undefined;
    const bytes = either.right?.bytes;
    return bytes === undefined ? undefined : bytesToHex(bytes);
  }

  it("compiles the account callee and the crediting root", () => {
    expect(compileContract(contractByName("S1SelfCallee")).exportedCircuits).toEqual(["validate"]);
    expect(compileContract(contractByName("S1SelfRoot")).exportedCircuits).toEqual([
      "accountCredit",
    ]);
  });

  it("deploys an account owned by the spike key, and a root bound to it", async () => {
    account = await deploySpike(
      "S1SelfCallee",
      [ownerArg(owner.ethAddr)],
      "PLAN-02 S1 step 3 account (validator callee)",
    );
    root = await deploySpike(
      "S1SelfRoot",
      [contractRefArg(account.deploy.contractAddress)],
      "PLAN-02 S1 step 3 token root",
    );

    const ledger = await readLedger<{ owner: Uint8Array }>(
      account.providers,
      account.deploy.contractAddress,
      account.loaded.module,
    );
    expect(`0x${bytesToHex(ledger.owner)}`).toBe(owner.ethAddr);
  });

  it("PROVES the full shape: verify -> validate -> credit the RETURNED address", async () => {
    const { result: call } = await timed(
      {
        contract: "S1SelfRoot",
        circuit: "accountCredit",
        note: "S1 step 3 — verify + CCC validate + credit kernel.self()",
      },
      () =>
        callCircuit(root.deploy.deployed, "accountCredit", [
          owner.payload,
          owner.sig,
          owner.pk,
          CREDIT,
        ]),
    );

    // A ContractAddress survived the CCC return boundary, and it is the
    // account's own address — produced by kernel.self() inside the account's
    // proof, which is the only reason the root can trust it as a balance key.
    const returned = call.result as { bytes: Uint8Array };
    expect(bytesToHex(returned.bytes)).toBe(
      bytesToHex(contractAddressBytes(account.deploy.contractAddress)),
    );

    const rootLedger = await readLedger<{
      lastValidated: { bytes: Uint8Array };
      balances: Iterable<readonly [unknown, bigint]>;
    }>(root.providers, root.deploy.contractAddress, root.loaded.module);

    expect(bytesToHex(rootLedger.lastValidated.bytes)).toBe(
      bytesToHex(contractAddressBytes(account.deploy.contractAddress)),
    );

    // The balance is keyed on the returned address, on the right arm of the OZ
    // Either key — the exact shape PLAN-04's token inherits.
    const entries = [...rootLedger.balances];
    expect(entries).toHaveLength(1);
    const [key, value] = entries[0]!;
    expect(rightArmHex(key)).toBe(
      bytesToHex(contractAddressBytes(account.deploy.contractAddress)),
    );
    expect(value).toBe(CREDIT);

    // The account committed its own write inside the root's transaction.
    const accountLedger = await readLedger<{
      consumedDigests: { member: (d: Uint8Array) => boolean };
      validateCount: bigint;
    }>(account.providers, account.deploy.contractAddress, account.loaded.module);
    expect(accountLedger.consumedDigests.member(owner.digest)).toBe(true);
    expect(accountLedger.validateCount).toBe(1n);
  });

  it("R6 — rejects the replayed digest, and moves no balance", async () => {
    await expect(
      callCircuit(root.deploy.deployed, "accountCredit", [
        owner.payload,
        owner.sig,
        owner.pk,
        CREDIT,
      ]),
    ).rejects.toThrow(/digest already consumed/);

    const rootLedger = await readLedger<{ balances: Iterable<readonly [unknown, bigint]> }>(
      root.providers,
      root.deploy.contractAddress,
      root.loaded.module,
    );
    expect([...rootLedger.balances].map(([, v]) => v)).toEqual([CREDIT]);
  });

  it("R2 — the flipped-s twin of a consumed signature is rejected too", async () => {
    // The malleability payoff. (r, n-s) verifies, so a signature-bytes replay set
    // would let this through; the digest set does not, because the digest is
    // identical. This is the assertion PLAN-00 §3.3 exists for.
    await expect(
      callCircuit(root.deploy.deployed, "accountCredit", [
        owner.payload,
        flipS(owner.sig),
        owner.pk,
        CREDIT,
      ]),
    ).rejects.toThrow(/digest already consumed/);
  });

  it("R4 — rejects a valid signature from a key that is not the owner", async () => {
    // Not a forged signature: a perfectly valid one, from the wrong key. The
    // account binds signer->owner, so authorization fails at the CCC callee
    // rather than at the verifier.
    await expect(
      callCircuit(root.deploy.deployed, "accountCredit", [
        stranger.payload,
        stranger.sig,
        stranger.pk,
        CREDIT,
      ]),
    ).rejects.toThrow(/signer is not the account owner/);
  });

  it("R14 — a direct validate burns the digest; the relay fails cleanly and re-signing recovers", async () => {
    // Design rule 3's accepted risk, demonstrated rather than asserted. There is
    // no kernel.caller() and no CCC-only circuit on this lane, so `validate` is a
    // public entry point: anyone who observes (payload, sig, pk) can compute the
    // digest and burn it before the relayer lands the transaction.
    const pending = signKeccakPayload(SPIKE_PRIV, new Uint8Array(32).fill(0x03));

    const { result: grief } = await timed(
      {
        contract: "S1SelfCallee",
        circuit: "validate",
        note: "S1 step 3 — R14 griefing: direct validate burns the digest",
      },
      () =>
        callCircuit(account.deploy.deployed, "validate", [
          hexToBytes(owner.ethAddr),
          pending.digest,
        ]),
    );
    // Even called directly, validate returns its own address.
    expect(bytesToHex((grief.result as { bytes: Uint8Array }).bytes)).toBe(
      bytesToHex(contractAddressBytes(account.deploy.contractAddress)),
    );

    // The relay of the griefed operation now fails — cleanly, with the reason
    // named, and with no balance movement.
    await expect(
      callCircuit(root.deploy.deployed, "accountCredit", [
        pending.payload,
        pending.sig,
        pending.pk,
        CREDIT,
      ]),
    ).rejects.toThrow(/digest already consumed/);

    // Re-signing a different payload recovers: the griefing denies one
    // operation, it does not disable the account.
    const resigned = signKeccakPayload(SPIKE_PRIV, new Uint8Array(32).fill(0x04));
    await timed(
      {
        contract: "S1SelfRoot",
        circuit: "accountCredit",
        note: "S1 step 3 — R14 recovery: re-signed operation lands",
      },
      () =>
        callCircuit(root.deploy.deployed, "accountCredit", [
          resigned.payload,
          resigned.sig,
          resigned.pk,
          CREDIT,
        ]),
    );

    const rootLedger = await readLedger<{ balances: Iterable<readonly [unknown, bigint]> }>(
      root.providers,
      root.deploy.contractAddress,
      root.loaded.module,
    );
    expect([...rootLedger.balances].map(([, v]) => v)).toEqual([CREDIT * 2n]);
  });
});
