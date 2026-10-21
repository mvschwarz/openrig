/** The YAML span and body offset in the original document; no YAML parsing or byte rewriting. */
export interface FrontmatterBlock {
  yaml: string;
  bodyStart: number;
}

/** Locate only the leading frontmatter boundary, preserving each reader's existing grammar. */
export function findFrontmatterBlock(
  raw: string,
  options: { openingWhitespace?: boolean; consumeClosingNewline?: boolean } = {},
): FrontmatterBlock | null {
  const crlf = raw.slice(0, raw.indexOf("\n")).endsWith("\r");
  const opening = options.openingWhitespace ? "\\s*\\n" : crlf ? "\\r\\n" : "\\n";
  const newline = crlf ? "\\r?\\n" : "\\n";
  // Keep one match so the whitespace-tolerant opener can backtrack exactly as before.
  // Closing prefixes (---- and ---suffix) remain accepted; the suffix is body text.
  const match = new RegExp(`^---${opening}([\\s\\S]*?)${newline}---`).exec(raw);
  if (!match) return null;
  let bodyStart = match[0].length;
  if (options.consumeClosingNewline) {
    if (crlf && raw.startsWith("\r\n", bodyStart)) bodyStart += 2;
    else if (raw[bodyStart] === "\n") bodyStart += 1;
  }
  return { yaml: match[1]!, bodyStart };
}
