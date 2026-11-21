# Task 3 fixture: one multiline classic EDIT surface (WinForms TextBox), no tabs,
# no islands. COMMIT writes the live text to -Out and closes; the TextBox HWND is
# published to -StateFile so the harness and probe can target/read it directly.
param(
  [string]$Name = 'KB3',
  [string]$Out = '',
  [string]$StateFile = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ForceFgKb {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
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
$form.Size = New-Object System.Drawing.Size(420, 240)
$form.StartPosition = 'CenterScreen'
$field = New-Object System.Windows.Forms.TextBox
$field.Name = 'field'
$field.Multiline = $true
$field.Location = New-Object System.Drawing.Point(16, 16)
$field.Size = New-Object System.Drawing.Size(370, 120)
$form.Controls.Add($field)
$button = New-Object System.Windows.Forms.Button
$button.Name = 'commit'
# ASCII only: Windows PowerShell 5.1 reads this file as ANSI, so non-ASCII labels would mangle.
$button.Text = 'COMMIT'
$button.Location = New-Object System.Drawing.Point(16, 150)
$button.Size = New-Object System.Drawing.Size(120, 34)
$button.Add_Click({
  if ($Out) { [System.IO.File]::WriteAllText($Out, $field.Text, (New-Object System.Text.UTF8Encoding $false)) }
  $form.Close()
})
$form.Controls.Add($button)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 700
$timer.Add_Tick({
  $timer.Stop()
  if ($StateFile) { [System.IO.File]::WriteAllText($StateFile, $field.Handle.ToInt64().ToString()) }
  $form.Activate()
  [ForceFgKb]::Take($form.Handle)
})
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
