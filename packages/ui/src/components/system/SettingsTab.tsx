// User Settings v0 — System drawer Settings tab.
//
// Three sections at v0: Workspace, Files, Progress. Each setting shows
// the resolved value + source (env / file / default) + default.
// Operators set per-key via inline form; Init Workspace button + Reset
// button per setting.
//
// Keep this read+write surface small. The CLI (`rig config get/set/reset`)
// is the canonical agent-edit path per founder dialog.

import { useState, type ReactNode } from "react";
import {
  useSettings,
  useSetSetting,
  useResetSetting,
  useInitWorkspace,
  type SettingsKey,
  type ResolvedSetting,
} from "../../hooks/useSettings.js";

interface SettingsRowProps {
  label: string;
  settingKey: SettingsKey;
  resolved: ResolvedSetting;
  testIdPrefix: string;
}

function SettingsRow({ label, settingKey, resolved, testIdPrefix }: SettingsRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(resolved.value ?? ""));
  const [error, setError] = useState<string | null>(null);
  const setMutation = useSetSetting();
  const resetMutation = useResetSetting();

  const isOverridden = resolved.source !== "default";

  const onSave = async () => {
    setError(null);
    try {
      await setMutation.mutateAsync({ key: settingKey, value: draft });
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onReset = async () => {
    setError(null);
    try {
      await resetMutation.mutateAsync(settingKey);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div
      data-testid={`${testIdPrefix}-${settingKey}`}
      className="border border-stone-300/40 bg-white/8 px-3 py-2 space-y-1"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-stone-700 truncate">{label}</span>
        <span className="font-mono text-[8px] uppercase tracking-[0.10em] text-stone-500 shrink-0">
          source: {resolved.source}
        </span>
      </div>
      {editing ? (
        <div className="space-y-1">
          <input
            data-testid={`${testIdPrefix}-${settingKey}-input`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full border border-stone-300 bg-white/80 px-2 py-1 font-mono text-[10px]"
          />
          <div className="flex gap-2">
            <button
              data-testid={`${testIdPrefix}-${settingKey}-save`}
              onClick={() => void onSave()}
              disabled={setMutation.isPending}
              className="font-mono text-[8px] uppercase border border-stone-300 px-2 py-0.5 hover:bg-stone-200 disabled:opacity-50"
            >
              Save
            </button>
            <button
              onClick={() => { setEditing(false); setDraft(String(resolved.value ?? "")); setError(null); }}
              className="font-mono text-[8px] uppercase text-stone-500 hover:text-stone-900"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-0.5">
          <div className="font-mono text-[10px] text-stone-800 break-all">{String(resolved.value ?? "")}</div>
          <div className="font-mono text-[8px] text-stone-500 break-all">default: {String(resolved.defaultValue ?? "")}</div>
          <div className="flex gap-1 pt-1">
            <button
              data-testid={`${testIdPrefix}-${settingKey}-edit`}
              onClick={() => { setEditing(true); setError(null); }}
              className="font-mono text-[8px] uppercase border border-stone-300 px-1 py-0.5 hover:bg-stone-200"
            >
              Edit
            </button>
            {isOverridden && (
              <button
                data-testid={`${testIdPrefix}-${settingKey}-reset`}
                onClick={() => void onReset()}
                disabled={resetMutation.isPending}
                className="font-mono text-[8px] uppercase border border-stone-300 px-1 py-0.5 hover:bg-stone-200 disabled:opacity-50"
              >
                Reset
              </button>
            )}
          </div>
        </div>
      )}
      {error && <div data-testid={`${testIdPrefix}-${settingKey}-error`} className="font-mono text-[9px] text-red-600">{error}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-stone-500">{title}</div>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

export function SettingsTab() {
  const { data, isLoading, error } = useSettings();
  const initWorkspace = useInitWorkspace();
  const [initResult, setInitResult] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  const onInitWorkspace = async () => {
    setInitError(null);
    setInitResult(null);
    try {
      const r = await initWorkspace.mutateAsync({});
      setInitResult(`Initialized at ${r.root} — created ${r.subdirs.filter((s) => s.created).length} subdir(s).`);
    } catch (err) {
      setInitError((err as Error).message);
    }
  };

  if (isLoading) {
    return <div data-testid="settings-loading" className="px-4 py-3 font-mono text-[10px] text-stone-400">Loading settings…</div>;
  }
  if (error || !data) {
    return (
      <div data-testid="settings-error" className="px-4 py-3 font-mono text-[10px] text-red-600">
        Could not load settings: {(error as Error)?.message ?? "unknown"}
      </div>
    );
  }

  const s = data.settings;

  return (
    <div data-testid="settings-tab" className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
      <Section title="Workspace">
        <SettingsRow label="Workspace root" settingKey="workspace.root" resolved={s["workspace.root"]} testIdPrefix="setting" />
        <SettingsRow label="Slices root" settingKey="workspace.slices_root" resolved={s["workspace.slices_root"]} testIdPrefix="setting" />
        <SettingsRow label="Steering path" settingKey="workspace.steering_path" resolved={s["workspace.steering_path"]} testIdPrefix="setting" />
        <SettingsRow label="Field notes root" settingKey="workspace.field_notes_root" resolved={s["workspace.field_notes_root"]} testIdPrefix="setting" />
        <SettingsRow label="Specs root" settingKey="workspace.specs_root" resolved={s["workspace.specs_root"]} testIdPrefix="setting" />
        <button
          data-testid="settings-init-workspace"
          onClick={() => void onInitWorkspace()}
          disabled={initWorkspace.isPending}
          className="mt-2 font-mono text-[9px] uppercase border border-stone-400 px-2 py-1 hover:bg-stone-200 disabled:opacity-50"
        >
          {initWorkspace.isPending ? "Initializing…" : "Init Workspace"}
        </button>
        {initResult && <div data-testid="settings-init-result" className="font-mono text-[9px] text-stone-600">{initResult}</div>}
        {initError && <div data-testid="settings-init-error" className="font-mono text-[9px] text-red-600">{initError}</div>}
      </Section>

      <Section title="Files (browser allowlist)">
        <SettingsRow label="Allowlist (name:/abs/path,...)" settingKey="files.allowlist" resolved={s["files.allowlist"]} testIdPrefix="setting" />
      </Section>

      <Section title="Progress">
        <SettingsRow label="Scan roots (name:/abs/path,...)" settingKey="progress.scan_roots" resolved={s["progress.scan_roots"]} testIdPrefix="setting" />
      </Section>

      <Section title="Daemon (legacy)">
        <SettingsRow label="Port" settingKey="daemon.port" resolved={s["daemon.port"]} testIdPrefix="setting" />
        <SettingsRow label="Host" settingKey="daemon.host" resolved={s["daemon.host"]} testIdPrefix="setting" />
      </Section>

      <Section title="Database / Transcripts (legacy)">
        <SettingsRow label="DB path" settingKey="db.path" resolved={s["db.path"]} testIdPrefix="setting" />
        <SettingsRow label="Transcripts enabled" settingKey="transcripts.enabled" resolved={s["transcripts.enabled"]} testIdPrefix="setting" />
        <SettingsRow label="Transcripts path" settingKey="transcripts.path" resolved={s["transcripts.path"]} testIdPrefix="setting" />
      </Section>
    </div>
  );
}
