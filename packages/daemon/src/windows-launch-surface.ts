export { parseLiteralLaunchWords, powershellQuote, renderWindowsLaunch, renderWindowsLaunchArgv } from "./adapters/windows-launch.js";
export { parseWindowsCommandLine } from "./adapters/windows-argv.js";
export { operatorShellWord } from "./adapters/shell-quote.js";
export { resolveWindowsProviderCommand } from "./domain/windows-provider-command.js";
export { readPlatformEnv } from "./domain/platform-env.js";
export { readWindowsTileAttachArgv, windowsTileAttachArgv } from "./domain/terminal/windows-tile-attach.js";
export { bindNativeSessionName } from "./domain/terminal/native-session-name.js";
export { execWindowsJobFile } from "./domain/windows-job-exec.js";
export { spawnWindowsJobProcess } from "./domain/windows-job-process.js";

export { resolveWindowsCommand } from "./domain/windows-command.js";
export { windowsPowerShell } from "./domain/windows-executables.js";

export { localControlEndpoint } from "./domain/local-control-endpoint.js";
export { herdrAppSocketPath, resolveHerdrAppHome } from "./domain/terminal/herdr-app-transport.js";
