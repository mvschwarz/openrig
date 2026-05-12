// Slice 27 — Claude Auto-Compaction Policy form.
//
// Operator-configurable pre-compaction trigger: when a Claude seat's
// context usage crosses `threshold_percent`, the daemon's ContextMonitor
// dispatches `/compact` via SessionTransport, optionally with
// `compact_instruction` as slash-command args. The compaction hooks
// inject the operator's `message_inline` (or contents of
// `message_file_path`) alongside the standard restore-instructions.
//
// Opt-in default-off. Empty instruction + inline + file path preserves
// standard restore behavior.

import { useState } from "react";
import type { FormEvent } from "react";
import { SectionHeader } from "../ui/section-header.js";
import { useSettings, useSetSetting } from "../../hooks/useSettings.js";

type FormState = {
  enabled: boolean;
  thresholdPercent: string;
  compactInstruction: string;
  messageInline: string;
  messageFilePath: string;
};

const KEY_ENABLED = "policies.claude_compaction.enabled" as const;
const KEY_THRESHOLD = "policies.claude_compaction.threshold_percent" as const;
const KEY_COMPACT_INSTRUCTION = "policies.claude_compaction.compact_instruction" as const;
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
    thresholdPercent: String(coerceNumber(data[KEY_THRESHOLD]?.value, 80)),
    compactInstruction: coerceString(data[KEY_COMPACT_INSTRUCTION]?.value),
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
    const thresholdRaw = form.thresholdPercent.trim();
    const thresholdValue = Number(thresholdRaw);
    if (!/^\d+$/.test(thresholdRaw) || thresholdValue < 1 || thresholdValue > 100) {
      setThresholdError("Threshold must be an integer between 1 and 100.");
      return;
    }
    setThresholdError(null);

    const updates: Array<{ key: Parameters<typeof setSetting.mutateAsync>[0]["key"]; value: string }> = [
      { key: KEY_ENABLED, value: form.enabled ? "true" : "false" },
      { key: KEY_THRESHOLD, value: String(thresholdValue) },
      { key: KEY_COMPACT_INSTRUCTION, value: form.compactInstruction },
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
        OpenRig arms an automatic compaction and sends
        <code className="font-mono text-[12px]"> /compact</code> once the seat is idle
        with an empty prompt. Compaction instructions are sent with that slash
        command. After compaction, OpenRig sends one restore prompt that points
        the seat at its restore packet.
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
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={form.thresholdPercent}
            onChange={(e) => setForm((s) => ({ ...s, thresholdPercent: e.target.value }))}
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
          <label htmlFor="claude-compaction-compact-instruction" className="text-sm font-medium text-stone-900">
            Compaction instruction
          </label>
          <textarea
            id="claude-compaction-compact-instruction"
            data-testid="claude-compaction-compact-instruction"
            rows={3}
            value={form.compactInstruction}
            onChange={(e) => setForm((s) => ({ ...s, compactInstruction: e.target.value }))}
            placeholder="Optional. Sent as /compact <instruction> when OpenRig triggers compaction."
            className="border border-outline-variant px-2 py-1 font-mono text-sm"
          />
          <span className="text-xs text-on-surface-variant">
            This controls the compaction summary itself.
          </span>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="claude-compaction-inline" className="text-sm font-medium text-stone-900">
            Post-compaction restore instruction (inline)
          </label>
          <textarea
            id="claude-compaction-inline"
            data-testid="claude-compaction-message-inline"
            rows={4}
            value={form.messageInline}
            onChange={(e) => setForm((s) => ({ ...s, messageInline: e.target.value }))}
            placeholder="Optional. Appended to the restore directive after compaction."
            className="border border-outline-variant px-2 py-1 font-mono text-sm"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="claude-compaction-file" className="text-sm font-medium text-stone-900">
            Post-compaction restore instruction (file path)
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
