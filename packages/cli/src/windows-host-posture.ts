import { isIP } from "node:net";
import type { HostEntry } from "./host-registry.js";
import type { CheckRow, DoctorDeps } from "./commands/host.js";

export const WINDOWS_POSTURE_PROFILE_ID = "product-factory-windows";
export const WINDOWS_POSTURE_ITEMS = ["nonadmin-openrig-user", "administrator-ssh-disabled", "key-only-ssh",
  "firewall-default-deny-incoming", "tailnet-ingress-allowed", "tailscale-minimal-trust", "daemon-bind-not-public",
  "public-daemon-port-unreachable", "public-ssh-unreachable-or-accepted"] as const;
// The trusted shipped collector travels over stdin. Read it as one script,
// avoiding both SSH/cmd length limits and PowerShell's interactive stdin parser.
export const WINDOWS_POSTURE_ARGV = ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
  Buffer.from("$ErrorActionPreference='Stop'; & ([ScriptBlock]::Create([Console]::In.ReadToEnd()))", "utf16le").toString("base64")] as const;

/** Read-only, fixed collector. Never outputs keys, raw configuration, user SIDs or Tailscale account data. */
export const WINDOWS_POSTURE_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$facts=[ordered]@{version=1;account=$null;ssh=$null;firewall=$null;tailnetAllow=$null;tailscale=$null;listeners=$null}
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
  $exe=$null
  if ($service.PathName -match '^\s*"([^"]+\.exe)"\s*$') { $exe=$matches[1] }
  elseif ($service.PathName -match '^\s*([^\s"]+\.exe)\s*$') { $exe=$matches[1] }
  # Alternate service arguments/configuration need a separate qualified read.
  if ($exe -and (Test-Path -LiteralPath $exe -PathType Leaf)) {
    $config=@(& $exe -T 2>$null)
    if ($LASTEXITCODE -eq 0) {
      $settings=@{}
      foreach ($line in $config) { if ($line -match '^(passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|gssapiauthentication|hostbasedauthentication|denygroups)\s+(.+)$') { $settings[$matches[1]]=$matches[2].Trim().ToLowerInvariant() } }
      $admin=Get-LocalGroup -SID 'S-1-5-32-544' -ErrorAction Stop
      $facts.ssh=@{scope='service-default-global';password=$settings['passwordauthentication'];keyboard=$settings['kbdinteractiveauthentication'];publicKey=$settings['pubkeyauthentication'];gssapi=$settings['gssapiauthentication'];hostbased=$settings['hostbasedauthentication'];denyGroups=$settings['denygroups'];administratorGroup=$admin.Name.ToLowerInvariant()}
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
try { $facts.listeners=@(Get-NetTCPConnection -State Listen -LocalPort 7433 -ErrorAction Stop | ForEach-Object { [string]$_.LocalAddress }) } catch {}
$facts | ConvertTo-Json -Depth 6 -Compress
`;

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const row = (step: string, status: CheckRow["status"], detail: string, fix: string): CheckRow => ({ step, status, detail, ...(status !== "pass" ? { fix } : {}) });
const trustedBind = (address: string): boolean => {
  if (address === "::1") return true;
  if (isIP(address) !== 4) return false;
  const bytes = address.split(".").map(Number);
  return bytes[0] === 127 || (bytes[0] === 100 && bytes[1]! >= 64 && bytes[1]! <= 127);
};

/** Interpret only bounded native observations. Missing/ambiguous facts never become a pass. */
export function windowsPostureRows(value: unknown): CheckRow[] {
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
  const denied = !!group && !/[\s*?!]/.test(group) && denyGroups.includes(group);
  const sshQualified = ssh.scope === "service-default-global";
  rows.push(row("administrator-ssh-disabled", sshQualified && denied ? "pass" : "unknown",
    sshQualified && denied ? "default service-wide sshd configuration explicitly denies the Administrators group"
      : "an explicit service-wide administrator SSH denial is not confirmed",
    "Inspect effective Windows OpenSSH DenyGroups for the Administrators SID group and any Match/user-specific overrides; retain console access before changing SSH policy."));
  const authKnown = sshQualified && [ssh.password, ssh.keyboard, ssh.publicKey, ssh.gssapi, ssh.hostbased].every(value => value === "yes" || value === "no");
  const keyOnly = ssh.publicKey === "yes" && [ssh.password, ssh.keyboard, ssh.gssapi, ssh.hostbased].every(value => value === "no");
  rows.push(row("key-only-ssh", authKnown ? keyOnly ? "pass" : "fail" : "unknown",
    authKnown ? `default service-wide publickey=${ssh.publicKey}; password=${ssh.password}; keyboard-interactive=${ssh.keyboard}; gssapi=${ssh.gssapi}; hostbased=${ssh.hostbased}` : "default service-wide SSH authentication policy is incomplete",
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
  const listeners = valid && Array.isArray(facts.listeners) && facts.listeners.every(address => typeof address === "string" && isIP(address)) ? facts.listeners as string[] : null;
  rows.push(row("daemon-bind-not-public", listeners?.length ? listeners.every(trustedBind) ? "pass" : "fail" : "unknown",
    listeners?.length ? listeners.every(trustedBind) ? "observed :7433 listeners use loopback/tailnet addresses" : "an observed :7433 listener uses a public or wildcard address" : "no complete :7433 listener observation",
    "Inspect Get-NetTCPConnection -State Listen -LocalPort 7433 and the daemon host binding; verify the intended daemon port separately if it differs."));
  return rows;
}

export async function windowsPostureCheck(host: HostEntry, deps: DoctorDeps, opts: { publicAddr?: string } = {}): Promise<CheckRow[]> {
  if (host.transport !== "ssh" || host.remoteShell !== "powershell") return WINDOWS_POSTURE_ITEMS.map(step => row(step, "unknown",
    "Windows native posture requires an explicitly selected PowerShell SSH entry", "Select the Windows host's SSH entry with remoteShell: powershell; HTTP/POSIX entries cannot supply these observations."));
  let facts: unknown = null;
  try {
    const result = await deps.run(host, WINDOWS_POSTURE_ARGV, { stdin: WINDOWS_POSTURE_SCRIPT });
    if (result.ok && Buffer.byteLength(result.stdout) <= 65536) facts = JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
  } catch { /* Unreadable native facts stay unknown; no changing command is attempted. */ }
  const rows = windowsPostureRows(facts);
  for (const [step, port] of [["public-daemon-port-unreachable", 7433], ["public-ssh-unreachable-or-accepted", 22]] as const) {
    if (!opts.publicAddr || !isIP(opts.publicAddr)) { rows.push(row(step, "unknown", "no literal public probe address supplied", "Pass --public-addr <ip> for the owned host's outside-vantage probe.")); continue; }
    let probe: "open" | "closed" | "unknown" = "unknown";
    try { probe = await deps.tcpProbe(opts.publicAddr, port, 5000); } catch { /* unknown */ }
    rows.push(row(step, probe === "open" ? "fail" : probe === "closed" ? "pass" : "unknown",
      probe === "open" ? `outside-vantage TCP :${port} connected` : probe === "closed" ? `outside-vantage TCP :${port} did not connect (refusal/filter/timeout)` : `outside-vantage TCP :${port} unavailable`,
      `Inspect Windows Firewall and network ingress for :${port}; a failed dial alone does not prove a specific firewall rule.`));
  }
  return rows;
}
