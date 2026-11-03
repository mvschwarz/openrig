// OPR.0.4.4.22 FR-6 — DRILL-IN: the terminal content, on demand, via the
// SHIPPED read-only transcript routes (tail / grep / full — zero new routes,
// no daemon changes for reading). This is the tier where raw ids and pane
// content legitimately appear (BR-10's drill-in tier).
//
// PULL-ON-DEMAND ONLY: this component mounts when the founder drills in;
// nothing here is fetched for the standing panel (the zero-standing-
// transcript-cost contract — a money proof). A seat with no transcript
// renders the daemon's honest per-seat error, never a silent empty pane.

import { useEffect, useRef, useState } from "react";

type DrillMode = "tail" | "grep" | "full";

interface DrillState {
  mode: DrillMode;
  content: string | null;
  error: string | null;
  loading: boolean;
}

async function fetchDrill(session: string, mode: DrillMode, pattern: string): Promise<{ content: string | null; error: string | null }> {
  const base = `/api/transcripts/${encodeURIComponent(session)}`;
  const url =
    mode === "tail" ? `${base}/tail?lines=50`
    : mode === "grep" ? `${base}/grep?pattern=${encodeURIComponent(pattern)}`
    : `${base}/full`;
  try {
    const res = await fetch(url);
    const body = (await res.json()) as { content?: string; matches?: string[]; error?: string };
    if (!res.ok) {
      // The daemon's honest per-seat error, verbatim.
      return { content: null, error: body.error ?? `HTTP ${res.status}` };
    }
    if (mode === "grep") {
      const matches = body.matches ?? [];
      return { content: matches.length > 0 ? matches.join("\n") : "(no matches)", error: null };
    }
    return { content: body.content ?? "", error: null };
  } catch (err) {
    return { content: null, error: err instanceof Error ? err.message : "transcript fetch failed" };
  }
}

export function TranscriptDrillPanel({ sessionName, deferUntilDetailsOpen = false }: { sessionName: string; deferUntilDetailsOpen?: boolean }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [pattern, setPattern] = useState("");
  const [armed, setArmed] = useState(!deferUntilDetailsOpen);
  const [state, setState] = useState<DrillState>({ mode: "tail", content: null, error: null, loading: true });

  const load = (mode: DrillMode, grepPattern = pattern) => {
    setState((s) => ({ ...s, mode, loading: true }));
    void fetchDrill(sessionName, mode, grepPattern).then(({ content, error }) =>
      setState({ mode, content, error, loading: false }),
    );
  };

  // Recent tail on open (the drill-in's landing view).
  useEffect(() => {
    if (deferUntilDetailsOpen) {
      const details = rootRef.current?.closest("details");
      if (details && !details.open) {
        setArmed(false);
        setState({ mode: "tail", content: null, error: null, loading: false });
        let loaded = false;
        const onOpen = () => {
          if (details.open && !loaded) {
            loaded = true;
            setArmed(true);
            load("tail");
          }
        };
        const observer = new MutationObserver(onOpen);
        observer.observe(details, { attributes: true, attributeFilter: ["open"] });
        details.addEventListener("toggle", onOpen);
        return () => {
          observer.disconnect();
          details.removeEventListener("toggle", onOpen);
        };
      }
    }
    setArmed(true);
    load("tail");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionName]);

  if (!armed) {
    return <div ref={rootRef} />;
  }

  return (
    <div ref={rootRef} data-testid={`transcript-drill-${sessionName}`} className="mt-2 space-y-1 border border-outline-variant p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-on-surface-variant">transcript · {sessionName}</span>
        <button
          type="button"
          data-testid="drill-tail"
          onClick={() => load("tail")}
          className={`border px-2 py-0.5 text-[11px] ${state.mode === "tail" ? "border-outline bg-surface-variant" : "border-outline-variant hover:bg-surface-variant/50"}`}
        >
          Tail
        </button>
        <input
          data-testid="drill-grep-input"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && pattern.trim()) load("grep", pattern);
          }}
          placeholder="grep pattern…"
          className="border border-outline-variant bg-transparent px-2 py-0.5 font-mono text-[11px]"
        />
        <button
          type="button"
          data-testid="drill-grep"
          disabled={!pattern.trim()}
          onClick={() => load("grep", pattern)}
          className="border border-outline-variant px-2 py-0.5 text-[11px] hover:bg-surface-variant/50 disabled:opacity-50"
        >
          Search
        </button>
        {/* Full only on EXPLICIT request (FR-6). */}
        <button
          type="button"
          data-testid="drill-full"
          onClick={() => load("full")}
          className="border border-outline-variant px-2 py-0.5 text-[11px] hover:bg-surface-variant/50"
        >
          Full
        </button>
      </div>
      {state.loading ? (
        <p className="font-mono text-[11px] text-on-surface-variant">loading {state.mode}…</p>
      ) : state.error ? (
        <p data-testid="drill-error" className="font-mono text-[11px] text-red-700">
          {state.error}
        </p>
      ) : (
        <pre
          data-testid="drill-content"
          className="max-h-80 overflow-auto whitespace-pre-wrap break-words bg-surface-lowest/40 p-2 font-mono text-[11px] leading-relaxed"
        >
          {state.content}
        </pre>
      )}
    </div>
  );
}
