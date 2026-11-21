# Controlled Win32 "desk" window for the M6 end-to-end run: an editable field, a tree view to
# scroll, and buttons that mutate the field and append to a log the test reads directly.
# Everything the plugin does is asserted from outside: -Log lines are written by this app on each
# click, -Out is a JSON dump written by the app itself when SAVE is clicked.
param(
  [string]$Name = 'DESK',
  [string]$Out = '',
  [string]$Log = '',
  [int]$Nodes = 200,
  [int]$ActivateAfterMs = 900
)
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
function Write-Log([string]$line) {
  if ($Log) { [System.IO.File]::AppendAllText($Log, $line + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding $false)) }
}
$form = New-Object System.Windows.Forms.Form
$form.Text = "REPLACER_FIXTURE_$Name"
$form.Size = New-Object System.Drawing.Size(700, 640)
$form.StartPosition = 'CenterScreen'
$field = New-Object System.Windows.Forms.TextBox
$field.Name = 'field'
$field.Multiline = $true
$field.ScrollBars = 'Vertical'
$field.Location = New-Object System.Drawing.Point(12, 12)
$field.Size = New-Object System.Drawing.Size(660, 110)
$form.Controls.Add($field)
$tree = New-Object System.Windows.Forms.TreeView
$tree.Name = 'nodes'
$tree.Location = New-Object System.Drawing.Point(12, 134)
$tree.Size = New-Object System.Drawing.Size(660, 330)
1..$Nodes | ForEach-Object { [void]$tree.Nodes.Add("node $_") }
$form.Controls.Add($tree)
function Add-Button([string]$caption, [int]$x, [scriptblock]$onClick) {
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $caption
  $button.Location = New-Object System.Drawing.Point($x, 480)
  $button.Size = New-Object System.Drawing.Size(150, 40)
  $button.Add_Click($onClick)
  $form.Controls.Add($button)
  return $button
}
$null = Add-Button 'APPEND_ALPHA' 12 {
  $field.Text = $field.Text + ' [ALPHA]'
  Write-Log 'APPEND_ALPHA'
}
$null = Add-Button 'APPEND_BETA' 174 {
  $field.Text = $field.Text + ' [BETA]'
  Write-Log 'APPEND_BETA'
}
$null = Add-Button 'CLEAR' 336 {
  $field.Text = ''
  Write-Log 'CLEAR'
}
$null = Add-Button 'SAVE' 498 {
  $payload = [ordered]@{ text = $field.Text; appendLog = @([System.IO.File]::ReadAllLines($Log)); treeTop = $tree.TopNode.Text }
  [System.IO.File]::WriteAllText($Out, ($payload | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding $false))
  Write-Log 'SAVE'
  $form.Close()
}
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $ActivateAfterMs
$timer.Add_Tick({ $timer.Stop(); $form.Activate(); [ForceFg]::Take($form.Handle) })
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
