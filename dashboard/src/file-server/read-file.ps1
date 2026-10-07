$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class LapisSafeRead {
  [StructLayout(LayoutKind.Sequential)] public struct Info {
    public uint Attr; public System.Runtime.InteropServices.ComTypes.FILETIME Create,Access,Write;
    public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle h,StringBuilder p,uint n,uint f);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string p,uint a,uint s,IntPtr security,uint mode,uint flags,IntPtr template);
  static string Final(SafeFileHandle h){var b=new StringBuilder(32768);uint n=GetFinalPathNameByHandle(h,b,(uint)b.Capacity,0);if(n==0||n>=b.Capacity)throw new IOException();string p=b.ToString();if(p.StartsWith(@"\\?\"))p=p.Substring(4);return p;}
  public static void Run(string root,string ino,string path,long start,long end){
    using(var dir=CreateFile(root,0,1,IntPtr.Zero,3,0x02000000,IntPtr.Zero)){
      Info ri;if(dir.IsInvalid||!GetFileInformationByHandle(dir,out ri))throw new IOException();
      ulong rootId=((ulong)ri.IndexHigh<<32)|ri.IndexLow;
      if(rootId.ToString()!=ino||!String.Equals(Final(dir),root,StringComparison.OrdinalIgnoreCase))throw new IOException();
      using(var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)){
        Info fi;if(!GetFileInformationByHandle(file.SafeFileHandle,out fi)||fi.Links!=1||fi.Volume!=ri.Volume)throw new IOException();
        string final=Final(file.SafeFileHandle);
        if(!String.Equals(final,path,StringComparison.OrdinalIgnoreCase)||!final.StartsWith(root.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase))throw new IOException();
        long count=file.Length==0?0:end-start+1;
        if(start<0||end>=file.Length||count<0)throw new IOException();
        var stdout=Console.OpenStandardOutput();var header=Encoding.UTF8.GetBytes("{\"size\":"+file.Length+",\"bytes\":"+count+"}\n");stdout.Write(header,0,header.Length);stdout.Flush();file.Position=start;
        var buffer=new byte[65536];while(count>0){int n=file.Read(buffer,0,(int)Math.Min(buffer.Length,count));if(n==0)throw new IOException();stdout.Write(buffer,0,n);count-=n;}stdout.Flush();
      }
    }
  }
}
'@
try { [LapisSafeRead]::Run([string]$request.root,[string]$request.rootIno,[string]$request.path,[long]$request.start,[long]$request.end) }
catch { exit 1 }
