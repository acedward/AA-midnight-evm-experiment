// PLAN-03 gates G3.3–G3.6 — the account contract, live on the persistent
// Part-0 stack (midnight-aa-36080).
//
// The real thing, end to end: two Account instances (same owner key, the
// identical build — expectedVk rule) and two MiniTokenAA roots, driven with
// MetaMask-shaped (payload, sig, pk) tuples over the frozen
// MIDNIGHT_ACCOUNT_V1 payload.
//
//   G3.3  one proven accountTransfer (deploy → mint → transfer → read back)
//   G3.4  griefing containment: a direct `validate` burns the digest, the
//         relay fails cleanly, a re-signed op recovers (R14)
//   G3.5  cross-account replay rejected — two accounts, one owner key, one
//         signature (R9), and the rejection reverts ATOMICALLY (no digest
//         burned at the wrong account)
//   G3.6  ONE account controls TWO deployed tokens in one digest/nonce space —
//         the generality claim (plus R8 cross-token replay rejected live)
//
// One client-side nonce sequence (0, 1, 2, …) runs through the whole suite —
// with the digest-set-only decision the nonce's job is digest uniqueness and
// ordering LEGIBILITY, and this suite is what that looks like in practice.

import { beforeAll, describe, expect, it } from "vitest";

import {
  OP_TRANSFER,
  ethAddressOfPriv,
  padEthAddress,
  signAccountPayload,
  type SignedAccountPayload,
} from "../account-payload.ts";
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
import { recordDeployment } from "../deployments.ts";
import { ROLE_SEEDS } from "../genesis-seeds.ts";
import { bytesToHex, hexToBytes } from "../hex.ts";
import { createProviders, type Providers } from "../providers.ts";
import { flipS } from "../secp256k1-vectors.ts";
import { timed } from "../timings.ts";
import { createWallet, syncWallet, type WalletCtx } from "../wallet.ts";
import type { LoadedCompiledModule } from "../compiled.ts";

// The demo owner key (same convention as the spikes; PLAN-05 owns real
// MetaMask capture).
const OWNER_PRIV = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const RECIPIENT = padEthAddress(`0x${"cc".repeat(20)}`);

let alice: WalletCtx;

beforeAll(async () => {
  alice = await createWallet("alice", ROLE_SEEDS.alice);
  await syncWallet(alice);
}, 600_000);

interface Fixture {
  providers: Providers;
  loaded: LoadedCompiledModule;
  deploy: DeployResult;
  /** The 32-byte on-chain address. */
  addressBytes: Uint8Array;
}

async function deployContract(
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
  return { providers, loaded, deploy, addressBytes: contractAddressBytes(deploy.contractAddress) };
}

function contractRefArg(fixture: Fixture): { bytes: Uint8Array } {
  return { bytes: fixture.addressBytes };
}

interface AccountLedger {
  owner: Uint8Array;
  consumedDigests: { member: (d: Uint8Array) => boolean };
  validateCount: bigint;
}

interface TokenLedger {
  balances: Iterable<readonly [unknown, bigint]>;
  txCount: bigint;
}

/** Right-arm (ContractAddress) balance of `addressBytes`, 0n if absent. */
function accountBalance(ledger: TokenLedger, addressBytes: Uint8Array): bigint {
  for (const [key, value] of ledger.balances) {
    const either = key as { is_left: boolean; right?: { bytes: Uint8Array } };
    if (!either.is_left && bytesToHex(either.right!.bytes) === bytesToHex(addressBytes)) {
      return value;
    }
  }
  return 0n;
}

/** Left-arm (identity) balance of the 32-byte identity, 0n if absent. */
function identityBalance(ledger: TokenLedger, identity: Uint8Array): bigint {
  for (const [key, value] of ledger.balances) {
    const either = key as { is_left: boolean; left?: { bytes: Uint8Array } };
    if (either.is_left && bytesToHex(either.left!.bytes) === bytesToHex(identity)) {
      return value;
    }
  }
  return 0n;
}

describe("PLAN-03 live — the Account contract on the persistent stack", () => {
  let account1: Fixture;
  let account2: Fixture;
  let tokenA: Fixture;
  let tokenB: Fixture;

  // ONE nonce sequence across the whole suite (and both tokens) — the
  // one-digest-space property G3.6 demonstrates.
  let nextNonce = 0n;

  /** Sign a TRANSFER intent for (token, account) with the owner key. */
  function signTransfer(
    token: Fixture,
    account: Fixture,
    amount: bigint,
    overrides: { nonce?: bigint } = {},
  ): SignedAccountPayload {
    const nonce = overrides.nonce ?? nextNonce++;
    return signAccountPayload(OWNER_PRIV, {
      op: OP_TRANSFER,
      token: token.addressBytes,
      account: account.addressBytes,
      to: RECIPIENT,
      nonce,
      amount,
    });
  }

  async function relay(token: Fixture, account: Fixture, signed: SignedAccountPayload) {
    return callCircuit(token.deploy.deployed, "accountTransfer", [
      contractRefArg(account),
      signed.payload,
      signed.sig,
      signed.pk,
    ]);
  }

  const accountLedger = (f: Fixture) =>
    readLedger<AccountLedger>(f.providers, f.deploy.contractAddress, f.loaded.module);
  const tokenLedger = (f: Fixture) =>
    readLedger<TokenLedger>(f.providers, f.deploy.contractAddress, f.loaded.module);

  it("deploys two identical-build accounts (one owner) and two tokens", async () => {
    const ownerAddr = hexToBytes(ethAddressOfPriv(OWNER_PRIV));

    account1 = await deployContract("Account", [ownerAddr], "PLAN-03 Account #1 (G3.3–G3.6)");
    account2 = await deployContract("Account", [ownerAddr], "PLAN-03 Account #2 (G3.5 cross-account)");
    tokenA = await deployContract("MiniTokenAA", [], "PLAN-03 token A (harness root)");
    tokenB = await deployContract("MiniTokenAA", [], "PLAN-03 token B (G3.6 second token)");

    for (const account of [account1, account2]) {
      const ledger = await accountLedger(account);
      expect(bytesToHex(ledger.owner)).toBe(bytesToHex(ownerAddr));
      expect(ledger.validateCount).toBe(0n);
    }
  }, 900_000);

  it("mints working balances onto account #1 at both tokens", async () => {
    await timed(
      { contract: "MiniTokenAA", circuit: "mint", note: "G3.3 — mint on token A" },
      () => callCircuit(tokenA.deploy.deployed, "mint", [account1.addressBytes, 10_000n]),
    );
    await timed(
      { contract: "MiniTokenAA", circuit: "mint", note: "G3.6 — mint on token B" },
      () => callCircuit(tokenB.deploy.deployed, "mint", [account1.addressBytes, 10_000n]),
    );
    expect(accountBalance(await tokenLedger(tokenA), account1.addressBytes)).toBe(10_000n);
    expect(accountBalance(await tokenLedger(tokenB), account1.addressBytes)).toBe(10_000n);
  });

  let transfer0: SignedAccountPayload;

  it("G3.3 — PROVES one accountTransfer end to end (the gate)", async () => {
    transfer0 = signTransfer(tokenA, account1, 1_000n); // nonce 0
    const { result: call } = await timed(
      {
        contract: "MiniTokenAA",
        circuit: "accountTransfer",
        note: "G3.3 — first proven accountTransfer over the frozen payload",
      },
      () => relay(tokenA, account1, transfer0),
    );

    // The returned balance key is the account's own address, produced by
    // kernel.self() inside the account's proof.
    expect(bytesToHex((call.result as { bytes: Uint8Array }).bytes)).toBe(
      bytesToHex(account1.addressBytes),
    );

    // The call tree names both contracts: callee first, root last.
    const tree = (call as CallResult).calls?.map((c) => c.contractAddress);
    expect(tree).toEqual([account1.deploy.contractAddress, tokenA.deploy.contractAddress]);

    const ledger = await tokenLedger(tokenA);
    expect(accountBalance(ledger, account1.addressBytes)).toBe(9_000n);
    expect(identityBalance(ledger, RECIPIENT)).toBe(1_000n);

    const acct = await accountLedger(account1);
    expect(acct.consumedDigests.member(transfer0.digest)).toBe(true);
    expect(acct.validateCount).toBe(1n);
  });

  it("R6/R2 — replay and its flipped-s twin are both refused by the digest set", async () => {
    await expect(relay(tokenA, account1, transfer0)).rejects.toThrow(/digest already consumed/);
    await expect(
      relay(tokenA, account1, { ...transfer0, sig: flipS(transfer0.sig) }),
    ).rejects.toThrow(/digest already consumed/);
    expect(accountBalance(await tokenLedger(tokenA), account1.addressBytes)).toBe(9_000n);
  });

  it("R8 — the token-A signature is inert at token B (cross-token replay)", async () => {
    await expect(relay(tokenB, account1, transfer0)).rejects.toThrow(/wrong token/);
    expect(accountBalance(await tokenLedger(tokenB), account1.addressBytes)).toBe(10_000n);
  });

  it("G3.5 — cross-account replay rejected, atomically (two accounts, one owner, one signature)", async () => {
    const transfer1 = signTransfer(tokenA, account1, 500n); // nonce 1, bound to account #1

    // Relayed against account #2: same owner, so `validate` would pass there —
    // the ACCOUNT BIND kills it (returned kernel.self() != payload.account).
    await expect(relay(tokenA, account2, transfer1)).rejects.toThrow(/account mismatch/);

    // Atomicity: the failed root call reverted account #2's digest insert.
    const acct2 = await accountLedger(account2);
    expect(acct2.consumedDigests.member(transfer1.digest)).toBe(false);
    expect(acct2.validateCount).toBe(0n);

    // And the intended relay still lands afterwards — nothing was burned.
    await timed(
      {
        contract: "MiniTokenAA",
        circuit: "accountTransfer",
        note: "G3.5 — intended relay lands after the cross-account attempt",
      },
      () => relay(tokenA, account1, transfer1),
    );
    expect(accountBalance(await tokenLedger(tokenA), account1.addressBytes)).toBe(8_500n);
  });

  it("G3.4 — griefing containment: direct validate burn → clean failure → re-sign recovers", async () => {
    const griefed = signTransfer(tokenA, account1, 700n); // nonce 2 — observed by the griefer

    // Anyone holding the observed tuple can call the PUBLIC validate directly.
    await timed(
      {
        contract: "Account",
        circuit: "validate",
        note: "G3.4 — direct validate call burns the observed digest (R14)",
      },
      () =>
        callCircuit(account1.deploy.deployed, "validate", [
          hexToBytes(griefed.ethAddr),
          griefed.digest,
        ]),
    );

    // The legit relay now fails cleanly, with the reason named.
    await expect(relay(tokenA, account1, griefed)).rejects.toThrow(/digest already consumed/);
    expect(accountBalance(await tokenLedger(tokenA), account1.addressBytes)).toBe(8_500n);

    // Re-signing (fresh nonce ⇒ fresh digest) recovers: the griefer denied ONE
    // operation, not the account.
    const resigned = signTransfer(tokenA, account1, 700n); // nonce 3
    await timed(
      {
        contract: "MiniTokenAA",
        circuit: "accountTransfer",
        note: "G3.4 — re-signed operation lands (R14 recovery)",
      },
      () => relay(tokenA, account1, resigned),
    );
    expect(accountBalance(await tokenLedger(tokenA), account1.addressBytes)).toBe(7_800n);
  });

  it("G3.6 — ONE account controls TWO tokens in one digest/nonce space", async () => {
    const onTokenB = signTransfer(tokenB, account1, 2_000n); // nonce 4 — same sequence
    await timed(
      {
        contract: "MiniTokenAA",
        circuit: "accountTransfer",
        note: "G3.6 — same account authorizes a transfer on the SECOND token",
      },
      () => relay(tokenB, account1, onTokenB),
    );

    const ledgerB = await tokenLedger(tokenB);
    expect(accountBalance(ledgerB, account1.addressBytes)).toBe(8_000n);
    expect(identityBalance(ledgerB, RECIPIENT)).toBe(2_000n);

    // The generality claim in one ledger read: ONE account's digest set now
    // holds authorizations for BOTH tokens, signed with sequential nonces.
    const acct = await accountLedger(account1);
    expect(acct.consumedDigests.member(transfer0.digest)).toBe(true); // token A, nonce 0
    expect(acct.consumedDigests.member(onTokenB.digest)).toBe(true); // token B, nonce 4
    expect(acct.validateCount).toBe(5n); // nonces 0..4, griefing burn included
  });

  it("post-hop failure reverts the digest burn — sign once, fund later, same signature lands", async () => {
    // The insufficient-balance assert fires AFTER the account consumed the
    // digest inside the call tree; the abort must revert that consumption or
    // every underfunded relay would burn its own authorization.
    const tooBig = signTransfer(tokenB, account1, 50_000n); // nonce 5 > balance
    await expect(relay(tokenB, account1, tooBig)).rejects.toThrow(/insufficient balance/);

    const before = await accountLedger(account1);
    expect(before.consumedDigests.member(tooBig.digest)).toBe(false);

    // A permissionless mint (deposit) later — and the ORIGINAL signature is
    // still good: no auth state advanced by someone else's deposit.
    await callCircuit(tokenB.deploy.deployed, "mint", [account1.addressBytes, 100_000n]);
    await timed(
      {
        contract: "MiniTokenAA",
        circuit: "accountTransfer",
        note: "G3.4/atomicity — the once-underfunded signature lands after a deposit",
      },
      () => relay(tokenB, account1, tooBig),
    );
    expect(accountBalance(await tokenLedger(tokenB), account1.addressBytes)).toBe(58_000n);
  });
});
