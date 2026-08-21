/**
 * Validates that a path is safe: relative, no traversal, no absolute.
 * @param path - the path to validate
 * @param label - human-readable label for error messages
 * @returns error string or null if valid
 */
export function validateSafePath(path: string, label: string): string | null {
  if (!path || typeof path !== "string") return `${label}: path is required`;
  // Windows drive letter absolute
  if (/^[A-Za-z]:[/\\]/.test(path)) return `${label}: absolute paths are not allowed (got "${path}")`;
  // Normalize backslashes for traversal check
  const normalized = path.replace(/\\/g, "/");
  // Absolute path
  if (normalized.startsWith("/")) return `${label}: absolute paths are not allowed (got "${path}")`;
  // Traversal
  const segments = normalized.split("/");
  if (segments.some((s) => s === "..")) return `${label}: path traversal (..) is not allowed (got "${path}")`;
  return null;
}
