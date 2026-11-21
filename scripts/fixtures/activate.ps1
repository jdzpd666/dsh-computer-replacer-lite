# Bring a window to the foreground the way a person switching windows does (no input synthesis).
# The classic recipe: share the current foreground thread's input queue, then SetForegroundWindow.
param([Parameter(Mandatory = $true)][long]$Hwnd)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Activate {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  public static bool Take(IntPtr target) {
    uint pid;
    IntPtr foreground = GetForegroundWindow();
    uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out pid);
    uint targetThread = GetWindowThreadProcessId(target, out pid);
    uint mine = GetCurrentThreadId();
    if (foregroundThread != 0) AttachThreadInput(mine, foregroundThread, true);
    if (targetThread != 0) AttachThreadInput(mine, targetThread, true);
    ShowWindow(target, 9);
    bool ok = SetForegroundWindow(target);
    if (targetThread != 0) AttachThreadInput(mine, targetThread, false);
    if (foregroundThread != 0) AttachThreadInput(mine, foregroundThread, false);
    return ok;
  }
}
'@
$ok = [Activate]::Take([IntPtr]$Hwnd)
Write-Output ("ACTIVATE " + $ok)
