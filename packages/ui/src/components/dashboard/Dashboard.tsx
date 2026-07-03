// OPR.0.4.1.14 — Dashboard route visual refresh (founder-LOCKED fidelity twin).
//
// A pure visual refresh of the welcome/home LAUNCHER surface. No behaviour
// change: the same six destinations route to the same paths, and the global
// AppShell header + left rail are untouched (the twin's "header + sidebar =
// keep as-is" is that shell chrome). The big-numeral vellum card wall is
// replaced by the disciplined paper-draft launcher grid + Field Environment
// readout + drafting footer of the locked twin
// (digital-twin/opr-0.4.1.14/dashboard-fidelity.intent.html), built with the
// founder-ratified existing-code glyph set.
//
// Real-data wiring — every Field Environment row reads live runtime state
// (OPR.0.4.1.14 functional refinement; no placeholder rows):
//   useRigSummary    → RIGS count                (REAL, own line)
//   usePsEntries     → AGENTS count              (REAL, own line)
//   window.location.hostname → STATION ID        (REAL)
//   useSettings(agents.operator_session) → OPERATOR ID, with an honest
//     "OPERATOR" fallback when unset (best-available identity: there is no
//     per-user identity and /api/whoami needs a session param a browser
//     cannot supply — see the slice handoff note).
//   useDaemonVersion → VERSION                   (REAL running daemon version,
//     via /api/health-summary/version; NOT the UI bundle's build-time version).
// The earlier placeholder SESSION row and decorative DECLINATION flourish were
// dropped so the card shows only real runtime data.

import "./dashboard-fidelity.css";

import { Link } from "@tanstack/react-router";
import { useRigSummary } from "../../hooks/useRigSummary.js";
import { usePsEntries } from "../../hooks/usePsEntries.js";
import { useSettings } from "../../hooks/useSettings.js";
import { useDaemonVersion } from "../../hooks/useDaemonVersion.js";
import { KernelStatusCard } from "../KernelStatusCard.js";
import { ErrorBoundary } from "../ui/ErrorBoundary.js";
import {
  TopologyGlyph,
  ProjectGlyph,
  ForYouGlyph,
  LibraryGlyph,
  SearchGlyph,
  SettingsGlyph,
  FieldGlobeGlyph,
  CaptionGlyph,
  type CaptionGlyphKind,
} from "./vellum/fidelity-glyphs.js";

interface Destination {
  num: string;
  to: string;
  label: string;
  caption: string;
  glyph: React.ReactNode;
  captionGlyph: CaptionGlyphKind;
  /** FOR YOU is the single amber-accented caption (prioritized-for-you). */
  amber?: boolean;
}

// Routes + order are UNCHANGED from the prior dashboard (no behaviour change).
const DESTINATIONS: Destination[] = [
  { num: "01", to: "/topology", label: "TOPOLOGY", caption: "VIEW RIG GRAPH", glyph: <TopologyGlyph />, captionGlyph: "cross" },
  { num: "02", to: "/project", label: "PROJECT", caption: "BROWSE PROJECTS", glyph: <ProjectGlyph />, captionGlyph: "square" },
  { num: "03", to: "/for-you", label: "FOR YOU", caption: "PRIORITIZED FOR YOU", glyph: <ForYouGlyph />, captionGlyph: "square", amber: true },
  { num: "04", to: "/specs", label: "LIBRARY", caption: "SPECS & ARTIFACTS", glyph: <LibraryGlyph />, captionGlyph: "cross" },
  { num: "05", to: "/search", label: "SEARCH & AUDIT", caption: "FIND & VERIFY", glyph: <SearchGlyph />, captionGlyph: "circle" },
  { num: "06", to: "/settings", label: "SETTINGS", caption: "CONFIGURE · STATUS", glyph: <SettingsGlyph />, captionGlyph: "circle" },
];

function pad2(n: number): string {
  return String(Math.max(0, n)).padStart(2, "0");
}

/** Read a string ConfigStore setting from the useSettings payload. */
function readSetting(
  data: { settings?: Record<string, { value?: unknown }> } | undefined,
  key: string,
): string {
  const v = data?.settings?.[key]?.value;
  return typeof v === "string" ? v : "";
}

export function Dashboard() {
  const { data: rigs } = useRigSummary();
  const { data: psEntries, isError: psError } = usePsEntries();
  const { data: settings } = useSettings();
  const { data: versionData } = useDaemonVersion();

  const totalRigs = rigs?.length ?? 0;
  const totalAgents = psEntries?.reduce((acc, p) => acc + p.nodeCount, 0) ?? 0;

  const hostname =
    typeof window === "undefined" ? "localhost" : window.location.hostname || "localhost";
  const station = hostname.toUpperCase();
  const online = !psError && psEntries !== undefined;

  // Operator identity from the configured operator seat (logicalId@rigId), with
  // an honest "OPERATOR" fallback when unset — the best-available real source.
  const operatorSession = readSetting(settings, "agents.operator_session");
  const at = operatorSession.indexOf("@");
  const operatorId =
    at > 0 ? operatorSession.slice(0, at).toUpperCase() : "OPERATOR";

  // Running daemon version (real, via useDaemonVersion). Honest em-dash fallback
  // while the query is loading or on a fetch failure; the daemon itself already
  // returns "unknown" if it cannot read its own package.json.
  const version = (versionData?.version ?? "").toUpperCase() || "—";

  return (
    <div data-testid="dashboard-surface" className="df-root">
      <div className="df-main">
        <div className="df-head">
          <div className="df-eyebrow">
            <span className="df-eyebrow-l">
              <span className="df-gd" aria-hidden="true" />
              OPERATOR
            </span>
            <span className="df-eyebrow-r">DASHBOARD · LAUNCHER · CONFIGSTORE-BACKED</span>
          </div>

          <h1 data-testid="dashboard-greeting" className="df-h1">
            Welcome back, operator.
          </h1>
          <div className="df-sub">
            STATION {station} IS <b>[ {online ? "ONLINE" : "CONNECTING"} ]</b>
          </div>

          <FieldEnvironment
            station={station}
            operatorId={operatorId}
            rigs={totalRigs}
            agents={totalAgents}
            version={version}
          />
          <div className="df-reg" aria-hidden="true" />
        </div>

        {/* OPR.0.4.3.22 — kernel status FIRST (from /api/kernel/status, NEVER
            daemon /healthz), with a Restore-kernel recovery control. */}
        <section data-testid="dashboard-kernel-section" className="mb-6 max-w-md">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-secondary mb-2">
            Host / kernel
          </div>
          <ErrorBoundary label="Kernel status">
            <KernelStatusCard />
          </ErrorBoundary>
        </section>

        <div className="df-grid" data-testid="dashboard-launcher-grid">
          {DESTINATIONS.map((d) => (
            <LauncherCard key={d.num} dest={d} />
          ))}
        </div>
      </div>

      <DashboardFooter />
    </div>
  );
}

interface FieldEnvironmentProps {
  station: string;
  operatorId: string;
  rigs: number;
  agents: number;
  version: string;
}

function FieldEnvironment({
  station,
  operatorId,
  rigs,
  agents,
  version,
}: FieldEnvironmentProps) {
  // Every row is REAL runtime data (OPR.0.4.1.14): the placeholder SESSION and
  // decorative DECLINATION rows were dropped; RIGS and AGENTS are split onto
  // their own lines as single live counts; VERSION is the running daemon
  // version. The vintage mono / dotted-leader treatment is unchanged.
  const rows: Array<{ k: string; v: string }> = [
    { k: "STATION ID", v: station },
    { k: "OPERATOR ID", v: operatorId },
    { k: "RIGS", v: pad2(rigs) },
    { k: "AGENTS", v: pad2(agents) },
    { k: "VERSION", v: version },
  ];
  return (
    <section
      data-testid="dashboard-field-environment"
      className="df-fieldenv"
      aria-label="Field environment"
    >
      <div className="df-feh">
        <span>FIELD ENVIRONMENT</span>
        <span className="df-feh-mark" aria-hidden="true" />
      </div>
      <div className="df-fe-body">
        <div className="df-fe-list">
          {rows.map((r) => (
            <div className="df-fe-row" key={r.k}>
              <span className="df-k">{r.k}</span>
              <span className="df-dots" aria-hidden="true" />
              <span className="df-v">{r.v}</span>
            </div>
          ))}
        </div>
        <div className="df-fe-globe" aria-hidden="true">
          <FieldGlobeGlyph />
        </div>
      </div>
    </section>
  );
}

function LauncherCard({ dest }: { dest: Destination }) {
  return (
    <div className="df-cell">
      <Link
        to={dest.to}
        data-testid={`dashboard-card-${dest.num}`}
        aria-label={dest.label}
        className="df-card"
      >
        <span className="df-plus" aria-hidden="true" />
        <span className="df-idx">
          {dest.num} <i className="df-idx-sq" aria-hidden="true" />
        </span>
        <span className="df-glyph" aria-hidden="true">
          {dest.glyph}
        </span>
        <span className="df-clabel">{dest.label}</span>
        <span className="df-half" aria-hidden="true" />
        <span className="df-crop" aria-hidden="true">
          <i className="df-crop-tl" />
          <i className="df-crop-br" />
        </span>
      </Link>
      <div className={`df-cap${dest.amber ? " df-cap--amber" : ""}`}>
        <span className="df-cap-glyph" aria-hidden="true">
          <CaptionGlyph kind={dest.captionGlyph} />
        </span>
        <span className="df-lead" aria-hidden="true" />
        {dest.caption}
      </div>
    </div>
  );
}

function DashboardFooter() {
  // Semi-random drafting "artifacts" — fixed scatter (deterministic so the
  // surface is stable across renders), per the locked twin.
  const arts: Array<{ left: number; top: number; w: number; h: number }> = [
    { left: 6, top: 14, w: 4, h: 1 },
    { left: 16, top: 9, w: 1, h: 1 },
    { left: 24, top: 16, w: 3, h: 1 },
    { left: 34, top: 6, w: 1, h: 1 },
    { left: 30, top: 13, w: 1, h: 1 },
    { left: 46, top: 11, w: 5, h: 1 },
    { left: 58, top: 7, w: 1, h: 1 },
    { left: 66, top: 15, w: 2, h: 1 },
    { left: 78, top: 10, w: 1, h: 1 },
    { left: 90, top: 13, w: 4, h: 1 },
  ];
  return (
    <div className="df-foot" data-testid="dashboard-footer">
      <div className="df-foot-fl">
        <span className="df-foot-sq" aria-hidden="true" />
        [ LOG ] .0001 · A SOLO BUILD, DELIBERATE, YEAR OVER YEAR
      </div>
      <span className="df-plus2" aria-hidden="true" />
      <span className="df-foot-dots" aria-hidden="true" />
      <div className="df-dissolve" aria-hidden="true">
        <span className="df-dissolve-blk" />
      </div>
      <div className="df-arts" aria-hidden="true">
        {arts.map((a, i) => (
          <i
            key={i}
            style={{ left: `${a.left}px`, top: `${a.top}px`, width: `${a.w}px`, height: `${a.h}px` }}
          />
        ))}
      </div>
      <div className="df-sqs" aria-hidden="true">
        <span className="df-sq-o" />
        <span className="df-sq-b" />
      </div>
      <span className="df-plus2" aria-hidden="true" />
    </div>
  );
}
