import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

test("the CLI build carries the unchanged repository LICENSE and README into npm pack", () => {
  const root = mkdtempSync(join(tmpdir(), "cli-license-"));
  try {
    const cli = join(root, "packages/cli");
    const bin = join(root, "bin");
    for (const dir of [cli, bin, join(cli, "src/schemas"), join(cli, "src/lib/scope-templates")]) mkdirSync(dir, { recursive: true });
    copyFileSync("LICENSE", join(root, "LICENSE"));
    copyFileSync("README.md", join(root, "README.md"));
    copyFileSync("packages/cli/package.json", join(cli, "package.json"));
    writeFileSync(join(cli, "src/schemas/fixture.json"), "{}\n");
    writeFileSync(join(cli, "src/lib/scope-templates/fixture.md"), "fixture\n");
    // Compilation is outside this packaging regression. Run the actual build
    // script with its expected compiler output, then npm's real file selection.
    writeFileSync(join(bin, "tsc"), "#!/bin/sh\nmkdir -p dist\nprintf '%s\\n' '// compiler fixture' > dist/bin-wrapper.js\n");
    chmodSync(join(bin, "tsc"), 0o755);
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
    execFileSync("npm", ["run", "build"], { cwd: cli, env, stdio: "pipe" });
    const source = readFileSync(join(root, "LICENSE"));
    assert.deepEqual(readFileSync(join(cli, "LICENSE")), source, "build must stage the repository license verbatim");
    const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json"], { cwd: cli, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }));
    assert.ok(packed[0].files.some((file) => file.path === "LICENSE"), "npm archive must include LICENSE");
    const bytes = execFileSync("tar", ["-xOf", join(cli, packed[0].filename), "package/LICENSE"]);
    assert.deepEqual(bytes, source, "packed license must equal the existing root bytes");
    // npm shows the package-root README on the registry page; without it the page reads "No README data found".
    const readme = readFileSync(join(root, "README.md"));
    assert.ok(packed[0].files.some((file) => file.path === "README.md"), "npm archive must include README.md");
    const readmeBytes = execFileSync("tar", ["-xOf", join(cli, packed[0].filename), "package/README.md"]);
    assert.deepEqual(readmeBytes, readme, "packed README must equal the existing root bytes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
