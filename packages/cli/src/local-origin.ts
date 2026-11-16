import type Database from "better-sqlite3";
import { validateHostRegistry } from "./host-registry.js";
import { openLocalDbReadonly } from "./local-db.js";

/** Read the boot-minted identity without requiring the local daemon or minting a replacement. */
export function readLocalOrigin(): string | undefined {
  let db: Database.Database | undefined;
  try {
    db = openLocalDbReadonly();
    const row = db.prepare("SELECT host_id FROM self_host_identity WHERE singleton = 1").get() as { host_id?: unknown } | undefined;
    const id = row?.host_id;
    if (typeof id !== "string" || id === "localhost") return undefined;
    const valid = validateHostRegistry({ hosts: [{ id, transport: "ssh", target: "identity-validation" }] }, "<local-origin>");
    return valid.ok ? id : undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}
