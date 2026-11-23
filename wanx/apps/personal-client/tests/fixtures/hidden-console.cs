using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading;

// Test-only driver. Give PowerShell a real, hidden console instead of pipe
// handles, and inject keys only into that isolated console's input buffer.
internal static class HiddenConsole {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int cb; public string reserved, desktop, title;
    public int x,y,xSize,ySize,xChars,yChars,fill,flags;
    public short show,reservedSize; public IntPtr reservedPtr,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public int id,threadId; }
  [StructLayout(LayoutKind.Sequential)] struct JobBasic {
    public long processTime,jobTime; public uint flags;
    public UIntPtr minWorkingSet,maxWorkingSet; public uint activeProcesses;
    public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct JobLimits {
    public JobBasic basic;
    public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes;
    public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory;
  }
  [StructLayout(LayoutKind.Explicit, Size=20)] struct InputRecord {
    [FieldOffset(0)] public short type;
    [FieldOffset(4)] public int down;
    [FieldOffset(8)] public short repeat;
    [FieldOffset(10)] public short key;
    [FieldOffset(14)] public char character;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder args, IntPtr pa, IntPtr ta, bool inherit, int flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo info);
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(int id);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr security, int disposition, int flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool WriteConsoleInput(IntPtr input, InputRecord[] records, int count, out int written);
  [DllImport("kernel32.dll")] static extern int WaitForSingleObject(IntPtr handle, int timeout);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out int code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, int code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr security,string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job,int kind,ref JobLimits limits,int size);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  static int Main(string[] args) {
    var startup = new Startup { cb=Marshal.SizeOf(typeof(Startup)), flags=1, show=0 };
    ProcessInfo info;
    if (!CreateProcess(args[0], new StringBuilder("\""+args[0]+"\" -NoProfile -ExecutionPolicy Bypass -File \""+args[1]+"\""), IntPtr.Zero, IntPtr.Zero, false, 0x10, IntPtr.Zero, null, ref startup, out info)) return 90;
    var job=CreateJobObject(IntPtr.Zero,null);
    try {
      var limits=new JobLimits {basic=new JobBasic {flags=0x2000}};
      if (job==IntPtr.Zero||!SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(JobLimits)))||!AssignProcessToJobObject(job,info.process)) return 97;
      for (int phase=2;phase<args.Length;phase+=2) {
        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (!File.Exists(args[phase])) {
          if (WaitForSingleObject(info.process, 20)==0) { int exit; GetExitCodeProcess(info.process,out exit); return exit; }
          if (DateTime.UtcNow >= deadline) return 91;
        }
        Thread.Sleep(150); // An EOF bug must fail before the injected input.
        FreeConsole();
        if (!AttachConsole(info.id)) return 92;
        var input=CreateFile("CONIN$",0xc0000000,3,IntPtr.Zero,3,0,IntPtr.Zero);
        if (input==new IntPtr(-1)) return 93;
        try {
          var keys=new InputRecord[args[phase+1].Length*2];
          for (int i=0;i<args[phase+1].Length;i++) {
            keys[i*2]=new InputRecord {type=1,down=1,repeat=1,key=(short)(args[phase+1][i]=='\r'?13:0),character=args[phase+1][i]};
            keys[i*2+1]=keys[i*2]; keys[i*2+1].down=0;
          }
          int written;
          if (!WriteConsoleInput(input,keys,keys.Length,out written)||written!=keys.Length) return 94;
        } finally { CloseHandle(input); }
      }
      if (WaitForSingleObject(info.process,15000)!=0) return 95;
      int code; GetExitCodeProcess(info.process,out code); return code;
    } finally { TerminateProcess(info.process,96); CloseHandle(job); CloseHandle(info.thread); CloseHandle(info.process); }
  }
}
