import { useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { useSpecsWorkspace, type SpecsDraft } from "./SpecsWorkspace.js";
import { useSpecLibrary, useLibraryReview, type SpecLibraryEntry } from "../hooks/useSpecLibrary.js";
import { usePsEntries } from "../hooks/usePsEntries.js";
import { useExpandRig, type ExpandRigResult } from "../hooks/mutations.js";
import { ExpansionOutcome } from "./ExpansionOutcome.js";

interface SpecsPanelProps {
  onClose: () => void;
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="border border-stone-300/28 bg-white/10 px-3 py-3">
      <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-stone-500">{title}</div>
      <p className="mt-2 text-[11px] leading-5 text-stone-600">{description}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {children}
      </div>
    </section>
  );
}

function DraftList({
  title,
  drafts,
  onSelect,
}: {
  title: string;
  drafts: SpecsDraft[];
  onSelect: (draftId: string) => void;
}) {
  if (drafts.length === 0) return null;

  return (
    <div className="mt-3 w-full space-y-2">
      <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-stone-500">{title}</div>
      <div className="w-full space-y-1">
        {drafts.map((draft) => (
          <button
            key={draft.id}
            type="button"
            onClick={() => onSelect(draft.id)}
            className="flex w-full items-center justify-between border border-stone-300/28 bg-white/5 px-2 py-2 text-left transition-colors hover:border-stone-900/25 hover:bg-white/10"
          >
            <span className="min-w-0 truncate text-[11px] text-stone-800">{draft.label}</span>
            <span className="ml-3 shrink-0 font-mono text-[8px] uppercase tracking-[0.16em] text-stone-500">
              {new Date(draft.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function LibraryList({
  title,
  entries,
  onSelect,
  renderAction,
}: {
  title: string;
  entries: SpecLibraryEntry[];
  onSelect: (id: string) => void;
  renderAction?: (entry: SpecLibraryEntry) => ReactNode;
}) {
  if (entries.length === 0) return null;

  return (
    <div className="mt-3 w-full space-y-2">
      <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-stone-500">{title}</div>
      <div className="w-full space-y-1">
        {entries.map((entry) => (
          <div key={entry.id}>
            <div className="flex w-full items-center border border-stone-300/28 bg-white/5 transition-colors hover:border-stone-900/25 hover:bg-white/10">
              <button
                type="button"
                data-testid={`library-entry-${entry.id}`}
                onClick={() => onSelect(entry.id)}
                className="flex flex-1 items-center justify-between px-2 py-2 text-left min-w-0"
              >
                <span className="min-w-0 truncate text-[11px] text-stone-800">{entry.name}</span>
                <span className="ml-3 shrink-0 font-mono text-[8px] uppercase tracking-[0.16em] text-stone-500">
                  {entry.sourceType === "builtin" ? "built-in" : entry.version}
                </span>
              </button>
              {renderAction && <div className="shrink-0 pr-2">{renderAction(entry)}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AddToRigFlow({ entryId, onDone }: { entryId: string; onDone: () => void }) {
  const { data: review } = useLibraryReview(entryId);
  const { data: psEntries = [] } = usePsEntries();
  const expandRig = useExpandRig();
  const [selectedRigId, setSelectedRigId] = useState("");
  const [selectedPodIdx, setSelectedPodIdx] = useState(0);
  const [result, setResult] = useState<ExpandRigResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runningRigs = psEntries.filter((e) => e.status === "running");
  const pods = (review && "pods" in review && Array.isArray(review.pods)) ? review.pods as Array<{ id: string; label?: string; members: unknown[]; edges: unknown[] }> : [];

  const handleExpand = async () => {
    if (!selectedRigId || pods.length === 0) return;
    setError(null);
    setResult(null);
    const pod = pods[selectedPodIdx]!;
    try {
      const res = await expandRig.mutateAsync({ rigId: selectedRigId, pod: pod as Record<string, unknown> });
      setResult(res);
      if (res.status === "ok") setTimeout(onDone, 1500);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!review) return <div className="font-mono text-[9px] text-stone-400 p-2">Loading spec...</div>;
  if (pods.length === 0) return <div className="font-mono text-[9px] text-stone-400 p-2">No pods available in this spec.</div>;

  return (
    <div data-testid="add-to-rig-flow" className="mt-2 p-2 border border-stone-300/28 bg-white/5 space-y-2">
      <div className="font-mono text-[8px] text-stone-400 uppercase">Add to Rig</div>
      <select
        data-testid="add-to-rig-select"
        className="w-full font-mono text-[9px] border border-stone-300 p-1"
        value={selectedRigId}
        onChange={(e) => setSelectedRigId(e.target.value)}
      >
        <option value="">Select rig...</option>
        {runningRigs.map((r) => (
          <option key={r.rigId} value={r.rigId}>{r.name}</option>
        ))}
      </select>
      {pods.length > 1 && (
        <select
          data-testid="add-to-rig-pod-select"
          className="w-full font-mono text-[9px] border border-stone-300 p-1"
          value={selectedPodIdx}
          onChange={(e) => setSelectedPodIdx(Number(e.target.value))}
        >
          {pods.map((p, i) => (
            <option key={p.id} value={i}>{p.label ?? p.id}</option>
          ))}
        </select>
      )}
      <button
        data-testid="add-to-rig-submit"
        disabled={!selectedRigId || expandRig.isPending}
        onClick={handleExpand}
        className="px-2 py-1 border border-stone-300 font-mono text-[8px] uppercase hover:bg-stone-200 disabled:opacity-50"
      >
        {expandRig.isPending ? "Expanding..." : `Add ${pods[selectedPodIdx]?.label ?? pods[selectedPodIdx]?.id ?? "pod"}`}
      </button>
      {result && <ExpansionOutcome result={result} />}
      {error && <div className="font-mono text-[9px] text-red-600">{error}</div>}
      <button onClick={onDone} className="font-mono text-[8px] text-stone-400 hover:text-stone-700">Cancel</button>
    </div>
  );
}

export function SpecsPanel({ onClose }: SpecsPanelProps) {
  const navigate = useNavigate();
  const {
    activeTask,
    currentRigDraft,
    currentAgentDraft,
    recentRigDrafts,
    recentAgentDrafts,
    selectRigDraft,
    selectAgentDraft,
  } = useSpecsWorkspace();

  const openSurface = async (
    to: "/import" | "/bootstrap" | "/agents/validate" | "/specs/rig" | "/specs/agent"
  ) => {
    await navigate({ to });
  };

  const openRigDraft = async (draftId: string) => {
    selectRigDraft(draftId);
    await openSurface("/specs/rig");
  };

  const openAgentDraft = async (draftId: string) => {
    selectAgentDraft(draftId);
    await openSurface("/specs/agent");
  };

  const { data: rigLibrary = [] } = useSpecLibrary("rig");
  const { data: agentLibrary = [] } = useSpecLibrary("agent");
  const [addToRigEntryId, setAddToRigEntryId] = useState<string | null>(null);

  const openLibraryEntry = async (id: string) => {
    await navigate({ to: "/specs/library/$entryId", params: { entryId: id } });
  };

  const rigDraftHistory = recentRigDrafts.filter((draft) => draft.id !== currentRigDraft?.id);
  const agentDraftHistory = recentAgentDrafts.filter((draft) => draft.id !== currentAgentDraft?.id);

  return (
    <aside
      data-testid="specs-panel"
      className="absolute inset-y-0 right-0 z-20 w-80 border-l border-stone-300/25 bg-[rgba(250,249,245,0.035)] supports-[backdrop-filter]:bg-[rgba(250,249,245,0.018)] backdrop-blur-[14px] backdrop-saturate-75 shadow-[-6px_0_14px_rgba(46,52,46,0.04)] flex flex-col overflow-hidden"
    >
      <div className="flex items-center justify-between border-b border-stone-300/35 px-4 py-3 shrink-0">
        <h2 className="min-w-0 truncate font-mono text-xs font-bold text-stone-900">specs</h2>
        <button
          data-testid="specs-close"
          onClick={onClose}
          className="text-stone-400 hover:text-stone-900 text-sm"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {activeTask && (
          <Section
            title="Current Task"
            description={activeTask.summary}
          >
            <Button variant="outline" size="sm" onClick={() => openSurface(activeTask.route)}>
              Resume {activeTask.label}
            </Button>
          </Section>
        )}

        <Section
          title="Rig Specs"
          description="Import a rig spec, review it in the workspace, then instantiate or bootstrap it."
        >
          <Button variant="outline" size="sm" onClick={() => openSurface("/import")}>
            Import RigSpec
          </Button>
          <Button variant="outline" size="sm" onClick={() => openSurface("/bootstrap")}>
            Bootstrap
          </Button>
          <LibraryList
            title="Library"
            entries={rigLibrary}
            onSelect={openLibraryEntry}
            renderAction={(entry) => (
              <button
                data-testid={`library-add-to-rig-${entry.id}`}
                onClick={(e) => { e.stopPropagation(); setAddToRigEntryId(addToRigEntryId === entry.id ? null : entry.id); }}
                className="shrink-0 font-mono text-[7px] uppercase tracking-[0.12em] text-stone-500 hover:text-stone-900 border border-stone-300 px-1 py-0.5"
              >
                + Rig
              </button>
            )}
          />
          {addToRigEntryId && rigLibrary.some((e) => e.id === addToRigEntryId) && (
            <AddToRigFlow entryId={addToRigEntryId} onDone={() => setAddToRigEntryId(null)} />
          )}
          {currentRigDraft && (
            <DraftList title="Current Draft" drafts={[currentRigDraft]} onSelect={openRigDraft} />
          )}
          <DraftList title="Recent Drafts" drafts={rigDraftHistory} onSelect={openRigDraft} />
        </Section>

        <Section
          title="Agent Specs"
          description="Validate agent specs and use the workspace for spec-level review surfaces."
        >
          <Button variant="outline" size="sm" onClick={() => openSurface("/agents/validate")}>
            Validate AgentSpec
          </Button>
          <LibraryList title="Library" entries={agentLibrary} onSelect={openLibraryEntry} />
          {currentAgentDraft && (
            <DraftList title="Current Draft" drafts={[currentAgentDraft]} onSelect={openAgentDraft} />
          )}
          <DraftList title="Recent Drafts" drafts={agentDraftHistory} onSelect={openAgentDraft} />
        </Section>
      </div>
    </aside>
  );
}
