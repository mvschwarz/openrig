import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { prepareGitHubBundle } from "../src/lib/bundle-source.js";

it.runIf(process.platform === "win32").each(["folder", "agent-reference"])("prepares an owned bundle with an internal native %s junction within a short-root checkout", async kind => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-native-alias-"));
  const commit = "a".repeat(40);
  try {
    const fakeGit = async (cwd: string, args: string[]) => {
      if (args[0] === "ls-remote") return `${commit}\tHEAD\n${commit}\trefs/heads/main\n`;
      if (args[0] === "rev-parse") return commit;
      if (args[0] === "checkout") {
        const physical = path.join(cwd, "physical");
        fs.mkdirSync(physical);
        fs.mkdirSync(path.join(physical, "agent"));
        fs.writeFileSync(path.join(physical, "agent", "agent.yaml"), "name: owned-agent\n");
        fs.writeFileSync(path.join(physical, "rig.yaml"), kind === "folder" ? "name: owned-fixture\n"
          : "name: owned-fixture\npods:\n  - members:\n      - agent_ref: local:../alias/agent\n");
        fs.symlinkSync(fs.realpathSync.native(physical), path.join(cwd, "alias"), "junction");
      }
      return "";
    };
    const folder = kind === "folder" ? "alias" : "physical";
    const prepared = await prepareGitHubBundle(`https://github.com/example/owned-fixture/tree/main/${folder}`, fakeGit, root);
    expect(fs.realpathSync.native(prepared.folder)).toBe(fs.realpathSync.native(path.join(prepared.checkoutDir, "physical")));
    expect(JSON.parse(fs.readFileSync(prepared.receiptPath, "utf8"))).toMatchObject({ folder, resolvedCommit: commit });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it.runIf(process.platform === "win32")("refuses a native junction outside the owned checkout and leaves its target intact", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-native-outside-"));
  const commit = "a".repeat(40), imports = path.join(root, "imports"), outside = path.join(root, "outside");
  try {
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "rig.yaml"), "name: outside-owned-fixture\n");
    const fakeGit = async (cwd: string, args: string[]) => {
      if (args[0] === "ls-remote") return `${commit}\tHEAD\n${commit}\trefs/heads/main\n`;
      if (args[0] === "rev-parse") return commit;
      if (args[0] === "checkout") fs.symlinkSync(fs.realpathSync.native(outside), path.join(cwd, "alias"), "junction");
      return "";
    };
    await expect(prepareGitHubBundle("https://github.com/example/owned-fixture/tree/main/alias", fakeGit, imports)).rejects.toThrow(/rig.yaml inside the fetched repository/);
    expect(fs.readdirSync(imports)).toEqual([]);
    expect(fs.readFileSync(path.join(outside, "rig.yaml"), "utf8")).toBe("name: outside-owned-fixture\n");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
