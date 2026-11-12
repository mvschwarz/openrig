param([string]$EncodedPayload)
$ErrorActionPreference='Stop'
Remove-Item Env:TMUX -ErrorAction SilentlyContinue
$config=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedPayload)) | ConvertFrom-Json
$tmux=$config.tmux; $target=$config.session; $server=@($config.server); $retrySeconds=[int]$config.retrySeconds
$routing=@{Target=$target}
function Quote-Argument([string]$value) {
  $builder=New-Object Text.StringBuilder; [void]$builder.Append([char]34); $slashes=0
  foreach($char in $value.ToCharArray()){
    if($char -eq [char]92){$slashes++; continue}
    $count=$slashes; if($char -eq [char]34){$count=$slashes*2+1}
    [void]$builder.Append([char]92,[int]$count); [void]$builder.Append($char); $slashes=0
  }
  [void]$builder.Append([char]92,($slashes*2)); [void]$builder.Append([char]34); return $builder.ToString()
}
function Join-Arguments([object[]]$values) {
  $quoted=@(); foreach($value in $values){$quoted+=Quote-Argument ([string]$value)}; return $quoted -join " "
}
# The first -t selects psmux's session server. A later bare $N only selects
# an immutable session within that server; it must never choose the default.
function Set-Target([string]$name) {
  $routing.Target=$name
  $routing.Route=@($server)+@('-t',('='+$name))
  $attach=$routing.Route+@('attach'); if($config.readOnly){$attach+='-r'}else{$attach+=@('-f','ignore-size')}; $attach+='-t'
  $routing.SnapshotLine=Join-Arguments ($routing.Route+@('display-message','-p','-t',('='+$name+':'),'#{pid} #{session_id}:#{session_name}'))
  $routing.IdentityPrefix=Join-Arguments ($routing.Route+@('show-environment','-t'))
  $routing.AttachPrefix=Join-Arguments $attach
  $routing.FallbackLine=Join-Arguments ($attach+@('='+$name))
}
function Invoke-Tmux([string]$line,[bool]$capture) {
  $info=New-Object Diagnostics.ProcessStartInfo
  $info.FileName=$tmux; $info.Arguments=$line; $info.UseShellExecute=$false
  if($capture){
    $info.CreateNoWindow=$true; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
    $info.StandardOutputEncoding=New-Object Text.UTF8Encoding($false)
    $info.StandardErrorEncoding=New-Object Text.UTF8Encoding($false)
  }
  if(-not $capture -and $config.gate -and -not $script:openrigGateOpened){
    $writable=$info.Arguments
    $info.Arguments=$writable.Replace('"-f" "ignore-size"','"-r"')
    $observer=[Diagnostics.Process]::Start($info)
    try {
      while(-not $observer.HasExited -and -not [IO.File]::Exists($config.gate.path) -and [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() -lt $config.gate.until){Start-Sleep -Milliseconds 100}
      if($observer.HasExited){$config | Add-Member -MemberType NoteProperty -Name attachOnly -Value $true -Force; return @{Code=$observer.ExitCode;Output='';Error=''}}
      $opened=[IO.File]::Exists($config.gate.path)
      $observer.Kill(); $observer.WaitForExit()
      if(-not $opened){[Console]::WriteLine($config.gate.expired);$config | Add-Member -MemberType NoteProperty -Name attachOnly -Value $true -Force;return @{Code=0;Output='';Error=''}}
      Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class OpenRigViewerInput { [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n); [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushConsoleInputBuffer(IntPtr h); public static void Flush(){if(!FlushConsoleInputBuffer(GetStdHandle(-10)))throw new System.ComponentModel.Win32Exception();} }'
      [OpenRigViewerInput]::Flush()
      $script:openrigGateOpened=$true
      return Invoke-Tmux $writable $false
    } finally {if(-not $observer.HasExited){$observer.Kill();$observer.WaitForExit()};$observer.Dispose()}
  }
  $child=[Diagnostics.Process]::Start($info)
  try {
    if($capture){$out=$child.StandardOutput.ReadToEndAsync(); $err=$child.StandardError.ReadToEndAsync()}
    $child.WaitForExit(); $code=$child.ExitCode; $text=""
    $errorText=''; if($capture){$text=$out.GetAwaiter().GetResult(); $errorText=$err.GetAwaiter().GetResult()}
    return @{Code=$code; Output=$text; Error=$errorText}
  } finally {$child.Dispose()}
}
function Test-ExactSession([string]$name) {
  $result=Invoke-Tmux (Join-Arguments (@($server)+@('has-session','-t',('='+$name)))) $true
  if($result.Code -eq 0){return $true}
  if($result.Code -eq 1 -and [string]::IsNullOrEmpty($result.Output) -and [string]::IsNullOrEmpty($result.Error)){return $false}
  if($result.Error -match "^(session not found|can't find session|no current target|no sessions?)\b"){return $false}
  throw 'Native session presence is unknown; no attachment was attempted.'
}
function Read-NameMarker([string]$name) {
  $line=Join-Arguments (@($server)+@('-t',('='+$name),'show-options','-qv','-t',('='+$name+':'),'@openrig-logical-session-v1'))
  $result=Invoke-Tmux $line $true
  if($result.Code -ne 0){throw 'Native session binding could not be read.'}
  return $result.Output.TrimEnd([char[]]"`r`n")
}
function Resolve-Target {
  if($null -eq $config.nativeBinding){return [string]$config.session}
  $binding=$config.nativeBinding; $present=Test-ExactSession $binding.physical
  $matched=$false; if($present){$matched=(Read-NameMarker $binding.physical) -ceq $binding.marker}
  $legacy=$false
  if($binding.legacy -and (Test-ExactSession $config.session)){$legacy=[string]::IsNullOrEmpty((Read-NameMarker $config.session))}
  if($matched -and $legacy){throw 'Native session name is ambiguous; no attachment was attempted.'}
  if($matched){return [string]$binding.physical}
  if($legacy){return [string]$config.session}
  throw 'Native session has no matching logical binding; no attachment was attempted.'
}
Set-Target $target
function Read-Snapshot {
  try {
    Set-Target (Resolve-Target)
    $result=Invoke-Tmux $routing.SnapshotLine $true
    $text=$result.Output.TrimEnd([char[]]"`r`n")
    if($result.Code -eq 0 -and $text -cmatch "^([0-9]+) (\$[0-9]+):(.*)$"){
      if($Matches[3] -ceq $routing.Target){return @{Key=$Matches[1]+" "+$Matches[2]; Id=$Matches[2]}}
    }
  } catch {}
  return $null
}
function Read-Identity($snapshot) {
  try {
    $line=$routing.IdentityPrefix+' "'+$snapshot.Id+'" "OPENRIG_NODE_ID"'
    $result=Invoke-Tmux $line $true
    if($result.Code -eq 0){
      $text=$result.Output.TrimEnd([char[]]"`r`n")
      if($text -cmatch "^OPENRIG_NODE_ID=.+$" -and $text -notmatch "[\r\n]"){return $text}
    }
  } catch {}
  return $null
}
$snapshot=Read-Snapshot
if($null -eq $snapshot){
  if($null -ne $config.nativeBinding){[Console]::Error.WriteLine('Native logical attachment could not be verified; reopen this view after checking its binding.'); exit 1}
  $result=Invoke-Tmux $routing.FallbackLine $false; exit $result.Code
}
$node=Read-Identity $snapshot
if([string]::IsNullOrEmpty($node)){
  [Console]::WriteLine("No managed identity for "+$target+"; reopen this view after replacement.")
  $result=Invoke-Tmux ($routing.AttachPrefix+' "'+$snapshot.Id+'"') $false; exit $result.Code
}
while($true){
  $attached=Invoke-Tmux ($routing.AttachPrefix+' "'+$snapshot.Id+'"') $false
  if($attached.Code -ne 0){
    [Console]::Error.WriteLine("Viewer attach failed (exit "+$attached.Code+"); inspect the selected server before reopening this view.")
    exit $attached.Code
  }
  if($config.attachOnly){exit $attached.Code}
  $left=$retrySeconds; $same=0
  while($left -gt 0){
    $next=Read-Snapshot
    if($null -ne $next){
      $identity=Read-Identity $next
      if(-not [string]::IsNullOrEmpty($identity)){
        if($identity -cne $node){[Console]::WriteLine("Seat identity changed for "+$target+"; reopen its view."); exit 1}
        if($next.Key -cne $snapshot.Key){$snapshot=$next; break}
        $same++; if($same -ge 3){exit 0}
      } else {$same=0}
    } else {$same=0}
    Start-Sleep -Seconds 1; $left--
  }
  if($left -eq 0){[Console]::WriteLine("No replacement for "+$target+"; reopen the view with rig terminal open."); exit 0}
}
