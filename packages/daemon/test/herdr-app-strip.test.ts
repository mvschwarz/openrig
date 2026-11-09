// The rig-strip mod as herdr-app runs it: its own source, with the host modules ("herdr", "gpui-kit", "gpui-base")
// replaced by fakes, so its acknowledgement is exercised rather than faked.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(import.meta.dirname, "..", "assets", "herdr-app", "mods", "rig-strip", "main.js"), "utf8");

interface Host {
  props: Record<string, unknown>;
  layout: unknown;
  read(path: string): Promise<string | null>;
  writes: { path: string; text: string; expected: string | null }[];
}

/** Evaluates the strip's source with its imports bound to `host`, and returns a strip instance. */
function strip(host: Host) {
  const body = SOURCE
    .replace(/^import .*$/gm, "")
    .replace("export default class RigStrip", "return class RigStrip");
  const el = () => new Proxy({}, { get: (_t, _k, self) => () => self });
  const make = new Function("View", "div", "h_flex", "props", "theme", "run", "focused", "layout", "nextCommand",
    "appHome", "readTextFile", "writeTextFile", body);
  const RigStrip = make(class {}, el, el, () => host.props, () => ({}), () => null, () => null, () => host.layout,
    () => new Promise(() => {}), () => "/app", (path: string) => host.read(path),
    async (path: string, text: string, expected: string | null) => { host.writes.push({ path, text, expected }); return null; });
  return new RigStrip();
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function hostFor(read: Host["read"]): Host {
  const props = { stack: "rig-work", main: "tabs", revision: "r-1", views: [] };
  return {
    props,
    layout: { id: "root", children: [{ id: "rig-work", header: { content: { mod: "rig-strip", props } }, children: [{ id: "c1", content: { terminal: "t7" } }] }] },
    read,
    writes: [],
  };
}

describe("rig-strip acknowledgement", () => {
  it("acknowledges a write when ack.json is absent (herdr-app reads it as null)", async () => {
    const host = hostFor(async () => null);
    strip(host).acknowledge();
    await settle();
    expect(host.writes).toHaveLength(1);
    expect(host.writes[0]).toMatchObject({ path: "/app/openrig/ack.json", expected: null });
    expect(JSON.parse(host.writes[0]!.text)).toMatchObject({ revision: "r-1", terminals: ["t7"] });
  });

  it("still attempts the acknowledgement write when reading ack.json fails (whether herdr-app accepts that write is not simulated)", async () => {
    const host = hostFor(async () => { throw new Error("Text file exceeds 1 MiB"); });
    strip(host).acknowledge();
    await settle();
    expect(host.writes).toHaveLength(1);
    expect(JSON.parse(host.writes[0]!.text)).toMatchObject({ revision: "r-1", terminals: ["t7"] });
  });

  it("acknowledges a revision once", async () => {
    const host = hostFor(async () => null);
    const s = strip(host);
    s.acknowledge();
    await settle();
    s.acknowledge();
    await settle();
    expect(host.writes).toHaveLength(1);
  });
});
