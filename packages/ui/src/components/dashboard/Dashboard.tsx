// C10: Dashboard v2 — "what's running, and what needs you."
//
// Replaces the OPR.0.4.1.14 paper-draft launcher surface (destination cards
// with drawings, field-environment box, drafting footer). The vellum files
// under components/dashboard/vellum/ stay for /lab/vellum-lab; this component
// just stops rendering them.

import * as Collapsible from "@radix-ui/react-collapsible";
import { Link } from "@tanstack/react-router";
import { PageHeader } from "../ui/page-header.js";
import { Button } from "../ui/button.js";
import { EmptyState } from "../ui/empty-state.js";
import { MetricTile } from "../ui/metric-tile.js";
import { StatusBadge, StatusDot } from "../ui/status-badge.js";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../ui/table.js";
import { ErrorBoundary } from "../ui/ErrorBoundary.js";
import { relativeTime } from "../../lib/relative-time.js";
import { daemonStatus } from "../../lib/daemon-status.js";
import { usePsEntries } from "../../hooks/usePsEntries.js";
import { useAttentionItems } from "../../hooks/useAttentionItems.js";
import { useFeedSubscriptions } from "../../hooks/useFeedSubscriptions.js";
import { useDaemonHealth } from "../../hooks/useDaemonHealth.js";
import { useActivityFeed } from "../../hooks/useActivityFeed.js";
import { VerbActions } from "../mission-control/components/VerbActions.js";
import { GettingStarted } from "./GettingStarted.js";
import { KernelStatusCard } from "../KernelStatusCard.js";
import { HostConfigCard } from "./HostConfigCard.js";

/** `rig.started` -> "Rig started" (fallback: the raw type). */
function humanizeEventType(type: string): string {
  return type
    .split(".")
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function NeedsYou() {
  const { anyRemoteEnabled } = useFeedSubscriptions();
  const attention = useAttentionItems(50, anyRemoteEnabled);
  const items = (attention.data?.items ?? []).slice(0, 5);
  return (
    <section data-testid="dashboard-needs-you" aria-label="Needs you">
      <h2 className="text-sm font-semibold text-on-surface">Needs you</h2>
      {items.length === 0 ? (
        <EmptyState
          title="You're all caught up"
          label="Nothing needs you"
          description="Approvals and questions from your agents show up here."
        />
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {items.map((item) => (
            <li
              key={item.qitemId}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-surface-lowest px-3 py-2 shadow-sm"
            >
              <StatusDot status="attention_required" />
              <span className="min-w-0 flex-1 text-sm text-on-surface">
                {item.summary ?? item.body.split("\n")[0]}
              </span>
              <span className="font-mono text-xs text-on-surface-variant">{item.sourceSession}</span>
              <span className="text-xs text-on-surface-variant">{relativeTime(item.tsUpdated)}</span>
              <VerbActions
                bare
                qitemId={item.qitemId}
                actorSession="human@host"
                hostId={item.hostId}
                enabledVerbs={["approve"]}
                oneClickVerbs={["approve"]}
              />
            </li>
          ))}
        </ul>
      )}
      <Link to="/for-you" className="mt-2 inline-block text-sm text-brand hover:underline">
        Open inbox
      </Link>
    </section>
  );
}

function MetricTiles({ attentionCount }: { attentionCount: number }) {
  const { data: ps } = usePsEntries();
  const { query, signal } = useDaemonHealth();
  const rigsRunning = (ps ?? []).filter((r) => r.status !== "stopped").length;
  const rigsTotal = (ps ?? []).length;
  const activeAgents = (ps ?? []).reduce((acc, r) => acc + (r.activeCount ?? 0), 0);
  const aliveAgents = (ps ?? []).reduce((acc, r) => acc + r.runningCount, 0);
  const daemon = daemonStatus(query, signal);
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <MetricTile label="Rigs running" value={rigsRunning} sublabel={`${rigsTotal} total`} to="/topology" testId="dashboard-tile-rigs" />
      <MetricTile label="Active agents" value={activeAgents} sublabel={`${aliveAgents} alive`} to="/agents" testId="dashboard-tile-agents" />
      <MetricTile label="Needs you" value={attentionCount} sublabel="approvals and questions" to="/for-you" testId="dashboard-tile-needs-you" />
      <MetricTile
        label="Daemon"
        value={<StatusBadge status={daemon.status} label={daemon.label} />}
        sublabel="control plane"
        to="/settings/status"
        testId="dashboard-tile-daemon"
      />
    </div>
  );
}

function RigsTable() {
  const { data: ps } = usePsEntries();
  const rows = ps ?? [];
  if (rows.length === 0) {
    return (
      <section data-testid="dashboard-rigs" aria-label="Rigs">
        <h2 className="text-sm font-semibold text-on-surface">Rigs</h2>
        <EmptyState
          title="No rigs yet"
          label="No rigs yet"
          description="A rig is a team of agents defined by a spec. Create one from the Library or import an existing one."
          action={{ label: "New rig", href: "/specs/rig" }}
        />
      </section>
    );
  }
  return (
    <section data-testid="dashboard-rigs" aria-label="Rigs">
      <h2 className="text-sm font-semibold text-on-surface">Rigs</h2>
      <div className="mt-2">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Agents</TableHead>
              <TableHead>Has work</TableHead>
              <TableHead>Uptime</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.rigId}>
                <TableCell>
                  <Link to="/topology/rig/$rigId" params={{ rigId: r.rigId }} className="text-brand hover:underline">
                    {r.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <StatusBadge status={r.lifecycleState ?? r.status} />
                </TableCell>
                <TableCell>
                  {r.activeCount ?? 0}/{r.nodeCount}
                </TableCell>
                <TableCell>{r.hasWorkCount ?? 0}</TableCell>
                <TableCell className="font-mono text-xs">{r.uptime ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function RecentActivity() {
  const { events } = useActivityFeed();
  const last = events.slice(0, 10);
  return (
    <section data-testid="dashboard-activity" aria-label="Recent activity">
      <h2 className="text-sm font-semibold text-on-surface">Recent activity</h2>
      {last.length === 0 ? (
        <p className="mt-2 text-sm text-on-surface-variant">No activity yet.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1">
          {last.map((e) => {
            const rig = typeof e.payload["rigId"] === "string" ? (e.payload["rigId"] as string) : null;
            const session = typeof e.payload["session"] === "string" ? (e.payload["session"] as string) : null;
            return (
              <li key={e.seq} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="text-xs text-on-surface-variant">{relativeTime(e.createdAt)}</span>
                <span className="text-on-surface">{humanizeEventType(e.type)}</span>
                {rig ? <span className="font-mono text-xs text-on-surface-variant">{rig}</span> : null}
                {session ? <span className="font-mono text-xs text-on-surface-variant">{session}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function Dashboard() {
  const { anyRemoteEnabled } = useFeedSubscriptions();
  const attention = useAttentionItems(50, anyRemoteEnabled);
  const attentionCount = attention.data?.items.length ?? 0;
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <PageHeader
        title="Dashboard"
        description="What's running, and what needs you."
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/import">Import</Link>
            </Button>
            <Button asChild>
              <Link to="/specs/rig">New rig</Link>
            </Button>
          </>
        }
      />
      <div className="flex flex-col gap-8">
        <GettingStarted />
        <NeedsYou />
        <MetricTiles attentionCount={attentionCount} />
        <RigsTable />
        <RecentActivity />
        <Collapsible.Root defaultOpen={false}>
          <section data-testid="dashboard-host-section" aria-label="Host">
            <Collapsible.Trigger className="text-sm font-semibold text-on-surface">
              Host
            </Collapsible.Trigger>
            <Collapsible.Content>
              <div className="mt-2 flex flex-col gap-4">
                <ErrorBoundary label="Kernel status">
                  <KernelStatusCard />
                </ErrorBoundary>
                <ErrorBoundary label="Hosts">
                  <HostConfigCard />
                </ErrorBoundary>
              </div>
            </Collapsible.Content>
          </section>
        </Collapsible.Root>
      </div>
    </div>
  );
}
