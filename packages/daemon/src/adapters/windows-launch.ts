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

export function renderWindowsLaunch(command: string, env: Readonly<Record<string, string>> = {}): string {
  const [executable, ...args] = parseLiteralLaunchWords(command);
  const assignments = Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("Invalid environment name");
    return `$env:${key}=${powershellQuote(value)}; `;
  }).join("");
  return `${assignments}& ${powershellQuote(executable!)} @(${args.map(powershellQuote).join(", ")})`;
}

/** Match managed env -i admission while retaining auth only by pane variable name. */
export function renderWindowsManagedLaunch(executable: string, args: readonly string[], cwd: string,
  environment: Readonly<Record<string, string>>, inherited: readonly string[]): string {
  const names = [...new Set(inherited)];
  if ([...Object.keys(environment), ...names].some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name !== "PROGRAMFILES(X86)")) throw new Error("Invalid managed environment name");
  const entries = Object.entries(environment).map(([key, value]) => `${powershellQuote(key)}=${powershellQuote(value)}`).join("; ");
  return `& {\n$openrigChildEnv = @{${entries}}\n`
    + `foreach ($openrigName in @(${names.map(powershellQuote).join(", ")})) { $openrigValue = [Environment]::GetEnvironmentVariable($openrigName, 'Process'); if ($openrigValue) { $openrigChildEnv[$openrigName] = $openrigValue } }\n`
    + `$openrigStart = New-Object System.Diagnostics.ProcessStartInfo\n$openrigStart.UseShellExecute = $false\n$openrigStart.FileName = ${powershellQuote(executable)}\n`
    + `$openrigStart.WorkingDirectory = ${powershellQuote(cwd)}\n$openrigStart.Arguments = ${powershellQuote(windowsArguments(args))}\n$openrigStart.EnvironmentVariables.Clear()\n`
    + `foreach ($openrigName in $openrigChildEnv.Keys) { $openrigStart.EnvironmentVariables[$openrigName] = $openrigChildEnv[$openrigName] }\n`
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
