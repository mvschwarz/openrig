import { describe, it, expect } from "vitest";
import { scopeForTarget } from "../src/domain/session-transport.js";

// Send/broadcast header (ruling 03c35295) — TargetSpec → EnvelopeScope mapping. The transport fan-out
// knows the target shape + the resolved recipient set, so it builds the honest scale scope daemon-side
// (a recipient tells DM vs multi vs rig-broadcast vs topology from the header alone — the anti-storm teeth).

describe("scopeForTarget — TargetSpec → EnvelopeScope (daemon-side scale truth)", () => {
  it("{session} → dm", () => {
    expect(scopeForTarget({ session: "a@r" }, ["a@r"])).toEqual({ kind: "dm" });
  });
  it("{sessions} → multi with the full recipient list", () => {
    expect(scopeForTarget({ sessions: ["a@r", "b@r"] }, ["a@r", "b@r"])).toEqual({ kind: "multi", recipients: ["a@r", "b@r"] });
  });
  it("{rig} → rig-broadcast with the seat count (the anti-storm scale)", () => {
    expect(scopeForTarget({ rig: "openrig-pm" }, ["a@pm", "b@pm", "c@pm"])).toEqual({ kind: "rig-broadcast", rig: "openrig-pm", seats: 3 });
  });
  it("{pod, rig} → a scoped broadcast labeled <rig>/<pod>", () => {
    expect(scopeForTarget({ pod: "dev", rig: "pm" }, ["a@pm", "b@pm"])).toEqual({ kind: "rig-broadcast", rig: "pm/dev", seats: 2 });
  });
  it("{global} → topology", () => {
    expect(scopeForTarget({ global: true }, ["a@r", "b@x"])).toEqual({ kind: "topology" });
  });
});
