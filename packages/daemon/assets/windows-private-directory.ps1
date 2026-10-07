param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
try {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $security = [System.Security.AccessControl.DirectorySecurity]::new()
  $security.SetOwner($sid)
  $security.SetAccessRuleProtection($true, $false)
  foreach ($identity in @($sid, $system)) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $security.AddAccessRule($rule)
  }
  # This overload applies the DACL at creation, before any capability is written.
  if (-not [System.IO.Directory]::Exists($Path)) { [System.IO.Directory]::CreateDirectory($Path, $security) | Out-Null }
  $directory = [System.IO.DirectoryInfo]::new($Path)
  if (($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point' }
  $actual = $directory.GetAccessControl()
  if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Owner or inherited access' }
  $ownerAccess = $false
  foreach ($rule in $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow') {
      if ($rule.IdentityReference.Value -notin @($sid.Value, $system.Value)) { throw 'Other identity' }
      if ($rule.IdentityReference.Value -eq $sid.Value -and ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl) { $ownerAccess = $true }
    }
  }
  if (-not $ownerAccess) { throw 'Missing owner access' }
} catch {
  [Console]::Error.WriteLine('Windows private control directory unavailable; no capability published.')
  exit 1
}
