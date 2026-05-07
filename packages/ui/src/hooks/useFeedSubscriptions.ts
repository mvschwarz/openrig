// V1 attempt-3 Phase 5 P5-3 — For You feed subscription state hook.
//
// Reads the 5 feed.subscriptions.* allowlist keys from /api/config and
// provides a toggle function that writes back via /api/config/<key>.
// Per for-you-feed.md L144-L151:
//   - action_required is FORCED ON (cannot be disabled per L145; the
//     UI surface this hook drives never renders an interactive toggle
//     for that key).
//   - approvals / shipped / progress default ON.
//   - audit_log default OFF.
//
// SC-29 exception scope (declared in Phase 5 ACK §5 DRIFT P5-D2): same
// as Phase 4 ConfigStore allowlist exception; allowlist-only additions.

import { useSettings, useSetSetting } from "./useSettings.js";
import type { FeedCardKind } from "../lib/feed-classifier.js";

export interface FeedSubscriptionState {
  actionRequired: boolean;
  approvals: boolean;
  shipped: boolean;
  progress: boolean;
  auditLog: boolean;
}

export type FeedSubscriptionToggleKey =
  | "approvals"
  | "shipped"
  | "progress"
  | "auditLog";

const TOGGLE_KEY_TO_CONFIG_KEY: Record<FeedSubscriptionToggleKey, string> = {
  approvals: "feed.subscriptions.approvals",
  shipped: "feed.subscriptions.shipped",
  progress: "feed.subscriptions.progress",
  auditLog: "feed.subscriptions.audit_log",
};

const DEFAULTS: FeedSubscriptionState = {
  actionRequired: true,
  approvals: true,
  shipped: true,
  progress: true,
  auditLog: false,
};

function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
  }
  return fallback;
}

export interface UseFeedSubscriptionsResult {
  state: FeedSubscriptionState;
  /** Toggle a non-forced subscription. action_required is forced ON and
   *  cannot be toggled — calling toggle("actionRequired") is intentionally
   *  not part of the API. */
  toggle: (key: FeedSubscriptionToggleKey) => void;
  /** True when the underlying setSetting mutation is in flight. */
  isMutating: boolean;
  /** True when the daemon does not expose /api/config (legacy v0.2.0). */
  unavailable: boolean;
}

export function useFeedSubscriptions(): UseFeedSubscriptionsResult {
  const { data, error } = useSettings();
  const setSetting = useSetSetting();

  const settings = data?.settings as Record<string, { value: unknown }> | undefined;
  const unavailable = !!error || !settings;

  const state: FeedSubscriptionState = unavailable
    ? DEFAULTS
    : {
        actionRequired: readBool(
          settings?.["feed.subscriptions.action_required"]?.value,
          DEFAULTS.actionRequired,
        ),
        approvals: readBool(
          settings?.["feed.subscriptions.approvals"]?.value,
          DEFAULTS.approvals,
        ),
        shipped: readBool(
          settings?.["feed.subscriptions.shipped"]?.value,
          DEFAULTS.shipped,
        ),
        progress: readBool(
          settings?.["feed.subscriptions.progress"]?.value,
          DEFAULTS.progress,
        ),
        auditLog: readBool(
          settings?.["feed.subscriptions.audit_log"]?.value,
          DEFAULTS.auditLog,
        ),
      };

  const toggle = (toggleKey: FeedSubscriptionToggleKey) => {
    const configKey = TOGGLE_KEY_TO_CONFIG_KEY[toggleKey];
    const current = state[toggleKey];
    setSetting.mutate({
      key: configKey as Parameters<typeof setSetting.mutate>[0]["key"],
      value: current ? "false" : "true",
    });
  };

  return {
    state,
    toggle,
    isMutating: setSetting.isPending,
    unavailable,
  };
}

/** Map a feed card kind to its subscription state field. Used by the
 *  Feed component to filter out cards whose subscription is OFF. */
export function isCardKindSubscribed(
  kind: FeedCardKind,
  state: FeedSubscriptionState,
): boolean {
  switch (kind) {
    case "action-required":
      return state.actionRequired; // always true in V1 (forced ON)
    case "approval":
      return state.approvals;
    case "shipped":
      return state.shipped;
    case "progress":
      return state.progress;
    case "observation":
      return state.auditLog;
  }
}
