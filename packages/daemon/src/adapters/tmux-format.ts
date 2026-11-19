/** tmux preserves hash runs before a style bracket; other hash runs expand once. */
export function tmuxSessionNameFormat(value: string): string {
  return value.replace(/#+(\[)?/g, (run, style?: string) => style ? run : run + run);
}

/** A literal operand inside a nested format comparison, not a shell argument. */
export function tmuxFormatLiteral(value: string): string {
  return tmuxSessionNameFormat(value).replace(/,/g, "#,").replace(/}/g, "#}");
}
