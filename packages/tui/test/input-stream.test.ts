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

  it("preserves UTF-8 characters split between bytes", () => {
    const bytes = Buffer.from("界");
    for (let split = 1; split < bytes.length; split++) {
      const decoder = createInputDecoder();
      expect(decoder.write(bytes.subarray(0, split))).toEqual([]);
      expect(decoder.write(bytes.subarray(split))).toEqual([{ type: "char", ch: "界" }]);
    }
  });
});
