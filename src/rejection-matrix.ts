// The rejection matrix — PLAN-02's test strategy, as data rather than prose.
//
// PLAN-00 §6.8 (from passport S10): a signature verifier that vacuously accepts
// is worse than none at all. Two live precedents on this lane made the point —
// the JubjubPoint `==`→`===` runtime bug, and OpenZeppelin's
// `stubVerifySignature { return true; }`. So the negative cases are not extras;
// they are the specification.
//
// The matrix lives here, in code, because a table in a markdown file drifts
// silently: a case gets renamed, a suite gets deleted, and the document still
// claims coverage. `src/test/rejection-matrix.test.ts` checks every entry
// against reality — a case marked covered must name a test that exists, and a
// pending case must name the plan that will close it.
//
// Layers (PLAN-02 §Test strategy):
//   1  pure circuits, no chain — `pureCircuits` + noble vectors, the fast loop
//   2  simulator pattern, no chain — the 0.18-native circuit-context driver
//   3  live — deploy, prove, submit, read back through the indexer
//
// Cases are written against the ACCOUNT path (token root → account callee) and,
// where the contingency seam in PLAN-03 §2 is built, must be re-run against it.

/** Where a case has to be green before its owning gate can be ticked. */
export type Layer = 1 | 2 | 3;

export interface CoveredBy {
  /** Test file, repo-relative. */
  file: string;
  /** A distinctive fragment of the `it(...)` title that asserts this case. */
  test: string;
}

export interface RejectionCase {
  /** R1…R15, as PLAN-02 numbers them. */
  id: string;
  title: string;
  /** The observable outcome the case demands. */
  expects: string;
  layers: readonly Layer[];
  /** The gate that ticks when this case is green. */
  gate: string;
  /**
   * Where it is asserted today. An empty list means the subject does not exist
   * yet — `blockedBy` says which plan builds it. Nothing else is a valid reason
   * for an empty list.
   */
  covered: readonly CoveredBy[];
  /** Plan that must close the case, when `covered` is empty. */
  blockedBy?: string;
  /** Why this case exists at all — the failure it would have caught. */
  rationale: string;
}

const S1 = "src/test/s1-ccc.test.ts";
const MATRIX_TEST = "src/test/rejection-matrix.test.ts";
// PLAN-03's three layers over the frozen MIDNIGHT_ACCOUNT_V1 payload.
const PAYLOAD_TEST = "src/test/account-payload.test.ts";
const SIM_TEST = "src/test/account-simulator.test.ts";
const LIVE_TEST = "src/test/account-live.test.ts";

export const REJECTION_MATRIX: readonly RejectionCase[] = [
  {
    id: "R1",
    title: "valid signature, correct everything",
    expects: "accept; balances move; event emitted",
    layers: [1, 2, 3],
    gate: "G2.3",
    covered: [],
    blockedBy: "PLAN-04 (the token's Transfer event; S1 proved the balance movement)",
    rationale:
      "The positive control. Without it a matrix of rejections proves only that the " +
      "contract rejects everything, which a `return false` also achieves.",
  },
  {
    id: "R2",
    title: "flipped-s twin (r, n−s) of a valid signature",
    expects:
      "accepts-or-rejects, but consumes the SAME digest — asserted explicitly, never assumed",
    layers: [1, 3],
    gate: "G2.2",
    covered: [
      { file: S1, test: "accepts the flipped-s twin" },
      { file: S1, test: "R2 — the flipped-s twin of a consumed signature is rejected too" },
      { file: MATRIX_TEST, test: "R2 — malleability is real at layer 1" },
      { file: SIM_TEST, test: "R2 — the flipped-s twin passes the verifier" },
      { file: LIVE_TEST, test: "R6/R2 — replay and its flipped-s twin are both refused" },
    ],
    rationale:
      "`secp256k1EcdsaVerify` enforces no low-s rule, so both twins verify. Replay " +
      "protection keyed on signature bytes would be defeated by a transformation any " +
      "observer can apply; keyed on the digest it is untouched. PLAN-00 §3.3 exists " +
      "because of this case.",
  },
  {
    id: "R3",
    title: "wrong s / garbage signature",
    expects: "reject, no state change anywhere in the call tree",
    layers: [1, 2, 3],
    gate: "G2.2",
    covered: [
      { file: S1, test: "rejects a garbage signature and leaves the CALLEE untouched" },
      { file: MATRIX_TEST, test: "R3 — a mutated signature is rejected at layer 1" },
    ],
    rationale:
      "The base negative. The CCC form matters more than the single-contract form: the " +
      "authorization assert must run BEFORE the hop, or a rejected call still drives " +
      "callee state.",
  },
  {
    id: "R4",
    title: "valid signature from a DIFFERENT key (address mismatch)",
    expects: 'reject "not owner"',
    layers: [1, 2, 3],
    gate: "G2.2",
    covered: [{ file: S1, test: "R4 — rejects a valid signature from a key that is not the owner" }],
    rationale:
      "Not a forgery — a real signature from the wrong signer. Catches a verifier that " +
      "checks the signature and forgets to bind it to the registered owner.",
  },
  {
    id: "R5",
    title: "tampered payload field (each field, one at a time)",
    expects: "reject — the digest changes, so the signature no longer verifies",
    layers: [1, 2],
    gate: "G2.2",
    covered: [
      { file: PAYLOAD_TEST, test: "changes the digest and kills the signature" },
      { file: SIM_TEST, test: "R5 — tampering a signed field in transit invalidates the signature in-circuit" },
    ],
    rationale:
      "Per-field, not per-payload: a field left out of the digest is invisible to a " +
      "whole-payload test and is exactly how an amount or recipient becomes forgeable.",
  },
  {
    id: "R6",
    title: "reused digest",
    expects: 'reject "digest consumed"',
    layers: [2, 3],
    gate: "G2.3",
    covered: [
      { file: S1, test: "R6 — rejects the replayed digest, and moves no balance" },
      { file: SIM_TEST, test: "R6 — a consumed digest is refused on the second call" },
      { file: LIVE_TEST, test: "R6/R2 — replay and its flipped-s twin are both refused" },
    ],
    rationale: "Single-use is the whole point of the consumed-digest set (PLAN-00 §6.2).",
  },
  {
    id: "R7",
    title: "wrong nonce",
    expects:
      "relayer refuses out-of-order nonces; in-circuit a nonce change is a digest change (R5)",
    layers: [1, 2],
    gate: "G2.2",
    covered: [],
    blockedBy:
      "PLAN-05 (relayer-side ordering). PLAN-03 DECISION (recorded in contracts/PAYLOAD.md): " +
      "replay authority is the digest set ONLY — no ledger nonce, no in-circuit nonce assert, " +
      "because a strictly-sequential nonce on a public `validate` adds a griefing vector " +
      "(garbage-digest nonce bumps) the digest set doesn't have. The signed payload nonce " +
      "provides digest uniqueness + ordering legibility; its tamper-rejection is R5.",
    rationale:
      "A dedicated auth nonce, separate from any global counter, is what keeps " +
      "permissionless deposits from invalidating pending signatures (R13's other half).",
  },
  {
    id: "R8",
    title: "cross-token replay — the same signature at a second deployed token",
    expects: "reject (token binding)",
    layers: [3],
    gate: "G2.3",
    covered: [
      { file: SIM_TEST, test: "R8 (shape) — a payload bound to a DIFFERENT token address is refused" },
      { file: LIVE_TEST, test: "R8 — the token-A signature is inert at token B (cross-token replay)" },
    ],
    rationale:
      "The payload carries the token address and the root asserts it equals " +
      "`kernel.self()`. Without this test that assert can be dropped and nothing fails. " +
      "Proven live with two MiniTokenAA instances (PLAN-03); PLAN-04 G4.3 re-asserts it " +
      "against the real OZ fork.",
  },
  {
    id: "R9",
    title: "cross-account replay — the same signature at a second account",
    expects: "reject (account binding)",
    layers: [3],
    gate: "G2.4",
    covered: [
      {
        file: LIVE_TEST,
        test: "G3.5 — cross-account replay rejected, atomically (two accounts, one owner, one signature)",
      },
    ],
    rationale:
      "One owner may hold several accounts; a signature for one must be inert at another. " +
      "The bind is against the ContractAddress `validate` RETURNED (kernel.self()), never " +
      "against a passed-in address — and the rejection reverts the wrong account's digest " +
      "insert atomically.",
  },
  {
    id: "R10",
    title: "wrong op selector (a TRANSFER signature sent to the APPROVE path)",
    expects: "reject",
    layers: [1, 2],
    gate: "G2.2",
    covered: [
      { file: SIM_TEST, test: "R10 — an APPROVE-op signature is refused on the transfer path" },
    ],
    rationale:
      "Operation confusion: without a selector in the digest, an approval signature is " +
      "also a transfer signature.",
  },
  {
    id: "R11",
    title: "wrong chainId domain tag",
    expects: "reject",
    layers: [1, 2],
    gate: "G2.2",
    covered: [
      { file: SIM_TEST, test: "R11 — a foreign domain tag (other chain/version) is refused" },
    ],
    rationale: "Cross-chain replay of an identically-shaped intent.",
  },
  {
    id: "R12",
    title: "identity point / default public key",
    expects: "reject — the stdlib asserts a non-identity point",
    layers: [1],
    gate: "G2.2",
    covered: [{ file: MATRIX_TEST, test: "R12 — the identity point is refused" }],
    rationale:
      "A degenerate public key that some verifiers accept, turning 'anyone' into a valid " +
      "signer.",
  },
  {
    id: "R13",
    title: "deposit independence — a permissionless op between signing and submission",
    expects: "the original signature still lands",
    layers: [3],
    gate: "G2.3",
    covered: [],
    blockedBy: "PLAN-04 (needs the token's permissionless entry points)",
    rationale:
      "passport AUTH-8. A signature invalidated by someone else's deposit is a liveness " +
      "bug that only shows up under concurrency.",
  },
  {
    id: "R14",
    title: "griefing — a direct `validate` call burns the digest",
    expects: "the relay fails cleanly; re-signing succeeds",
    layers: [3],
    gate: "G2.4",
    covered: [
      {
        file: S1,
        test: "R14 — a direct validate burns the digest; the relay fails cleanly and re-signing recovers",
      },
      {
        file: LIVE_TEST,
        test: "G3.4 — griefing containment: direct validate burn → clean failure → re-sign recovers",
      },
    ],
    rationale:
      "`validate` is a public entry point (no `kernel.caller()`, no CCC-only circuits), so " +
      "this is reachable by anyone. The accepted risk is bounded denial of ONE operation — " +
      "which only stays true if re-signing actually recovers.",
  },
  {
    id: "R15",
    title: "Wycheproof secp256k1 vectors (the DER-parsable subset)",
    expects: "the in-circuit verifier agrees with noble on every case",
    layers: [1],
    gate: "G2.2",
    covered: [
      { file: MATRIX_TEST, test: "R15 — the in-circuit verifier agrees with noble" },
      { file: MATRIX_TEST, test: "R15b — the corpus's own verdicts are matched" },
    ],
    rationale:
      "The corpus exists to find verifiers that are right on happy paths and wrong on " +
      "edge cases: large x-coordinates, small r/s, points of small order, modular-inverse " +
      "boundaries.",
  },
];

export function caseById(id: string): RejectionCase {
  const found = REJECTION_MATRIX.find((c) => c.id === id);
  if (!found) throw new Error(`no rejection-matrix case ${id}`);
  return found;
}

/** Cases with no test asserting them yet, in plan order. */
export function pendingCases(): RejectionCase[] {
  return REJECTION_MATRIX.filter((c) => c.covered.length === 0);
}
