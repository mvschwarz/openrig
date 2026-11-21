import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { FileWriteService, sha256Hex } from "../src/domain/files/file-write-service.js";

it.each(["create", "replace"] as const)("can %s an owned valid long filename", operation => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "file-edit-long-")));
  const name = "x".repeat(230) + ".md", file = path.join(root, name);
  const service = new FileWriteService({ allowlist: [{ name: "owned", canonicalPath: root }], auditFilePath: path.join(root, "audit.jsonl") });
  try {
    const request = { rootName: "owned", path: name, content: "new owned content", actor: "owned fixture" };
    if (operation === "replace") {
      fs.writeFileSync(file, "old owned content");
      service.writeAtomic({ ...request, expectedMtime: fs.statSync(file).mtime.toISOString(), expectedContentHash: sha256Hex("old owned content") });
    } else service.createAtomic(request);
    expect(fs.readFileSync(file, "utf8")).toBe(request.content);
    expect(fs.readdirSync(root).sort()).toEqual(["audit.jsonl", name].sort());
    const audit = JSON.parse(fs.readFileSync(path.join(root, "audit.jsonl"), "utf8"));
    expect(audit.path).toBe(name);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
