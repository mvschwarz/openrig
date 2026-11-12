import { windowsArguments } from "./windows-argv.js";

/** Parse only the literal word form produced by the runtime command builders.
 * No expansions, operators or substitutions are evaluated or translated. */
export function parseLiteralLaunchWords(command: string): string[] {
  const words: string[] = [];
  let word = "", quote: "'" | '"' | undefined, started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else {
        if (quote === '"' && /[$`\\]/.test(char)) throw new Error("Expanded launch word is unsupported");
        word += char;
      }
    } else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/.test(char)) {
      if (started) { words.push(word); word = ""; started = false; }
    } else {
      if (/[;&|<>$`(){}\\]/.test(char)) throw new Error("Nonliteral launch syntax is unsupported");
      word += char; started = true;
    }
  }
  if (quote) throw new Error("Unterminated launch word");
  if (started) words.push(word);
  if (!words[0]) throw new Error("Empty launch command");
  return words;
}

export function powershellQuote(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

/** A script shim must encode its dynamic $args too: PowerShell 5's native
 * call operator drops empty words and changes embedded quotes. */
export function renderWindowsArgvForwarder(executable: string, prefix: readonly string[]): string {
  return `$global:LASTEXITCODE = 1\n$ErrorActionPreference = 'Stop'\n`
    + `$openrigQuoted = foreach ($openrigWord in (@(${prefix.map(powershellQuote).join(", ")}) + @($args))) {\n`
    + String.raw`  '"' + [regex]::Replace([regex]::Replace([string]$openrigWord, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'` + "\n}\n"
    + `$openrigStart = New-Object System.Diagnostics.ProcessStartInfo\n$openrigStart.UseShellExecute = $false\n`
    + `$openrigStart.FileName = ${powershellQuote(executable)}\n$openrigStart.Arguments = $openrigQuoted -join ' '\n`
    + `$openrigStart.WorkingDirectory = (Get-Location).ProviderPath\n`
    + `$openrigChild = [Diagnostics.Process]::Start($openrigStart)\ntry { $openrigChild.WaitForExit(); $global:LASTEXITCODE = $openrigChild.ExitCode } finally { $openrigChild.Dispose() }\n`;
}

export function renderWindowsLaunch(command: string, env: Readonly<Record<string, string>> = {}, options: { remove?: readonly string[]; beforeStart?: string; prependPath?: string } = {}): string {
  return renderWindowsLaunchArgv(parseLiteralLaunchWords(command), env, options);
}

/** Structured native callers already have argv and must not reparse shell syntax. */
export function renderWindowsLaunchArgv(argv: readonly string[], env: Readonly<Record<string, string>> = {}, options: { remove?: readonly string[]; beforeStart?: string; prependPath?: string } = {}): string {
  const [executable, ...args] = argv;
  if (!executable || argv.some(word => word.includes("\0"))) throw new Error("Invalid native launch argv");
  const assignments = Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("Invalid environment name");
    return `$openrigStart.EnvironmentVariables[${powershellQuote(key)}]=${powershellQuote(value)}\n`;
  }).join("");
  // Windows PowerShell's native invocation drops empty argv words. Send the
  // literal Windows command line directly to CreateProcess instead, as the
  // managed launch path does, and keep its console handles attached to the pane.
  return `& {\n$global:LASTEXITCODE = 1\n$ErrorActionPreference = 'Stop'\n$openrigStart = New-Object System.Diagnostics.ProcessStartInfo\n`
    + `$openrigStart.UseShellExecute = $false\n$openrigStart.FileName = ${powershellQuote(executable!)}\n`
    + `$openrigStart.Arguments = ${powershellQuote(windowsArguments(args))}\n`
    + `${(options.remove ?? []).map(name => `$openrigStart.EnvironmentVariables.Remove(${powershellQuote(name)})\n`).join("")}${assignments}`
    + (options.prependPath === undefined ? "" : `$openrigStart.EnvironmentVariables['PATH']=${powershellQuote(options.prependPath)}+';'+[Environment]::GetEnvironmentVariable('PATH','Process')\n`)
    + `${options.beforeStart ?? ""}\n`
    + `$openrigChild = [Diagnostics.Process]::Start($openrigStart)\ntry { $openrigChild.WaitForExit(); $global:LASTEXITCODE = $openrigChild.ExitCode } finally { $openrigChild.Dispose() }\n}`;
}

/** Match managed env -i admission while retaining auth only by pane variable name. */
export function renderWindowsManagedLaunch(executable: string, args: readonly string[], cwd: string,
  environment: Readonly<Record<string, string>>, inherited: readonly string[], beforeStart = "", nonemptyInherited: readonly string[] = []): string {
  const names = [...new Set(inherited)];
  if ([...Object.keys(environment), ...names, ...nonemptyInherited].some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name.toUpperCase() !== "PROGRAMFILES(X86)")) throw new Error("Invalid managed environment name");
  const entries = Object.entries(environment).map(([key, value]) => `${powershellQuote(key)}=${powershellQuote(value)}`).join("; ");
  return `& {\n$global:LASTEXITCODE = 1\n$ErrorActionPreference = 'Stop'\n$openrigChildEnv = @{${entries}}\n`
    + `$openrigPaneEnv=[Environment]::GetEnvironmentVariables('Process')\nforeach ($openrigName in @(${names.map(powershellQuote).join(", ")})) { if ($openrigPaneEnv.Contains($openrigName)) { $openrigChildEnv[$openrigName] = $openrigPaneEnv[$openrigName] } }\n`
    + `foreach ($openrigName in @(${nonemptyInherited.map(powershellQuote).join(", ")})) { if ($openrigChildEnv.ContainsKey($openrigName) -and [string]::IsNullOrEmpty($openrigChildEnv[$openrigName])) { $openrigChildEnv.Remove($openrigName) } }\n`
    + `$openrigStart = New-Object System.Diagnostics.ProcessStartInfo\n$openrigStart.UseShellExecute = $false\n$openrigStart.FileName = ${powershellQuote(executable)}\n`
    + `$openrigStart.WorkingDirectory = ${powershellQuote(cwd)}\n$openrigStart.Arguments = ${powershellQuote(windowsArguments(args))}\n$openrigStart.EnvironmentVariables.Clear()\n`
    + `foreach ($openrigName in $openrigChildEnv.Keys) { $openrigStart.EnvironmentVariables[$openrigName] = $openrigChildEnv[$openrigName] }\n`
    + `${beforeStart}\n`
    + `$openrigChild = [Diagnostics.Process]::Start($openrigStart)\ntry { $openrigChild.WaitForExit(); $global:LASTEXITCODE = $openrigChild.ExitCode } finally { $openrigChild.Dispose() }\n}`;
}
/** psmux can deliver late OSC colour replies as native Windows key events.
 * Only recognise an entire otherwise-empty current composer, never old history
 * or a human draft containing additional text. Used during owned launch only. */
export function hasOnlyWindowsTerminalResponseDraft(content: string): boolean {
  const lines = content.split(/\r?\n/);
  let current = -1;
  for (let i = 0; i < lines.length; i++) if (/^\s*[›>]\s/.test(lines[i]!)) current = i;
  if (current < 0 || (lines[current + 1] ?? "").trim() !== "") return false;
  return /^\s*[›>]\s*(?:\](?:10|11);rgb:[0-9a-f]{1,4}\/[0-9a-f]{1,4}\/[0-9a-f]{1,4}\\){1,2}\s*$/i.test(lines[current]!);
}
