import { isIP } from "node:net";
import { parseWindowsCommandLine } from "@openrig/daemon/windows-launch";
import type { HostEntry } from "./host-registry.js";
import type { CheckRow, DoctorDeps } from "./commands/host.js";
import { resolvePosturePorts, type PostureOptions } from "./host-posture-options.js";

export const WINDOWS_POSTURE_PROFILE_ID = "product-factory-windows";
export const WINDOWS_POSTURE_ITEMS = ["nonadmin-openrig-user", "administrator-ssh-disabled", "key-only-ssh",
  "firewall-default-deny-incoming", "tailnet-ingress-allowed", "tailscale-minimal-trust", "daemon-bind-not-public",
  "public-daemon-port-unreachable", "public-ssh-unreachable-or-accepted"] as const;
// The trusted shipped collector travels over stdin. Read it as one script,
// avoiding both SSH/cmd length limits and PowerShell's interactive stdin parser.
export const WINDOWS_POSTURE_ARGV = ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
  Buffer.from("$ErrorActionPreference='Stop'; & ([ScriptBlock]::Create([Console]::In.ReadToEnd()))", "utf16le").toString("base64")] as const;
const serviceArgvProgram = `const parse=${parseWindowsCommandLine.toString()};let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(parse(Buffer.from(input.replace(/^\uFEFF/,''),'base64').toString('utf8')))));`;
const serviceArgvProgramBase64 = Buffer.from(serviceArgvProgram).toString("base64");

/** Read-only, fixed collector. Never outputs keys, raw configuration, user SIDs or Tailscale account data. */
export const WINDOWS_POSTURE_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$postureDaemonPort=7433
$facts=[ordered]@{version=1;daemonPort=$postureDaemonPort;account=$null;ssh=$null;firewall=$null;tailnetAllow=$null;tailscale=$null;listeners=$null}
try {
  $users=@(Get-LocalUser -ErrorAction Stop | Where-Object Name -eq 'openrig')
  if ($users.Count -eq 0) { $facts.account=@{exists=$false} }
  elseif ($users.Count -eq 1) {
    $members=@(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction Stop)
    $direct=@($members | Where-Object { $_.SID.Value -eq $users[0].SID.Value }).Count -gt 0
    $nested=@($members | Where-Object ObjectClass -eq 'Group').Count -gt 0
    $facts.account=@{exists=$true;enabled=[bool]$users[0].Enabled;administrator=($direct -or $users[0].SID.Value.EndsWith('-500'));indirectUnresolved=$nested}
  }
} catch {}
try {
  $service=Get-CimInstance Win32_Service -Filter "Name='sshd'" -ErrorAction Stop
  if (!$service.PathName -or $service.PathName.Length -gt 32767 -or $service.PathName.Contains([char]0)) { throw 'service command unavailable' }
  # Node is already required by the paired rig entry. Reuse its shipped pure
  # argv parser without an Add-Type/compiler or shell interpretation dependency.
  $argvStart=New-Object Diagnostics.ProcessStartInfo
  $argvStart.FileName=(Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $argvStart.Arguments='-e "eval(Buffer.from(''${serviceArgvProgramBase64}'',''base64'').toString(''utf8''))"'
  $argvStart.UseShellExecute=$false;$argvStart.CreateNoWindow=$true
  $argvStart.RedirectStandardInput=$true;$argvStart.RedirectStandardOutput=$true;$argvStart.RedirectStandardError=$true
  $argvStart.StandardOutputEncoding=New-Object Text.UTF8Encoding($false)
  $argvProcess=New-Object Diagnostics.Process
  try {
    $argvProcess.StartInfo=$argvStart;[void]$argvProcess.Start()
    $argvOutput=$argvProcess.StandardOutput.ReadToEndAsync();$argvError=$argvProcess.StandardError.ReadToEndAsync()
    $argvProcess.StandardInput.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($service.PathName)));$argvProcess.StandardInput.Close()
    if (!$argvProcess.WaitForExit(5000)) { $argvProcess.Kill();throw 'service argv observation timeout' }
    if ($argvProcess.ExitCode -ne 0 -or !$argvOutput.Wait(1000)) { throw 'service argv observation failed' }
    $sshdWords=[string[]](ConvertFrom-Json -InputObject $argvOutput.Result)
  } finally { if ($argvProcess.Id -and !$argvProcess.HasExited) { $argvProcess.Kill() };$argvProcess.Dispose() }
  $exe=$sshdWords[0]
  if ([IO.Path]::GetFileName($exe) -ine 'sshd.exe' -or ![IO.Path]::IsPathRooted($exe)) { throw 'service executable unqualified' }
  $sshdProbeArgs=New-Object 'System.Collections.Generic.List[string]'
  for ($index=1;$index -lt $sshdWords.Length;$index++) {
    $word=$sshdWords[$index]
    if ($word -cmatch '^-(D|e|q|i|d{1,3})$') { continue }
    if ($word -eq '-4' -or $word -eq '-6') { $sshdProbeArgs.Add($word); continue }
    if ($word -cmatch '^-[fophcguE]') {
      $option=$word.Substring(0,2)
      if ($word.Length -eq 2) { $index++; if ($index -ge $sshdWords.Length) { throw 'missing service option value' }; $optionValue=$sshdWords[$index] }
      else { $optionValue=$word.Substring(2) }
      if (!$optionValue) { throw 'empty service option value' }
      if ($option -eq '-E') { continue } # Do not create the service's log file during a read.
      if ($option -eq '-f' -and $optionValue -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/])') { throw 'relative service configuration is unqualified' }
      $sshdProbeArgs.Add($option);$sshdProbeArgs.Add($optionValue);continue
    }
    throw 'unsupported service option'
  }
  function Read-OpenRigSshSettings($lines) {
    $settings=@{}
    foreach ($line in $lines) { if ($line -match '^(usedns|authenticationmethods|passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|gssapiauthentication|hostbasedauthentication|denygroups)\s+(.+)$') { $settings[$matches[1]]=$matches[2].Trim().ToLowerInvariant() } }
    return $settings
  }
  if (Test-Path -LiteralPath $exe -PathType Leaf) {
    $connection=@($env:SSH_CONNECTION -split '\s+' | Where-Object { $_ })
    $sourceIp=$null;$localIp=$null;$localPort=0
    # Always supply the connection before the first query: Match LocalPort can
    # reject even a nominal global -T read without it.
    if ($connection.Count -eq 4 -and [Net.IPAddress]::TryParse($connection[0],[ref]$sourceIp) -and [Net.IPAddress]::TryParse($connection[2],[ref]$localIp) -and [int]::TryParse($connection[3],[ref]$localPort) -and $localPort -ge 1 -and $localPort -le 65535) {
      $context=',host='+$connection[0]+',addr='+$connection[0]+',laddr='+$connection[2]+',lport='+$localPort
      $effective=@(& $exe @sshdProbeArgs -T -C ('user=openrig'+$context) 2>$null)
      if ($LASTEXITCODE -eq 0) {
        $settings=Read-OpenRigSshSettings $effective
        # With DNS enabled the resolved client host is not known here.
        if ($settings['usedns'] -ne 'no') { throw 'resolved SSH client host unavailable' }
        $scope='service-login-context';$adminSettings=@{};$adminQualified=$false
        $builtin=@(Get-LocalUser -ErrorAction Stop | Where-Object { $_.SID.Value.EndsWith('-500') })
        if ($builtin.Count -eq 1 -and $builtin[0].Name -notmatch '[,\x00-\x1f]') {
          $adminEffective=@(& $exe @sshdProbeArgs -T -C ('user='+$builtin[0].Name.ToLowerInvariant()+$context) 2>$null)
          if ($LASTEXITCODE -eq 0) { $adminSettings=Read-OpenRigSshSettings $adminEffective;$adminQualified=$true }
        }
        $admin=Get-LocalGroup -SID 'S-1-5-32-544' -ErrorAction Stop
        $facts.ssh=@{scope=$scope;administratorContextQualified=$adminQualified;methods=$settings['authenticationmethods'];password=$settings['passwordauthentication'];keyboard=$settings['kbdinteractiveauthentication'];publicKey=$settings['pubkeyauthentication'];gssapi=$settings['gssapiauthentication'];hostbased=$settings['hostbasedauthentication'];denyGroups=$adminSettings['denygroups'];administratorGroup=$admin.Name.ToLowerInvariant()}
      }
    }
  }
} catch {}
try {
  $profiles=@(Get-NetFirewallProfile -PolicyStore ActiveStore -ErrorAction Stop)
  $facts.firewall=@($profiles | ForEach-Object { @{name=[string]$_.Name;enabled=[string]$_.Enabled;inbound=[string]$_.DefaultInboundAction} })
} catch {}
try {
  $adapters=@(Get-NetAdapter -IncludeHidden -ErrorAction Stop | Where-Object InterfaceDescription -like 'Tailscale*')
  if ($adapters.Count -gt 0) {
    $allowed=$false
    foreach ($rule in @(Get-NetFirewallRule -PolicyStore ActiveStore -Enabled True -Direction Inbound -Action Allow -ErrorAction Stop)) {
      foreach ($filter in @(Get-NetFirewallInterfaceFilter -AssociatedNetFirewallRule $rule -ErrorAction Stop)) {
        foreach ($alias in @($filter.InterfaceAlias)) {
          if ($alias -and $alias -ne 'Any' -and @($adapters | Where-Object { $_.Name -like $alias }).Count -gt 0) { $allowed=$true }
        }
      }
    }
    $facts.tailnetAllow=$allowed
  }
} catch {}
try {
  $statusRaw=& tailscale.exe status --json 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'status unavailable' }
  $status=$statusRaw | ConvertFrom-Json
  if (!$status.Self) { throw 'status incomplete' }
  $prefsRaw=& tailscale.exe debug prefs --json 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'prefs unavailable' }
  $prefs=$prefsRaw | ConvertFrom-Json
  $runSsh=$null
  if ($prefs.RunSSH -is [bool]) { $runSsh=$prefs.RunSSH }
  elseif ($prefs.Prefs.RunSSH -is [bool]) { $runSsh=$prefs.Prefs.RunSSH }
  elseif ($prefs.CurrentProfile.RunSSH -is [bool]) { $runSsh=$prefs.CurrentProfile.RunSSH }
  $facts.tailscale=@{routes=@($status.Self.PrimaryRoutes | Where-Object { $null -ne $_ }).Count;exitNode=([bool]$status.ExitNodeStatus -or $status.Self.ExitNodeOption -eq $true);runSsh=$runSsh}
} catch {}
try { $facts.listeners=@(Get-NetTCPConnection -State Listen -LocalPort $postureDaemonPort -ErrorAction Stop | ForEach-Object { [string]$_.LocalAddress }) } catch {}
$facts | ConvertTo-Json -Depth 6 -Compress
`;

export function windowsPostureScriptForPort(daemonPort?: number): string {
  const selected = resolvePosturePorts({ daemonPort }).daemonPort;
  return WINDOWS_POSTURE_SCRIPT.replace("$postureDaemonPort=7433", `$postureDaemonPort=${selected}`);
}

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const row = (step: string, status: CheckRow["status"], detail: string, fix: string): CheckRow => ({ step, status, detail, ...(status !== "pass" ? { fix } : {}) });
const trustedBind = (address: string): boolean => {
  if (address === "::1") return true;
  if (isIP(address) !== 4) return false;
  const bytes = address.split(".").map(Number);
  return bytes[0] === 127 || (bytes[0] === 100 && bytes[1]! >= 64 && bytes[1]! <= 127);
};

/** Interpret only bounded native observations. Missing/ambiguous facts never become a pass. */
export function windowsPostureRows(value: unknown, opts: Pick<PostureOptions, "daemonPort"> = {}): CheckRow[] {
  const { daemonPort } = resolvePosturePorts(opts);
  const parsed = record(value);
  const facts = parsed.version === 1 ? parsed : {};
  const valid = facts.version === 1;
  const account = record(valid ? facts.account : null), ssh = record(valid ? facts.ssh : null), ts = record(valid ? facts.tailscale : null);
  const rows: CheckRow[] = [];
  const accountStatus = account.exists === false || account.enabled === false || account.administrator === true ? "fail"
    : account.exists === true && account.enabled === true && account.administrator === false && account.indirectUnresolved === false ? "pass" : "unknown";
  rows.push(row("nonadmin-openrig-user", accountStatus,
    accountStatus === "pass" ? "enabled local openrig account; complete direct administrator census has no membership or nested groups"
      : accountStatus === "fail" ? "local openrig account is missing, disabled or an administrator" : "local openrig account or indirect administrator membership is unverified",
    "Inspect Get-LocalUser openrig and Get-LocalGroupMember -SID S-1-5-32-544; use an enabled non-administrator account."));
  const denyGroups = typeof ssh.denyGroups === "string" ? ssh.denyGroups.split(/\s+/) : [];
  const group = typeof ssh.administratorGroup === "string" ? ssh.administratorGroup : "";
  // Names containing whitespace/pattern syntax require OpenSSH-aware matching; do not guess it here.
  const simpleGroups = !!group && !/[\s,*?![\]]/.test(group) && denyGroups.every(value => !/[,*!?[\]]/.test(value));
  const denied = simpleGroups && denyGroups.includes(group);
  const sshQualified = ssh.scope === "service-login-context";
  const administratorDenied = ssh.administratorContextQualified === true && denied;
  rows.push(row("administrator-ssh-disabled", administratorDenied ? "pass" : "unknown",
    administratorDenied ? "built-in administrator's effective SSH login context explicitly denies its Administrators group"
      : "an explicit built-in administrator SSH denial for this connection context is not confirmed",
    "Inspect effective Windows OpenSSH DenyGroups for the Administrators SID group and any Match/user-specific overrides; retain console access before changing SSH policy."));
  const authKnown = sshQualified && [ssh.password, ssh.keyboard, ssh.publicKey, ssh.gssapi, ssh.hostbased].every(value => value === "yes" || value === "no");
  const methods = typeof ssh.methods === "string" ? ssh.methods.trim() : "";
  const explicitlyKeyOnly = !!methods && methods.split(/\s+/).every(sequence => /^publickey(?:,publickey)*$/.test(sequence));
  const alternatives = [ssh.password, ssh.keyboard, ssh.gssapi, ssh.hostbased];
  const keyOnly = sshQualified && ssh.publicKey === "yes" && (explicitlyKeyOnly || (authKnown && methods === "any" && alternatives.every(value => value === "no")));
  const authFailure = sshQualified && (ssh.publicKey === "no" || (methods === "any" && alternatives.some(value => value === "yes")));
  rows.push(row("key-only-ssh", keyOnly ? "pass" : authFailure ? "fail" : "unknown",
    keyOnly || authFailure ? `openrig login context: methods=${methods}; publickey=${ssh.publicKey}; password=${ssh.password}; keyboard-interactive=${ssh.keyboard}; gssapi=${ssh.gssapi ?? "unreported"}; hostbased=${ssh.hostbased ?? "unreported"}` : "effective openrig SSH authentication policy or connection context is incomplete",
    "Inspect the actual sshd service configuration and Match overrides; confirm public-key authentication and disable alternative authentication methods for this baseline."));
  const profiles = valid && Array.isArray(facts.firewall) ? facts.firewall.map(record) : [];
  const complete = ["domain", "private", "public"].every(name => profiles.filter(p => String(p.name).toLowerCase() === name).length === 1);
  const known = complete && profiles.every(p => ["true", "false"].includes(String(p.enabled).toLowerCase()) && ["block", "allow"].includes(String(p.inbound).toLowerCase()));
  const blocking = known && profiles.every(p => String(p.enabled).toLowerCase() === "true" && String(p.inbound).toLowerCase() === "block");
  rows.push(row("firewall-default-deny-incoming", known ? blocking ? "pass" : "fail" : "unknown",
    known ? blocking ? "Domain, Private and Public ActiveStore profiles enabled with default inbound Block" : "an ActiveStore profile is disabled or permits inbound traffic by default" : "effective firewall profiles/default actions are incomplete or NotConfigured",
    "Inspect Get-NetFirewallProfile -PolicyStore ActiveStore; verify all three effective profiles and their inbound defaults."));
  rows.push(row("tailnet-ingress-allowed", valid && typeof facts.tailnetAllow === "boolean" ? facts.tailnetAllow ? "pass" : "fail" : "unknown",
    facts.tailnetAllow === true ? "an enabled inbound Allow rule explicitly selects an observed Tailscale adapter; effective port access still requires a connection probe"
      : facts.tailnetAllow === false ? "no explicit inbound Allow rule selects an observed Tailscale adapter" : "Tailscale adapter/firewall interface-rule observation unavailable",
    "Inspect enabled ActiveStore inbound rules and their interface filters for the actual Tailscale adapter; verify the required connection separately."));
  const tsKnown = Number.isSafeInteger(ts.routes) && Number(ts.routes) >= 0 && typeof ts.exitNode === "boolean" && typeof ts.runSsh === "boolean";
  const tsUnsafe = Number.isSafeInteger(ts.routes) && Number(ts.routes) > 0 || ts.exitNode === true || ts.runSsh === true;
  rows.push(row("tailscale-minimal-trust", tsUnsafe ? "fail" : tsKnown ? "pass" : "unknown",
    tsKnown ? `advertised routes=${ts.routes}; exit node=${ts.exitNode}; Tailscale SSH=${ts.runSsh}` : "Tailscale status/preferences are incomplete",
    "Inspect tailscale status --json and tailscale debug prefs --json; remove unneeded advertised routes/exit-node use and disable Tailscale SSH."));
  const listeners = valid && facts.daemonPort === daemonPort && Array.isArray(facts.listeners) && facts.listeners.every(address => typeof address === "string" && isIP(address)) ? facts.listeners as string[] : null;
  rows.push(row("daemon-bind-not-public", listeners?.length ? listeners.every(trustedBind) ? "pass" : "fail" : "unknown",
    listeners?.length ? listeners.every(trustedBind) ? `observed :${daemonPort} listeners use loopback/tailnet addresses` : `an observed :${daemonPort} listener uses a public or wildcard address` : `no complete :${daemonPort} listener observation for the selected port`,
    `Inspect Get-NetTCPConnection -State Listen -LocalPort ${daemonPort} and the selected daemon host binding.`));
  return rows;
}

export async function windowsPostureCheck(host: HostEntry, deps: DoctorDeps, opts: PostureOptions = {}): Promise<CheckRow[]> {
  const { daemonPort, sshPort } = resolvePosturePorts(opts);
  if (host.transport !== "ssh" || host.remoteShell !== "powershell") return WINDOWS_POSTURE_ITEMS.map(step => row(step, "unknown",
    "Windows native posture requires an explicitly selected PowerShell SSH entry", "Select the Windows host's SSH entry with remoteShell: powershell; HTTP/POSIX entries cannot supply these observations."));
  let facts: unknown = null;
  try {
    const result = await deps.run(host, WINDOWS_POSTURE_ARGV, { stdin: windowsPostureScriptForPort(daemonPort) });
    if (result.ok && Buffer.byteLength(result.stdout) <= 65536) facts = JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
  } catch { /* Unreadable native facts stay unknown; no changing command is attempted. */ }
  const rows = windowsPostureRows(facts, { daemonPort });
  for (const [step, port] of [["public-daemon-port-unreachable", daemonPort], ["public-ssh-unreachable-or-accepted", sshPort]] as const) {
    if (!opts.publicAddr || !isIP(opts.publicAddr)) { rows.push(row(step, "unknown", "no literal public probe address supplied", "Pass --public-addr <ip> for the owned host's outside-vantage probe.")); continue; }
    let probe: "open" | "closed" | "unknown" = "unknown";
    try { probe = await deps.tcpProbe(opts.publicAddr, port, 5000); } catch { /* unknown */ }
    rows.push(row(step, probe === "open" ? "fail" : probe === "closed" ? "pass" : "unknown",
      probe === "open" ? `outside-vantage TCP :${port} connected` : probe === "closed" ? `outside-vantage TCP :${port} did not connect (refusal/filter/timeout)` : `outside-vantage TCP :${port} unavailable`,
      `Inspect Windows Firewall and network ingress for :${port}; a failed dial alone does not prove a specific firewall rule.`));
  }
  return rows;
}
