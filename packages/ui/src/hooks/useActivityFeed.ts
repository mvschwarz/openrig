import { useEffect, useRef, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

const MAX_EVENTS = 30;

export interface ActivityEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
  receivedAt: number; // Date.now() when received
}

export interface UseActivityFeedResult {
  events: ActivityEvent[];
  connected: boolean;
  feedOpen: boolean;
  setFeedOpen: (open: boolean) => void;
}

export function useActivityFeed(): UseActivityFeedResult {
  const queryClient = useQueryClient();
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [feedOpen, setFeedOpen] = useState(false);
  const hasErroredRef = useRef(false);

  const addEvent = useCallback((data: string) => {
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      const event: ActivityEvent = {
        seq: typeof parsed["seq"] === "number" ? parsed["seq"] : Date.now(),
        type: (parsed["type"] as string) ?? "unknown",
        payload: parsed,
        createdAt: (parsed["createdAt"] as string) ?? new Date().toISOString(),
        receivedAt: Date.now(),
      };
      setEvents((prev) => [event, ...prev].slice(0, MAX_EVENTS));

      // Invalidate package queries on package mutation events
      if (event.type === "package.installed" || event.type === "package.rolledback") {
        queryClient.invalidateQueries({ queryKey: ["packages"] });
      }
      // Invalidate rig summary on bootstrap completion (new rig may have been created)
      if (event.type === "bootstrap.completed" || event.type === "bootstrap.partial") {
        queryClient.invalidateQueries({ queryKey: ["rigs", "summary"] });
      }
      // Invalidate discovery queries on discovery events
      if (event.type === "session.discovered" || event.type === "session.vanished") {
        queryClient.invalidateQueries({ queryKey: ["discovery"] });
      }
      // node.claimed: invalidate discovery + target rig graph
      if (event.type === "node.claimed") {
        queryClient.invalidateQueries({ queryKey: ["discovery"] });
        const rigId = event.payload["rigId"] as string | undefined;
        if (rigId) queryClient.invalidateQueries({ queryKey: ["rig", rigId, "graph"] });
      }
    } catch {
      // Ignore unparseable messages
    }
  }, [queryClient]);

  useEffect(() => {
    hasErroredRef.current = false;
    setConnected(false);

    const es = new EventSource("/api/events");

    es.addEventListener("open", () => {
      setConnected(true);
      hasErroredRef.current = false;
    });

    es.addEventListener("message", (event: Event) => {
      const msgEvent = event as MessageEvent;
      addEvent(msgEvent.data as string);
    });

    es.addEventListener("error", () => {
      setConnected(false);
      hasErroredRef.current = true;
    });

    return () => {
      es.close();
    };
  }, [addEvent]);

  return { events, connected, feedOpen, setFeedOpen };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function tailId(value: unknown, length = 6): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.slice(-length);
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

export function formatLogTime(timestamp: string | number | Date): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "??:??:??";
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** Maps event type to a CSS color class for the status dot */
export function eventColor(type: string): string {
  if (type === "bundle.created") return "bg-accent";
  if (type.startsWith("bootstrap.")) return "bg-accent";
  if (type.startsWith("package.")) return "bg-primary";
  if (type.startsWith("rig.")) return "bg-accent";
  if (type.startsWith("snapshot.")) return "bg-primary";
  if (type.startsWith("restore.")) return "bg-warning";
  if (type === "chat.message") return "bg-primary";
  if (type === "node.startup_ready") return "bg-green-500";
  if (type === "node.startup_pending") return "bg-amber-400";
  if (type === "node.startup_failed") return "bg-destructive";
  if (type === "session.detached") return "bg-destructive";
  if (type === "session.discovered") return "bg-accent";
  if (type === "session.vanished") return "bg-destructive";
  if (type === "node.claimed") return "bg-primary";
  if (type === "node.launched") return "bg-primary";
  return "bg-foreground-muted-on-dark";
}

/** Maps event to a one-line summary string */
export function eventSummary(event: ActivityEvent): string {
  const p = event.payload;
  const rigTail = tailId(p["rigId"]);
  const snapTail = tailId(p["snapshotId"]);
  const installTail = tailId(p["installId"]);
  const nodeTail = tailId(p["nodeId"]);
  const logicalId = normalizeText(p["logicalId"]);
  const sender = normalizeText(p["sender"]);
  const body = normalizeText(p["body"]);

  switch (event.type) {
    case "bootstrap.planned":
      return `bootstrap planned ${p["sourceRef"]}`;
    case "bootstrap.started":
      return `bootstrap started ${p["sourceRef"]}`;
    case "bootstrap.completed":
      return rigTail ? `bootstrap rig#${rigTail} completed` : `bootstrap completed`;
    case "bootstrap.partial":
      return `bootstrap partial ${p["completed"]} ok ${p["failed"]} failed`;
    case "bootstrap.failed":
      return `error bootstrap ${p["error"]}`;
    case "package.validated":
      return `package ${p["packageName"]} validated`;
    case "package.planned":
      return `package ${p["packageName"]} planned ${p["actionable"]} actionable ${p["deferred"]} deferred`;
    case "package.installed":
      return `package ${p["packageName"]}@${p["packageVersion"]} ${p["applied"]} applied ${p["deferred"]} deferred`;
    case "package.rolledback":
      return installTail ? `rollback install#${installTail} restored ${p["restored"]}` : `rollback restored ${p["restored"]}`;
    case "package.install_failed":
      return `error package ${p["packageName"]} ${p["message"]}`;
    case "rig.created":
      return rigTail ? `rig rig#${rigTail} created` : "rig created";
    case "rig.deleted":
      return rigTail ? `rig rig#${rigTail} deleted` : "rig deleted";
    case "rig.imported":
      return rigTail ? `import ${p["specName"]} rig#${rigTail} created` : `import ${p["specName"]} created`;
    case "snapshot.created":
      return rigTail && snapTail ? `snapshot rig#${rigTail} ${p["kind"]} snap#${snapTail}` : `snapshot ${p["kind"]}`;
    case "restore.started":
      return rigTail ? `restore rig#${rigTail} started` : "restore started";
    case "restore.completed": {
      const nodes = Array.isArray(p["result"]) ? p["result"] : ((p["result"] as Record<string, unknown>)?.["nodes"] as unknown[]) ?? [];
      return rigTail ? `restore rig#${rigTail} ${nodes.length} nodes restored` : `restore ${nodes.length} nodes restored`;
    }
    case "node.launched":
      return `startup ${logicalId ?? normalizeText(p["nodeId"]) ?? "unknown"} launched`;
    case "node.startup_pending":
      return nodeTail ? `startup node#${nodeTail} pending` : "startup pending";
    case "node.startup_ready":
      return nodeTail ? `startup node#${nodeTail} ready` : "startup ready";
    case "node.startup_failed":
      return nodeTail ? `error startup node#${nodeTail} ${p["error"]}` : `error startup ${p["error"]}`;
    case "session.detached":
      return `error session ${p["sessionName"]} lost`;
    case "bundle.created":
      return `bundle ${p["bundleName"]} v${p["bundleVersion"]} bundled`;
    case "session.discovered":
      return `discover ${p["tmuxSession"]}:${p["tmuxPane"]} ${p["runtimeHint"]}`;
    case "session.vanished":
      return `error ${p["tmuxSession"]}:${p["tmuxPane"]} vanished`;
    case "node.claimed":
      return rigTail ? `claim ${p["logicalId"]} rig#${rigTail}` : `claim ${p["logicalId"]}`;
    case "chat.message":
      return `chat ${sender ?? "unknown"}: ${body ?? ""}`.trim();
    default:
      return event.type;
  }
}

/** Returns a route path for navigable events, or null for non-navigable ones */
export function eventRoute(event: ActivityEvent): string | null {
  const p = event.payload;
  const rigId = p["rigId"] as string | undefined;

  // Discovery events
  if (event.type === "session.discovered" || event.type === "session.vanished") return "/discovery";
  if (event.type === "node.claimed") {
    const claimRigId = event.payload["rigId"] as string | undefined;
    return claimRigId ? `/rigs/${claimRigId}` : "/discovery";
  }

  // Bootstrap events navigate to /bootstrap
  if (event.type.startsWith("bootstrap.")) return "/bootstrap";

  // Package events navigate to /packages
  if (event.type.startsWith("package.")) return "/packages";

  // Rig-scoped events
  if (rigId) {
    return `/rigs/${rigId}`;
  }

  return null;
}
