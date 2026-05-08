import { useState, useCallback, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/copy-text";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  useDiscoveredSessions,
  useDiscoveryScan,
  useBindSession,
  type DiscoveredSession,
} from "../hooks/useDiscovery.js";
import { useRigSummary } from "../hooks/useRigSummary.js";
import { WorkspacePage } from "./WorkspacePage.js";
import { RuntimeBadge, ToolMark } from "./graphics/RuntimeMark.js";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function attachCommand(session: DiscoveredSession): string {
  const target = session.tmuxWindow ? `${session.tmuxSession}:${session.tmuxWindow}` : session.tmuxSession;
  return `tmux attach -t ${shellQuote(target)}`;
}

function DiscoveryActionButton({
  label,
  activeLabel,
  onClick,
  testId,
  tool,
}: {
  label: string;
  activeLabel: string;
  onClick: () => boolean | Promise<boolean>;
  testId?: string;
  tool?: string;
}) {
  const [active, setActive] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleClick = async () => {
    const result = await onClick();
    if (!result) return;
    setActive(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setActive(false);
      timerRef.current = null;
    }, 900);
  };

  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      onClick={() => { void handleClick(); }}
      className={cn(
        "inline-flex items-center gap-1.5 px-spacing-2 py-1 border font-mono text-[10px] uppercase transition-colors duration-150 ease-tactical",
        active
          ? "bg-stone-900 text-white border-stone-900"
          : "bg-white text-stone-900 border-stone-300 hover:bg-stone-100",
      )}
    >
      {tool ? <ToolMark tool={tool} size="sm" /> : null}
      <span>{active ? activeLabel : label}</span>
    </button>
  );
}

function DiscoveredSessionCard({ session, onAdopt }: { session: DiscoveredSession; onAdopt: (id: string) => void }) {
  return (
    <div
      data-testid="discovered-node"
      className={cn(
        "border-dashed border border-foreground/20 bg-[rgba(255,255,255,0.72)] px-spacing-4 py-spacing-3 mb-spacing-2 shadow-[0_10px_28px_rgba(20,20,20,0.04)] backdrop-blur-sm",
      )}
    >
      <div className="flex flex-col gap-spacing-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-spacing-3 gap-y-spacing-1">
            <span data-testid="runtime-badge">
              <RuntimeBadge runtime={session.runtimeHint} size="sm" compact />
            </span>
            <div
              data-testid="session-name"
              className="font-mono text-[13px] leading-5 text-foreground"
              title={session.tmuxSession}
            >
              {session.tmuxSession}
            </div>
            {session.confidence === "medium" ? (
              <div
                data-testid="runtime-inferred-note"
                className="text-[10px] uppercase tracking-[0.08em] text-foreground-muted"
              >
                runtime inferred
              </div>
            ) : null}
          </div>
          {session.cwd ? (
            <div className="mt-spacing-2 min-w-0">
              <div className="text-[10px] uppercase tracking-[0.08em] text-foreground-muted">
                cwd
              </div>
              <div
                className="font-mono text-[12px] leading-5 text-foreground-muted truncate"
                title={session.cwd}
              >
                {session.cwd}
              </div>
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-spacing-2 lg:justify-end">
        <DiscoveryActionButton
          label="copy tmux"
          activeLabel="copied"
          testId="copy-tmux-btn"
          tool="tmux"
          onClick={async () => {
            const ok = await copyText(attachCommand(session));
            return ok;
          }}
        />
        {session.cwd ? (
          <DiscoveryActionButton
            label="copy cwd"
            activeLabel="copied"
            testId="copy-cwd-btn"
            onClick={async () => {
              const ok = await copyText(session.cwd ?? "");
              return ok;
            }}
          />
        ) : null}
          <Button
            variant="tactical"
            size="sm"
            data-testid="adopt-btn"
            onClick={() => onAdopt(session.id)}
          >
            ADOPT
          </Button>
        </div>
      </div>
    </div>
  );
}

export function GenerateDraftSection() {
  const [draftYaml, setDraftYaml] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleGenerate = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/discovery/draft-rig", { method: "POST" });
      if (!res.ok) {
        setDraftYaml(`# Error: draft generation failed (HTTP ${res.status})`);
        return;
      }
      const yaml = await res.text();
      setDraftYaml(yaml);
    } catch {
      setDraftYaml("# Error: failed to reach daemon");
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div className="mt-spacing-4 border-t border-foreground/10 pt-spacing-4" data-testid="generate-draft-section">
      <Button
        variant="tactical"
        onClick={handleGenerate}
        disabled={loading}
        data-testid="generate-draft-btn"
        className="mb-spacing-3"
      >
        {loading ? "GENERATING..." : "GENERATE RIG SPEC"}
      </Button>

      {draftYaml && (() => {
        // Extract warning comments from YAML preamble
        const lines = draftYaml.split("\n");
        const warnings = lines.filter((l) => l.startsWith("# WARNING:")).map((l) => l.replace(/^# WARNING:\s*/, ""));
        const yamlBody = lines.filter((l) => !l.startsWith("# WARNING:")).join("\n").trim();
        return (
        <div className="relative">
          {warnings.length > 0 && (
            <div className="mb-spacing-2 p-spacing-2 bg-warning/10 border border-warning/30 text-label-sm" data-testid="draft-warnings">
              {warnings.map((w, i) => <div key={i} className="text-warning font-mono">{w}</div>)}
            </div>
          )}
          <pre className="bg-surface-low p-spacing-3 text-label-sm font-mono overflow-x-auto max-h-64 border border-foreground/10" data-testid="draft-yaml">
            {yamlBody}
          </pre>
          <button
            onClick={() => navigator.clipboard?.writeText(draftYaml)}
            className="absolute top-2 right-2 text-label-sm text-foreground-muted hover:text-foreground"
            data-testid="copy-draft-btn"
          >
            COPY
          </button>
        </div>
        );
      })()}
    </div>
  );
}

export function DiscoveryOverlay() {
  const { data: sessions = [] } = useDiscoveredSessions({
    status: "active",
    runtimeHint: ["claude-code", "codex"],
    minConfidence: "medium",
  });
  const scanMutation = useDiscoveryScan();
  const { data: rigs = [] } = useRigSummary();
  const bindMutation = useBindSession();
  const visibleSessions = sessions;

  const [adoptTarget, setAdoptTarget] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [rigId, setRigId] = useState("");
  const [logicalId, setLogicalId] = useState("");

  const handleAdoptClick = (discoveredId: string) => {
    setAdoptTarget(discoveredId);
    setDialogOpen(true);
    setRigId("");
    setLogicalId("");
    bindMutation.reset();
  };

  const finishAdopt = () => {
    setDialogOpen(false);
    setAdoptTarget(null);
  };

  const handleAdoptConfirm = () => {
    if (!adoptTarget || !rigId || !logicalId.trim()) return;
    bindMutation.mutate(
      { discoveredId: adoptTarget, rigId, logicalId: logicalId.trim() },
      { onSuccess: finishAdopt },
    );
  };

  const adoptError = bindMutation.error?.message ?? null;
  const adoptPending = bindMutation.isPending;

  return (
    <WorkspacePage>
    <div data-testid="discovery-overlay">
        <div>
        <div className="flex flex-col gap-spacing-4 border-b border-foreground/10 pb-spacing-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-[620px]">
            <h2 className="text-headline-lg uppercase">DISCOVERY</h2>
            <p className="mt-spacing-1 text-body-md text-foreground-muted">
              Running agent sessions currently visible on this machine. Copy a tmux attach command,
              review the working directory, or adopt the session into a rig.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            data-testid="scan-now-btn"
            disabled={scanMutation.isPending}
            onClick={() => scanMutation.mutate()}
          >
            {scanMutation.isPending ? "SCANNING..." : "SCAN NOW"}
          </Button>
        </div>

        {scanMutation.isError ? (
          <div className="mt-spacing-4 text-label-sm text-destructive" data-testid="scan-error">
            Discovery scan failed: {scanMutation.error?.message}
          </div>
        ) : null}

        {visibleSessions.length === 0 ? (
          <div className="py-spacing-8" data-testid="discovery-empty">
            <p className="text-body-md text-foreground-muted">No running Claude or Codex sessions are currently visible.</p>
          </div>
        ) : (
          <div className="mt-spacing-6 space-y-spacing-3" data-testid="discovery-active-section">
            <div className="mb-spacing-2">
              <h3 className="text-headline-sm uppercase">Running agents</h3>
              <p className="text-label-md text-foreground-muted">
                {visibleSessions.length} session{visibleSessions.length !== 1 ? "s" : ""} available to inspect or adopt
              </p>
            </div>
            {visibleSessions.map((session) => (
              <DiscoveredSessionCard key={session.id} session={session} onAdopt={handleAdoptClick} />
            ))}
          </div>
        )}

        <GenerateDraftSection />
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent data-testid="adopt-dialog">
          <DialogHeader>
            <DialogTitle className="text-headline-md uppercase">ADOPT SESSION</DialogTitle>
            <DialogDescription>Bind this session to an existing logical node in the rig.</DialogDescription>
          </DialogHeader>
          <div className="space-y-spacing-3">
            <div>
              <label className="text-label-sm uppercase block mb-spacing-1">RIG</label>
              <select
                data-testid="adopt-rig-input"
                value={rigId}
                onChange={(e) => setRigId(e.target.value)}
                className="w-full bg-white border-b border-outline py-spacing-1 text-body-md font-mono focus:outline-none focus:border-stone-900 appearance-none cursor-pointer"
              >
                <option value="">Select a rig...</option>
                {rigs.map((r) => (
                  <option key={r.id} value={r.id}>{r.name} ({r.nodeCount} nodes)</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-label-sm uppercase block mb-spacing-1">LOGICAL ID (required)</label>
              <input
                data-testid="adopt-logical-input"
                type="text"
                value={logicalId}
                onChange={(e) => setLogicalId(e.target.value)}
                className="w-full bg-transparent border-b border-foreground/20 py-spacing-1 text-body-md font-mono focus:outline-none focus:border-primary"
              />
              <p className="mt-spacing-1 text-label-sm text-foreground-muted">
                Enter the logical ID of an existing node in the target rig. For pod placement, use the Discovery drawer instead.
              </p>
            </div>
          </div>
          {adoptError && (
            <p className="text-destructive text-label-sm" data-testid="adopt-error">
              {adoptError}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>CANCEL</Button>
            <Button
              variant="tactical"
              onClick={handleAdoptConfirm}
              disabled={!rigId || !logicalId.trim() || adoptPending}
              data-testid="adopt-confirm"
            >
              {adoptPending ? "ADOPTING..." : "ADOPT"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </WorkspacePage>
  );
}
