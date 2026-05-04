// Preview Terminal v0 (PL-018) — useSyncExternalStore React hook
// wrapping the previewPinStore. Components that read pins should use
// this hook so they re-render on pin/unpin events.

import { useSyncExternalStore, useEffect } from "react";
import { previewPinStore, type PreviewPin } from "./preview-pin-store.js";
import { useSettings } from "../../hooks/useSettings.js";

export function usePreviewPins(): {
  pins: PreviewPin[];
  maxPins: number;
  pin: (pin: PreviewPin) => boolean;
  unpin: (rigId: string, logicalId: string) => void;
  isPinned: (rigId: string, logicalId: string) => boolean;
} {
  const { data: settings } = useSettings();
  const settingMaxPins = settings?.settings?.["ui.preview.max_pins"]?.value as number | undefined;

  // Sync max-pins from settings whenever it changes.
  useEffect(() => {
    if (typeof settingMaxPins === "number") {
      previewPinStore.setMaxPins(settingMaxPins);
    }
  }, [settingMaxPins]);

  const pins = useSyncExternalStore(
    (cb) => previewPinStore.subscribe(cb),
    () => previewPinStore.list(),
    () => previewPinStore.list(),
  );

  return {
    pins,
    maxPins: previewPinStore.getMaxPins(),
    pin: (p) => previewPinStore.pin(p),
    unpin: (rigId, logicalId) => previewPinStore.unpin(rigId, logicalId),
    isPinned: (rigId, logicalId) => previewPinStore.isPinned(rigId, logicalId),
  };
}
