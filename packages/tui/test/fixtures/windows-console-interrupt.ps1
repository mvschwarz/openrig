param([int]$Target, [string]$RootStartedAt, [string]$ExpectedJson)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class FixtureConsoleInterrupt {
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] static extern uint GetConsoleProcessList([Out] uint[] pids,uint size);
  [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(IntPtr handler,bool ignore);
  [DllImport("kernel32.dll")] static extern bool GenerateConsoleCtrlEvent(uint kind,uint group);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr handle,out long created,out long exited,out long kernel,out long user);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static void Send(int target,long started,int[] owned,int[] required) {
    var process=OpenProcess(0x1000,false,target);
    if(process==IntPtr.Zero)throw new Exception("Fixture root is unavailable");
    try {
    long created,exited,kernel,user;
    if(!GetProcessTimes(process,out created,out exited,out kernel,out user)||created!=started)throw new Exception("Fixture root identity changed");
    FreeConsole();
    if(!AttachConsole((uint)target)) throw new Exception("Cannot attach owned fixture console");
    try {
      var allowed=new HashSet<uint>();foreach(int pid in owned)allowed.Add((uint)pid);
      allowed.Add((uint)Process.GetCurrentProcess().Id);
      var pids=new uint[32];uint count=GetConsoleProcessList(pids,32);
      if(count==0||count>32)throw new Exception("Unknown fixture console membership");
      var actual=new HashSet<uint>();
      for(int i=0;i<count;i++) { if(!allowed.Contains(pids[i]))throw new Exception("Foreign process in fixture console: "+pids[i]+" "+Process.GetProcessById((int)pids[i]).ProcessName);actual.Add(pids[i]); }
      foreach(int pid in required)if(!actual.Contains((uint)pid))throw new Exception("Required fixture process missing");
      if(!SetConsoleCtrlHandler(IntPtr.Zero,true))throw new Exception("Cannot protect interrupt helper");
      if(!GenerateConsoleCtrlEvent(0,0))throw new Exception("Cannot interrupt fixture console");
      System.Threading.Thread.Sleep(100);
    } finally { FreeConsole(); }
    } finally { CloseHandle(process); }
  }
}
'@
# vite-node owns an esbuild service in the same console. Admit only current
# descendants of the exact fixture root, with monotonic creation times, never
# a process merely because its executable name is familiar.
$rows=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate)
$root=@($rows | Where-Object ProcessId -eq $Target)
if($root.Count -ne 1 -or !$root[0].CreationDate) { throw 'Fixture root identity unavailable' }
$owned=@{}; $owned[$Target]=$root[0].CreationDate
do {
  $changed=$false
  foreach($row in $rows) {
    $id=[int]$row.ProcessId; $parent=[int]$row.ParentProcessId
    if(!$owned.ContainsKey($id) -and $owned.ContainsKey($parent) -and $row.CreationDate -and $row.CreationDate -ge $owned[$parent]) {
      $owned[$id]=$row.CreationDate; $changed=$true
    }
  }
} while($changed)
foreach($expected in (ConvertFrom-Json $ExpectedJson)) {
  if(!$owned.ContainsKey([int]$expected)) { throw 'Expected process is not an owned fixture descendant' }
}
[FixtureConsoleInterrupt]::Send($Target,[long]$RootStartedAt,[int[]]@($owned.Keys),[int[]](ConvertFrom-Json $ExpectedJson))
