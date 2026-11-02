export { parseLiteralLaunchWords, powershellQuote, renderWindowsLaunch, renderWindowsLaunchArgv } from "./adapters/windows-launch.js";
export { parseWindowsCommandLine } from "./adapters/windows-argv.js";
export { operatorShellWord } from "./adapters/shell-quote.js";
export { resolveWindowsProviderCommand } from "./domain/windows-provider-command.js";
export { readPlatformEnv } from "./domain/platform-env.js";
export { readWindowsTileAttachArgv } from "./domain/terminal/windows-tile-attach.js";
