param([string]$EncodedPayload)
$ErrorActionPreference='Stop'
Remove-Item Env:TMUX -ErrorAction SilentlyContinue
$config=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedPayload)) | ConvertFrom-Json
$tmux=$config.tmux; $target=$config.session; $server=@($config.server); $retrySeconds=[int]$config.retrySeconds
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
$attach=@($server)+@('attach'); if($config.readOnly){$attach+='-r'}else{$attach+=@('-f','ignore-size')}; $attach+='-t'
$snapshotLine=Join-Arguments (@($server)+@('display-message','-p','-t',('='+$target+':'),'#{pid} #{session_id}:#{session_name}'))
$identityPrefix=Join-Arguments (@($server)+@('show-environment','-t'))
$attachPrefix=Join-Arguments $attach
$fallbackLine=Join-Arguments ($attach+@('='+$target))
function Invoke-Tmux([string]$line,[bool]$capture) {
  $info=New-Object Diagnostics.ProcessStartInfo
  $info.FileName=$tmux; $info.Arguments=$line; $info.UseShellExecute=$false
  if($capture){
    $info.CreateNoWindow=$true; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
    $info.StandardOutputEncoding=New-Object Text.UTF8Encoding($false)
    $info.StandardErrorEncoding=New-Object Text.UTF8Encoding($false)
  }
  $child=[Diagnostics.Process]::Start($info)
  try {
    if($capture){$out=$child.StandardOutput.ReadToEndAsync(); $err=$child.StandardError.ReadToEndAsync()}
    $child.WaitForExit(); $code=$child.ExitCode; $text=""
    if($capture){$text=$out.GetAwaiter().GetResult(); $null=$err.GetAwaiter().GetResult()}
    return @{Code=$code; Output=$text}
  } finally {$child.Dispose()}
}
function Read-Snapshot {
  try {
    $result=Invoke-Tmux $snapshotLine $true
    $text=$result.Output.TrimEnd([char[]]"`r`n")
    if($result.Code -eq 0 -and $text -cmatch "^([0-9]+) (\$[0-9]+):(.*)$"){
      if($Matches[3] -ceq $target){return @{Key=$Matches[1]+" "+$Matches[2]; Id=$Matches[2]}}
    }
  } catch {}
  return $null
}
function Read-Identity($snapshot) {
  try {
    $line=$identityPrefix+' "'+$snapshot.Id+'" "OPENRIG_NODE_ID"'
    $result=Invoke-Tmux $line $true
    if($result.Code -eq 0){
      $text=$result.Output.TrimEnd([char[]]"`r`n")
      if($text -cmatch "^OPENRIG_NODE_ID=.+$" -and $text -notmatch "[\r\n]"){return $text}
    }
  } catch {}
  return $null
}
$snapshot=Read-Snapshot
if($null -eq $snapshot){$result=Invoke-Tmux $fallbackLine $false; exit $result.Code}
$node=Read-Identity $snapshot
if([string]::IsNullOrEmpty($node)){
  [Console]::WriteLine("No managed identity for "+$target+"; reopen this view after replacement.")
  $result=Invoke-Tmux ($attachPrefix+' "'+$snapshot.Id+'"') $false; exit $result.Code
}
while($true){
  $null=Invoke-Tmux ($attachPrefix+' "'+$snapshot.Id+'"') $false
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
