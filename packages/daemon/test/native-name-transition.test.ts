import { expect, it } from "vitest";
import { NativeNameTransition, type NativeNameTransitionIO, type NativePhysicalSession } from "../src/domain/native-name-transition.js";
import { bindNativeSessionName } from "../src/domain/terminal/native-session-name.js";

function fixture(from = "owned:old", to = "owned|new", legacy = false) {
  const a = legacy ? {logical:from,physical:from,marker:undefined} : bindNativeSessionName(from), b = bindNativeSessionName(to);
  const original: NativePhysicalSession = { nodeId: "node", generation: "old", serverPid: "1234", sessionId: "$0", sessionCreated: "123", marker: a.marker };
  const slots = new Map([[a.physical, { ...original }]]), calls: string[] = [];
  let lease = true, fault = "";
  const io: NativeNameTransitionIO = {
    ownsLifecycle: () => lease,
    observe: async name => slots.has(name) ? { state: "present", session: { ...slots.get(name)! } } : { state: "absent" },
    rename: async (source, destination, expected) => {
      calls.push("rename"); expect(slots.get(source)).toEqual(expected); expect(slots.has(destination)).toBe(false);
      if (fault === "before") { fault = ""; throw new Error("before rename"); }
      slots.set(destination, slots.get(source)!); slots.delete(source);
      if (fault === "after") { fault = ""; throw new Error("rename reply lost"); }
    },
    writeMarker: async (name, marker, expected) => {
      calls.push("marker"); expect(slots.get(name)).toEqual(expected); slots.get(name)!.marker = marker;
      if (fault === "marker") { fault = ""; throw new Error("marker reply lost"); }
    },
  };
  return { transition: new NativeNameTransition("node", io), io, a, b, slots, calls, from, to, fault: (value: string) => { fault = value; }, loseLease: () => { lease = false; } };
}
it.each(["", "before", "after", "marker"])("recovers a qualified name/marker transition at %s without replaying an applied rename", async fault => {
  const f = fixture(), intent = await f.transition.prepare(f.from, f.to, "old"); f.fault(fault);
  if (fault) await expect(f.transition.resume(intent)).rejects.toThrow(); else await f.transition.resume(intent);
  const applied = f.calls.filter(c => c === "rename").length;
  await f.transition.resume(intent);
  expect(f.calls.filter(c => c === "rename")).toHaveLength(fault === "before" ? applied + 1 : applied);
  expect(f.slots.has(f.a.physical)).toBe(false); expect(f.slots.get(f.b.physical)?.marker).toBe(f.b.marker);
});
it("removes an old marker when moving to an ordinary native name", async () => {
  const f = fixture("owned:old", "ordinary"), intent = await f.transition.prepare(f.from, f.to, "old");
  await f.transition.resume(intent); expect(f.slots.get(f.b.physical)?.marker).toBeUndefined();
});
it.each(["serverPid", "sessionId", "sessionCreated", "generation"] as const)("rejects malformed intent %s even when the occupant matches it", async key => {
  const f = fixture(), intent = await f.transition.prepare(f.from, f.to, "old");
  intent[key] = ""; f.slots.get(f.a.physical)![key] = "";
  await expect(f.transition.resume(intent)).rejects.toThrow("Invalid"); expect(f.calls).toEqual([]);
});
it.each(["serverPid", "sessionId", "sessionCreated", "nodeId", "generation", "marker"] as const)("refuses changed %s before mutation", async key => {
  const f = fixture(), intent = await f.transition.prepare(f.from, f.to, "old"); f.slots.get(f.a.physical)![key] = "foreign";
  await expect(f.transition.resume(intent)).rejects.toThrow(); expect(f.calls).toEqual([]);
});
it("does not repair an occupied destination or continue after lease loss", async () => {
  const f = fixture(), intent = await f.transition.prepare(f.from, f.to, "old"); f.slots.set(f.b.physical, { ...f.slots.get(f.a.physical)! });
  await expect(f.transition.resume(intent)).rejects.toThrow(); expect(f.calls).toEqual([]);
  f.slots.delete(f.b.physical); f.loseLease(); await expect(f.transition.resume(intent)).rejects.toThrow("lease"); expect(f.calls).toEqual([]);
});
it.each(["", "before", "after", "marker"])("migrates a qualified unmarked legacy source and recovers %s",async fault=>{
  const f=fixture("openrig-native-v1-legacy","owned|new",true),intent=await f.transition.prepare(f.from,f.to,"old");
  expect(intent.sourceLegacy).toBe(true);f.fault(fault);
  if(fault)await expect(f.transition.resume(intent)).rejects.toThrow();else await f.transition.resume(intent);
  const applied=f.calls.filter(c=>c==="rename").length;await f.transition.resume(intent);
  expect(f.calls.filter(c=>c==="rename")).toHaveLength(fault==="before"?applied+1:applied);
  expect(f.slots.has(f.from)).toBe(false);expect(f.slots.get(f.b.physical)?.marker).toBe(f.b.marker);
});
it("refuses simultaneous legacy and codec sources, including an alias appearing after intent preparation",async()=>{
  const f=fixture("openrig-native-v1-legacy","owned|new",true),encoded=bindNativeSessionName(f.from);
  const intent=await f.transition.prepare(f.from,f.to,"old");
  f.slots.set(encoded.physical,{...f.slots.get(f.from)!,marker:encoded.marker});
  await expect(f.transition.prepare(f.from,f.to,"old")).rejects.toThrow("ambiguous");
  await expect(f.transition.resume(intent)).rejects.toThrow("ambiguous");expect(f.calls).toEqual([]);
});
it("refuses a legacy destination alias rather than creating a competing encoded destination",async()=>{
  const f=fixture("owned:old","openrig-native-v1-legacy");f.slots.set(f.to,{...f.slots.get(f.a.physical)!,marker:undefined});
  await expect(f.transition.prepare(f.from,f.to,"old")).rejects.toThrow("ambiguous");expect(f.calls).toEqual([]);
});
it("does not adopt a legacy-looking source carrying a foreign marker",async()=>{
  const f=fixture("openrig-native-v1-legacy","owned|new",true);f.slots.get(f.from)!.marker="foreign";
  await expect(f.transition.prepare(f.from,f.to,"old")).rejects.toThrow("identity");expect(f.calls).toEqual([]);
});
