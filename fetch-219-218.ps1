
$ErrorActionPreference = 'Continue'
$env:GCM_INTERACTIVE = 'never'
$nl = [Environment]::NewLine
$inp = 'protocol=https' + $nl + 'host=github.com' + $nl + 'username=aa15119557034' + $nl + $nl
$out = $inp | git credential fill 2>&1
$pass = ((($out | Where-Object { $_ -match '^password=' }) -replace '^password=','') -join '').Trim()
$h = "Authorization: Bearer $pass"
foreach ($n in 219, 218) {
  curl.exe -sS --max-time 25 -H $h -H 'User-Agent: dsh' -H 'Accept: application/vnd.github+json' ("https://api.github.com/repos/aa15119557034/agent-review-room/pulls/" + $n) -o ("E:\agent-review-room\.review\p" + $n + ".json")
  curl.exe -sS --max-time 25 -H $h -H 'User-Agent: dsh' ("https://api.github.com/repos/aa15119557034/agent-review-room/pulls/" + $n + "/files?per_page=100") -o ("E:\agent-review-room\.review\p" + $n + "-files.json")
  curl.exe -sS --max-time 25 -H $h -H 'User-Agent: dsh' ("https://api.github.com/repos/aa15119557034/agent-review-room/issues/" + $n + "/comments?per_page=100") -o ("E:\agent-review-room\.review\p" + $n + "-comments.json")
}
foreach ($n in 219, 218) {
  $p = Get-Content ("E:\agent-review-room\.review\p" + $n + ".json") -Raw | ConvertFrom-Json
  '=== PR ' + $n + ' | ' + $p.title + ' | state=' + $p.state + ' merged=' + $p.merged + ' | ' + $p.head.ref + ' -> ' + $p.base.ref + ' | ' + $p.changed_files + ' files +' + $p.additions + ' -' + $p.deletions
  '--- body'; $p.body
  '--- comments'; $cs = @(Get-Content ("E:\agent-review-room\.review\p" + $n + "-comments.json") -Raw | ConvertFrom-Json); foreach ($c in $cs) { '[' + $c.created_at + '] ' + $c.user.login; $c.body; '---' }
}
