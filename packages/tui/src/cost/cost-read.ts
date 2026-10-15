// Slice 02 — System → Cost: the shape of the daemon's cost view (the same body `rig usage cost --json` prints), as
// DaemonClient.usageCost() returns it. The read itself lives in daemon-client.ts, the TUI's one daemon module.

type Row = Record<string, unknown>;

export interface CostBody {
  seats: Array<Row & { seatSession: string; status: string }>;
  note: string;
}

export interface CostRead {
  /** The served cost view, or why it couldn't be read (status null: no HTTP answer). */
  status: { body: CostBody } | { status: number | null; error: string };
}
