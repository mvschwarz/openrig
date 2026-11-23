import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addGrant, grantFor, readGrants, revokeGrant, rotateGrant } from "../src/mcp-http.js";

let tmpDir: string;
let tokenFile: string;

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function freshFile(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-rotate-"));
  tokenFile = path.join(tmpDir, "tokens.json");
  return tokenFile;
}

describe("rotateGrant", () => {
  it("issues a new token for an existing grant and keeps its scope", async () => {
    const file = freshFile();
    const original = await addGrant(file, {
      name: "worker",
      seat: "worker@team",
      rigs: ["team"],
      roots: ["/srv/artifacts"],
      workspace: true,
      owner: false,
    });
    const before = readGrants(file)![0]!;

    const rotated = await rotateGrant(file, "worker");

    expect(rotated).not.toBe(original);
    expect(rotated.startsWith("orm_")).toBe(true);
    const grants = readGrants(file)!;
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      name: "worker",
      seat: "worker@team",
      rigs: ["team"],
      roots: ["/srv/artifacts"],
      workspace: true,
      owner: false,
      createdAt: before.createdAt,
    });
    expect(grants[0]!.tokenSha256).not.toBe(before.tokenSha256);
  });

  it("makes the old token stop matching while the new one matches", async () => {
    const file = freshFile();
    const original = await addGrant(file, { name: "worker", seat: "worker@team", rigs: [], roots: [], workspace: false, owner: false });
    expect(grantFor(readGrants(file)!, original)?.name).toBe("worker");

    const rotated = await rotateGrant(file, "worker");

    const grants = readGrants(file)!;
    expect(grantFor(grants, original)).toBeNull();
    expect(grantFor(grants, rotated)?.name).toBe("worker");
  });

  it("rejects an unknown grant name", async () => {
    const file = freshFile();
    await addGrant(file, { name: "worker", seat: "worker@team", rigs: [], roots: [], workspace: false, owner: false });
    await expect(rotateGrant(file, "ghost")).rejects.toThrow(/No grant named ghost/);
  });

  it("keeps revoke working after a rotation", async () => {
    const file = freshFile();
    await addGrant(file, { name: "worker", seat: "worker@team", rigs: [], roots: [], workspace: false, owner: false });
    await rotateGrant(file, "worker");
    expect(await revokeGrant(file, "worker")).toBe(true);
    expect(readGrants(file)).toEqual([]);
  });
});
