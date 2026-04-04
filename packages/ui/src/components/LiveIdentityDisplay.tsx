import type { NodeDetailPeer, NodeDetailEdge, NodeDetailTranscript, NodeDetailCompactSpec } from "../hooks/useNodeDetail.js";
import { copyText } from "../lib/copy-text.js";

interface LiveIdentityDisplayProps {
  peers: NodeDetailPeer[];
  edges: { outgoing: NodeDetailEdge[]; incoming: NodeDetailEdge[] };
  transcript: NodeDetailTranscript;
  compactSpec: NodeDetailCompactSpec;
}

export function LiveIdentityDisplay({ peers, edges, transcript, compactSpec }: LiveIdentityDisplayProps) {
  return (
    <>
      {/* Edges */}
      {(edges.outgoing.length > 0 || edges.incoming.length > 0) && (
        <section data-testid="detail-edges" className="px-4 py-3 border-b border-stone-100">
          <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-2">Edges</div>
          <div className="space-y-0.5 font-mono text-[10px]">
            {edges.outgoing.map((e, i) => (
              <div key={`out-${i}`} className="flex gap-1">
                <span className="text-stone-400">→</span>
                <span className="text-stone-500">{e.kind}</span>
                <span className="text-stone-900">{e.to?.logicalId ?? "?"}</span>
              </div>
            ))}
            {edges.incoming.map((e, i) => (
              <div key={`in-${i}`} className="flex gap-1">
                <span className="text-stone-400">←</span>
                <span className="text-stone-500">{e.kind}</span>
                <span className="text-stone-900">{e.from?.logicalId ?? "?"}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Peers */}
      {peers.length > 0 && (
        <section data-testid="detail-peers" className="px-4 py-3 border-b border-stone-100">
          <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-2">Peers</div>
          <div className="space-y-0.5 font-mono text-[10px]">
            {peers.map((p) => (
              <div key={p.logicalId} className="space-y-0">
                <div className="flex justify-between">
                  <span className="text-stone-900">{p.logicalId}</span>
                  <span className="text-stone-500">{p.runtime ?? "—"}</span>
                </div>
                {p.canonicalSessionName && (
                  <div className="text-[9px] text-stone-400 truncate">{p.canonicalSessionName}</div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Transcript */}
      {transcript.enabled && transcript.tailCommand && (
        <section data-testid="detail-transcript" className="px-4 py-3 border-b border-stone-100">
          <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-2">Transcript</div>
          <div className="font-mono text-[9px] text-stone-700">{transcript.path ?? "enabled"}</div>
          <button
            onClick={() => copyText(transcript.tailCommand!)}
            className="mt-1 px-2 py-1 border border-stone-300 font-mono text-[8px] uppercase hover:bg-stone-200 text-left truncate w-full"
          >
            Copy tail command
          </button>
        </section>
      )}

      {/* Compact Spec */}
      {compactSpec.name && (
        <section data-testid="detail-compact-spec" className="px-4 py-3 border-b border-stone-100">
          <div className="font-mono text-[8px] text-stone-400 uppercase tracking-wider mb-2">Agent Spec</div>
          <div className="space-y-0.5 font-mono text-[10px]">
            <div className="flex justify-between"><span className="text-stone-500">Spec</span><span className="text-stone-900">{compactSpec.name}</span></div>
            {compactSpec.version && (
              <div className="flex justify-between"><span className="text-stone-500">Version</span><span className="text-stone-900">{compactSpec.version}</span></div>
            )}
            {compactSpec.profile && (
              <div className="flex justify-between"><span className="text-stone-500">Profile</span><span className="text-stone-900">{compactSpec.profile}</span></div>
            )}
            <div className="flex justify-between"><span className="text-stone-500">Skills</span><span className="text-stone-900">{compactSpec.skillCount}</span></div>
            <div className="flex justify-between"><span className="text-stone-500">Guidance</span><span className="text-stone-900">{compactSpec.guidanceCount}</span></div>
          </div>
        </section>
      )}
    </>
  );
}
