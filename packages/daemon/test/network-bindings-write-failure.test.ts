// A bind whose credential write fails partway leaves neither a credential nor a binding behind.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const failWrite = { on: false };
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    writeFileSync: (...args: Parameters<typeof real.writeFileSync>) => {
      // A partial write: some bytes reach the file, then the disk is full.
      if (failWrite.on && typeof args[0] === "number") {
        real.writeSync(args[0], "{\"version\":1,");
        throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
      }
      return real.writeFileSync(...args);
    },
  };
});

const { default: Database } = await import("better-sqlite3");
const { existsSync, mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { ALL_MIGRATIONS } = await import("../src/db/all-migrations.js");
const { migrate } = await import("../src/db/migrate.js");
const { RigRepository } = await import("../src/domain/rig-repository.js");
const { NetworkBindingStore, networkCredentialFile } = await import("../src/domain/network/network-bindings.js");

let db: InstanceType<typeof Database>;
let home: string;
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db, ALL_MIGRATIONS);
  const rigs = new RigRepository(db);
  const node = rigs.addNode(rigs.createRig("lab").id, "impl", { runtime: "claude-code" });
  db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s1', ?, 'a@lab', 'running')").run(node.id);
  home = mkdtempSync(join(tmpdir(), "openrig-network-write-"));
});
afterEach(() => { failWrite.on = false; db.close(); rmSync(home, { recursive: true, force: true }); });

it("removes the partly written credential and its folder, and records no binding", () => {
  const id = "netb-00000000000000000003";
  const store = new NetworkBindingStore(db, home, () => new Date(), () => id);
  failWrite.on = true;
  expect(() => store.create({ session: "a@lab", hubUrl: "https://hub.example/mcp", hubSeat: "alex@team", token: "tok" })).toThrow(/ENOSPC/);
  expect(existsSync(networkCredentialFile(home, id))).toBe(false);
  expect(existsSync(join(networkCredentialFile(home, id), ".."))).toBe(false);
  expect(store.list()).toHaveLength(0);
  failWrite.on = false;
  expect(store.create({ session: "a@lab", hubUrl: "https://hub.example/mcp", hubSeat: "alex@team", token: "tok" }).state).toBe("active");
});
