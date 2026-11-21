Get-Process | Where-Object { $_.ProcessName -match 'notepad|keyboard_probe|overlay|replacer' } | Select-Object Id,ProcessName,CPU,MainWindowHandle | Format-Table -AutoSize | Out-String -Width 120
