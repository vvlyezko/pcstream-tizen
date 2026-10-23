# Замер памяти процессов PC Stream (Electron) во времени.
# powershell -File test\memwatch.ps1 -Minutes 8 -Every 20 -Out mem.csv
param([int]$Minutes = 8, [int]$Every = 20, [string]$Out = "$env:TEMP\pcs_mem.csv")

"time,type,pid,privateMB,workingSetMB" | Set-Content $Out -Encoding utf8
$end = (Get-Date).AddMinutes($Minutes)
$t0 = Get-Date
while ((Get-Date) -lt $end) {
    $sec = [int]((Get-Date) - $t0).TotalSeconds
    Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.ExecutablePath -like '*pcstream*' } | ForEach-Object {
        $type = if ($_.CommandLine -match '--type=([\w-]+)') { $Matches[1] } else { 'main' }
        if ($type -eq 'utility' -and $_.CommandLine -match '--utility-sub-type=([\w.]+)') { $type = 'utility:' + ($Matches[1] -split '\.')[-2] }
        $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        if ($p) { "{0},{1},{2},{3:N0},{4:N0}" -f $sec, $type, $_.ProcessId, ($p.PrivateMemorySize64 / 1MB), ($p.WorkingSet64 / 1MB) -replace ' ', '' | Add-Content $Out -Encoding utf8 }
    }
    Start-Sleep -Seconds $Every
}
