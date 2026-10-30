import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { TmuxAdapter } from "../src/adapters/tmux.js";

it.runIf(process.platform === "win32").each([
  { operation: "create", outcome: "duplicate", removed: true },
  { operation: "create", outcome: "spawn", removed: true },
  { operation: "create", outcome: "timeout", removed: false },
  { operation: "create", outcome: "success", removed: false },
  { operation: "respawn", outcome: "spawn", removed: true },
  { operation: "respawn", outcome: "timeout", removed: false },
  { operation: "create", outcome: "cleanup-refused", removed: false },
])("handles the native $operation bootstrap after $outcome without consuming uncertain work", async ({ operation, outcome, removed }) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "owned-scoped-cleanup-"));
  const bootstrap = path.join(root, "bootstrap.ps1"), unlinked: string[] = [];
  const failure = outcome === "spawn" ? Object.assign(new Error("spawn owned-missing.exe ENOENT"), { syscall: "spawn owned-missing.exe", code: "ENOENT" })
    : new Error(outcome === "duplicate" || outcome === "cleanup-refused" ? "duplicate session: owned" : "owned request timed out");
  try {
    const adapter = new TmuxAdapter(async () => { throw Error("No shell transport expected"); }, {
      tmpName: () => bootstrap, bufferName: () => "unused",
      writeFile: async (file, content) => { fs.writeFileSync(file, content, { flag: "wx" }); },
      unlink: async file => {
        unlinked.push(file);
        if (outcome === "cleanup-refused") throw Object.assign(Error("owned cleanup refused"), { code: "EPERM" });
        fs.unlinkSync(file);
      },
    }, async argv => {
      if (argv.includes("show-options")) return argv.includes("default-shell") ? "powershell.exe" : "";
      if (argv.includes("openrig-private-environment-capability")) throw Error("unknown command: openrig-private-environment-capability");
      if (argv.includes("new-session") || argv.includes("respawn-pane")) {
        expect(fs.existsSync(bootstrap)).toBe(true);
        if (outcome !== "success") throw failure;
        return "%7";
      }
      return "";
    }, "psmux");
    adapter.launchEnvironment = () => ({ inheritTmuxEnvironment: false, env: { HOME: root, PATH: path.dirname(process.execPath), SystemRoot: process.env.SystemRoot } });
    const result = operation === "create"
      ? await adapter.createSession("owned", root, { OPENRIG_NODE_ID: "owned-node" })
      : await adapter.respawnPane("%7", "", { cwd: root, env: { OPENRIG_NODE_ID: "owned-node" } });
    expect(result.ok).toBe(outcome === "success");
    if (!result.ok) expect(result.message).toBe(failure.message);
    expect(fs.existsSync(bootstrap)).toBe(!removed);
    expect(unlinked).toEqual(removed || outcome === "cleanup-refused" ? [bootstrap] : []);
  } finally { fs.rmSync(root, { recursive: true }); }
});
