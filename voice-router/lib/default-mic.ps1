# Prints the friendly name of the Windows default capture device (what Sound settings calls "Default"), or nothing.
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDevEnum {}
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDeviceEnumerator { int EnumAudioEndpoints(int f, int m, out IntPtr d); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice d); }
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDevice { int Activate(); int OpenPropertyStore(int a, out IPropertyStore p); }
[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IPropertyStore { int GetCount(out int c); int GetAt(int i, out PK k); int GetValue(ref PK k, out PV v); }
[StructLayout(LayoutKind.Sequential)] struct PK { public Guid g; public int pid; }
[StructLayout(LayoutKind.Explicit)] struct PV { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p; }
public static class DefaultMic { public static string Get() {
  var e = (IMMDeviceEnumerator)new MMDevEnum(); IMMDevice d; e.GetDefaultAudioEndpoint(1, 0, out d);
  IPropertyStore s; d.OpenPropertyStore(0, out s); var k = new PK { g = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 }; PV v; s.GetValue(ref k, out v);
  return Marshal.PtrToStringUni(v.p); } }
'@
  [Console]::Out.Write([DefaultMic]::Get())
} catch { }
