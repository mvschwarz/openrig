// Preview Terminal v0 (PL-018) — pinned preview store.
//
// Per-session UI state (no daemon roundtrip). Pin persistence across
// browser refresh is OUT at v0 per PRD; this is in-memory only via a
// simple subscribable store (no Zustand dep needed for ~50 lines).
//
// Cap: ui.preview.max_pins (default 4) — enforced at pin time.

export interface PreviewPin {
  rigId: string;
  rigName: string;
  logicalId: string;
  sessionName: string;
}

type Listener = (pins: PreviewPin[]) => void;

class PreviewPinStore {
  private pins: PreviewPin[] = [];
  private listeners = new Set<Listener>();
  private maxPins = 4;

  setMaxPins(maxPins: number): void {
    this.maxPins = Math.max(1, Math.floor(maxPins));
    if (this.pins.length > this.maxPins) {
      this.pins = this.pins.slice(0, this.maxPins);
      this.notify();
    }
  }

  getMaxPins(): number {
    return this.maxPins;
  }

  list(): PreviewPin[] {
    return this.pins;
  }

  isPinned(rigId: string, logicalId: string): boolean {
    return this.pins.some((p) => p.rigId === rigId && p.logicalId === logicalId);
  }

  /**
   * Pin a seat. Returns true on success; false when the cap would be
   * exceeded (caller surfaces a UI hint).
   */
  pin(pin: PreviewPin): boolean {
    if (this.isPinned(pin.rigId, pin.logicalId)) return true;
    if (this.pins.length >= this.maxPins) return false;
    this.pins = [...this.pins, pin];
    this.notify();
    return true;
  }

  unpin(rigId: string, logicalId: string): void {
    const next = this.pins.filter((p) => !(p.rigId === rigId && p.logicalId === logicalId));
    if (next.length !== this.pins.length) {
      this.pins = next;
      this.notify();
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const l of this.listeners) l(this.pins);
  }
}

export const previewPinStore = new PreviewPinStore();
