<#
  Подготовка PC Stream к запуску из исходников:
    1) скачивает FFmpeg (сборка BtbN, GPL, с NVENC и gfxcapture) в pc\bin\ffmpeg.exe;
    2) компилирует pc\bin\winlist.exe из pc\native\winlist.cs (.NET Framework, есть в Windows).

  FFmpeg весит ~170 МБ и в репозиторий не входит (лимит GitHub — 100 МБ на файл).

  Запуск:  powershell -ExecutionPolicy Bypass -File tools\prepare.ps1
           powershell -ExecutionPolicy Bypass -File tools\prepare.ps1 -Force   # скачать FFmpeg заново
#>
param([switch]$Force)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root 'pc\bin'
New-Item -ItemType Directory -Force $bin | Out-Null

# --- FFmpeg ---
$ffmpeg = Join-Path $bin 'ffmpeg.exe'
if ($Force -or -not (Test-Path $ffmpeg)) {
    $url = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'
    $zip = Join-Path $env:TEMP 'pcstream-ffmpeg.zip'
    $tmp = Join-Path $env:TEMP 'pcstream-ffmpeg'
    Write-Host "Скачиваю FFmpeg: $url"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'   # иначе Invoke-WebRequest качает очень медленно
    Invoke-WebRequest $url -OutFile $zip -UseBasicParsing
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    Expand-Archive $zip $tmp
    $exe = Get-ChildItem $tmp -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
    if (-not $exe) { throw 'В архиве нет ffmpeg.exe' }
    Copy-Item $exe.FullName $ffmpeg -Force
    $lic = Get-ChildItem $tmp -Recurse -Filter 'LICENSE*' | Select-Object -First 1
    if ($lic) { Copy-Item $lic.FullName (Join-Path $bin 'FFMPEG-LICENSE.txt') -Force }
    Remove-Item -Recurse -Force $tmp, $zip
    Write-Host "FFmpeg: $ffmpeg" -ForegroundColor Green
} else {
    Write-Host "FFmpeg уже есть: $ffmpeg (скачать заново: -Force)"
}

# Проверяем, что в сборке есть нужное: NVENC и захват экрана/окон
$filters = & $ffmpeg -hide_banner -filters 2>$null | Out-String
$encoders = & $ffmpeg -hide_banner -encoders 2>$null | Out-String
foreach ($need in 'ddagrab', 'gfxcapture') { if ($filters -notmatch $need) { Write-Host "ВНИМАНИЕ: в FFmpeg нет фильтра $need" -ForegroundColor Yellow } }
if ($encoders -notmatch 'hevc_nvenc') { Write-Host 'ВНИМАНИЕ: в FFmpeg нет hevc_nvenc' -ForegroundColor Yellow }

# --- winlist.exe ---
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
& $csc /nologo /optimize /target:exe "/out:$(Join-Path $bin 'winlist.exe')" (Join-Path $root 'pc\native\winlist.cs')
if ($LASTEXITCODE -ne 0) { throw 'Не удалось собрать winlist.exe' }
Write-Host "winlist.exe: $(Join-Path $bin 'winlist.exe')" -ForegroundColor Green
