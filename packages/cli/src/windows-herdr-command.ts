import { renderWindowsLaunchArgv } from "@openrig/daemon/windows-launch";

/** Translate our structured env invocation without passing a POSIX shell string. */
export function windowsHerdrEnvironmentCommand(args: readonly string[]): string {
  const remove: string[] = [], env: Record<string,string> = {};
  let index = 0;
  while (args[index] === "-u") {
    const key = args[index+1];
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("Invalid Herdr environment removal");
    remove.push(key); index += 2;
  }
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[index] ?? "")) {
    const word=args[index++]!, split=word.indexOf("="); env[word.slice(0,split)]=word.slice(split+1);
  }
  if (!args[index] || !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(args[index]!)) throw new Error("Herdr executable must be an absolute native path");
  return "$ProgressPreference='SilentlyContinue'\n" + renderWindowsLaunchArgv(args.slice(index),env,{remove}) + "\nexit $LASTEXITCODE";
}
