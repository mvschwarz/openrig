import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Called only by the opt-in package Gate, with its owned prefix and home.
const [installed, home] = process.argv.slice(2);
assert.ok(installed && home, "installed package and owned home are required");
const load = name => import(pathToFileURL(join(resolve(installed), "daemon/dist/domain", name)).href);
const { ContextPackLibraryService } = await load("context-packs/context-pack-library-service.js");
const { SpecLibraryService } = await load("spec-library-service.js");
const { SpecReviewService } = await load("spec-review-service.js");
const root = join(resolve(home), "resource library 中文 & % fixture");
mkdirSync(root);
const source = join(root, "notes 中文 & %.md");
writeFileSync(source, "# Owned installed context\n");
const packs = join(root, "packs");
const library = new ContextPackLibraryService({ roots: [{ path: packs, sourceType: "user_file" }] });
const composed = library.composeFromFiles({ outRef: "owned/brief", sources: [{ path: source, label: "notes.md" }] });
assert.equal(composed.ref, "owned/brief");
assert.deepEqual(library.scan(), { count: 1, errors: [] });
assert.equal(library.getByRef("owned/brief").sourcePath, join(packs, "owned", "brief"));
assert.equal(readFileSync(join(packs, "owned", "brief", "source-0001.md"), "utf8"), "# Owned installed context\n");
assert.equal(library.removeByRef("owned/brief").removed, true);
assert.equal(existsSync(join(packs, "owned", "brief")), false);
const specs = join(root, "specs"); mkdirSync(specs);
writeFileSync(join(specs, "original.yaml"), 'name: owned-agent\nversion: "1.0"\ndefaults:\n  runtime: claude-code\nprofiles:\n  default:\n    uses: []\nresources:\n  skills: []\nstartup:\n  files: []\n  actions: []\n');
const specLibrary = new SpecLibraryService({ roots: [{ path: specs, sourceType: "user_file" }], specReviewService: new SpecReviewService() });
specLibrary.scan(); assert.equal(specLibrary.list().length, 1);
const renamed = specLibrary.rename(specLibrary.list()[0].id, "renamed owned agent");
assert.equal(renamed.ok, true); assert.equal(renamed.entry.name, "renamed owned agent");
assert.equal(existsSync(join(specs, "original.yaml")), false);
assert.equal(specLibrary.list().length, 1);
if (process.platform === "win32") {
  const cliModule = name => import(pathToFileURL(join(resolve(installed), "dist", name)).href);
  const { probeTmuxCapture } = await cliModule("tmux-health.js");
  const { doctorExec } = await cliModule("commands/doctor.js");
  const { defaultDeps } = await cliModule("commands/setup.js");
  const environments = [];
  const capture = probeTmuxCapture((_command, options) => {
    environments.push(options.env);
    assert.ok(options.env.HOME && existsSync(options.env.HOME));
    assert.equal(options.env.USERPROFILE, options.env.HOME);
    assert.equal(options.env.PSMUX_DATA_DIR, join(options.env.HOME, "psmux"));
    assert.equal(options.env.PSMUX_CONFIG_FILE, "NUL");
    return "";
  }, "owned-installed-capture");
  assert.deepEqual(capture, { status: "pass" });
  assert.equal(environments.length, 3);
  assert.ok(environments.every(env => env === environments[0]));
  assert.equal(existsSync(environments[0].HOME), false);
  for (const exec of [doctorExec, defaultDeps().exec]) {
    assert.equal(exec(`"${process.execPath}" -p "process.env.OPENRIG_TEST_CAPTURE_MARKER"`, {
      timeoutMs: 5000, env: { ...process.env, OPENRIG_TEST_CAPTURE_MARKER: "owned-installed-environment" },
    }).trim(), "owned-installed-environment");
  }
}
console.log(JSON.stringify({ contextComposeReadRemove: true, specScanRename: true, nativeCaptureEnvironment: process.platform === "win32" }));
