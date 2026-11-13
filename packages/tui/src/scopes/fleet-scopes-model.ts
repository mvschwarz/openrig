import { sectionRule, listItem, wrapDetailLines, type ContentLine } from "../detail.js";
import type { Action, FleetSnapshot, ViewState } from "../types.js";
import { scopesContentLines, sliceGlyph, type SliceScopeSnap } from "./scopes-model.js";

// #3093 first increment — the FLEET PROJECTS view: every registered host's Projects rows as
// this daemon's GET /api/fleet/scopes served them. Each row keeps its origin host, host
// label, project context and native ids (composite identity: identical native ids on two
// hosts are two rows and never collapse). This view renders what the daemon read — it
// aggregates nothing itself, writes nothing, and never re-times a host's rows. The local
// Projects pane is unchanged.

export interface FleetHostStatusRow {
  hostId: string;
  status: string;
  observedAt: string;
  lastSuccessAt: string | null;
  error?: string;
}

export interface FleetSliceRow {
  hostId: string;
  hostLabel: string;
  project: string | null;
  mission: string;
  dirName: string;
  id: string | null;
  displayName: string;
  status: string | null;
  stage: string | null;
  locks: { spec: { by: string; at: string } | null; delivery: { by: string; at: string } | null };
  error?: string;
}

export interface FleetMissionRow {
  hostId: string;
  hostLabel: string;
  project: string | null;
  mission: string;
  error?: string;
  slices: FleetSliceRow[];
}

export interface FleetScopesView {
  missions: FleetMissionRow[];
  hosts: FleetHostStatusRow[];
  skipped?: Array<{ hostId: string; reason: string }>;
  registry?: { state: string; error?: string };
  observedAt: string;
}

/** A fleet slice's detail as read from its ORIGIN host through the daemon's
 *  read-through (GET /api/scopes/slice?host=…), or why it couldn't be read. */
export type FleetSliceDetailRead = { detail: SliceScopeSnap } | { error: string };

export interface FleetScopesRead {
  /** The served view, or why it couldn't be read (status null: no HTTP answer). */
  status: { view: FleetScopesView } | { status: number | null; error: string };
}

export const FLEET_SCOPES_HEADER = "projects on every registered host, as this daemon read them";
export const FLEET_SCOPES_HINT = "Eventually consistent · each host's rows as that host served them · no cross-host snapshot · writes stay on the origin host";

const STATUS_LABEL: Record<string, string> = {
  ok: "answered",
  stale: "STALE — last-known rows below, read failed",
  unreachable: "unreachable",
  "auth-failed": "auth failed",
  unsupported: "unsupported (the remote daemon does not serve the scopes read)",
  "unsupported-transport": "unsupported (SSH-declared entry; needs an http-transport entry)",
};

function timeOf(iso: string | null | undefined): string {
  if (!iso) return "never";
  return iso.replace("T", " ").replace(/(\.\d+)?Z$/, "Z");
}

function hostLines(h: FleetHostStatusRow): ContentLine[] {
  const label = STATUS_LABEL[h.status] ?? h.status;
  const times = `observed ${timeOf(h.observedAt)} · last success ${timeOf(h.lastSuccessAt)}`;
  const line = { text: `  ${h.hostId}  ${label} · ${times}` };
  return h.error ? [line, { text: `    ! ${h.error}` }] : [line];
}

/** A fleet slice row rendered with the local pane's glyph vocabulary — the row's
 *  identity is composite: host, mission, then the native slice id. */
function fleetSliceLine(s: FleetSliceRow): ContentLine {
  const identity = `${s.id ?? s.dirName} · ${s.mission}@${s.hostId}`;
  return listItem(`${sliceGlyph(s as unknown as SliceScopeSnap)} ${s.displayName} · ${identity}${s.error ? " · source unavailable" : ""}`, { type: "fleet-slice-open", hostId: s.hostId, mission: s.mission, slice: s.dirName } satisfies Action, 4);
}

export function fleetScopesLines(state: ViewState, snap: FleetSnapshot, width: number): ContentLine[] {
  const lines: ContentLine[] = [
    { text: "Projects · all hosts" },
    { text: `  ${FLEET_SCOPES_HEADER}` },
    { text: `  ${FLEET_SCOPES_HINT}` },
  ];
  const read = snap.fleetScopes;
  if (!read) return wrapDetailLines([...lines, { text: "" }, { text: "  Not read yet." }], width);
  if (!("view" in read.status)) {
    const failure = read.status;
    return wrapDetailLines([...lines, { text: "" }, {
      text: failure.status === 404
        ? "  This daemon doesn't serve the fleet Projects view (HTTP 404)."
        : `  Fleet Projects unavailable: ${failure.error}. Nothing is inferred from the missing read.`,
    }], width);
  }
  const view = read.status.view;
  lines.push({ text: `  observed ${timeOf(view.observedAt)}` });
  if (view.registry && view.registry.state !== "read") lines.push({ text: `  ! host registry unreadable: ${view.registry.error ?? "unknown error"} — only this daemon's rows are shown` });
  lines.push(sectionRule("Hosts · every registered host on every read", width));
  for (const h of view.hosts) lines.push(...hostLines(h));
  for (const s of view.skipped ?? []) lines.push({ text: `  ${s.hostId}  skipped: ${s.reason}` });
  lines.push(sectionRule("Missions · grouped by origin host; native ids as each host served them", width));
  if (view.missions.length === 0) lines.push({ text: "  No missions served from any host." });

  const sel = state.fleetSelected;
  for (const host of view.hosts) {
    const missions = view.missions.filter(m => m.hostId === host.hostId);
    if (host.status === "ok" && missions.length === 0) continue;
    lines.push({ text: `  ${host.hostId}${host.status !== "ok" ? ` · ${host.status.toUpperCase()}` : ""}${missions[0]?.project ? ` · project ${missions[0]!.project}` : ""}` });
    for (const m of missions) {
      if (m.error) { lines.push({ text: `    ${m.mission} · source unavailable: ${m.error}` }); continue; }
      lines.push({ text: `    ${m.mission}${m.slices.length === 0 ? " · no slices" : ""}` });
      for (const s of m.slices) lines.push(fleetSliceLine(s));
    }
  }

  // The DETAIL keeps its origin host: the composite identity opens the read, and the
  // origin line names the host, project context and native id explicitly.
  if (sel) {
    const origin = view.missions.find(m => m.hostId === sel.hostId && m.mission === sel.mission);
    lines.push(sectionRule("Slice detail", width));
    lines.push({ text: `  origin ${sel.hostId} · project ${origin?.project ?? "workspace"} · mission ${sel.mission} · slice ${sel.slice}` });
    const detail = snap.fleetSliceDetail;
    if (!detail) lines.push({ text: "  Reading the slice detail from its origin host…" });
    else if ("error" in detail) lines.push({ text: `  ! detail unavailable from ${sel.hostId}: ${detail.error}` });
    else lines.push(...scopesContentLines(detail.detail, sel.mission, {
      collapseReqs: state.scopesCollapseReqs,
      narrative: false,
      width,
    }));
  }
  return wrapDetailLines(lines, width);
}
