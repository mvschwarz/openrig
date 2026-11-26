import { expect, it } from "vitest";
import { bindNativeSessionName, logicalNameFromNativeBinding } from "../src/domain/terminal/native-session-name.js";

it.each(["seat@rig", "ordinary-name", "日本語🙂", "space inside"])("preserves an ordinary native name (%s)", logical => {
  expect(bindNativeSessionName(logical)).toEqual({ logical, physical: logical });
});

it.each(["literal|name", "literal?name", "con", "aux.txt", "trailing.", "trailing ", "line\nbreak", "openrig-native-v1-ordinary"])("binds a native-constrained name reversibly with explicit metadata (%j)", logical => {
  const binding = bindNativeSessionName(logical);
  expect(binding.physical).toMatch(/^openrig-native-v1-[a-f0-9]{64}$/);
  expect(bindNativeSessionName(logical)).toEqual(binding);
  expect(logicalNameFromNativeBinding(binding.physical, binding.marker)).toBe(logical);
  expect(logicalNameFromNativeBinding(binding.physical, undefined)).toBeUndefined();
  expect(logicalNameFromNativeBinding(binding.physical + "x", binding.marker)).toBeUndefined();
});

it("does not merge distinct constrained names or trust another session's marker", () => {
  const names = ["a|b", "a?b", "a*b", "Ä|seat", "ä|seat"];
  const bindings = names.map(bindNativeSessionName);
  expect(new Set(bindings.map(binding => binding.physical)).size).toBe(names.length);
  expect(logicalNameFromNativeBinding(bindings[0]!.physical, bindings[1]!.marker)).toBeUndefined();
});

it("rejects noncanonical, invalid text and nonbinding markers", () => {
  const binding = bindNativeSessionName("a|b");
  for (const marker of [binding.marker + "=", Buffer.from([255]).toString("base64url"), Buffer.from("ordinary").toString("base64url"), "!"]) {
    expect(logicalNameFromNativeBinding(binding.physical, marker)).toBeUndefined();
  }
  for (const name of ["", "nul\0name", "bad\ud800name"]) expect(() => bindNativeSessionName(name)).toThrow("Invalid logical session name");
});
