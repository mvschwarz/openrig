import type { ExpandRigResult } from "../hooks/mutations.js";

export function ExpansionOutcome({ result }: { result: ExpandRigResult }) {
  return (
    <div data-testid="expand-result" className="mt-2 font-mono text-[9px]">
      <div className={result.status === "ok" ? "text-green-700" : "text-amber-700"}>
        Status: {result.status} — Pod: {result.podNamespace}
      </div>
      {result.nodes?.map((n) => (
        <div key={n.logicalId} className={n.status === "launched" ? "text-stone-700" : "text-red-600"}>
          [{n.status === "launched" ? "OK" : "FAIL"}] {n.logicalId}{n.error ? ` — ${n.error}` : ""}
        </div>
      ))}
    </div>
  );
}
