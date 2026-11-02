/** Paths belong to the daemon host, regardless of the browser's operating system. */
function windowsRoot(value: string): { root: string; rest: string } | null {
  const path = value.replaceAll("\\", "/");
  const match = /^(\/\/\?\/UNC\/[^/]+\/[^/]+\/|\/\/\?\/[A-Za-z]:\/|\/\/[^/?]+\/[^/]+\/|[A-Za-z]:\/)(.*)$/i.exec(path);
  return match ? { root: match[1]!, rest: match[2]! } : null;
}

function normalized(root: string, rest: string, windows: boolean): string {
  const parts: string[] = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const result = root + parts.join("/");
  return windows ? result.replaceAll("/", "\\") : result;
}

export function resolveServerFileReference(source: string | null | undefined, ref: string): string | null {
  if (!source || !ref || source.includes("\0") || ref.includes("\0")) return null;
  const sourceRoot = windowsRoot(source);
  if (sourceRoot) {
    const value = ref.replaceAll("\\", "/");
    const absolute = windowsRoot(ref);
    if (absolute) return normalized(absolute.root, absolute.rest, true);
    // Drive-relative refs need per-drive process cwd; the browser has no such evidence.
    if (/^[A-Za-z]:/.test(value) || value.startsWith("//")) return null;
    const parent = sourceRoot.rest.slice(0, sourceRoot.rest.lastIndexOf("/") + 1);
    return normalized(sourceRoot.root, value.startsWith("/") ? value.slice(1) : parent + value, true);
  }
  if (!source.startsWith("/")) return null;
  if (ref.startsWith("/")) return normalized("/", ref.slice(1), false);
  return normalized("/", source.slice(1, source.lastIndexOf("/") + 1) + ref, false);
}

/** Compare normalized server paths without inventing case-insensitive filesystem identity. */
export function serverPathIsWithin(candidate: string, directory: string): boolean {
  const win = windowsRoot(directory);
  const canonical = (value: string) => {
    const root = windowsRoot(value);
    return root ? normalized(root.root, root.rest, true) : value.startsWith("/") ? normalized("/", value.slice(1), false) : null;
  };
  const child = canonical(candidate), parent = canonical(directory);
  if (!child || !parent || Boolean(windowsRoot(candidate)) !== Boolean(win)) return false;
  const sep = win ? "\\" : "/";
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}
