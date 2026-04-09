import { useState } from "react";
import { useRigSummary, type RigSummary } from "../hooks/useRigSummary.js";
import { usePsEntries, type PsEntry } from "../hooks/usePsEntries.js";
import { useNodeInventory } from "../hooks/useNodeInventory.js";
import { useSnapshots } from "../hooks/useSnapshots.js";
import { RestoreError, useCreateSnapshot, useRestoreSnapshot, useStartRig, useTeardownRig, useExpandRig, type ExpandRigResult } from "../hooks/mutations.js";
import { getRestoreStatusColorClass } from "../lib/restore-status-colors.js";
import { shortId } from "../lib/display-id.js";
import { displayAgentName, displayPodName, inferPodName } from "../lib/display-name.js";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { RigChatPanel } from "./RigChatPanel.js";
import { RigEnvPanel } from "./RigEnvPanel.js";
import { ExpansionOutcome } from "./ExpansionOutcome.js";
import { useRigEnv } from "../hooks/useRigEnv.js";

interface RestoreNodeResult {
  nodeId: string;
  logicalId: string;
  status: string;
  error?: string;
}

interface RigDetailPanelProps {
  rigId: string;
  onClose: () => void;
}

function formatSnapshotAge(timestamp: string | null): string {
  if (!timestamp) return "No snapshots";
  const age = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.floor(age / 60000);
  if (minutes < 1) return "< 1m ago";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatRestoreError(err: Error, rigName: string): string {
  if (err instanceof RestoreError && err.code === "rig_not_stopped") {
    return `Stop ${rigName} before restoring. Run rig down ${rigName} and retry.`;
  }

  return err.message;
}

function formatNodeSummary(ps: PsEntry | undefined, summary: RigSummary | undefined): string {
  if (ps) {
    return `${ps.runningCount}/${ps.nodeCount} running`;
  }

  return `${summary?.nodeCount ?? 0} total`;
}

export function RigDetailPanel({ rigId, onClose }: RigDetailPanelProps) {
  const { data: summaries } = useRigSummary();
  const { data: psEntries } = usePsEntries();
  const { data: rawNodeInventory, isPending: nodesLoading } = useNodeInventory(rigId);
  const { data: snapshots = [], isPending: snapshotsLoading, error: snapshotsFetchError } = useSnapshots(rigId);
  const createSnapshot = useCreateSnapshot(rigId);
  const restoreSnapshot = useRestoreSnapshot(rigId);
  const startRig = useStartRig(rigId);
  const teardownRig = useTeardownRig(rigId);

  const { data: envData } = useRigEnv(rigId);
  const hasEnv = envData?.hasServices === true;

  const [activeTab, setActiveTab] = useState<"info" | "env" | "chat">("info");
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [confirmDown, setConfirmDown] = useState(false);
  const [showSnapshotHistory, setShowSnapshotHistory] = useState(false);
  const [restoreResult, setRestoreResult] = useState<RestoreNodeResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showAddPod, setShowAddPod] = useState(false);
  const [podYaml, setPodYaml] = useState("");
  const [expandResult, setExpandResult] = useState<ExpandRigResult | null>(null);
  const expandRig = useExpandRig();

  const summary: RigSummary | undefined = summaries?.find((s) => s.id === rigId);
  const ps: PsEntry | undefined = psEntries?.find((p) => p.rigId === rigId);
  const nodeInventory = Array.isArray(rawNodeInventory) ? rawNodeInventory : [];
  const pods = Array.from(
    nodeInventory.reduce((map, node) => {
      const key = node.podId ?? "__ungrouped__";
      const group = map.get(key) ?? [];
      group.push(node);
      map.set(key, group);
      return map;
    }, new Map<string, typeof nodeInventory>())
  );
  const orderedSnapshots = [...snapshots].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  const latestSnapshot = orderedSnapshots[0] ?? null;
  const olderSnapshots = orderedSnapshots.slice(1);
  const latestSnapshotTail = latestSnapshot ? shortId(latestSnapshot.id) : null;
  const rigIdTail = shortId(rigId);
  const rigIdHead = rigId.slice(0, Math.max(0, rigId.length - rigIdTail.length));
  const rigStatus = ps?.status ?? "stopped";

  const handleCreate = () => {
    setError(null);
    setActionError(null);
    createSnapshot.mutate(undefined, {
      onError: (err) => setActionError(err.message),
    });
  };

  const handleRestore = (snapshotId: string) => {
    setError(null);
    setRestoreResult(null);
    restoreSnapshot.mutate(snapshotId, {
      onSuccess: (data) => {
        setRestoreResult((data as { nodes?: RestoreNodeResult[] }).nodes ?? []);
        setConfirmRestore(null);
      },
      onError: (err) => {
        setError(formatRestoreError(err, summary?.name ?? rigId));
        setConfirmRestore(null);
      },
    });
  };

  const handleExport = async () => {
    setActionError(null);
    try {
      const res = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/spec`);
      if (!res.ok) {
        setActionError(`Export failed (HTTP ${res.status})`);
        return;
      }

      const yaml = await res.text();
      const blob = new Blob([yaml], { type: "text/yaml" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${summary?.name ?? rigId}.yaml`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Export failed");
    }
  };

  const handleStart = () => {
    setActionError(null);
    startRig.mutate(undefined, {
      onError: (err) => setActionError(err.message),
    });
  };

  const handleTeardown = () => {
    setActionError(null);
    teardownRig.mutate(undefined, {
      onSuccess: () => setConfirmDown(false),
      onError: (err) => setActionError(err.message),
    });
  };

  return (
    <aside
      data-testid="rig-detail-panel"
      className="absolute inset-y-0 right-0 z-20 w-80 border-l border-stone-300/25 bg-[rgba(250,249,245,0.035)] supports-[backdrop-filter]:bg-[rgba(250,249,245,0.018)] backdrop-blur-[14px] backdrop-saturate-75 shadow-[-6px_0_14px_rgba(46,52,46,0.04)] flex flex-col overflow-hidden"
    >
      {/* Header */}
      <div className="flex justify-between items-center px-4 py-3 border-b border-stone-300/35 shrink-0">
        <h2 className="min-w-0 font-mono text-xs font-bold text-stone-900 truncate">{summary?.name ?? rigId}</h2>
        <button
          data-testid="close-drawer"
          onClick={onClose}
          className="text-stone-400 hover:text-stone-900 text-sm"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-stone-300/35 shrink-0" data-testid="drawer-tabs">
        <button
          data-testid="tab-info"
          onClick={() => setActiveTab("info")}
          className={`flex-1 py-2 text-xs font-mono uppercase text-center ${activeTab === "info" ? "border-b-2 border-stone-800 font-bold" : "text-stone-400"}`}
        >
          Info
        </button>
        {hasEnv && (
          <button
            data-testid="tab-env"
            onClick={() => setActiveTab("env")}
            className={`flex-1 py-2 text-xs font-mono uppercase text-center ${activeTab === "env" ? "border-b-2 border-stone-800 font-bold" : "text-stone-400"}`}
          >
            Env
          </button>
        )}
        <button
          data-testid="tab-chat"
          onClick={() => setActiveTab("chat")}
          className={`flex-1 py-2 text-xs font-mono uppercase text-center ${activeTab === "chat" ? "border-b-2 border-stone-800 font-bold" : "text-stone-400"}`}
        >
          Chat Room
        </button>
      </div>

      {activeTab === "chat" ? (
        <RigChatPanel rigId={rigId} />
      ) : activeTab === "env" && hasEnv && envData ? (
        <RigEnvPanel rigId={rigId} envData={envData} />
      ) : (
      <div className="flex-1 overflow-y-auto">
      {/* Identity */}
      <section className="px-4 py-3 border-b border-stone-100">
        <div>
          <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-2">Identity</div>
          <div className="space-y-1 font-mono text-[10px]">
            <div className="flex justify-between gap-3">
              <span className="text-stone-500">ID</span>
              <span data-testid="rig-id-value" className="min-w-0 truncate text-stone-900">
                {rigIdHead && <span className="text-stone-500">{rigIdHead}</span>}
                <span data-testid="rig-id-tail" className="font-bold">{rigIdTail}</span>
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Status */}
      <section className="px-4 py-3 border-b border-stone-100">
        <div>
          <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-2">Status</div>
          <div className="space-y-1 font-mono text-[10px]">
            <div className="flex justify-between"><span className="text-stone-500">Nodes</span><span>{formatNodeSummary(ps, summary)}</span></div>
            <div className="flex justify-between"><span className="text-stone-500">Uptime</span><span data-testid="rig-uptime">{ps?.uptime ?? "—"}</span></div>
          </div>
        </div>
      </section>

      {/* Actions */}
      <section className="px-4 py-3 border-b border-stone-100">
        <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-2">Actions</div>
        <div className="flex flex-col gap-1">
          <button
            onClick={handleCreate}
            data-testid="rig-create-snapshot"
            disabled={createSnapshot.isPending}
            className="px-2 py-1 border border-stone-300 font-mono text-[8px] uppercase hover:bg-stone-200 text-left"
          >
            {createSnapshot.isPending ? "Creating..." : "Create snapshot"}
          </button>
          <button onClick={handleExport} data-testid="rig-export-spec" className="px-2 py-1 border border-stone-300 font-mono text-[8px] uppercase hover:bg-stone-200 text-left">
            Export spec
          </button>
          {rigStatus === "running" || rigStatus === "partial" ? (
            <button onClick={() => setConfirmDown(true)} data-testid="rig-power-action" className="px-2 py-1 border border-stone-300 font-mono text-[8px] uppercase hover:bg-stone-200 text-left">
              Turn off
            </button>
          ) : (
            <button onClick={handleStart} data-testid="rig-power-action" disabled={startRig.isPending} className="px-2 py-1 border border-stone-300 font-mono text-[8px] uppercase hover:bg-stone-200 text-left disabled:opacity-50">
              {startRig.isPending ? "Starting..." : "Turn on"}
            </button>
          )}
          <button
            onClick={() => { setShowAddPod(!showAddPod); setExpandResult(null); }}
            data-testid="rig-add-pod"
            className="px-2 py-1 border border-stone-300 font-mono text-[8px] uppercase hover:bg-stone-200 text-left"
          >
            Add pod
          </button>
        </div>
        {actionError && (
          <div data-testid="rig-action-error" className="mt-2 font-mono text-[9px] text-red-700">
            {actionError}
          </div>
        )}
      </section>

      {/* Add Pod form */}
      {showAddPod && (
        <section data-testid="add-pod-form" className="px-4 py-3 border-b border-stone-100">
          <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-2">Add Pod — YAML Fragment</div>
          <textarea
            data-testid="add-pod-yaml"
            className="w-full h-24 font-mono text-[9px] p-2 border border-stone-300 bg-white"
            value={podYaml}
            onChange={(e) => setPodYaml(e.target.value)}
            placeholder={"id: my-pod\nlabel: My Pod\nmembers:\n  - id: worker\n    runtime: terminal\n    agent_ref: \"builtin:terminal\"\nedges: []"}
          />
          <button
            data-testid="add-pod-submit"
            disabled={expandRig.isPending || !podYaml.trim()}
            onClick={async () => {
              setExpandResult(null);
              setActionError(null);
              try {
                const { parse } = await import("yaml");
                const pod = parse(podYaml);
                const result = await expandRig.mutateAsync({ rigId, pod });
                setExpandResult(result);
                if (result.status === "ok") { setShowAddPod(false); setPodYaml(""); }
              } catch (err) {
                setActionError((err as Error).message);
              }
            }}
            className="mt-1 px-2 py-1 border border-stone-300 font-mono text-[8px] uppercase hover:bg-stone-200 disabled:opacity-50"
          >
            {expandRig.isPending ? "Expanding..." : "Expand"}
          </button>
          {expandResult && <ExpansionOutcome result={expandResult} />}
        </section>
      )}

      {/* Pods */}
      <section className="px-4 py-3 border-b border-stone-100">
        <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-2">Pods</div>
        {nodesLoading ? (
          <div className="font-mono text-[9px] text-stone-400">Loading pods...</div>
        ) : pods.length === 0 ? (
          <div className="font-mono text-[9px] text-stone-400">No nodes yet</div>
        ) : (
          <div className="space-y-2">
            {pods.map(([podId, members]) => (
              <div key={podId} className="p-2 bg-stone-50 border border-stone-200">
                <div className="flex items-center justify-between">
                  <div className="font-mono text-[10px] font-bold">{inferPodName(members[0]?.logicalId) ?? displayPodName(podId === "__ungrouped__" ? null : podId)}</div>
                  <div className="font-mono text-[9px] text-stone-400">{members.length}</div>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {members.map((member) => (
                    <span key={member.logicalId} className="font-mono text-[9px] text-stone-700 border border-stone-200 bg-white px-1.5 py-0.5">
                      {displayAgentName(member.logicalId)}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Snapshots */}
      <section className="px-4 py-3">
        <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-3">
          Snapshots ({snapshots.length})
        </div>

        {/* Error */}
        {error && (
          <div data-testid="snapshot-error" className="mb-2 p-2 bg-red-50 border border-red-200 font-mono text-[9px] text-red-700">
            {error}
          </div>
        )}

        {/* Restore result */}
        {restoreResult && (
          <div data-testid="restore-result" className="mb-3 p-2 bg-stone-50 border border-stone-200">
            <div className="font-mono text-[9px] text-stone-500 uppercase mb-1">Restore Complete</div>
            {restoreResult.map((n) => (
              <div key={n.nodeId} className="flex items-center justify-between font-mono text-[10px]">
                <span>{n.logicalId}</span>
                <span className={getRestoreStatusColorClass(n.status)} data-testid={`restore-status-${n.logicalId}`}>
                  {n.status}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Snapshot fetch error */}
        {snapshotsFetchError && (
          <div data-testid="snapshot-fetch-error" className="mb-2 p-2 bg-red-50 border border-red-200 font-mono text-[9px] text-red-700">
            Failed to load snapshots
          </div>
        )}

        {/* Snapshot list */}
        {snapshotsLoading ? (
          <div className="font-mono text-[10px] text-stone-400 py-2 text-center">Loading snapshots...</div>
        ) : snapshots.length === 0 && !snapshotsFetchError ? (
          <div className="font-mono text-[10px] text-stone-400 py-2 text-center italic">
            No snapshots yet
          </div>
        ) : (
          <div className="space-y-1">
            {latestSnapshot && (
              <div className="p-2 bg-stone-50 hover:bg-stone-100 transition-colors">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="font-mono text-[8px] uppercase tracking-[0.12em] text-stone-400">
                      Latest
                    </div>
                    <div className="font-mono text-[10px] font-bold" data-testid={`snap-short-${latestSnapshot.id}`}>
                      {latestSnapshotTail}
                    </div>
                    <div className="font-mono text-[9px] text-stone-400 mt-0.5">
                      {latestSnapshot.kind} · {formatSnapshotAge(latestSnapshot.createdAt)}
                    </div>
                  </div>
                  <button
                    data-testid={`restore-btn-${latestSnapshot.id}`}
                    onClick={() => setConfirmRestore(latestSnapshot.id)}
                    className="font-mono text-[8px] border border-stone-300 px-1 py-0.5 hover:bg-stone-200"
                  >
                    Restore
                  </button>
                </div>
              </div>
            )}

            {olderSnapshots.length > 0 && (
              <div className="border-t border-stone-200 pt-2">
                <button
                  type="button"
                  data-testid="snapshot-history-toggle"
                  onClick={() => setShowSnapshotHistory((value) => !value)}
                  className="font-mono text-[8px] uppercase tracking-[0.12em] text-stone-500 hover:text-stone-900"
                >
                  {showSnapshotHistory ? "Hide history" : `Show history (${olderSnapshots.length})`}
                </button>

                {showSnapshotHistory && (
                  <div className="mt-2 space-y-1">
                    {olderSnapshots.map((snap) => (
                      <div key={snap.id} className="p-2 bg-stone-50 hover:bg-stone-100 transition-colors">
                        <div className="flex justify-between items-start gap-3">
                          <div className="min-w-0">
                            <div className="font-mono text-[10px] font-bold" data-testid={`snap-short-${snap.id}`}>
                              {shortId(snap.id)}
                            </div>
                            <div className="font-mono text-[9px] text-stone-400 mt-0.5">
                              {snap.kind} · {formatSnapshotAge(snap.createdAt)}
                            </div>
                          </div>
                          <button
                            data-testid={`restore-btn-${snap.id}`}
                            onClick={() => setConfirmRestore(snap.id)}
                            className="shrink-0 font-mono text-[8px] border border-stone-300 px-1 py-0.5 hover:bg-stone-200"
                          >
                            Restore
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Restore confirmation dialog */}
      <Dialog open={confirmRestore !== null} onOpenChange={(open) => { if (!open) setConfirmRestore(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-headline text-lg font-bold uppercase">Restore Snapshot</DialogTitle>
            <DialogDescription className="text-sm text-stone-500">
              Restore from {confirmRestore ? shortId(confirmRestore) : ""}? Existing sessions will be restarted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmRestore(null)}>Cancel</Button>
            <Button
              variant="default"
              data-testid={confirmRestore ? `confirm-restore-${confirmRestore}` : undefined}
              onClick={() => confirmRestore && handleRestore(confirmRestore)}
            >
              Confirm Restore
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDown} onOpenChange={(open) => { if (!open) setConfirmDown(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-headline text-lg font-bold uppercase">Turn Off Rig</DialogTitle>
            <DialogDescription className="text-sm text-stone-500">
              Stop all running sessions for {summary?.name ?? rigId}?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDown(false)}>Cancel</Button>
            <Button
              variant="default"
              data-testid="confirm-rig-down"
              disabled={teardownRig.isPending}
              onClick={handleTeardown}
            >
              {teardownRig.isPending ? "Stopping..." : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
      )}
    </aside>
  );
}
