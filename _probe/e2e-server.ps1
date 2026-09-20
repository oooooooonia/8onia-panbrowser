# E2E: start an isolated headless PanBrowser main process (own userData, port 17999) and verify the
# new /api/stream path: when the upstream cannot be built it must answer 502 quickly instead of
# leaving the response hanging half-written. Empty credentials override the seeded ones (no account use).
# Compatible with Windows PowerShell 5.1.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$ud = Join-Path $PSScriptRoot 'e2e-userdata'
New-Item -ItemType Directory -Force -Path $ud | Out-Null
@{
  clientId = ''; clientSecret = ''; refreshToken = ''; accessToken = ''; accessTokenExpiresAt = 0
  port = 17999; hostBind = '127.0.0.1'; rootFolderPath = '/'
} | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $ud 'config.json')

function Get-Raw([string]$url, [bool]$withRange) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $req = [System.Net.HttpWebRequest]::Create($url)
    $req.Timeout = 45000
    $req.ReadWriteTimeout = 45000
    $req.UserAgent = 'e2e-probe'
    if ($withRange) { [void]$req.AddRange(0, 2047) }
    $resp = $req.GetResponse()
    $code = [int]$resp.StatusCode
    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $body = $sr.ReadToEnd()
    $sr.Close(); $resp.Close(); $sw.Stop()
    return @{ Code = $code; Body = $body; Ms = $sw.ElapsedMilliseconds }
  } catch [System.Net.WebException] {
    $sw.Stop()
    $resp = $_.Exception.Response
    if ($resp) {
      try { $sr = New-Object System.IO.StreamReader($resp.GetResponseStream()); $body = $sr.ReadToEnd() } catch { $body = '' }
      return @{ Code = [int]$resp.StatusCode; Body = $body; Ms = $sw.ElapsedMilliseconds }
    }
    return @{ Code = -1; Body = $_.Exception.Message; Ms = $sw.ElapsedMilliseconds }
  }
}

$env:PANBOX_HEADLESS = '1'
$env:PANBOX_USERDATA = $ud
$exe = Join-Path $root 'node_modules\electron\dist\electron.exe'
Write-Host "PSVersion=$($PSVersionTable.PSVersion) electron=$exe"
$p = Start-Process -FilePath $exe -ArgumentList '.' -WorkingDirectory $root -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 8
Write-Host "electron pid=$($p.Id) hasExited=$($p.HasExited)"

$base = 'http://127.0.0.1:17999'
$st = Get-Raw "$base/api/status" $false
Write-Host ("[/api/status] HTTP {0} in {1}ms len={2}" -f $st.Code, $st.Ms, $st.Body.Length)

$r1 = Get-Raw "$base/api/stream?path=/no-such-file.mp4" $true
Write-Host ("[stream+Range #1] HTTP {0} in {1}ms body={2}" -f $r1.Code, $r1.Ms, $r1.Body)
$r2 = Get-Raw "$base/api/stream?path=/no-such-file.mp4" $false
Write-Host ("[stream #2]       HTTP {0} in {1}ms body={2}" -f $r2.Code, $r2.Ms, $r2.Body)

Write-Host '--- server debug log tail (new stream fail/retry lines) ---'
$log = Join-Path $root '.debug\log.txt'
if (Test-Path $log) { Get-Content $log -Tail 5 | ForEach-Object { Write-Host "  $_" } }

Write-Host '--- cleanup ---'
& taskkill /PID $p.Id /T /F 2>&1 | Out-String | Write-Host
Start-Sleep -Seconds 1
Remove-Item -Recurse -Force $ud -ErrorAction SilentlyContinue
