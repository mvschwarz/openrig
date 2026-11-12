import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL(
  "../assets/plugins/openrig-core/skills/openrig-operating-model/scripts/trunk-diff.sh",
  import.meta.url,
));
const fixtures: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture, { recursive: true });
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trunk-diff-"));
  fixtures.push(dir);
  const root = path.join(dir, "tree");
  fs.mkdirSync(root);
  const write = (name: string, value: string) => fs.writeFileSync(
    path.join(root, name), `---\nintent: ${value}\n---\n# ${name}\n${value}\n`,
  );
  const run = (...args: string[]) => execFileSync(
    process.platform === "win32" ? process.execPath : "bash",
    [process.platform === "win32" ? helper.replace(/\.sh$/, ".mjs") : helper, root, path.join(dir, "state"), ...args],
    { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  return { write, run };
}

describe("trunk-diff filename selection", () => {
  it.each(["SPEC.md", "SOP.md", "CULTURE.md", "LEARNED.md", "PLAYBOOK.md", "INTENT.md"])(
    "default selection detects a change to %s", (name) => {
      const f = fixture();
      f.write(name, "alpha");
      f.run();
      f.write(name, "beta");
      expect(f.run()).toContain("+intent: beta");
      expect(f.run()).toContain("no changes since your last render");
    },
  );

  it.each(["SPEC.md", "README.md"])("explicit --name detects %s", (name) => {
    const f = fixture();
    f.write(name, "alpha");
    f.run("--name", name);
    f.write(name, "beta");
    expect(f.run("--name", name)).toContain("+intent: beta");
  });

  it("explicit names replace the defaults", () => {
    const f = fixture();
    f.write("SPEC.md", "alpha");
    f.write("LEARNED.md", "alpha");
    f.run("--name", "LEARNED.md");
    f.write("SPEC.md", "beta");
    expect(f.run("--name", "LEARNED.md")).toContain("no changes since your last render");
    f.write("LEARNED.md", "gamma");
    expect(f.run("--name", "LEARNED.md")).toContain("+intent: gamma");
  });
});
