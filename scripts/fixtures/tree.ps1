# Controlled scrollable Win32 window: a tree view with many nodes.
param([string]$Name = 'TREE', [int]$Nodes = 200, [int]$ActivateAfterMs = 900)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ForceFg {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  public static void Take(IntPtr h) {
    uint pid;
    uint target = GetWindowThreadProcessId(h, out pid);
    uint mine = GetCurrentThreadId();
    AttachThreadInput(mine, target, true);
    SetForegroundWindow(h);
    AttachThreadInput(mine, target, false);
  }
}
'@
$form = New-Object System.Windows.Forms.Form
$form.Text = "REPLACER_FIXTURE_$Name"
$form.Size = New-Object System.Drawing.Size(360, 420)
$form.StartPosition = 'CenterScreen'
$tree = New-Object System.Windows.Forms.TreeView
$tree.Name = 'nodes'
$tree.Location = New-Object System.Drawing.Point(12, 12)
$tree.Size = New-Object System.Drawing.Size(320, 340)
1..$Nodes | ForEach-Object { [void]$tree.Nodes.Add("node $_") }
$form.Controls.Add($tree)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $ActivateAfterMs
$timer.Add_Tick({ $timer.Stop(); $form.Activate(); [ForceFg]::Take($form.Handle) })
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
