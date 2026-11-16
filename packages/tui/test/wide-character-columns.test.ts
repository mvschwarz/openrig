import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../src/demo-data.js";
import { renderScreen } from "../src/render.js";
import { createViewState } from "../src/state.js";
import type { Screen } from "../src/types.js";

const COLS = 180;
const DRIVER = "dev50-driver@openrig-build";

const SUMMARIES: Array<[name: string, summary: string]> = [
  ["ascii", "incremental build of the pulse view"],
  ["cjk", "构建脉冲视图的增量构建并检查所有测试是否通过"],
  ["kana", "パルスビューの段階的なビルドとテストの確認"],
  ["hangul", "펄스 보기 증분 빌드 및 테스트 확인"],
  ["combining", "résumé of the pulse view build and tests"],
];

/** The openrig-build rig table, with the driver seat's NOW summary replaced. */
function rigScreen(summary: string): Screen {
  const snap = demoSnapshot();
  for (const list of [snap.attention, snap.blocked, snap.inProgress, snap.pending]) for (const row of list) {
    if (row.destinationSession === DRIVER) row.summary = summary;
  }
  const view = createViewState({ instanceId: "wide-character-columns", getSnapshot: () => snap });
  view.dispatch({ type: "drill", resource: "rig", name: "openrig-build", target: { host: "vm-host" } });
  return renderScreen(view.get(), snap, { cols: COLS, rows: 40, nowMs: Date.parse("2026-08-06T12:00:00.000Z") });
}

/** The driver's table row: its index in `lines` and the terminal column (1-based) where its `term ▸` is drawn. */
function driverTerm(screen: Screen): { index: number; column: number } {
  const index = screen.lines.findIndex((line) => /\bdriver\b/.test(line) && line.includes("term ▸"));
  expect(index).toBeGreaterThanOrEqual(0);
  const line = screen.lines[index]!;
  return { index, column: stringWidth(line.slice(0, line.indexOf("term ▸"))) + 1 };
}

describe("rig table cells are sized in terminal columns", () => {
  it.each(SUMMARIES)("keeps every line within the terminal width with a %s NOW summary", (_, summary) => {
    const screen = rigScreen(summary);

    expect(screen.lines.filter((line) => stringWidth(line) > COLS)).toEqual([]);
  });

  it.each(SUMMARIES)("draws term ▸ in the ACTIONS column with a %s NOW summary", (_, summary) => {
    const ascii = driverTerm(rigScreen("x"));

    const wide = driverTerm(rigScreen(summary));

    expect(wide.column).toBe(ascii.column);
  });

  it.each(SUMMARIES)("puts the term ▸ click target where term ▸ is drawn with a %s NOW summary", (_, summary) => {
    const screen = rigScreen(summary);
    const { index, column } = driverTerm(screen);

    const target = screen.hitMap.find((hit) =>
      hit.y === index + 1 && hit.action.type === "act" && "act" in hit.action && hit.action.act === "open-terminal");

    expect(target).toBeDefined();
    expect(column).toBeGreaterThanOrEqual(target!.x1);
    expect(column + stringWidth("term ▸") - 1).toBeLessThanOrEqual(target!.x2);
  });
});
