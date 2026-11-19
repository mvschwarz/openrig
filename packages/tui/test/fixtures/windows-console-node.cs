using System;
using System.Text;
using System.Runtime.InteropServices;
class ConsoleNode {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int size; public string reserved,desktop,title;
    public uint x,y,xSize,ySize,xChars,yChars,fill,flags;
    public ushort show,reservedSize; public IntPtr reservedData,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct Child { public IntPtr process,thread;public uint pid,tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup start,out Child child);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(IntPtr handler,bool ignore);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr handle,out long created,out long exited,out long kernel,out long user);
  static string Quote(string value) {
    var b=new StringBuilder("\"");int slashes=0;
    foreach(char c in value) {
      if(c=='\\') { slashes++;continue; }
      b.Append('\\',c=='"'?slashes*2+1:slashes);b.Append(c);slashes=0;
    }
    return b.Append('\\',slashes*2).Append('"').ToString();
  }
  static int Main(string[] args) {
    // A detached parent can pass its inheritable CTRL_C ignore attribute on.
    // Reset this fixture launcher before creating the private child console.
    if(!SetConsoleCtrlHandler(IntPtr.Zero,false))return 124;
    var command=new StringBuilder();foreach(string arg in args)command.Append(Quote(arg)).Append(' ');
    var start=new Startup { size=Marshal.SizeOf(typeof(Startup)),flags=0x101,show=0,
      input=GetStdHandle(-10),output=GetStdHandle(-11),error=GetStdHandle(-12) };
    foreach(var handle in new[]{start.input,start.output,start.error})if(!SetHandleInformation(handle,1,1))return 125;
    Child child;
    // CREATE_NEW_CONSOLE + SW_HIDE: a real private console without showing a test window.
    if(!CreateProcess(args[0],command,IntPtr.Zero,IntPtr.Zero,true,0x10,IntPtr.Zero,null,ref start,out child))return 126;
    try {
      long created,exited,kernel,user;
      if(!GetProcessTimes(child.process,out created,out exited,out kernel,out user))return 123;
      Console.WriteLine("FIXTURE_TUI_PID:"+child.pid+":"+created);
      WaitForSingleObject(child.process,0xffffffff);uint code;
      return GetExitCodeProcess(child.process,out code)?unchecked((int)code):127;
    } finally { CloseHandle(child.thread);CloseHandle(child.process); }
  }
}
