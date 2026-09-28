// Node.js support policy shared by `rig doctor` and `rig preflight`.
// Must agree with the postinstall guard in scripts/check-abi.mjs (a test pins
// the two together): 22 and 24 are supported, below 22 and odd majors are
// refused, and even majors above 24 are allowed but untested.

export const SUPPORTED_NODE_MAJORS = [22, 24] as const;

export type NodeSupportKind = "supported" | "too_old" | "odd" | "untested";

export interface NodeSupport {
  major: number;
  kind: NodeSupportKind;
  /** One-line statement, present for every kind except "supported". */
  message?: string;
  reason?: string;
  fix?: string;
}

const FIX = "Install Node 22 or 24 via nvm, fnm, or your package manager, then reinstall @openrig/cli.";

export function classifyNodeVersion(version: string): NodeSupport {
  const match = version.match(/^v?(\d+)/);
  const major = match ? parseInt(match[1]!, 10) : 0;

  if ((SUPPORTED_NODE_MAJORS as readonly number[]).includes(major)) {
    return { major, kind: "supported" };
  }
  if (major < SUPPORTED_NODE_MAJORS[0]) {
    return {
      major,
      kind: "too_old",
      message: `Node ${version} is not supported (requires Node.js 22 or 24).`,
      reason: "OpenRig supports Node.js 22 and 24. Its SQLite binding (better-sqlite3 13) requires Node 22 or newer and crashes on Node 20.",
      fix: FIX,
    };
  }
  if (major % 2 !== 0) {
    return {
      major,
      kind: "odd",
      message: `Node ${version} is an odd-numbered release and is not supported.`,
      reason: "OpenRig supports Node.js 22 and 24 (LTS). Odd-numbered releases are not supported.",
      fix: FIX,
    };
  }
  return {
    major,
    kind: "untested",
    message: `Node ${major} is untested with OpenRig. Supported: Node.js 22 and 24 (LTS).`,
  };
}
