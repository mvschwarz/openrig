import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NAV_SECTIONS, NAV_FOOTER, NAV_CHAT, allNavItems } from "../src/lib/nav.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_SRC = readFileSync(path.resolve(__dirname, "../src/routes.tsx"), "utf8");

describe("nav model", () => {
  it("every testId is unique", () => {
    const ids = [
      ...NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.testId)),
      ...NAV_FOOTER.map((i) => i.testId),
      ...NAV_CHAT.map((i) => i.testId),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every to matches a route path in routes.tsx", () => {
    for (const item of allNavItems()) {
      expect(
        ROUTES_SRC.includes(`path: "${item.to}"`),
        `nav item ${item.id} to=${item.to} has no matching route path`,
      ).toBe(true);
    }
  });

  it("allNavItems contains the stable rail testids", () => {
    const testIds = allNavItems().map((i) => i.testId);
    for (const expected of [
      "rail-dashboard",
      "rail-topology",
      "rail-for-you",
      "rail-project",
      "rail-specs",
      "rail-settings",
    ]) {
      expect(testIds).toContain(expected);
    }
  });

  it("activeWhen truth table", () => {
    const byId = new Map(allNavItems().map((i) => [i.id, i]));
    const activeIds = (pathname: string) =>
      [...byId.values()].filter((i) => i.activeWhen(pathname)).map((i) => i.id);

    expect(activeIds("/topology/rig/x")).toEqual(["rigs"]);
    expect(activeIds("/rigs/x")).toEqual(["rigs"]);
    expect(activeIds("/plugins/x")).toEqual(["library"]);
    expect(activeIds("/")).toEqual(["dashboard"]);
  });
});
