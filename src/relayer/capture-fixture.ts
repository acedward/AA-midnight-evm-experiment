// PLAN-05 G5.4 — real-MetaMask `personal_sign` fixture capture, ported from
// evm-relayer @ 3703317 (relayer/capture-fixture.ts, PART-E E-G2) onto the
// frozen 176-byte MIDNIGHT_ACCOUNT_V1 payload.
//
//   node --experimental-strip-types src/relayer/capture-fixture.ts
//
// Open the printed URL in a MetaMask-equipped browser (any THROWAWAY key —
// fixtures never use real keys), click the one button, approve the signature.
// The page assembles the canonical fixture payload (from = connected account,
// the other fields fixed demo constants below), personal_signs it, and POSTs
// the result back; this server re-derives everything through src/signer.ts and
// refuses to save anything that does not verify. On save,
// src/test/relayer-signer.test.ts's G5.4 suite un-skips itself.
//
// The fixture's job is BYTE PARITY with a real wallet for the 176-byte format
// (prefix "\x19Ethereum Signed Message:\n176"), not relayability — the token/
// account fields are the PAYLOAD.md KAT constants, no live contract involved.

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { DOMAIN_TAG_HEX } from "../account-payload.ts";
import { bytesToHex, hexToBytes } from "../hex.ts";
import { REPO_ROOT, requireStackVar } from "../stack-env.ts";
import { eip191Digest, parseAccountPayload, tupleFromEthSignature } from "../signer.ts";

export const ACCOUNT_FIXTURE_PATH = path.join(
  REPO_ROOT,
  "src",
  "vectors",
  "metamask-personal-sign-account.json",
);

const PORT = Number(
  process.env.AA_CAPTURE_PORT ?? Number(requireStackVar("AA_BASE_PORT")) + 5,
);

// Demo constants (the PAYLOAD.md KAT shape; `from` comes from MetaMask).
const TOKEN = "aa".repeat(32);
const ACCOUNT = "bb".repeat(32);
const TO = "00".repeat(12) + "cc".repeat(20);
const NONCE = "00".repeat(8); // 0
const AMOUNT = "00".repeat(16); // 0
const RESERVED = "00".repeat(3);

const page = /* html */ `<!doctype html>
<meta charset="utf-8">
<title>MIDNIGHT_ACCOUNT_V1 fixture capture</title>
<body style="font:14px/1.5 system-ui; max-width:640px; margin:40px auto">
<h1>MIDNIGHT_ACCOUNT_V1 — personal_sign fixture (G5.4)</h1>
<p>176-byte payload: domainTag(2400) ‖ op=01 ‖ token=aa… ‖ account=bb… ‖
from=<b id="acct">?</b> ‖ to=…cc ‖ nonce=0 ‖ amount=0 ‖ 000000</p>
<p><b>Use a throwaway MetaMask key.</b></p>
<button id="go" style="font-size:16px;padding:8px 16px">Connect + personal_sign</button>
<pre id="out"></pre>
<script>
const out = (m) => document.getElementById("out").textContent = m;
document.getElementById("go").onclick = async () => {
  try {
    if (!window.ethereum) throw new Error("no window.ethereum — install MetaMask");
    const [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
    document.getElementById("acct").textContent = account;
    const from = account.toLowerCase().replace(/^0x/, "");
    const payload = "${DOMAIN_TAG_HEX}" + "01" + "${TOKEN}" + "${ACCOUNT}" +
      from + "${TO}" + "${NONCE}" + "${AMOUNT}" + "${RESERVED}";
    if (payload.length !== 352) throw new Error("payload length bug: " + payload.length);
    const signature = await window.ethereum.request({
      method: "personal_sign",
      params: ["0x" + payload, account],
    });
    const fixture = { payloadHex: payload, signatureHex: signature.replace(/^0x/, ""), address: account };
    const res = await fetch("/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fixture),
    });
    out(await res.text() + "\\n\\n" + JSON.stringify(fixture, null, 2));
  } catch (e) { out("FAILED: " + (e.message ?? e)); }
};
</script>
`;

const server = http.createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page);
    return;
  }
  if (req.method === "POST" && req.url === "/save") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const fixture = JSON.parse(body) as {
          payloadHex: string;
          signatureHex: string;
          address: string;
        };
        // Verify before saving: structure, recovery, from-bind, digest math.
        const payload = hexToBytes(fixture.payloadHex);
        const fields = parseAccountPayload(payload);
        if (bytesToHex(fields.domainTag) !== DOMAIN_TAG_HEX) throw new Error("wrong domain tag");
        const tuple = tupleFromEthSignature(payload, hexToBytes(fixture.signatureHex));
        const recovered = `0x${bytesToHex(tuple.signer)}`;
        if (recovered !== fixture.address.toLowerCase()) {
          throw new Error(`recovered ${recovered} != claimed ${fixture.address}`);
        }
        if (bytesToHex(fields.from) !== bytesToHex(tuple.signer)) {
          throw new Error("payload.from != recovered signer");
        }
        fs.writeFileSync(ACCOUNT_FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
        const digest = bytesToHex(eip191Digest(payload));
        console.log(`[capture] saved ${ACCOUNT_FIXTURE_PATH} (signer ${recovered}, digest ${digest})`);
        res.writeHead(200);
        res.end(`saved — signer ${recovered} verified, digest ${digest}`);
        setTimeout(() => process.exit(0), 500);
      } catch (e) {
        console.error("[capture] rejected:", e);
        res.writeHead(400);
        res.end(`rejected: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[capture] open http://127.0.0.1:${PORT} in a MetaMask-equipped browser`);
});
