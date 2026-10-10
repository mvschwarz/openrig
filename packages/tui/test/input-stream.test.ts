import { describe, expect, it } from "vitest";
import { createInputDecoder, decodeInput, sgrClick } from "../src/input.js";

describe("stateful stdin decoding", () => {
  it("preserves arrows, paging, and SGR mouse at every chunk split", () => {
    const vectors = ["\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D", "\x1b[5~", "\x1b[6~", sgrClick(47, 12)];
    for (const vector of vectors) {
      const expected = decodeInput(vector);
      for (let split = 1; split < Buffer.byteLength(vector); split++) {
        const decoder = createInputDecoder();
        const bytes = Buffer.from(vector);
        const actual = [
          ...decoder.write(bytes.subarray(0, split)),
          ...decoder.write(bytes.subarray(split)),
        ];
        expect(actual, `${JSON.stringify(vector)} split ${split}`).toEqual(expected);
      }
    }
  });

  it("decodes application-cursor arrows like normal arrows at every split", () => {
    for (const suffix of ["A", "B", "C", "D"]) {
      const bytes = Buffer.from(`\x1bO${suffix}`);
      const expected = decodeInput(`\x1b[${suffix}`);
      expect(decodeInput(bytes)).toEqual(expected);
      for (let split = 1; split < bytes.length; split++) {
        const decoder = createInputDecoder();
        expect([...decoder.write(bytes.subarray(0, split)), ...decoder.write(bytes.subarray(split))])
          .toEqual(expected);
      }
    }
  });

  it("continues ignoring unsupported SS3 keys as a whole sequence", () => {
    for (const suffix of ["P", "Q", "R", "S"]) {
      expect(decodeInput(`\x1bO${suffix}x`)).toEqual([{ type: "char", ch: "x" }]);
    }
  });

  it("preserves UTF-8 characters split between bytes", () => {
    const bytes = Buffer.from("界");
    for (let split = 1; split < bytes.length; split++) {
      const decoder = createInputDecoder();
      expect(decoder.write(bytes.subarray(0, split))).toEqual([]);
      expect(decoder.write(bytes.subarray(split))).toEqual([{ type: "char", ch: "界" }]);
    }
  });

  it("holds a bare Esc (an arrow/mouse prefix) and reports it pending so the caller can flush it as a keypress", () => {
    const decoder = createInputDecoder();
    expect(decoder.hasPending()).toBe(false);
    expect(decoder.write("\x1b")).toEqual([]);
    expect(decoder.hasPending()).toBe(true);
    expect(decoder.flush()).toEqual([{ type: "key", key: "escape" }]);
    expect(decoder.hasPending()).toBe(false);
    // a real arrow arriving in the next chunk still decodes as one key, never as Esc + bytes
    expect(decoder.write("\x1b")).toEqual([]);
    expect(decoder.write("[A")).toEqual([{ type: "key", key: "up", action: { type: "select", delta: -1 } }]);
    expect(decoder.hasPending()).toBe(false);
  });

  it("defines EOF flush for an incomplete CSI prefix", () => {
    const decoder = createInputDecoder();
    expect(decoder.write("\x1b[")).toEqual([]);
    expect(decoder.flush()).toEqual([
      { type: "key", key: "escape" },
      { type: "char", ch: "[" },
    ]);
  });
});

it("treats CRLF as one activation across arbitrary input chunks", () => {
  const enter = { type: "key", key: "enter", action: { type: "activate" } };
  expect(decodeInput("\r\n")).toEqual([enter]);
  const decoder = createInputDecoder();
  expect(decoder.write("\r")).toEqual([enter]);
  expect(decoder.flush()).toEqual([]);
  expect(decoder.write("\n")).toEqual([]);
  expect(decoder.write("x\n")).toEqual([{ type: "char", ch: "x" }, enter]);
  expect(decodeInput("\r\r")).toEqual([enter, enter]);
});
