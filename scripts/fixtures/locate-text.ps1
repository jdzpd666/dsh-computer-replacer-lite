# Batch-4 locate fixture (text channel, C1): a fixed-size / fixed-position WinForms window whose
# controls are UIA-visible AND whose text is large enough for the WinRT OCR channel to read.
# This is the positive case for replacer_locate fusion: both channels see the same CJK words.
#
# Run (Windows PowerShell 5.1; this file is UTF-8 **with BOM** so the CJK literals survive
# the ANSI-codepage trap documented in HANDOFF.md - do not re-save without BOM):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fixtures\locate-text.ps1
# Optional params:
#   -StateFile <path>   writes {"pid":..,"hwnd":..,"title":..} once the window is on screen
#   -ActivateAfterMs    delay before the fixture takes the foreground (default 700 ms)
# Close the window (X / Alt+F4) to exit; the harness taskkills the PID it spawned.
#
# Fixed contract for scripts/verify-locate.mjs (C2):
#   window title = replacer-locate-fixture   (identify via replacer_windows / state-file hwnd)
#   host process = powershell.exe (the -File host); hwnd comes from -StateFile
#   geometry     = form at (120,120) logical, ClientSize 560x300 (fixed, never CenterScreen)
#   UIA labels   = 文件 (Label), 保存 / 提交 (Button)   <- the positive query is 保存
#   TopMost      = true so the screen region is never occluded during the OCR capture;
#                  this is window z-order only, it does not inject input or touch focus.
# Nothing mutates the text after startup; no timers other than the one-shot activation.
param(
  [string]$Title = 'replacer-locate-fixture',
  [string]$StateFile = '',
  [int]$ActivateAfterMs = 700
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
$form.Text = $Title
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedSingle
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Location = New-Object System.Drawing.Point(120, 120)
$form.ClientSize = New-Object System.Drawing.Size(560, 300)
$form.BackColor = [System.Drawing.Color]::White
$form.TopMost = $true
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 16, [System.Drawing.FontStyle]::Regular)

$labelFile = New-Object System.Windows.Forms.Label
$labelFile.Name = 'label-file'
$labelFile.Text = '文件'
$labelFile.AutoSize = $true
$labelFile.Location = New-Object System.Drawing.Point(40, 40)
$form.Controls.Add($labelFile)

$btnSave = New-Object System.Windows.Forms.Button
$btnSave.Name = 'button-save'
$btnSave.Text = '保存'
$btnSave.Location = New-Object System.Drawing.Point(40, 120)
$btnSave.Size = New-Object System.Drawing.Size(200, 64)
$form.Controls.Add($btnSave)

$btnSubmit = New-Object System.Windows.Forms.Button
$btnSubmit.Name = 'button-submit'
$btnSubmit.Text = '提交'
$btnSubmit.Location = New-Object System.Drawing.Point(290, 120)
$btnSubmit.Size = New-Object System.Drawing.Size(200, 64)
$form.Controls.Add($btnSubmit)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $ActivateAfterMs
$timer.Add_Tick({
  $timer.Stop()
  if ($StateFile) {
    $state = [ordered]@{
      pid = [System.Diagnostics.Process]::GetCurrentProcess().Id
      hwnd = $form.Handle.ToInt64()
      title = $form.Text
    } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($StateFile, $state, (New-Object System.Text.UTF8Encoding $false))
  }
  $form.Activate()
  [ForceFg]::Take($form.Handle)
})
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
