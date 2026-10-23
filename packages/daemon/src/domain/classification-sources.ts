import { physicalSessionName } from "./session-registry.js";
import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { workSource, insideProject, type ProjectRead } from "./workspace/project-read.js";
import { isMissionDotId, isSliceDotId } from "./scope/dot-id.js";
import type { StreamStore } from "./stream-store.js";

export const sourceHash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export interface ClassifierOccupant { nodeId: string; rigId: string; session: string; generation: string }

// Same real running-session/tenure sources as startup liveness. No daemon pseudo-session.
export function classifierOccupant(db: Database.Database, session: string): ClassifierOccupant | null {
  session = physicalSessionName(db, session);
  const rows = db.prepare(`SELECT DISTINCT n.id AS nodeId, n.rig_id AS rigId, b.tmux_session AS session,
    o.generation_uuid AS generation FROM nodes n JOIN bindings b ON b.node_id=n.id
    JOIN sessions s ON s.node_id=n.id AND s.session_name=b.tmux_session AND s.status='running'
      AND s.id=(SELECT id FROM sessions WHERE node_id=n.id ORDER BY id DESC LIMIT 1)
    JOIN occupant_tenures o ON o.node_id=n.id
      AND o.generation_ordinal=(SELECT MAX(generation_ordinal) FROM occupant_tenures WHERE node_id=n.id)
    WHERE b.tmux_session=? LIMIT 2`).all(session) as ClassifierOccupant[];
  return rows.length === 1 && rows[0]!.generation ? rows[0]! : null;
}

export function classificationSources(db: Database.Database, project: ProjectRead, occupant: ClassifierOccupant, stream: StreamStore) {
  const unavailable: string[] = [];
  const scopes: { id: string; source: string; hash: string }[] = [];
  const observedAt = new Date().toISOString();
  let sourceBytes = 0;
  const readScope = (dir: string, missionId?: string): string => {
    if (scopes.length >= 1000) throw Error("scope count exceeds 1000");
    const source = insideProject(project.root, workSource(project.root, dir, false));
    const size = fs.statSync(source).size;
    if (size > 128 * 1024 || (sourceBytes += size) > 4 * 1024 * 1024) throw Error("scope source byte limit");
    const text = readBounded(source, Math.min(128 * 1024, 4 * 1024 * 1024 - sourceBytes + size));
    const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    const id: unknown = front ? parse(front[1]!)?.id : undefined;
    if (typeof id !== "string" || !(missionId ? isSliceDotId(id) && id.startsWith(missionId + ".") : isMissionDotId(id))) {
      throw Error(`canonical ${missionId ? "slice" : "mission"} ID unavailable: ${source}`);
    }
    if (scopes.some(x => x.id === id)) throw Error(`ambiguous scope ID: ${id}`);
    scopes.push({ id, source, hash: sourceHash(text) });
    return id;
  };
  const projectSources: {source: string; hash: string}[] = [];
  try {
    for (const source of [project.sourcePath, path.join(project.root, "project.yaml")]) {
      if (!source || !fs.existsSync(source) || projectSources.some(x => x.source === source)) continue;
      const actual = insideProject(project.root, source);
      projectSources.push({source: actual, hash: sourceHash(readBounded(actual, 128 * 1024))});
    }
    if (!projectSources.length) throw Error("project source unavailable");
    insideProject(project.root, project.missionsRoot);
    const missions = fs.readdirSync(project.missionsRoot, { withFileTypes: true }).filter(x => x.isDirectory() || x.isSymbolicLink()).sort((a,b) => a.name.localeCompare(b.name));
    if (missions.length > 1000) throw Error("mission count exceeds 1000");
    for (const mission of missions) {
      const dir = path.join(project.missionsRoot, mission.name);
      const id = readScope(dir);
      const slices = path.join(dir, "slices");
      if (!fs.existsSync(slices)) continue;
      insideProject(project.root, slices);
      const children = fs.readdirSync(slices, { withFileTypes: true }).filter(x => x.isDirectory() || x.isSymbolicLink()).sort((a,b) => a.name.localeCompare(b.name));
      if (children.length + scopes.length > 1000) throw Error("scope count exceeds 1000");
      for (const child of children) readScope(path.join(slices, child.name), id);
    }
  } catch (error) { unavailable.push(error instanceof Error ? error.message : "scope sources unavailable"); }
  const names = db.prepare(`SELECT DISTINCT b.tmux_session AS session FROM bindings b JOIN nodes n ON n.id=b.node_id WHERE n.rig_id=? ORDER BY session LIMIT 1001`).all(occupant.rigId) as {session: string}[];
  const roster = names.flatMap(x => { const row = classifierOccupant(db, x.session); return row ? [row] : []; });
  if (names.length > 1000) unavailable.push("roster exceeds 1000");
  const recent = stream.list({ limit: 100, direction: "latest" }).map(item => ({
    streamItemId: item.streamItemId, body: item.body.slice(0, 2000), bodyTruncated: item.body.length > 2000, sourceSession: item.sourceSession,
    evidenceRef: `stream:${item.streamItemId}:${sourceHash(item.body)}`,
  }));
  const sources = { project: { id: project.id, root: project.root, missionsRoot: project.missionsRoot, files: projectSources }, scopes, rosterSource: "bindings + running sessions + latest occupant_tenures in the classifier rig", roster: roster.slice(0,1000), recent };
  // Versioned on its own so open-work churn can't stale the `version` that occupant-written decisions bind to.
  // A failure here leaves the other sources usable; the decisions consumer then defers to intake.
  let routing: ReturnType<typeof routingCandidates> | null = null, routingUnavailable: string | null = null;
  try { routing = routingCandidates(db, occupant.rigId); } catch (error) { routingUnavailable = error instanceof Error ? error.message : "routing candidates unavailable"; }
  return { occupant, observedAt, version: sourceHash(JSON.stringify({sources, unavailable})), sources, unavailable,
    duplicateCoverage: "Most recent 100 nonarchived items; a retrieval miss is unknown, not no duplicate.",
    routing, routingVersion: routing ? sourceHash(JSON.stringify(routing)) : null, routingUnavailable };
}

/** Routing candidates for the decisions consumer: the rig's seats, running or not (running occupants alone
 *  aren't the ownership registry), and the open work they hold, newest first. Past a cap is unknown, not absent. */
export function routingCandidates(db: Database.Database, rigId: string) {
  const seats = db.prepare(`SELECT b.tmux_session AS session, n.logical_id AS logicalId, n.role AS role FROM nodes n JOIN bindings b ON b.node_id=n.id
    WHERE n.rig_id=? AND b.tmux_session IS NOT NULL ORDER BY b.tmux_session LIMIT 201`).all(rigId) as {session: string; logicalId: string; role: string | null}[];
  const owners = seats.slice(0, 200);
  const open = owners.length ? db.prepare(`SELECT qitem_id AS qitemId, destination_session AS destination, state, summary, substr(body,1,160) AS excerpt
    FROM queue_items WHERE state IN ('pending','in-progress','blocked') AND destination_session IN (${owners.map(() => "?").join(",")})
    ORDER BY ts_updated DESC, qitem_id DESC LIMIT 31`).all(...owners.map(x => x.session)) as {qitemId: string; destination: string; state: string; summary: string | null; excerpt: string}[] : [];
  return { ownersSource: "nodes with bindings in the classifier rig, running or not", owners, ownersTruncated: seats.length > 200,
    workSource: "open queue rows those seats hold, newest 30",
    work: open.slice(0, 30).map(({excerpt, ...row}) => ({...row, summary: (row.summary ?? excerpt).slice(0, 160)})), workTruncated: open.length > 30 };
}

function readBounded(file: string, limit: number): string {
  const fd = fs.openSync(file, "r");
  try {
    if (!fs.fstatSync(fd).isFile()) throw Error(`not a regular source file: ${file}`);
    const bytes = Buffer.alloc(limit + 1);
    let used = 0, count = 0;
    while (used < bytes.length && (count = fs.readSync(fd, bytes, used, bytes.length - used, null))) used += count;
    if (used > limit) throw Error(`source byte limit: ${file}`);
    return bytes.subarray(0, used).toString("utf8");
  } finally { fs.closeSync(fd); }
}
