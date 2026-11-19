import { posix } from "node:path";

/** Authored media refs are portable relative paths, never per-drive cwd references. */
export function nonRelativeMediaPath(ref: string): boolean {
  return /^(?:[\\/]|[A-Za-z]:)/.test(ref);
}

export function sliceRelativeMediaPath(ref: string, baseDir: string, platform: NodeJS.Platform = process.platform): string | null {
  if (nonRelativeMediaPath(ref) || nonRelativeMediaPath(baseDir) || ref.includes("\0") || baseDir.includes("\0")) return null;
  const portable = posix.normalize(posix.join(baseDir.replaceAll("\\", "/"), ref.replaceAll("\\", "/")));
  if (portable === ".." || portable.startsWith("../")) return null;
  // On POSIX an ordinary backslash is filename content, not a separator.
  return platform === "win32" ? portable : posix.normalize(posix.join(baseDir, ref));
}
