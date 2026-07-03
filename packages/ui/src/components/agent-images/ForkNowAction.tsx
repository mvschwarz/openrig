import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { usePsEntries } from "@/hooks/usePsEntries";
import { useNodeInventory } from "@/hooks/useNodeInventory";
import type { AgentImageEntry } from "@/hooks/useAgentImageLibrary";

interface AddMemberResponse {
  ok: boolean;
  message?: string;
  errors?: string[];
  code?: string;
  result?: {
    node?: {
      logicalId: string;
      status: string;
      error?: string;
      sessionName?: string;
    };
    warnings?: string[];
  };
}

interface ForkNowResult {
  ok: boolean;
  status?: string;
  error?: string;
  logicalId?: string;
}

export function ForkNowAction({ entry }: { entry: AgentImageEntry }) {
  const [open, setOpen] = useState(false);
  const [selectedRigId, setSelectedRigId] = useState<string | null>(null);
  const [selectedPod, setSelectedPod] = useState<string | null>(null);
  const [selectedSibling, setSelectedSibling] = useState<string | null>(null);
  const [newMemberId, setNewMemberId] = useState("");
  const [result, setResult] = useState<ForkNowResult | null>(null);

  const queryClient = useQueryClient();
  const psQuery = usePsEntries();
  const nodesQuery = useNodeInventory(selectedRigId);

  const noCwd = !entry.sourceCwd;

  const rigs = psQuery.data ?? [];
  const nodes = nodesQuery.data ?? [];

  const pods = [...new Set(nodes.filter((n) => n.podId).map((n) => n.podNamespace ?? n.podId!))];
  const podNodes = selectedPod
    ? nodes.filter((n) => (n.podNamespace ?? n.podId) === selectedPod && n.runtime === entry.runtime && !!n.agentRef && !!n.profile)
    : [];

  const selectedSiblingNode = podNodes.find((n) => n.logicalId === selectedSibling);

  const forkMutation = useMutation({
    mutationFn: async () => {
      if (!selectedRigId || !selectedPod || !selectedSiblingNode || !newMemberId.trim()) {
        throw new Error("Missing required fields");
      }

      const member: Record<string, unknown> = {
        id: newMemberId.trim(),
        runtime: entry.runtime,
        agent_ref: selectedSiblingNode.agentRef,
        profile: selectedSiblingNode.profile,
        cwd: entry.sourceCwd,
        session_source: {
          mode: "agent_image",
          ref: { kind: "image_name", value: entry.name },
        },
      };
      if (entry.runtime === "codex" && selectedSiblingNode.codexConfigProfile) {
        member.codex_config_profile = selectedSiblingNode.codexConfigProfile;
      }

      const res = await fetch(
        `/api/rigs/${encodeURIComponent(selectedRigId)}/pods/${encodeURIComponent(selectedPod)}/members`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ member }),
        },
      );
      const data: AddMemberResponse = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.message ?? data.errors?.join("; ") ?? data.code ?? `HTTP ${res.status}`);
      }
      const nodeStatus = data.result?.node?.status;
      if (nodeStatus === "failed" || nodeStatus === "attention_required") {
        return {
          ok: false,
          status: nodeStatus,
          error: data.result?.node?.error ?? `Launch ${nodeStatus}`,
          logicalId: data.result?.node?.logicalId,
        };
      }
      return {
        ok: true,
        status: nodeStatus ?? "launched",
        logicalId: data.result?.node?.logicalId ?? newMemberId.trim(),
      };
    },
    onSuccess: (data) => {
      setResult(data);
      void queryClient.invalidateQueries({ queryKey: ["ps"] });
    },
    onError: (err) => {
      setResult({ ok: false, error: (err as Error).message });
    },
  });

  if (noCwd) {
    return (
      <div data-testid="fork-now-disabled-no-cwd" className="font-mono text-[9px] text-on-surface-variant">
        Fork now unavailable: image lacks source cwd (pre-Finding-2 manifest)
      </div>
    );
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        data-testid="fork-now-button"
        onClick={() => { setOpen(true); setResult(null); }}
      >
        Fork now
      </Button>

      {open && (
        <div data-testid="fork-now-modal" className="border border-outline bg-surface-lowest px-3 py-3 space-y-3 mt-2">
          <div className="font-mono text-[10px] uppercase tracking-[0.10em] text-on-surface">
            Fork "{entry.name}" into a running rig
          </div>

          <div className="space-y-2">
            <label className="block font-mono text-[9px] text-on-surface-variant">
              Target rig
              <select
                data-testid="fork-now-rig-select"
                className="block w-full mt-0.5 border border-outline-variant bg-surface-lowest px-1 py-0.5 font-mono text-[10px]"
                value={selectedRigId ?? ""}
                onChange={(e) => { setSelectedRigId(e.target.value || null); setSelectedPod(null); setSelectedSibling(null); }}
              >
                <option value="">Select rig…</option>
                {rigs.map((r) => (
                  <option key={r.rigId} value={r.rigId}>{r.name}</option>
                ))}
              </select>
            </label>

            {selectedRigId && (
              <label className="block font-mono text-[9px] text-on-surface-variant">
                Target pod
                <select
                  data-testid="fork-now-pod-select"
                  className="block w-full mt-0.5 border border-outline-variant bg-surface-lowest px-1 py-0.5 font-mono text-[10px]"
                  value={selectedPod ?? ""}
                  onChange={(e) => { setSelectedPod(e.target.value || null); setSelectedSibling(null); }}
                >
                  <option value="">Select pod…</option>
                  {pods.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </label>
            )}

            {selectedPod && podNodes.length === 0 && (
              <div data-testid="fork-now-no-sibling" className="font-mono text-[9px] text-amber-600">
                No {entry.runtime} member in this pod to clone identity from. Choose a different pod.
              </div>
            )}

            {selectedPod && podNodes.length > 0 && (
              <label className="block font-mono text-[9px] text-on-surface-variant">
                Clone identity from ({entry.runtime} member)
                <select
                  data-testid="fork-now-sibling-select"
                  className="block w-full mt-0.5 border border-outline-variant bg-surface-lowest px-1 py-0.5 font-mono text-[10px]"
                  value={selectedSibling ?? ""}
                  onChange={(e) => setSelectedSibling(e.target.value || null)}
                >
                  <option value="">Select member…</option>
                  {podNodes.map((n) => (
                    <option key={n.logicalId} value={n.logicalId}>{n.logicalId}</option>
                  ))}
                </select>
              </label>
            )}

            {selectedSibling && (
              <label className="block font-mono text-[9px] text-on-surface-variant">
                New member ID (no dots)
                <input
                  data-testid="fork-now-member-id"
                  type="text"
                  className="block w-full mt-0.5 border border-outline-variant bg-surface-lowest px-1 py-0.5 font-mono text-[10px]"
                  value={newMemberId}
                  onChange={(e) => setNewMemberId(e.target.value.replace(/\./g, ""))}
                  placeholder="e.g. forked-worker"
                />
              </label>
            )}
          </div>

          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              data-testid="fork-now-confirm"
              disabled={!selectedSibling || !newMemberId.trim() || forkMutation.isPending}
              onClick={() => forkMutation.mutate()}
            >
              {forkMutation.isPending ? "Forking…" : "Confirm fork"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
          </div>

          {result && (
            <div
              data-testid="fork-now-result"
              className={`font-mono text-[9px] ${result.ok ? "text-green-700" : "text-red-600"}`}
            >
              {result.ok
                ? `Forked: ${result.logicalId ?? newMemberId} launched from image "${entry.name}" (${result.status})`
                : `Fork failed: ${result.status ? `[${result.status}] ` : ""}${result.error}`}
            </div>
          )}
        </div>
      )}
    </>
  );
}
