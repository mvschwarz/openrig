// Slice 27 — Claude Auto-Compaction Policy form.
//
// Operator-configurable pre-compaction trigger: when a Claude seat's
// context usage crosses `threshold_percent`, the daemon's ContextMonitor
// dispatches `/compact` via SessionTransport; the existing PreCompact
// hook injects the operator's `message_inline` (or contents of
// `message_file_path`) alongside the standard restore-instructions.
//
// Opt-in default-off. Empty inline + file path = standard restore behavior
// preserved. Designed to land on the slice 26 `/settings/policies` route
// once the route shell ships; while slice 26 is in flight, the form is
// also reachable from a temporary mount at `/settings/policies` here.

import { useState } from "react";
import type { FormEvent } from "react";
import { SectionHeader } from "../ui/section-header.js";
import { useSettings, useSetSetting } from "../../hooks/useSettings.js";

type FormState = {
  enabled: boolean;
  thresholdPercent: number;
  messageInline: string;
  messageFilePath: string;
};

const KEY_ENABLED = "policies.claude_compaction.enabled" as const;
const KEY_THRESHOLD = "policies.claude_compaction.threshold_percent" as const;
const KEY_INLINE = "policies.claude_compaction.message_inline" as const;
const KEY_FILE_PATH = "policies.claude_compaction.message_file_path" as const;

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function coerceNumber(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number(value);
    if (!Number.isNaN(n)) return n;
  }
  return fallback;
}

function coerceString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

export function ClaudeCompactionPolicyForm() {
  const { data, isLoading, error } = useSettings();
  const setSetting = useSetSetting();

  if (!data) {
    return (
      <section
        data-testid="claude-compaction-policy-form"
        className="border border-outline-variant p-5 bg-white/50"
      >
        <SectionHeader tone="muted">Policy</SectionHeader>
        <h2 className="font-headline text-headline-sm font-bold tracking-tight uppercase text-stone-900 mt-1">
          Claude Auto-Compaction
        </h2>
        {isLoading && (
          <p className="mt-4 text-sm text-on-surface-variant" data-testid="claude-compaction-policy-loading">
            Loading current settings…
          </p>
        )}
        {error && (
          <p className="mt-4 text-sm text-error" data-testid="claude-compaction-policy-error">
            {error instanceof Error ? error.message : String(error)}
          </p>
        )}
      </section>
    );
  }

  return <PolicyFormBody data={data.settings} setSetting={setSetting} />;
}

interface PolicyFormBodyProps {
  data: Record<string, { value: unknown }>;
  setSetting: ReturnType<typeof useSetSetting>;
}

function PolicyFormBody({ data, setSetting }: PolicyFormBodyProps) {
  const [form, setForm] = useState<FormState>(() => ({
    enabled: coerceBoolean(data[KEY_ENABLED]?.value, false),
    thresholdPercent: coerceNumber(data[KEY_THRESHOLD]?.value, 80),
    messageInline: coerceString(data[KEY_INLINE]?.value),
    messageFilePath: coerceString(data[KEY_FILE_PATH]?.value),
  }));
  const [thresholdError, setThresholdError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitOk, setSubmitOk] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitOk(false);
    setSubmitError(null);
    if (form.thresholdPercent < 1 || form.thresholdPercent > 100 || !Number.isInteger(form.thresholdPercent)) {
      setThresholdError("Threshold must be an integer between 1 and 100.");
      return;
    }
    setThresholdError(null);

    const updates: Array<{ key: Parameters<typeof setSetting.mutateAsync>[0]["key"]; value: string }> = [
      { key: KEY_ENABLED, value: form.enabled ? "true" : "false" },
      { key: KEY_THRESHOLD, value: String(form.thresholdPercent) },
      { key: KEY_INLINE, value: form.messageInline },
      { key: KEY_FILE_PATH, value: form.messageFilePath },
    ];
    try {
      for (const update of updates) {
        await setSetting.mutateAsync(update);
      }
      setSubmitOk(true);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section
      data-testid="claude-compaction-policy-form"
      className="border border-outline-variant p-5 bg-white/50"
    >
      <SectionHeader tone="muted">Policy</SectionHeader>
      <h2 className="font-headline text-headline-sm font-bold tracking-tight uppercase text-stone-900 mt-1">
        Claude Auto-Compaction
      </h2>
      <p className="mt-2 text-sm text-on-surface-variant max-w-prose">
        When a Claude seat's context usage crosses the configured threshold,
        OpenRig sends <code className="font-mono text-[12px]">/compact</code> to the seat.
        The existing pre-compaction hook continues to emit the standard
        restore packet; the optional custom message below is appended to the
        post-compaction system message.
      </p>

      <form
        className="mt-4 flex flex-col gap-5"
        onSubmit={handleSubmit}
        data-testid="claude-compaction-policy-form-element"
      >
        <label className="inline-flex items-center gap-2 text-sm text-stone-900">
          <input
            type="checkbox"
            data-testid="claude-compaction-enabled"
            checked={form.enabled}
            onChange={(e) => setForm((s) => ({ ...s, enabled: e.target.checked }))}
          />
          <span>Enable automatic pre-compaction trigger</span>
        </label>

        <div className="flex flex-col gap-1">
          <label htmlFor="claude-compaction-threshold" className="text-sm font-medium text-stone-900">
            Threshold percentage
          </label>
          <input
            id="claude-compaction-threshold"
            data-testid="claude-compaction-threshold"
            type="number"
            step={1}
            value={form.thresholdPercent}
            onChange={(e) => setForm((s) => ({ ...s, thresholdPercent: Number(e.target.value) }))}
            className="border border-outline-variant px-2 py-1 w-32 font-mono text-sm"
            aria-describedby="claude-compaction-threshold-hint"
          />
          <span className="text-xs text-on-surface-variant">
            Fires when context usage at-or-above this percentage (1–100).
          </span>
          {thresholdError && (
            <span className="text-xs text-error" data-testid="claude-compaction-threshold-error">
              {thresholdError}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="claude-compaction-inline" className="text-sm font-medium text-stone-900">
            Custom message (inline)
          </label>
          <textarea
            id="claude-compaction-inline"
            data-testid="claude-compaction-message-inline"
            rows={4}
            value={form.messageInline}
            onChange={(e) => setForm((s) => ({ ...s, messageInline: e.target.value }))}
            placeholder="Optional. Appended to the restore-instructions in the post-compaction system message."
            className="border border-outline-variant px-2 py-1 font-mono text-sm"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="claude-compaction-file" className="text-sm font-medium text-stone-900">
            Custom message (file path)
          </label>
          <input
            id="claude-compaction-file"
            data-testid="claude-compaction-message-file-path"
            type="text"
            value={form.messageFilePath}
            onChange={(e) => setForm((s) => ({ ...s, messageFilePath: e.target.value }))}
            placeholder="Optional. Path read at hook-fire time; ignored when inline is set."
            className="border border-outline-variant px-2 py-1 font-mono text-sm"
          />
          <span className="text-xs text-on-surface-variant">
            When both fields are set, inline wins. When neither is set, only
            the standard restore packet is injected.
          </span>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            data-testid="claude-compaction-policy-submit"
            disabled={setSetting.isPending}
            className="border border-outline px-4 py-2 bg-stone-900 text-white font-medium text-sm disabled:opacity-60"
          >
            {setSetting.isPending ? "Saving…" : "Save policy"}
          </button>
          {submitOk && (
            <span className="text-sm text-success" data-testid="claude-compaction-policy-saved">
              Saved.
            </span>
          )}
          {submitError && (
            <span className="text-sm text-error" data-testid="claude-compaction-policy-submit-error">
              {submitError}
            </span>
          )}
        </div>
      </form>
    </section>
  );
}
