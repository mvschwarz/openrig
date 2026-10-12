// The HTTP reader and explicit local TUI reader share the same containment and bytes.
import * as fs from "node:fs";
import * as path from "node:path";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { resolveAllowedFile, type AllowlistRoot } from "./path-safety.js";

export const FILE_READ_TRUNCATION_BYTES = 1_048_576;

export function readAllowedFile(allowlist: AllowlistRoot[], root: string, relativePath: string) {
  const resolved = resolveAllowedFile(allowlist, root, relativePath);
  const stat = fs.statSync(resolved);
  const fullContent = fs.readFileSync(resolved);
  const truncated = fullContent.length > FILE_READ_TRUNCATION_BYTES;
  const binary = fullContent.includes(0) || !isUtf8(fullContent);
  let returnedBytes = Math.min(fullContent.length, FILE_READ_TRUNCATION_BYTES);
  if (truncated && !binary) {
    // When the next byte continues a UTF-8 sequence, leave that whole character
    // for the unread suffix instead of decoding an incomplete prefix as U+FFFD.
    while ((fullContent[returnedBytes]! & 0xc0) === 0x80) returnedBytes--;
  }
  const returned = fullContent.subarray(0, returnedBytes);
  return {
    root, path: relativePath, absolutePath: resolved,
    resolvedPath: path.relative(allowlist.find((entry) => entry.name === root)!.canonicalPath, resolved),
    content: returned.toString("utf8"),
    binary,
    mtime: stat.mtime.toISOString(), contentHash: createHash("sha256").update(fullContent).digest("hex"),
    size: stat.size, truncated, truncatedAtBytes: truncated ? returnedBytes : null,
    totalBytes: fullContent.length,
  };
}
