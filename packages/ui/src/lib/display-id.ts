/**
 * Returns the last N characters of an ID for glanceable display.
 * ULID tail is more distinguishable than head (timestamps make heads similar).
 */
export function shortId(id: string, length = 6): string {
  if (id.length <= length) return id;
  return id.slice(-length);
}
