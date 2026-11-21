# Controlled Win32 test window: one text box and one button. The button writes the text box
# content to -Out and closes the form, so the assertion layer can read it without the plugin.
param(
  [string]$Name = 'A',
  [string]$Out = '',
  [int]$ActivateAfterMs = 900
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ForceFg {
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
$form.Size = New-Object System.Drawing.Size(420, 200)
$form.StartPosition = 'CenterScreen'
$field = New-Object System.Windows.Forms.TextBox
$field.Name = 'field'
$field.Location = New-Object System.Drawing.Point(16, 16)
$field.Size = New-Object System.Drawing.Size(360, 28)
$form.Controls.Add($field)
$button = New-Object System.Windows.Forms.Button
$button.Name = 'commit'
# ASCII only: Windows PowerShell 5.1 reads this file as ANSI, so non-ASCII labels would mangle.
$button.Text = 'COMMIT'
$button.Location = New-Object System.Drawing.Point(16, 64)
$button.Size = New-Object System.Drawing.Size(120, 34)
$button.Add_Click({
  if ($Out) { [System.IO.File]::WriteAllText($Out, $field.Text, (New-Object System.Text.UTF8Encoding $false)) }
  $form.Close()
})
$form.Controls.Add($button)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $ActivateAfterMs
$timer.Add_Tick({ $timer.Stop(); $form.Activate(); [ForceFg]::Take($form.Handle) })
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
