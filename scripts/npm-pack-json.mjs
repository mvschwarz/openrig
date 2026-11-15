// `npm pack --json` prints an array of entries up to npm 11 and, from npm 12, an object keyed by package name
// ("the --json output of `npm pack` and `npm publish` have changed",
// https://github.com/npm/cli/releases/tag/v12.0.0). Every reader of that output goes through here, so both shapes
// give the same entries.

/** The entries `npm pack --json` printed, in order, from its output text or its parsed value. */
export function packEntries(output) {
  const parsed = typeof output === "string" ? JSON.parse(output) : output;
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === "object" ? Object.values(parsed) : null;
  if (!entries || !entries.every((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry))) {
    throw new Error("npm pack --json printed neither an array of entries nor an object of per-package entries");
  }
  return entries;
}

/** The one entry of a `npm pack --json` run that packed one package; any other count throws. */
export function packEntry(output) {
  const entries = packEntries(output);
  if (entries.length !== 1) {
    throw new Error(`npm pack --json printed ${entries.length} entries where one package was packed`);
  }
  return entries[0];
}
