import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { SEAT_SCOPE_SLICE, rigSeatSlice } from "../src/adapters/seat-slice.js";

// #80: a rig that opts in groups its seats' scopes beneath its own slice under openrigseats.slice. A dash in a slice
// name is nesting in systemd, so the rig name is escaped byte by byte and no rig name can reach another rig's slice.
describe("rigSeatSlice", () => {
  it("puts a plain rig name under openrigseats.slice", () => {
    expect(SEAT_SCOPE_SLICE).toBe("openrigseats.slice");
    expect(rigSeatSlice("kydek")).toEqual({ kind: "slice", name: "openrigseats-kydek.slice" });
  });

  it("escapes every dash and slash, so a rig name never nests a level deeper or names another rig's slice", () => {
    expect(rigSeatSlice("lab-a")).toEqual({ kind: "slice", name: "openrigseats-lab\\x2da.slice" });
    expect(rigSeatSlice("a/b")).toEqual({ kind: "slice", name: "openrigseats-a\\x2fb.slice" });
    // "a-b" and "a/b" stay distinct slices, both directly under openrigseats.slice
    const names = ["a-b", "a/b", "a_b"].map((rig) => rigSeatSlice(rig));
    expect(new Set(names.map((n) => (n.kind === "slice" ? n.name : n.reason))).size).toBe(3);
  });

  it("escapes a leading dot and non-ASCII bytes the way systemd escapes unit names", () => {
    expect(rigSeatSlice(".hidden")).toEqual({ kind: "slice", name: "openrigseats-\\x2ehidden.slice" });
    expect(rigSeatSlice("é")).toEqual({ kind: "slice", name: "openrigseats-\\xc3\\xa9.slice" });
    expect(rigSeatSlice("v1.2:x_y")).toEqual({ kind: "slice", name: "openrigseats-v1.2:x_y.slice" });
  });

  it("gives a reason, not a slice, for an empty name or one too long for a unit name", () => {
    expect(rigSeatSlice("").kind).toBe("unusable");
    const long = rigSeatSlice("x".repeat(300));
    expect(long.kind).toBe("unusable");
    if (long.kind === "unusable") expect(long.reason).toMatch(/255/);
    const fits = rigSeatSlice("x".repeat(255 - "openrigseats-".length - ".slice".length));
    expect(fits.kind).toBe("slice");
  });

  it("matches systemd-escape for names without a slash, where systemd-escape is installed", () => {
    let escape: (s: string) => string;
    try {
      execFileSync("systemd-escape", ["--version"], { stdio: "ignore" });
      escape = (s) => execFileSync("systemd-escape", ["--", s], { encoding: "utf8" }).trim();
    } catch {
      return; // not a systemd host: the cases above still pin the escaping
    }
    for (const rig of ["kydek", "lab-a", ".hidden", "é", "v1.2:x_y", "two words"]) {
      const got = rigSeatSlice(rig);
      expect(got).toEqual({ kind: "slice", name: `openrigseats-${escape(rig)}.slice` });
    }
  });
});
