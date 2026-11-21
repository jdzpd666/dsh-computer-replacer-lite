# Batch-4 locate fixture (vision-only channel, C1): a fixed WinForms Form that paints CJK text
# itself in the Paint event with Graphics.DrawString. The form has NO child controls, so that text
# exists only in pixels: UIA cannot see it, OCR can. This is the case that proves why the vision
# channel exists (replacer_locate textOnly = screen text with no UIA counterpart).
#
# Run (Windows PowerShell 5.1; this file is UTF-8 **with BOM** so the CJK literals survive the
# ANSI-codepage trap documented in HANDOFF.md - do not re-save without BOM):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fixtures\locate-drawn.ps1
# Optional params:
#   -StateFile <path>   writes {"pid":..,"hwnd":..,"title":..} once the window is on screen
#   -ActivateAfterMs    delay before the fixture takes the foreground (default 700 ms)
# Close the window (X / Alt+F4) to exit; the harness taskkills the PID it spawned.
#
# Fixed contract for scripts/verify-locate.mjs (C2):
#   window title  = replacer-locate-drawn
#   drawn text    = 绘制文字-仅视觉可见
#                   (painted black at client (40,80), Microsoft YaHei UI 26pt Bold, white bg)
#   UIA tree      = the window root only; Controls.Count is 0, so no UIA label carries the text.
#   TopMost       = true so the screen region is never occluded during the OCR capture
#                   (z-order only: no input injection, no focus change).
param(
  [string]$Title = 'replacer-locate-drawn',
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
$form.ClientSize = New-Object System.Drawing.Size(760, 320)
$form.BackColor = [System.Drawing.Color]::White
$form.TopMost = $true
$drawnText = '绘制文字-仅视觉可见'
$form.Add_Paint({
  param($sender, $paintEvent)
  $font = New-Object System.Drawing.Font('Microsoft YaHei UI', 26, [System.Drawing.FontStyle]::Bold)
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black)
  try {
    $paintEvent.Graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $paintEvent.Graphics.DrawString($drawnText, $font, $brush, [System.Drawing.PointF]::new(40, 80))
  } finally {
    $brush.Dispose()
    $font.Dispose()
  }
})
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
