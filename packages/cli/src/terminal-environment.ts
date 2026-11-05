/** A new terminal client must not inherit the parent's multiplexer context. */
export function detachedTerminalEnvironment(input: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...input };
  for (const key of Object.keys(env)) {
    if ((process.platform === "win32" ? key.toUpperCase() : key) === "TMUX") delete env[key];
  }
  return env;
}
