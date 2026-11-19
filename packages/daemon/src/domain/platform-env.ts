/** Match Node's child-environment lookup: Windows keeps the first key in
 * lexicographic order among case-insensitive duplicates; POSIX is exact. */
export function readPlatformEnv(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).sort().find(key => key.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}
