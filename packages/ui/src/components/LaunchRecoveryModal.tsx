// OPR.0.4.3.22 — the launch/recovery modal (plan-before-mutation).
//
// Contract (PRD + guard):
//  - defaults to restore-original; on open, fetches the READ-ONLY per-seat PLAN
//    (POST /launch-plan, mutated:false) BEFORE any mutation (AC-3);
//  - one row PER SEAT with independent TOKEN + PLAN columns — a missing-token
//    seat renders `awaiting-decision` (NOT a fresh launch) and BLOCKS the
//    restore-original action, WHILE resumable seats independently stay
//    `resume-original` (the LOCK — the resumable seats stay visible);
//  - `fresh` is a deliberate, LABELED, all-seats operator choice
//    (identity/context-changing) → maps to per-seat `freshLogicalIds`, never an
//    implicit global flip;
//  - vocabulary is the shipped restore vocabulary only (resume-original /
//    awaiting-decision / fresh-primed) — NO best-effort (out of scope).

import { useEffect, useState } from "react";
import { Ban, Check, RotateCcw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog.js";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./ui/table.js";
import { Button } from "./ui/button.js";
import { StatusPip, type StatusPipStatus } from "./ui/status-pip.js";
import { cn } from "../lib/utils.js";
import { useLaunchPlan, type LaunchPlanNode } from "../hooks/useLaunchPlan.js";
import { useLaunchRig } from "../hooks/mutations.js";
import type { SeatIntendedAction, SeatTokenState } from "../hooks/useRigStatus.js";

type LaunchPolicy = "restore-original" | "fresh";

const verdictPip: Record<SeatIntendedAction, StatusPipStatus> = {
  "resume-original": "running",
  "fresh-primed": "info",
  "awaiting-decision": "warning",
};

// Token state → tone. stale / unverified are DISTINCT from missing (FR-6): a
// stale/unverified token is visible for re-verify, not silently collapsed to missing.
const tokenTone: Record<SeatTokenState, string> = {
  present: "text-success",
  missing: "text-tertiary font-bold",
  stale: "text-warning font-bold",
  unverified: "text-warning",
};

export interface LaunchRecoveryModalProps {
  rigId: string;
  rigName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function PolicyOption({
  policy,
  label,
  selected,
  warn,
  sub,
  onSelect,
}: {
  policy: LaunchPolicy;
  label: string;
  selected: boolean;
  warn?: boolean;
  sub: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={`launch-policy-${policy}`}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex-1 border px-3 py-2 text-left",
        selected ? "border-stone-900 bg-stone-900 text-white" : "border-outline bg-white text-stone-700",
        warn && !selected && "border-tertiary/50",
      )}
    >
      <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide">
        {selected ? <Check className="h-3 w-3" /> : null}
        {label}
        {policy === "restore-original" ? (
          <span className={cn("ml-auto text-[8px]", selected ? "text-white/70" : "text-secondary")}>default</span>
        ) : null}
      </div>
      <div
        className={cn(
          "mt-1 font-mono text-[8px] leading-snug",
          selected ? "text-white/75" : warn ? "text-tertiary" : "text-secondary",
        )}
      >
        {sub}
      </div>
    </button>
  );
}

export function LaunchRecoveryModal({ rigId, rigName, open, onOpenChange }: LaunchRecoveryModalProps) {
  const planMut = useLaunchPlan(rigId);
  const launchMut = useLaunchRig(rigId);
  const [policy, setPolicy] = useState<LaunchPolicy>("restore-original");

  const planNodes: LaunchPlanNode[] = planMut.data?.nodes ?? [];
  const allSeatIds = planNodes.map((n) => n.logicalId);

  // Plan-before-action: fetch the read-only plan when the modal opens. Reset to
  // restore-original each open. `planMut.mutate` / `launchMut.reset` are stable.
  useEffect(() => {
    if (!open) return;
    setPolicy("restore-original");
    launchMut.reset();
    planMut.mutate(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rigId]);

  function selectPolicy(next: LaunchPolicy) {
    if (next === policy) return;
    setPolicy(next);
    // Re-fetch the read-only forecast under the chosen policy: fresh forecasts
    // fresh-primed for ALL seats (the explicit, labeled all-seats choice).
    planMut.mutate(next === "fresh" ? planNodes.map((n) => n.logicalId) : undefined);
  }

  // Under restore-original, ANY awaiting-decision seat blocks the whole action —
  // restore-original NEVER silently fresh-primes (the honesty contract).
  const blockedSeats = planNodes.filter((n) => n.intendedAction === "awaiting-decision");
  const isBlocked = policy === "restore-original" && blockedSeats.length > 0;
  const canExecute = !isBlocked && planNodes.length > 0 && !planMut.isPending && !launchMut.isPending;

  function execute() {
    // fresh = an explicit, labeled all-seats operator choice → per-seat freshLogicalIds.
    launchMut.mutate(policy === "fresh" ? allSeatIds : undefined, {
      onSuccess: () => onOpenChange(false),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent hideCloseButton className="max-w-3xl border-stone-900" data-testid="launch-recovery-modal">
        <DialogHeader>
          <DialogTitle className="font-headline uppercase tracking-tight flex items-center gap-2">
            <RotateCcw className="h-4 w-4" />
            Restore {rigName}
          </DialogTitle>
          <DialogDescription className="font-mono text-[10px] text-secondary">
            Plan before action — this is a READ-ONLY preview. No changes made yet.
          </DialogDescription>
        </DialogHeader>

        {/* Policy picker — restore-original (default) + fresh only (no best-effort). */}
        <div className="flex gap-2" data-testid="launch-policy-picker">
          <PolicyOption
            policy="restore-original"
            label="Restore original"
            selected={policy === "restore-original"}
            sub="Resume original sessions only. If a seat can't resume, fail loudly — never fresh-prime silently."
            onSelect={() => selectPolicy("restore-original")}
          />
          <PolicyOption
            policy="fresh"
            label="Fresh"
            selected={policy === "fresh"}
            warn
            sub="⚠ Identity/context-changing — creates NEW sessions for ALL seats. Previous conversation context is NOT restored."
            onSelect={() => selectPolicy("fresh")}
          />
        </div>

        {/* Blocked banner — the honesty contract, front and center. */}
        {isBlocked ? (
          <div
            data-testid="launch-blocked-banner"
            className="border border-tertiary bg-tertiary/10 px-3 py-2 flex items-start gap-2"
          >
            <Ban className="h-3.5 w-3.5 text-tertiary shrink-0" />
            <div className="font-mono text-[9px] leading-relaxed text-tertiary">
              <span className="font-bold uppercase">restore-original blocked</span> — {blockedSeats.length} seat(s)
              need a decision. restore-original will NOT silently fresh-prime. Resolve each seat below, or switch to{" "}
              <span className="underline">fresh</span> (identity-changing) for the whole rig.
            </div>
          </div>
        ) : null}

        {planMut.isPending ? (
          <p data-testid="launch-plan-loading" className="font-mono text-[10px] text-secondary py-4">
            Fetching read-only plan…
          </p>
        ) : planMut.isError ? (
          <p data-testid="launch-plan-error" className="font-mono text-[10px] text-tertiary py-4">
            Could not fetch plan: {(planMut.error as Error).message}
          </p>
        ) : (
          <>
            {/* Per-seat plan table — independent TOKEN + PLAN columns per seat. */}
            <Table data-testid="launch-plan-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="font-mono text-[9px]">Seat</TableHead>
                  <TableHead className="font-mono text-[9px]">Token</TableHead>
                  <TableHead className="font-mono text-[9px]">Plan</TableHead>
                  <TableHead className="font-mono text-[9px]">Prompt / note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {planNodes.map((s) => (
                  <TableRow key={s.logicalId} data-testid={`plan-row-${s.logicalId}`}>
                    <TableCell className="py-2 font-mono text-[10px] font-medium">{s.logicalId}</TableCell>
                    <TableCell className="py-2 font-mono text-[9px]" data-testid={`plan-token-${s.logicalId}`}>
                      <span className={cn(tokenTone[s.tokenState])}>{s.tokenState}</span>
                    </TableCell>
                    <TableCell className="py-2" data-testid={`plan-verdict-${s.logicalId}`}>
                      <StatusPip status={verdictPip[s.intendedAction]} variant="pill" label={s.intendedAction} />
                    </TableCell>
                    <TableCell className="py-2 font-mono text-[9px] text-secondary">
                      {s.runtimePrompt ?? s.reason ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {launchMut.isError ? (
              <p data-testid="launch-execute-error" className="font-mono text-[9px] text-tertiary">
                {(launchMut.error as Error).message}
              </p>
            ) : null}
          </>
        )}

        <DialogFooter className="items-center gap-2">
          <p className="mr-auto font-mono text-[8px] text-stone-400 leading-snug">
            src: composed from /api/rigs/:id/launch-plan (read-only forecast · mutated:false)
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="font-mono text-[10px]"
            onClick={() => onOpenChange(false)}
            data-testid="launch-cancel"
          >
            Cancel
          </Button>
          <Button
            variant={policy === "fresh" ? "destructive" : "default"}
            size="sm"
            disabled={!canExecute}
            onClick={execute}
            data-testid="launch-execute"
            className="font-mono text-[10px] tracking-widest"
          >
            {isBlocked
              ? "Resolve blockers to restore"
              : policy === "fresh"
                ? "Fresh-prime all seats ▸"
                : "Restore original ▸"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
