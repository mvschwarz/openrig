import type { ComposerSnapshot } from "../../src/domain/composer-prompts.js";

/** Sanitized geometry/footer shape from a 42x10 Codex 0.164 pane. Styling
 * variants are synthetic controls; the retained native capture was unstyled. */
export function codexTwoRowComposer(body = ""): ComposerSnapshot {
  const rows = body.split("\n");
  return {
    screen: ["› Earlier request", "• Ready.", "", "  Worked for 2s", "  Status", "",
      `› ${rows[0]}`, ...rows.slice(1).map(row => `  ${row}`), "",
      "  Model low · ~/project", "  ? for shortcuts                ⚠ 1 · f2", ""].join("\n"),
    cursor: { x: 2, y: 6, width: 42, height: 10 + rows.length - 1 }, inMode: false,
  };
}
