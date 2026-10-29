import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/** A real native executable for tests of shell-free Windows subprocess APIs.
 * It forwards literal argv/stdio/status to an owned Node fixture, never cmd.exe. */
export function writeWindowsNodeFixture(directory, name, source) {
  const script = join(directory, name + ".mjs"), executable = join(directory, name + ".exe");
  const cs = join(directory, name + ".cs");
  const compiler = ["Framework64", "Framework"].map(folder => join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", folder, "v4.0.30319", "csc.exe")).find(existsSync);
  if (!compiler) throw Error("Native executable fixtures require the Windows .NET Framework C# compiler");
  writeFileSync(script, source);
  writeFileSync(cs, `using System; using System.Text; using System.Diagnostics;
class Fixture {
  static string Quote(string value) {
    var b=new StringBuilder(); b.Append((char)34); int slashes=0;
    foreach(char c in value) {
      if(c==(char)92) { slashes++; continue; }
      b.Append((char)92, c==(char)34 ? slashes*2+1 : slashes); b.Append(c); slashes=0;
    }
    b.Append((char)92,slashes*2); b.Append((char)34); return b.ToString();
  }
  static int Main(string[] args) {
    var command=new StringBuilder(Quote(${JSON.stringify(script)}));
    foreach(string arg in args) command.Append(' ').Append(Quote(arg));
    var info=new ProcessStartInfo(${JSON.stringify(process.execPath)},command.ToString());
    info.UseShellExecute=false; info.CreateNoWindow=true;
    info.RedirectStandardInput=true; info.RedirectStandardOutput=true; info.RedirectStandardError=true;
    using(var child=Process.Start(info)) {
      Console.OpenStandardInput().CopyToAsync(child.StandardInput.BaseStream).ContinueWith(task => {
        try { child.StandardInput.Close(); } catch(System.InvalidOperationException) {} catch(System.IO.IOException) {}
      });
      var output=child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
      var errors=child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
      child.WaitForExit(); System.Threading.Tasks.Task.WaitAll(output,errors); return child.ExitCode;
    }
  }
}`);
  execFileSync(compiler, ["/nologo", "/target:exe", "/codepage:65001", "/out:" + executable, cs], { windowsHide: true, stdio: "pipe" });
  return executable;
}
