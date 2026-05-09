import type { LucideIcon } from "lucide-react";
import { CheckCircle2, FilePenLine, Pause, Route, Send, ShieldX, Trash2 } from "lucide-react";
import type { ProjectMetaTone, ProjectToken } from "../project/ProjectMetaPrimitives.js";
import type { MissionControlVerb } from "./hooks/useMissionControlAction.js";

export interface ActionVerbMeta {
  label: string;
  outcomeLabel: string;
  description: string;
  tone: ProjectMetaTone;
  icon: LucideIcon;
}

export const ACTION_VERB_META: Record<MissionControlVerb, ActionVerbMeta> = {
  approve: {
    label: "Approve",
    outcomeLabel: "Approved",
    description: "Accept the work and let it close or continue.",
    tone: "success",
    icon: CheckCircle2,
  },
  deny: {
    label: "Deny",
    outcomeLabel: "Denied",
    description: "Reject this request and leave a reason if needed.",
    tone: "danger",
    icon: ShieldX,
  },
  route: {
    label: "Route",
    outcomeLabel: "Routed",
    description: "Send this to another session for follow-up.",
    tone: "info",
    icon: Route,
  },
  annotate: {
    label: "Annotate",
    outcomeLabel: "Annotated",
    description: "Add context without changing ownership.",
    tone: "neutral",
    icon: FilePenLine,
  },
  hold: {
    label: "Hold",
    outcomeLabel: "Held",
    description: "Pause this item until more context is available.",
    tone: "warning",
    icon: Pause,
  },
  drop: {
    label: "Drop",
    outcomeLabel: "Dropped",
    description: "Remove this item from the active path.",
    tone: "neutral",
    icon: Trash2,
  },
  handoff: {
    label: "Handoff",
    outcomeLabel: "Handed off",
    description: "Transfer active ownership to another session.",
    tone: "info",
    icon: Send,
  },
};

export function actionVerbToken(verb: MissionControlVerb, mode: "action" | "outcome" = "action"): ProjectToken {
  const meta = ACTION_VERB_META[verb];
  return {
    label: mode === "outcome" ? meta.outcomeLabel : meta.label,
    tone: meta.tone,
    icon: meta.icon,
  };
}
