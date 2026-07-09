// OPR.0.4.6.MH1 FR-5 — the dashboard host-config component: YOUR host
// (renamable, FR-4) + every added host (address, transport, status,
// selected marker) + the add affordance (pair-first, FR-6) + the
// switcher (FR-1).
//
// SWITCHER SCOPE (the PRD §7 open item, resolved EXPLICITLY 2026-07-07,
// planner2 confirm — the qa2 no-silent-narrowing bind): selecting a host
// persists the host.selected pointer + renders honest selection state
// (marker + banner); flagless CLI commands consume it (FR-2). It does
// NOT retarget the UI's own data surfaces — UI surfaces rendering the
// selected host's data is MH-2 remote read-through (PRD §5 OOS line 1;
// P1-intent MH-2 mini-req 1). If founder taste later wants selection to
// drive UI retarget, that lands as MH-2 work on the read-through
// substrate, not a re-open of this slice.
//
// WRITE paths: switcher + rename = the settings store (useSetSetting →
// POST /api/config/host.selected|host.name — the ONE selection/name
// store both surfaces read); add = the pair handshake through the local
// daemon's narrow named route family (arch B1/P1 — the browser's write
// seam is its local daemon; both surfaces converge on the one registry
// write contract).

import { useState } from "react";
import { useSettings, useSetSetting } from "../../hooks/useSettings.js";
import { useHosts, usePairHost, usePairPoll, type HostRow } from "../../hooks/useHosts.js";

function settingValue(settings: ReturnType<typeof useSettings>["data"], key: string): string {
  const raw = settings?.settings?.[key as never] as { value?: unknown } | undefined;
  return typeof raw?.value === "string" ? raw.value : "";
}

function hostAddress(h: HostRow): string {
  return h.transport === "ssh" ? (h.target ?? "—") : (h.url ?? "—");
}

export function HostConfigCard() {
  const { data: settings } = useSettings();
  const { data: hosts, error: hostsError } = useHosts();
  const setSetting = useSetSetting();
  const pairHost = usePairHost();

  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [addDraft, setAddDraft] = useState("");
  const [pairId, setPairId] = useState<string | null>(null);
  const pairPoll = usePairPoll(pairId);

  const ownName = settingValue(settings, "host.name") || hosts?.ownName || "localhost";
  const selected = settingValue(settings, "host.selected") || hosts?.selected || "local";
  const rows = hosts?.hosts ?? [];

  const pairState = pairPoll.data?.status;
  const pairCode = pairPoll.data?.code ?? pairHost.data?.code;

  async function startPair() {
    const url = addDraft.trim();
    if (!url) return;
    try {
      const started = await pairHost.mutateAsync({ url });
      setPairId(started.pairId);
    } catch {
      // pairHost.error renders below — nothing else to do.
    }
  }

  function finishPair() {
    setPairId(null);
    setAddDraft("");
    pairHost.reset();
  }

  return (
    <section data-testid="dashboard-host-config" className="df-hosts">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-secondary mb-2">
        Hosts
      </div>

      {/* YOUR host (FR-4: one stored name, renamable). */}
      <div className="df-hosts-own" data-testid="host-config-own">
        {renaming ? (
          <form
            className="df-hosts-rename"
            onSubmit={(e) => {
              e.preventDefault();
              const v = nameDraft.trim();
              if (v) void setSetting.mutateAsync({ key: "host.name" as never, value: v });
              setRenaming(false);
            }}
          >
            <input
              data-testid="host-rename-input"
              className="df-hosts-input"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              autoFocus
            />
            <button type="submit" className="df-hosts-btn">Save</button>
            <button type="button" className="df-hosts-btn" onClick={() => setRenaming(false)}>Cancel</button>
          </form>
        ) : (
          <>
            <span data-testid="host-own-name" className="df-hosts-name">{ownName}</span>
            <span className="df-hosts-tag">this host</span>
            {selected === "local" ? (
              <span data-testid="host-selected-marker-local" className="df-hosts-selected">selected</span>
            ) : (
              <button
                type="button"
                className="df-hosts-btn"
                data-testid="host-select-local"
                onClick={() => void setSetting.mutateAsync({ key: "host.selected" as never, value: "local" })}
              >
                Select
              </button>
            )}
            <button
              type="button"
              className="df-hosts-btn"
              data-testid="host-rename-button"
              onClick={() => { setNameDraft(ownName); setRenaming(true); }}
            >
              Rename
            </button>
          </>
        )}
      </div>

      {/* Added hosts: one registry, two surfaces (FR-5 AC). */}
      {hostsError ? (
        <div className="df-hosts-empty">host registry unreadable: {String((hostsError as Error).message)}</div>
      ) : rows.length === 0 ? (
        <div data-testid="host-config-empty" className="df-hosts-empty">
          No remote hosts yet. Paste an address below and pair — one approval on the target, done.
        </div>
      ) : (
        <ul className="df-hosts-list" data-testid="host-config-rows">
          {rows.map((h) => (
            <li key={h.id} className="df-hosts-row">
              <span className="df-hosts-marker">{h.selected ? "*" : ""}</span>
              <span className="df-hosts-id">{h.id}</span>
              <span className="df-hosts-addr">{hostAddress(h)}</span>
              <span className="df-hosts-transport">{h.transport}</span>
              <span className={`df-hosts-status df-hosts-status-${h.status}`}>{h.status}</span>
              {h.selected ? (
                <span className="df-hosts-selected" data-testid={`host-selected-marker-${h.id}`}>selected</span>
              ) : (
                <button
                  type="button"
                  className="df-hosts-btn"
                  data-testid={`host-select-${h.id}`}
                  onClick={() => void setSetting.mutateAsync({ key: "host.selected" as never, value: h.id })}
                >
                  Select
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {selected !== "local" ? (
        <div className="df-hosts-banner" data-testid="host-selection-banner">
          Selected host: {selected} — flagless CLI commands run against it (rig host select local returns).
        </div>
      ) : null}

      {/* The add affordance: pair-first (FR-6 — the ceremony is never the
          front door). */}
      {pairId === null ? (
        <form
          className="df-hosts-add"
          onSubmit={(e) => { e.preventDefault(); void startPair(); }}
        >
          <input
            data-testid="host-pair-input"
            className="df-hosts-input"
            placeholder="http://host:7433 — pair a new host"
            value={addDraft}
            onChange={(e) => setAddDraft(e.target.value)}
          />
          <button type="submit" className="df-hosts-btn" data-testid="host-pair-button" disabled={pairHost.isPending}>
            Pair
          </button>
          {pairHost.error ? (
            <span className="df-hosts-error" data-testid="host-pair-error">{pairHost.error.message}</span>
          ) : null}
        </form>
      ) : (
        <div className="df-hosts-pairing" data-testid="host-pairing">
          {pairState === "approved" ? (
            <>
              <span>Paired.</span>
              <button type="button" className="df-hosts-btn" onClick={finishPair}>Done</button>
            </>
          ) : pairState === "denied" || pairState === "expired" ? (
            <>
              <span data-testid="host-pair-outcome">Pairing {pairState} — nothing was persisted.</span>
              <button type="button" className="df-hosts-btn" onClick={finishPair}>Dismiss</button>
            </>
          ) : (
            <>
              <span data-testid="host-pair-code">Code {pairCode ?? "…"} — waiting for approval on the target.</span>
              <button type="button" className="df-hosts-btn" onClick={finishPair}>Cancel</button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
