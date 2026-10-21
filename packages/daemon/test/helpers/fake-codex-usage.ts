// Slice 01 — a fake `codex` executable for the usage-windows reader. It speaks the app-server's
// newline-delimited JSON-RPC on stdio, answers from `$CODEX_HOME/fake-usage.json`, and appends one
// line to `$CODEX_HOME/spawns.log` per start so tests can count native reads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface FakeCodexPlan {
  /** ok: answer both reads; rpc_error: error on account/rateLimits/read; hang: never answer it;
   *  exit: exit before answering; bad_shape: answer with an unrecognized rate-limit shape. */
  mode: "ok" | "rpc_error" | "hang" | "exit" | "bad_shape";
  delayMs?: number;
  account?: unknown;
  rateLimits?: unknown;
}

const SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.CODEX_HOME;
fs.appendFileSync(path.join(home, "spawns.log"), process.argv.slice(2).join(" ") + "\\n");
const plan = JSON.parse(fs.readFileSync(path.join(home, "fake-usage.json"), "utf8"));
if (plan.mode === "exit") process.exit(3);
let buffered = "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("end", () => process.exit(0));
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let i;
  while ((i = buffered.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buffered.slice(0, i));
    buffered = buffered.slice(i + 1);
    if (m.id === 1) send({ id: 1, result: { userAgent: "fake" } });
    if (m.id === 2) send({ id: 2, result: plan.account ?? { account: null, requiresOpenaiAuth: true } });
    if (m.id === 3) {
      if (plan.mode === "hang") continue;
      setTimeout(() => {
        if (plan.mode === "rpc_error") send({ id: 3, error: { code: -32000, message: "backend unavailable" } });
        else if (plan.mode === "bad_shape") send({ id: 3, result: { rateLimits: "nope" } });
        else send({ id: 3, result: plan.rateLimits });
      }, plan.delayMs ?? 0);
    }
  }
});
`;

export interface FakeCodex {
  /** PATH entry holding the fake `codex`. */
  binDir: string;
  /** CODEX_HOME the fake reads its plan from and logs spawns into. */
  codexHome: string;
  setPlan(plan: FakeCodexPlan): void;
  spawns(): number;
}

export function makeFakeCodex(): FakeCodex {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fake-codex-usage-"));
  const binDir = path.join(root, "bin");
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(binDir);
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(binDir, "codex"), SCRIPT, { mode: 0o755 });
  return {
    binDir,
    codexHome,
    setPlan: (plan) => fs.writeFileSync(path.join(codexHome, "fake-usage.json"), JSON.stringify(plan)),
    spawns: () => {
      try {
        return fs.readFileSync(path.join(codexHome, "spawns.log"), "utf8").split("\n").filter(Boolean).length;
      } catch {
        return 0;
      }
    },
  };
}

/** A rate-limit answer in Codex 0.153.4's `GetAccountRateLimitsResponse` shape. */
export function rateLimitsAnswer(opts: {
  accountId?: string | null;
  limitId?: string;
  primaryUsed?: number;
  secondaryUsed?: number;
  primaryResets?: number;
  secondaryResets?: number;
  reached?: string | null;
  byLimitId?: boolean;
}): unknown {
  const limitId = opts.limitId ?? "codex";
  const snapshot = {
    limitId,
    limitName: null,
    primary: { usedPercent: opts.primaryUsed ?? 41, windowDurationMins: 300, resetsAt: opts.primaryResets ?? 1_918_000_000 },
    secondary: { usedPercent: opts.secondaryUsed ?? 59, windowDurationMins: 10080, resetsAt: opts.secondaryResets ?? 1_918_400_000 },
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: "plus",
    rateLimitReachedType: opts.reached ?? null,
  };
  return {
    rateLimits: snapshot,
    rateLimitsByLimitId: opts.byLimitId === false ? null : { [limitId]: snapshot },
    rateLimitResetCredits: null,
    accountId: opts.accountId === undefined ? "acct-1" : opts.accountId,
    rateLimitUpsell: null,
  };
}

export const ACCOUNT_ANSWER = { account: { type: "chatgpt", email: "dev@example.test", planType: "plus" }, requiresOpenaiAuth: true };
