// V1 attempt-3 Phase 3 bounce-fix — A3 fix.
//
// Smarter formatter for activity-feed event payloads. Original Phase 3
// LogPanel + RecentActivity only checked `payload.summary` and rendered
// "—" for events that don't carry that field — most events DO NOT.
//
// Strategy:
//   1. Try common message-style keys (summary, body, detail, message, title).
//   2. Build a compact key=value preview from up to 4 top-level payload keys
//      (skipping noise keys like timestamps and ULIDs).
//   3. Final fallback: JSON.stringify(payload).slice(0, 200).

const MESSAGE_KEYS = ["summary", "body", "detail", "message", "title", "text", "description"] as const;

const NOISE_KEYS = new Set([
  "ts",
  "ts_created",
  "ts_updated",
  "ts_emitted",
  "created_at",
  "updated_at",
  "received_at",
  "stream_sort_key",
  "audit_pointer",
]);

function shorten(s: string, max = 40): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function valuePreview(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const trimmed = v.trim();
    return trimmed.length > 0 ? shorten(trimmed) : null;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null; // skip nested objects/arrays in the compact preview
}

export function formatEventPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "—";
  const obj = payload as Record<string, unknown>;

  // Pass 1: explicit message keys.
  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && v.trim().length > 0) {
      return shorten(v.trim(), 200);
    }
  }

  // Pass 2: compact key=value preview of top-level scalar fields.
  const previewParts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (NOISE_KEYS.has(k)) continue;
    const preview = valuePreview(v);
    if (preview === null) continue;
    previewParts.push(`${k}=${preview}`);
    if (previewParts.length >= 4) break;
  }
  if (previewParts.length > 0) return previewParts.join(" · ");

  // Pass 3: JSON fallback (truncated).
  try {
    const json = JSON.stringify(obj);
    return shorten(json, 200);
  } catch {
    return "—";
  }
}
