param([string]$TargetHwnd = '2557626')
Add-Type -Namespace K5 -Name W -MemberDefinition '
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, Func<IntPtr,IntPtr,bool> cb, IntPtr l);
 [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);'
$chain = New-Object System.Collections.ArrayList
function Walk($h, $depth) {
  $sb = New-Object System.Text.StringBuilder 256
  [void][K5.W]::GetClassName($h, $sb, 256)
  [void]$chain.Add(("$([Convert]::ToInt64($h)) d$depth <$($sb.ToString())>"))
  [K5.W]::EnumChildWindows($h, { param($c, $l) Walk $c ($depth + 1); $true }, [IntPtr]::Zero) | Out-Null
}
Walk ([IntPtr][Convert]::ToInt64($TargetHwnd)) 0
$chain
