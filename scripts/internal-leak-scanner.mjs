export const INTERNAL_LEAK_REMEDY =
  "Move the detail to an internal sidecar, fence it, genericize it, or keep the whole file host-only.";

export function scanInternalLeaks({ path, bytes, rules }) {
  const normalizedPath = path.replaceAll("\\", "/");
  const pathRule = (rules.internal_path_globs ?? []).find((glob) =>
    matchesInternalPath(normalizedPath, glob),
  );
  if (pathRule) {
    return [
      {
        file: normalizedPath,
        token: pathRule,
        line: 1,
        remedy: INTERNAL_LEAK_REMEDY,
        kind: "path",
      },
    ];
  }

  const tokens = [
    ...(rules.path_prefixes ?? []),
    ...(rules.seat_and_rig_patterns ?? []),
    ...(rules.host_patterns ?? []),
    ...(rules.charged_terms ?? []),
  ];
  const allowed = rules.allowed_context_substrings ?? [];
  const findings = [];
  const lines = Buffer.from(bytes).toString("utf8").split("\n");

  for (const [index, line] of lines.entries()) {
    const lowerLine = line.toLowerCase();
    if (allowed.some((text) => lowerLine.includes(text.toLowerCase()))) {
      continue;
    }
    for (const token of tokens) {
      if (lowerLine.includes(token.toLowerCase())) {
        findings.push({
          file: normalizedPath,
          token,
          line: index + 1,
          remedy: INTERNAL_LEAK_REMEDY,
          kind: "content",
        });
      }
    }
  }

  return findings;
}

export function buildInternalLeakMessage(findings) {
  return [
    "Internal content leak detected:",
    ...findings.map(
      ({ file, token, line }) => `  ${file}: line ${line}: ${token}`,
    ),
    `Remedy: ${INTERNAL_LEAK_REMEDY}`,
  ].join("\n");
}

function matchesInternalPath(path, glob) {
  const parts = path.split("/");
  if (glob === "*.internal.*") {
    return parts.some((part) => part.includes(".internal."));
  }
  if (glob === "**/internal/**") {
    return parts.includes("internal");
  }
  if (glob === "*-internal/**") {
    return parts.some((part) => part.endsWith("-internal"));
  }
  return false;
}
