
$ErrorActionPreference = 'Continue'
$env:GCM_INTERACTIVE = 'never'
$nl = [Environment]::NewLine
$inp = 'protocol=https' + $nl + 'host=github.com' + $nl + 'username=aa15119557034' + $nl + $nl
$out = $inp | git credential fill 2>&1
$pass = ((($out | Where-Object { $_ -match '^password=' }) -replace '^password=','') -join '').Trim()
$h = @{ Authorization = "Bearer $pass"; 'User-Agent'='dsh'; Accept='application/vnd.github+json' }
foreach ($n in 219, 218) {
  $cs = @(Invoke-RestMethod ("https://api.github.com/repos/aa15119557034/agent-review-room/issues/" + $n + "/comments?per_page=100") -Headers $h)
  '=== PR ' + $n + ' comments=' + $cs.Count
  $cs | Select-Object -Last 3 | ForEach-Object { '[' + $_.created_at + '] ' + $_.user.login; $_.body; '---' }
}
