// #192 — the channel map's pure resolution and validation. Made-up IDs only.
import { describe, it, expect } from "vitest";
import {
  validateChannelMap,
  unsupportedChannelMapFields,
  resolveOutboundChannel,
  mappedChannels,
  setChannelMapEntry,
  removeChannelMapEntry,
  type ChannelMapConfig,
} from "../src/domain/gateway/slack/channel-map.js";

const base: ChannelMapConfig = { channel: "C0DEFAULT" };
const cfg: ChannelMapConfig = {
  ...base,
  channelMap: [
    { match: "my-rig", channel: "C0EXAMPLE1" },
    { match: "pr@my-rig", channel: "C0EXAMPLE2" },
    { match: "other-rig", channel: "C0EXAMPLE3" },
  ],
};

describe("resolveOutboundChannel — seat, then rig, then default", () => {
  it("an exact seat entry wins over its rig entry", () => {
    expect(resolveOutboundChannel(cfg, "pr@my-rig")).toBe("C0EXAMPLE2");
  });
  it("a seat without its own entry uses its rig's entry", () => {
    expect(resolveOutboundChannel(cfg, "lead@my-rig")).toBe("C0EXAMPLE1");
    expect(resolveOutboundChannel(cfg, "impl@other-rig")).toBe("C0EXAMPLE3");
  });
  it("an unmapped seat, a missing session and a bare rig name use the default", () => {
    expect(resolveOutboundChannel(cfg, "lead@unmapped-rig")).toBe("C0DEFAULT");
    expect(resolveOutboundChannel(cfg, null)).toBe("C0DEFAULT");
    expect(resolveOutboundChannel(cfg, undefined)).toBe("C0DEFAULT");
    expect(resolveOutboundChannel(cfg, "my-rig")).toBe("C0DEFAULT"); // a bare rig name is not a seat
  });
  it("a rig entry never matches a seat whose member happens to equal the rig name", () => {
    expect(resolveOutboundChannel(cfg, "my-rig@elsewhere")).toBe("C0DEFAULT");
  });
  it("no map is today's behaviour exactly", () => {
    expect(resolveOutboundChannel(base, "pr@my-rig")).toBe("C0DEFAULT");
    expect(resolveOutboundChannel({ ...base, channelMap: [] }, "pr@my-rig")).toBe("C0DEFAULT");
    expect(resolveOutboundChannel({ channel: null }, "pr@my-rig")).toBeNull();
  });
});

describe("mappedChannels — every unique channel, default first", () => {
  it("lists the default and each mapped channel once, naming what maps there", () => {
    const shared: ChannelMapConfig = { ...base, channelMap: [
      { match: "my-rig", channel: "C0EXAMPLE1" },
      { match: "other-rig", channel: "C0EXAMPLE1" },
      { match: "pr@my-rig", channel: "C0EXAMPLE2" },
      { match: "qa@my-rig", channel: "C0DEFAULT" },
    ] };
    expect(mappedChannels(shared)).toEqual([
      { channel: "C0DEFAULT", isDefault: true, matches: ["qa@my-rig"] },
      { channel: "C0EXAMPLE1", isDefault: false, matches: ["my-rig", "other-rig"] },
      { channel: "C0EXAMPLE2", isDefault: false, matches: ["pr@my-rig"] },
    ]);
  });
  it("without a map it is the default channel alone; without any channel it is empty", () => {
    expect(mappedChannels(base)).toEqual([{ channel: "C0DEFAULT", isDefault: true, matches: [] }]);
    expect(mappedChannels({ channel: null })).toEqual([]);
  });
});

describe("validateChannelMap — teaching errors", () => {
  const withMap = (channelMap: unknown): ChannelMapConfig => ({ ...base, channelMap: channelMap as ChannelMapConfig["channelMap"] });

  it("accepts an absent map, an empty map and a well-formed map", () => {
    expect(() => validateChannelMap(base)).not.toThrow();
    expect(() => validateChannelMap(withMap([]))).not.toThrow();
    expect(() => validateChannelMap(cfg)).not.toThrow();
  });
  it("rejects a non-array map and non-object entries", () => {
    expect(() => validateChannelMap(withMap({ "my-rig": "C1" }))).toThrow(/must be an array/);
    expect(() => validateChannelMap(withMap(["my-rig"]))).toThrow(/channelMap\[0\] must be an object/);
  });
  it("rejects a match that is neither a rig name nor a member@rig seat", () => {
    expect(() => validateChannelMap(withMap([{ match: "", channel: "C1" }]))).toThrow(/match must be a rig name/);
    expect(() => validateChannelMap(withMap([{ match: "@my-rig", channel: "C1" }]))).toThrow(/is not a seat/);
    expect(() => validateChannelMap(withMap([{ match: "alice@external", channel: "C1" }]))).toThrow(/is not a seat/);
    expect(() => validateChannelMap(withMap([{ match: "my rig", channel: "C1" }]))).toThrow(/rig name "my rig" contains " "/);
  });
  it("rejects a missing or malformed channel ID", () => {
    expect(() => validateChannelMap(withMap([{ match: "my-rig" }]))).toThrow(/channel must be a Slack channel ID/);
    expect(() => validateChannelMap(withMap([{ match: "my-rig", channel: "C1 C2" }]))).toThrow(/channel must be a Slack channel ID/);
  });
  it("rejects duplicate matches", () => {
    expect(() => validateChannelMap(withMap([{ match: "my-rig", channel: "C1" }, { match: "my-rig", channel: "C2" }])))
      .toThrow("channelMap has two entries for 'my-rig': edit slack-connector.json by hand and keep one entry");
  });
  it("accepts several entries sharing one channel, including the default", () => {
    expect(() => validateChannelMap(withMap([
      { match: "my-rig", channel: "C0EXAMPLE1" }, { match: "pr@my-rig", channel: "C0EXAMPLE1" }, { match: "qa@my-rig", channel: "C0DEFAULT" },
    ]))).not.toThrow();
  });
  it("an unsupported entry field is refused when writing and ignored (but reported) when reading", () => {
    const newer = withMap([{ match: "my-rig", channel: "C1", inbound: "lead@my-rig" }]);
    expect(() => validateChannelMap(newer)).toThrow(/channelMap\[0\] \('my-rig'\) has unsupported field\(s\) inbound: slack-connector\.json was written by a newer OpenRig version\. Upgrade OpenRig, or edit the file by hand/);
    expect(() => validateChannelMap(newer, { allowUnknownFields: true })).not.toThrow();
    expect(unsupportedChannelMapFields(newer)).toEqual(["channelMap[0].inbound"]);
    expect(unsupportedChannelMapFields(cfg)).toEqual([]);
    // Reading stays strict about everything else.
    expect(() => validateChannelMap(withMap([{ match: "my-rig", inbound: "x@y" }]), { allowUnknownFields: true })).toThrow(/channel must be/);
  });
});

describe("setChannelMapEntry / removeChannelMapEntry", () => {
  it("set adds, then replaces in place, without mutating the input", () => {
    const one = setChannelMapEntry(undefined, { match: "my-rig", channel: "C1" });
    expect(one).toEqual([{ match: "my-rig", channel: "C1" }]);
    const two = setChannelMapEntry(one, { match: "my-rig", channel: "C2" });
    expect(two).toEqual([{ match: "my-rig", channel: "C2" }]);
    expect(one).toEqual([{ match: "my-rig", channel: "C1" }]);
    const kept = setChannelMapEntry([{ match: "a", channel: "C1" }, { match: "b", channel: "C2" }], { match: "a", channel: "C3" });
    expect(kept.map((e) => e.match)).toEqual(["a", "b"]);
  });
  it("remove reports whether anything was removed", () => {
    expect(removeChannelMapEntry([{ match: "my-rig", channel: "C1" }], "my-rig")).toEqual({ map: [], removed: true });
    expect(removeChannelMapEntry(undefined, "my-rig")).toEqual({ map: [], removed: false });
  });
});
