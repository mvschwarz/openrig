import type Database from "better-sqlite3";

// The rigs `rig up` is still building on this daemon: created, with their seats being created and launched one by one
// and their edges still to be written. An agent that asks who's on its team in that window is told so, rather than
// reading a partial roster as the whole team (#2871). In memory only, like the import guard beside it: after a daemon
// restart nothing is marked, so the answer is today's, never a stuck "still being built".
const building = new WeakMap<Database.Database, Set<string>>();

export function markRigBuilding(db: Database.Database, rigId: string): void {
  let rigs = building.get(db);
  if (!rigs) building.set(db, (rigs = new Set()));
  rigs.add(rigId);
}

export function unmarkRigBuilding(db: Database.Database, rigId: string): void {
  building.get(db)?.delete(rigId);
}

export function rigStillBeingBuilt(db: Database.Database, rigId: string): boolean {
  return building.get(db)?.has(rigId) ?? false;
}
