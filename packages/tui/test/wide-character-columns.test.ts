import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../src/demo-data.js";
import { renderScreen } from "../src/render.js";
import { computeExplorerRows, createViewState } from "../src/state.js";
import { stylizeLines } from "../src/stylize.js";
import { createStyle, stripAnsi } from "../src/theme.js";
import type { Screen } from "../src/types.js";

const COLS = 180;
const DRIVER = "dev50-driver@openrig-build";
const UNICODE = ["界".repeat(12), "e\u0301".repeat(24)];

const SUMMARIES: Array<[name: string, summary: string]> = [
  ["ascii", "incremental build of the pulse view"],
  ["cjk", "构建脉冲视图的增量构建并检查所有测试是否通过"],
  ["kana", "パルスビューの段階的なビルドとテストの確認"],
  ["hangul", "펄스 보기 증분 빌드 및 테스트 확인"],
  ["combining", "résumé of the pulse view build and tests"],
];

/** The openrig-build rig table, with the driver seat's NOW summary replaced. */
function rigScreen(summary: string, focusTerm = false): Screen {
  const snap = demoSnapshot();
  for (const list of [snap.attention, snap.blocked, snap.inProgress, snap.pending]) for (const row of list) {
    if (row.destinationSession === DRIVER) row.summary = summary;
  }
  const view = createViewState({ instanceId: "wide-character-columns", getSnapshot: () => snap });
  view.dispatch({ type: "drill", resource: "rig", name: "openrig-build", target: { host: "vm-host" } });
  const size = { cols: COLS, rows: 40, nowMs: Date.parse("2026-08-06T12:00:00.000Z") };
  const screen = renderScreen(view.get(), snap, size);
  if (!focusTerm) return screen;
  const { index } = driverTerm(screen);
  const contentSelection = screen.contentTargets.findIndex((target) =>
    target.y === index + 1 && target.action.type === "act" && target.action.act === "open-terminal");
  expect(contentSelection).toBeGreaterThanOrEqual(0);
  return renderScreen({ ...view.get(), focusedPane: "content", contentSelection }, snap, size);
}

/** The driver's table row: its index in `lines` and the terminal column (1-based) where its `term ▸` is drawn. */
function driverTerm(screen: Screen): { index: number; column: number } {
  const index = screen.lines.findIndex((line) => /\bdriver\b/.test(line) && line.includes("term ▸"));
  expect(index).toBeGreaterThanOrEqual(0);
  const line = screen.lines[index]!;
  return { index, column: stringWidth(line.slice(0, line.indexOf("term ▸"))) + 1 };
}

describe("rig table cells are sized in terminal columns", () => {
  it.each(UNICODE)("keeps the focus marker directly before term ▸ for %s", (summary) => {
    const plain = rigScreen(summary);
    const { index, column } = driverTerm(plain);
    const focused = rigScreen(summary, true);
    const line = plain.lines[index]!;
    const term = line.indexOf("term ▸");
    expect(focused.lines[index]).toBe(line.slice(0, term - 1) + "›" + line.slice(term));
    expect(driverTerm(focused).column).toBe(column);
  });

  it.each(UNICODE)("paints selection and the divider after an explorer label with %s", (name) => {
    const snap = demoSnapshot();
    snap.hosts = [{ name: "host", reachable: true, rigs: [{ name, pods: [] }] }];
    const state = createViewState({ instanceId: "wide-explorer", getSnapshot: () => snap }).get();
    const key = `rig:host/${name}`;
    const selection = computeExplorerRows(state, snap).findIndex((row) => row.key === key);
    const screen = renderScreen({ ...state, selection }, snap, { cols: COLS, rows: 40 });
    const y = screen.explorerRows.find((row) => row.key === key)!.y;
    const style = createStyle("truecolor");
    const styled = stylizeLines(screen, style)[y - 1]!;
    expect(styled).toContain("48;2;34;52;82");
    expect(styled).toContain(style.paint("chrome", "┃"));
    expect(stripAnsi(styled)).toBe(screen.lines[y - 1]);
  });
  it("keeps a CJK pod's agent count inside the styled explorer", () => {
    const snap = demoSnapshot();
    const host = snap.hosts[0]!;
    const rig = host.rigs[0]!;
    const pod = rig.pods[0]!;
    pod.name = "界";
    pod.agents = pod.agents.slice(0, 1);
    const state = createViewState({ instanceId: "wide-explorer-meta", getSnapshot: () => snap }).get();
    const screen = renderScreen(state, snap, { cols: COLS, rows: 40 });
    const key = `pod:${host.name}/${rig.name}/${pod.name}`;
    const y = screen.explorerRows.find((row) => row.key === key)!.y;
    const plain = screen.lines[y - 1]!;
    const style = createStyle("truecolor");
    const styled = stylizeLines(screen, style)[y - 1]!;

    expect(plain.startsWith(" ")).toBe(true);
    expect(stripAnsi(styled)).toBe(plain);
    expect(styled).toContain(style.paint("dim", "1") + style.paint("chrome", "┃"));
    const border = plain.indexOf("1┃") + 1;
    expect(border).toBeGreaterThan(0);
    expect(stringWidth(plain.slice(0, border))).toBe(screen.explorerWidth);
  });

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
