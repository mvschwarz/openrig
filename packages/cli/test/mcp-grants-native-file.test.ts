import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addGrant, readGrants, revokeGrant } from "../src/mcp-http.js";

it.runIf(process.platform === "win32")("updates a long-named owned grants file without extending its basename", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-grants-native-"));
  try {
    const file = path.join(root, `${"g".repeat(240)}.json`);
    const grant = { name: "synthetic", seat: "synthetic@fixture", rigs: [], roots: [], workspace: false, owner: false };
    await addGrant(file, grant);
    expect(readGrants(file)?.map(value => value.name)).toEqual(["synthetic"]);
    expect(await revokeGrant(file, "synthetic")).toBe(true);
    expect(readGrants(file)).toEqual([]);
    expect(fs.readdirSync(root)).toEqual([path.basename(file)]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
