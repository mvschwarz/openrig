/** Cheap stable token estimate shared by store and assembly projections. */
export function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / 4);
}
