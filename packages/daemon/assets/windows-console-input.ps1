param([Parameter(Mandatory=$true)][int]$TargetPid,
      [string]$PayloadFile,
      [ValidateSet('bracketed','codex','codex-clear')][string]$Mode = 'bracketed')
$ErrorActionPreference = 'Stop'
$phase = 'read'
try {
  $birth = (Get-Process -Id $TargetPid).StartTime.ToUniversalTime().Ticks
  $text = if ($Mode -eq 'codex-clear') { [char]21 } else { [IO.File]::ReadAllText($PayloadFile, [Text.Encoding]::UTF8) }
  $phase = 'compile'
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OpenRigConsoleInput {
  [StructLayout(LayoutKind.Sequential)] public struct KeyEvent {
    public int Down; public ushort Repeat, VirtualKey, Scan, Character; public uint Control;
  }
  [StructLayout(LayoutKind.Explicit, Size=20)] public struct InputRecord {
    [FieldOffset(0)] public ushort Type;
    [FieldOffset(4)] public KeyEvent Key;
  }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool WriteConsoleInputW(IntPtr handle, InputRecord[] records, uint count, out uint written);
  public static void Write(IntPtr handle, string text, bool codex) {
    for (int start=0; start<text.Length; start+=2048) {
      int count=Math.Min(2048, text.Length-start);
      var records=new InputRecord[count];
      for (int i=0;i<count;i++) {
        char character=text[start+i];
        // Crossterm's native Windows backend reads key events, not VT paste
        // delimiters. Shift+Return inserts a literal newline in Codex's composer.
        records[i]=new InputRecord { Type=1, Key=new KeyEvent {
          Down=1,Repeat=1,Character=(ushort)(codex && character=='\n' ? '\r' : character),
          VirtualKey=(ushort)(codex && character=='\n' ? 13 : codex && character==21 ? 85 : 0),
          Control=(uint)(codex && character=='\n' ? 16 : codex && character==21 ? 8 : 0)
        }};
      }
      uint written;
      if (!WriteConsoleInputW(handle,records,(uint)count,out written) || written != count)
        throw new InvalidOperationException("Console input write incomplete");
    }
  }
}
'@
  $phase = 'attach'
  if ((Get-Process -Id $TargetPid).StartTime.ToUniversalTime().Ticks -ne $birth) { throw 'Target changed' }
  [OpenRigConsoleInput]::FreeConsole() | Out-Null
  if (-not [OpenRigConsoleInput]::AttachConsole([uint32]$TargetPid)) { throw 'Console attach failed' }
  $phase = 'open'
  $handle = [OpenRigConsoleInput]::CreateFileW('CONIN$', [uint32]3221225472, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
  if ($handle -eq [IntPtr]::new(-1)) { throw 'Console input unavailable' }
  try {
    if ((Get-Process -Id $TargetPid).StartTime.ToUniversalTime().Ticks -ne $birth) { throw 'Target changed' }
    $phase = 'write'
    $codex = $Mode -ne 'bracketed'
    $payload = if ($codex) { $text } else { [char]27 + '[200~' + $text + [char]27 + '[201~' }
    [OpenRigConsoleInput]::Write($handle, $payload, $codex)
    if ($codex) { Start-Sleep -Milliseconds 250 }
  } finally { [OpenRigConsoleInput]::CloseHandle($handle) | Out-Null; [OpenRigConsoleInput]::FreeConsole() | Out-Null }
} catch {
  # Diagnostics must never echo payload, credentials or launcher arguments.
  [Console]::Error.WriteLine("Windows console delivery failed at $phase; no successful delivery receipt.")
  exit 1
}
