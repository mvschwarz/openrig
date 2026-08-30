export interface ContinuitySeatIdentity {
  sessionName: string;
  successorSessionName: string;
  predecessorResumeHandle: string;
  mechanicDestination: string;
}

export const RUNG_1_STACK_STEPS = [
  "create-staged-unbound-successor",
  "freshness-check",
  "model-divergence-gate",
  "world-install",
  "mission-install",
  "position-grant",
  "introduce-yourself",
] as const;

export function rung1StackSteps(): string[] {
  return [...RUNG_1_STACK_STEPS];
}

export function renderRung1Packet(seat: ContinuitySeatIdentity): string {
  return [
    "# Continuity rung 1 — staged successor preparation",
    "",
    "Create a fresh, staged and unbound successor. Prove blank identity and the pinned model before installing anything; a reused conversation or fallback model makes every later receipt about the wrong occupant.",
    "",
    `Successor candidate: ${seat.successorSessionName}`,
    "First role read: `orienting-to-an-inherited-seat`. Keep that pointer in this durable packet, because a seat-name-keyed runtime prompt can outlive the occupant and become a ghost instruction.",
    "Then install the world, the mission, and the position in that order. The successor derives its own layer-5 delta and a second reader checks it; reading deposits is not proof they were installed.",
    "Open the apprenticeship as a conversation. The successor remains authority-free until the owner's word is recorded.",
  ].join("\n");
}

export function renderRung1IncumbentNotice(seat: ContinuitySeatIdentity): string {
  return [
    `Continuity prepare threshold crossed for ${seat.sessionName}.`,
    "Open `retiring-and-inheriting-a-seat` at its apprentice-mode section, then execute the documented rung-1 stack.",
    "Preserve advisory work while preparing the successor: the incumbent's accrued context is most valuable near the boundary.",
  ].join(" ");
}

export interface Rung2Baton {
  destination: string;
  template: string;
  custodyTable: Array<{ duty: string; holder: string; effectReceipt: string }>;
}

export function renderRung2Baton(seat: ContinuitySeatIdentity): Rung2Baton {
  return {
    destination: seat.mechanicDestination,
    template: [
      "Owned cutover baton — execute the portable cutover SOP; awareness-only is not custody.",
      "Delivery receipt: staged/submitted/consumed.",
      "Walker lease: one-active-walker.",
      "Authority: authority-effective-at-effect-receipt; intent-time claims do not count.",
      "Enumerate deposits and standing duties before the cutover. Do not rebind automatically; the mechanic acts only on the owner's word.",
    ].join("\n"),
    custodyTable: [],
  };
}

export function validateCustodyRecord(record: {
  claimedAt: "intent" | "effect";
  effectReceipt: string | null;
}): { ok: true } {
  if (record.claimedAt !== "effect" || !record.effectReceipt?.trim()) {
    throw new Error("custody requires a durable effect receipt; intent-time ownership is not effective custody");
  }
  return { ok: true };
}

export function checkStandingDutyCustody(input: {
  deposits: string[];
  custodyTable: string[];
}): { missing: string[] } {
  const held = new Set(input.custodyTable);
  return { missing: input.deposits.filter((duty) => !held.has(duty)) };
}

export interface GateReceipt {
  gate: string;
  evidence: string;
  worder: string;
}

export function validateGateModel(input: {
  receipts: GateReceipt[];
  simplerModel: string | null;
}): { ok: true; model: "receipts" | "declared-simpler" } {
  if (input.simplerModel?.trim()) return { ok: true, model: "declared-simpler" };
  const byGate = new Map(input.receipts.map((receipt) => [receipt.gate, receipt]));
  for (const gate of ["G0", "G1", "G2", "G3"]) {
    const receipt = byGate.get(gate);
    if (!receipt?.evidence.trim() || !receipt.worder.trim()) {
      throw new Error(`missing durable ${gate} receipt; declare a simpler model if this succession does not use G0–G3`);
    }
  }
  return { ok: true, model: "receipts" };
}

export function renderPostCutoverPacket(seat: ContinuitySeatIdentity): string {
  return [
    "Reach-back does not expire while the predecessor session record exists.",
    `Verbatim resume handle: claude -p --resume ${seat.predecessorResumeHandle}`,
    "Pre-formed questions: Which decision still depends on tacit context? Which failure tell should make the successor distrust the current shape?",
    "Ask the live predecessor for why; read durable artifacts for what. Treat every answer as testimony.",
  ].join("\n");
}

export function readyCheck(input: {
  expectedModel: string;
  liveModel: string;
  sessionName: string;
}): { ok: boolean; reason: string | null } {
  if (input.liveModel !== input.expectedModel) {
    return { ok: false, reason: "model_divergence" };
  }
  const local = input.sessionName.split("@")[0] ?? input.sessionName;
  if (/(?:-v\d+|-staged|-staging)$/.test(local)) {
    return { ok: false, reason: "noncanonical_successor_name" };
  }
  return { ok: true, reason: null };
}

export interface WidthRecoveryReceipt {
  postRestoreUsedPercentage: number;
  postRestoreUsableWidthPercentage: number;
  saturationBoundPercentage: number;
  widthRecovered: boolean;
  reason: "usable_width_recovered" | "restore_replayed_past_saturation_bound";
}

export function buildWidthRecoveryReceipt(input: {
  usedPercentage: number;
  maximumUsablePercentage: number;
}): WidthRecoveryReceipt {
  const used = Math.max(0, Math.min(100, input.usedPercentage));
  const bound = Math.max(0, Math.min(100, input.maximumUsablePercentage));
  const widthRecovered = used <= bound;
  return {
    postRestoreUsedPercentage: used,
    postRestoreUsableWidthPercentage: 100 - used,
    saturationBoundPercentage: bound,
    widthRecovered,
    reason: widthRecovered
      ? "usable_width_recovered"
      : "restore_replayed_past_saturation_bound",
  };
}
