<#
S-20：在这台电脑上给一位秘书安排「家」（ADR-003 §2a）。用管理员 PowerShell 运行，一次一位秘书：

  .\install-secretary.ps1 -Agent codex -HomeDir D:\AgentRoom -Port 7421 -ConfigTemplate <现有节点配置> -AppSource <仓库目录>

做的事：
  1. 检查 HomeDir 在本机 NTFS 盘上
  2. 建低权限账号 agentroom-<秘书>（随机密码，只在本次运行里用，不保存、不显示）
  3. 建 <HomeDir>\memory\<秘书>\ 的布局、memory.json、README.md；建 node\app、node\<秘书>\
  4. 设权限：<HomeDir> 关掉继承；记忆正文这位秘书只读，inbox / ext 她没有权限；配置和 Token 只有她和管理员能读
  5. 生成这位秘书的节点配置（homeDir / agent / runAsUser / port / 聊天 profile 的 memory）和 Token
  6. 注册计划任务：开机启动、不管是否登录都运行、身份是 agentroom-<秘书>
  7. 打开一个以这个账号运行的窗口，在里面登录这位秘书的命令行（Claude / Codex）

主控机上按 ADR-003 §2a「切换顺序」：先装 codex（7421）；D-40 迁移完成后才装 deepseek（7420）。
已有的记忆、文件不会被覆盖；重复运行只补缺的、重设权限。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet("claude", "deepseek", "codex")][string]$Agent,
  [Parameter(Mandatory)][string]$HomeDir,
  [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$Port,
  # 现有的节点配置（profiles 从这里拿，只保留 <秘书>- 开头的）
  [Parameter(Mandatory)][string]$ConfigTemplate,
  # 仓库目录，会复制到 <HomeDir>\node\app（不含 .git）
  [Parameter(Mandatory)][string]$AppSource,
  # 主控机上：桌面端以这个账号运行，一键导入要能读 Token（只给 Token 这一个文件只读）
  [string]$TokenReader = ""
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Fail($msg) { Write-Host "✗ $msg" -ForegroundColor Red; exit 1 }
function Step($msg) { Write-Host "→ $msg" -ForegroundColor Cyan }

$me = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$me).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail "请用「以管理员身份运行」的 PowerShell"
}
$owner = $me.Name  # 运行脚本的人（江浩）：记忆完全控制

# ---- 1. 盘
$HomeDir = [IO.Path]::GetFullPath($HomeDir).TrimEnd("\")
$drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($HomeDir))
if ($drive.DriveFormat -ne "NTFS" -or $drive.DriveType -ne "Fixed") {
  Fail "$HomeDir 所在的盘是 $($drive.DriveFormat) / $($drive.DriveType)。必须是本机 NTFS 盘（FAT、exFAT、网络盘、可移动盘上权限不生效）"
}

# ---- 2. 账号
$user = "agentroom-$Agent"
Add-Type -AssemblyName System.Web
$password = [Web.Security.Membership]::GeneratePassword(32, 6)
$secure = ConvertTo-SecureString $password -AsPlainText -Force
if (Get-LocalUser -Name $user -ErrorAction SilentlyContinue) {
  Step "账号 $user 已存在，重设密码（旧计划任务会一起更新）"
  Set-LocalUser -Name $user -Password $secure
} else {
  Step "建账号 $user"
  New-LocalUser -Name $user -Password $secure -PasswordNeverExpires -UserMayNotChangePassword -Description "Agent Review Room：$Agent 的节点" | Out-Null
}
# 只在「用户」组；不进管理员组
$account = "$env:COMPUTERNAME\$user"

# ---- 3. 文件夹
$memory = Join-Path $HomeDir "memory\$Agent"
$nodeApp = Join-Path $HomeDir "node\app"
$nodeMine = Join-Path $HomeDir "node\$Agent"
foreach ($d in @($HomeDir, (Join-Path $HomeDir "memory"), $memory, $nodeApp, $nodeMine, (Join-Path $nodeMine "sandbox"))) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}
foreach ($s in @("core", "notes", "journal", "inbox", "ext")) { New-Item -ItemType Directory -Force -Path (Join-Path $memory $s) | Out-Null }

$utf8 = [Text.UTF8Encoding]::new($false)
$settingsPath = Join-Path $memory "memory.json"
if (-not (Test-Path $settingsPath)) {
  [IO.File]::WriteAllText($settingsPath, '{ "version": 1, "budgetChars": 20000, "maxFileBytes": 65536 }' + "`n", $utf8)
}
$readme = Join-Path $memory "README.md"
if (-not (Test-Path $readme)) {
  [IO.File]::WriteAllText($readme, @"
# $Agent 的记忆

- core\：身份、和江浩的关系、长期约定。每次聊天都带，一条都不能少；放不下（超过 memory.json 的预算）时整个记忆会显示「不可用」
- notes\：长期笔记，可以有子文件夹；最近修改的优先
- journal\：经历和日记，journal\年\月-日.md 或 journal\年\月-日-标题.md；日期新的优先
- inbox\、ext\：以后用，现在节点不读
- 只认 .md / .txt（UTF-8）。搬到别的电脑时用 robocopy /COPY:DAT 保留修改时间
- 规则见仓库 docs/design/ADR-003-聊天空间.md §2a
"@, $utf8)
}

Step "复制节点程序到 $nodeApp"
robocopy $AppSource $nodeApp /MIR /XD .git /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "复制节点程序失败（robocopy $LASTEXITCODE）" }

# ---- 4. 权限
function Reset-Acl([string]$path, [string[]]$grants) {
  icacls $path /inheritance:r /Q | Out-Null
  icacls $path /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" /Q | Out-Null  # 管理员组、SYSTEM
  foreach ($g in $grants) { icacls $path /grant:r $g /Q | Out-Null }
  if ($LASTEXITCODE -ne 0) { Fail "设置权限失败：$path" }
}
Step "设权限"
# 根目录：关掉继承（很多盘根目录默认给「已验证用户」改子文件夹的权限）；各账号只能穿过
Reset-Acl $HomeDir @("${owner}:(OI)(CI)F")
Reset-Acl (Join-Path $HomeDir "memory") @("${owner}:(OI)(CI)F")
# 节点启动时要查 homeDir 和 memory 的真实路径：这两个文件夹本身给她 RX，不往下继承
foreach ($d in @($HomeDir, (Join-Path $HomeDir "memory"), (Join-Path $HomeDir "node"))) { icacls $d /grant "${account}:(RX)" /Q | Out-Null }
# 这位秘书的文件夹本身和 memory.json：她能读，但不往子文件夹继承（inbox / ext 她没有权限）
Reset-Acl $memory @("${owner}:(OI)(CI)F", "${account}:(RX)")
icacls $settingsPath /grant:r "${account}:(R)" /Q | Out-Null
foreach ($s in @("core", "notes", "journal")) { icacls (Join-Path $memory $s) /grant:r "${account}:(OI)(CI)(RX)" /Q | Out-Null }
# 节点程序：只读
icacls $nodeApp /grant "${account}:(OI)(CI)(RX)" /Q | Out-Null
# 配置和 Token：只有她和管理员（江浩不在这里，Token 另外单给）
Reset-Acl $nodeMine @("${account}:(OI)(CI)(RX)")
icacls (Join-Path $nodeMine "sandbox") /grant "${account}:(OI)(CI)M" /Q | Out-Null

# ---- 5. 配置和 Token
$template = Get-Content -Raw -Encoding UTF8 $ConfigTemplate | ConvertFrom-Json
$profiles = [ordered]@{}
foreach ($p in $template.profiles.PSObject.Properties) {
  if (-not $p.Name.StartsWith("$Agent-")) { continue }  # 节点也会拒绝别人的 profile
  $p.Value.cwd = (Join-Path $nodeMine "sandbox")
  if ($p.Name -eq "$Agent-chat") {
    $p.Value | Add-Member -Force -NotePropertyName memory -NotePropertyValue ([ordered]@{ dir = "memory/$Agent"; provider = "folder" })
  }
  $profiles[$p.Name] = $p.Value
}
if ($profiles.Count -eq 0) { Fail "模板里没有 $Agent- 开头的 profile" }
$template.profiles = [pscustomobject]$profiles
$template.port = $Port
foreach ($kv in @(@("homeDir", $HomeDir), @("agent", $Agent), @("runAsUser", $user), @("tokenFile", "agent-server.token"))) {
  $template | Add-Member -Force -NotePropertyName $kv[0] -NotePropertyValue $kv[1]
}
$configPath = Join-Path $nodeMine "agent-server.config.json"
[IO.File]::WriteAllText($configPath, ($template | ConvertTo-Json -Depth 20), $utf8)

$tokenPath = Join-Path $nodeMine "agent-server.token"
if (-not (Test-Path $tokenPath)) {
  $bytes = [byte[]]::new(32)
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  [IO.File]::WriteAllText($tokenPath, (($bytes | ForEach-Object { $_.ToString("x2") }) -join "") + "`n", $utf8)
}
if ($TokenReader -ne "") {
  # 只给 Token 这一个文件只读，不给文件夹（ADR-003 §2a：桌面端以普通账号一键导入）
  icacls $tokenPath /grant "${TokenReader}:(R)" /Q | Out-Null
}

# ---- 6. 计划任务
Step "注册计划任务 AgentRoom-$Agent"
$tsx = Join-Path $nodeApp "apps\agent-server\node_modules\.bin\tsx.cmd"
$main = Join-Path $nodeApp "apps\agent-server\src\main.ts"
if (-not (Test-Path $tsx)) { Fail "找不到 $tsx：先在 $AppSource 里运行 pnpm install --filter `"@room/agent-server...`"" }
$action = New-ScheduledTaskAction -Execute $tsx -Argument "`"$main`"" -WorkingDirectory $nodeMine
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "AgentRoom-$Agent" -Action $action -Trigger $trigger -Settings $settings -User $account -Password $password -RunLevel Limited -Force | Out-Null
# 低权限账号需要「作为批处理作业登录」：Register-ScheduledTask 带密码注册时 Windows 会自动授予

# ---- 防火墙：只放这个端口、只放专用网络
if (-not (Get-NetFirewallRule -DisplayName "AgentRoom $Agent $Port" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName "AgentRoom $Agent $Port" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private | Out-Null
}

# ---- 7. 在这个账号下登录命令行
$login = switch ($Agent) {
  "claude" { "claude" }    # 第一次运行会让你登录 Claude 账号
  "codex" { "codex login" }
  "deepseek" { "" }        # DeepSeek 用 API Key，见 README
}
if ($login -ne "") {
  Step "打开一个以 $user 运行的窗口：在里面完成登录后关掉它"
  $cred = [pscredential]::new($account, $secure)
  Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "cd /d `"$nodeMine\sandbox`" && $login" -Credential $cred -LoadUserProfile
}

$password = $null
Write-Host ""
Write-Host "✓ $Agent 安排好了" -ForegroundColor Green
Write-Host "  记忆文件夹：$memory（把记忆放进 core / notes / journal）"
Write-Host "  节点：http://127.0.0.1:$Port（开机自动启动；现在启动：Start-ScheduledTask AgentRoom-$Agent）"
