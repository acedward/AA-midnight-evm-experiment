// PLAN-01 Part 0 guard rails. These are the negative assertions the gate list
// calls out explicitly: the allocator must actually re-roll off a busy port and
// off the machine's reserved ranges, and NOTHING outside infra/ may name a port
// — on this machine a default port silently hits somebody else's live stack.

import { execFileSync } from "node:child_process";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { INFRA_DIR, REPO_ROOT } from "../stack-env.ts";

const LIB = path.join(INFRA_DIR, "stack-lib.sh");

/** Run a snippet with stack-lib.sh sourced; returns exit code + stdout. */
function inLib(snippet: string): { code: number; out: string } {
  try {
    const out = execFileSync("bash", ["-c", `. ${JSON.stringify(LIB)}\n${snippet}`], {
      encoding: "utf-8",
    });
    return { code: 0, out: out.trim() };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? "").trim() };
  }
}

describe("port allocator", () => {
  const servers: net.Server[] = [];

  afterAll(() => {
    for (const s of servers) s.close();
  });

  it("reports a bound port as busy", async () => {
    const server = net.createServer();
    servers.push(server);
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
    });

    expect(inLib(`port_free ${port} && echo FREE || echo BUSY`).out).toBe("BUSY");
  });

  it("refuses every reserved window on this machine", () => {
    // 10000-10030 live evm-compat stack, 12300-12599 midnight-ref-ai matrix.
    // A window is 10 wide, so a base just below a range still straddles it.
    for (const base of [9995, 10000, 10025, 10030, 12291, 12300, 12500, 12599]) {
      expect(
        inLib(`window_forbidden ${base} && echo FORBIDDEN || echo OK`).out,
        `base ${base}`,
      ).toBe("FORBIDDEN");
    }
  });

  it("allows windows clear of every reserved range", () => {
    for (const base of [10100, 12290, 12600, 36080, 63990]) {
      expect(
        inLib(`window_forbidden ${base} && echo FORBIDDEN || echo OK`).out,
        `base ${base}`,
      ).toBe("OK");
    }
  });

  it("allocates a base whose whole 10-port window is free and legal", () => {
    const result = inLib("alloc_base_port");
    expect(result.code).toBe(0);
    const base = Number(result.out);
    expect(base).toBeGreaterThanOrEqual(10100);
    expect(base).toBeLessThanOrEqual(63990);
    expect(inLib(`window_forbidden ${base} && echo FORBIDDEN || echo OK`).out).toBe("OK");
  });
});

describe("no default ports outside infra/", () => {
  // PLAN-00 §7 / PART-E Q4: a proxy maps 9944 -> 10000 and 8088 -> 10001 onto a
  // LIVE stack with a populated DB. A hardcoded default would not fail — it
  // would succeed against the wrong chain.
  //
  // The patterns match things that can actually DIAL something — a URL carrying
  // an explicit port, or a port assignment. A bare number in prose ("the
  // defaults 9944/8088/6300 are a proxy") dials nothing, and banning it would
  // only push the hazard out of the comments that explain it.
  const FORBIDDEN = [
    /(?:https?|wss?):\/\/[^\s"'`]*:\d+/, // http://host:1234, ws://host:1234
    /\blocalhost:\d+/,
    /\b127\.0\.0\.1:\d+/,
    /\bport\s*[:=]\s*(?:9944|8088|6300)\b/i,
  ];

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // `test` is excluded on purpose: the gates assert the hazardous port
        // numbers as constants, which is the opposite of hardcoding them.
        if (["node_modules", "managed", "vectors", ".git", "test"].includes(entry.name)) return [];
        return sourceFiles(full);
      }
      return entry.name.endsWith(".ts") ? [full] : [];
    });
  }

  it("no src/ file hardcodes a service port or a localhost URL", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(path.join(REPO_ROOT, "src"))) {
      const text = fs.readFileSync(file, "utf-8");
      text.split("\n").forEach((line, i) => {
        // Comments name the hazardous ports on purpose; only code counts.
        const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
        if (FORBIDDEN.some((pattern) => pattern.test(code))) {
          offenders.push(`${path.relative(REPO_ROOT, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, `hardcoded endpoints found:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the compose file has no port defaults — it fails without STACK.env", () => {
    const compose = fs.readFileSync(path.join(INFRA_DIR, "docker-compose.yml"), "utf-8");
    const publishes = compose.match(/^\s+- "127\.0\.0\.1:.*$/gm) ?? [];
    expect(publishes.length).toBeGreaterThan(0);
    for (const line of publishes) {
      expect(line, `port mapping without a required var: ${line}`).toMatch(/\$\{AA_[A-Z_]+:\?\}/);
    }
  });

  it("STACK.env is gitignored — a clean checkout must allocate fresh ports", () => {
    const ignored = fs.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf-8");
    expect(ignored).toMatch(/^infra\/STACK\.env$/m);
  });
});
