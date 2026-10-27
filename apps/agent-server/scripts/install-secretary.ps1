<#
S-20：在这台电脑上给一位秘书安排「家」（ADR-003 §2a）。用管理员 PowerShell 运行，一次一位秘书：

  .\install-secretary.ps1 -Agent codex -HomeDir D:\AgentRoom -Port 7421 -ConfigTemplate <现有节点配置> -AppSource <仓库目录>

做的事：
  1. 检查 HomeDir 在本机 NTFS 盘上
  2. 建低权限账号 agentroom-<秘书>（随机密码，只在本次运行里用，不保存、不显示）
  3. 建 <HomeDir>\memory\<秘书>\ 的布局、memory.json、README.md；建 node\app、node\<秘书>\
  4. 设权限：<HomeDir> 关掉继承；记忆正文这位秘书只读，inbox / ext 她没有权限；配置和 Token 只有她和管理员能读
  5. 生成这位秘书的节点配置（homeDir / agent / runAsUser / port / 聊天 profile 的 memory）和 Token
  6. 给 agentroom-<秘书> 装一份她自己的命令行（npm 装到 node\<秘书>\cli，profile 里写绝对路径）；
     授予「作为批处理作业登录」；注册计划任务：开机启动、不管是否登录都运行、身份是 agentroom-<秘书>
  7. 打开一个以这个账号运行的窗口，在里面登录这位秘书的命令行（Claude / Codex）

主控机上按 ADR-003 §2a「切换顺序」：先装 codex（7421）；D-40 迁移完成后才装 deepseek（7420）。
已有的记忆、文件不会被覆盖；重复运行只补缺的、重设权限。node\app 的程序整份换成新版本：先在 node\app.new 里准备、校验、设好权限，所有步骤都成功后最后才换上，中途失败时旧版本原样不动。
#>
#Requires -Version 5.1
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

# 建账号用的 LocalAccounts 模块在 PowerShell 7 里不一定能直接用：只认 Windows 自带的 PowerShell 5.1
if ($PSVersionTable.PSEdition -ne "Desktop") { Fail "请用 Windows 自带的 PowerShell（powershell.exe，以管理员身份运行），不要用 pwsh" }
# DeepSeek 的 API Key 在新账号下怎么给还没定（S-20 第二段），而且按 §2a 汐要等 D-40 之后才切
if ($Agent -eq "deepseek") { Fail "deepseek 现在还不能装：等 D-40 迁移完成、S-20 第二段安排好 API Key 之后再装（ADR-003 §2a 切换顺序）" }

$me = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$me).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail "请用「以管理员身份运行」的 PowerShell"
}
$owner = $me.Name  # 运行脚本的人（江浩）：记忆完全控制

# ---- 1. 盘
$HomeDir = [IO.Path]::GetFullPath($HomeDir).TrimEnd("\")
# HomeDir 和它的每一级上级都不能是 junction / 符号链接 / 挂载点：否则查的是链接所在的盘，文件实际可能在网络盘上
$p = $HomeDir
while ($p) {
  if (Test-Path -LiteralPath $p) {
    $item = Get-Item -LiteralPath $p -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail "$p 是链接、junction 或挂载点。AgentRoom 要放在普通文件夹里" }
  }
  $p = Split-Path -Parent $p
}
if ($HomeDir.StartsWith("\\")) { Fail "AgentRoom 不能放在网络路径上" }
if ($HomeDir.TrimEnd("\") -eq [IO.Path]::GetPathRoot($HomeDir).TrimEnd("\")) { Fail "AgentRoom 不能是盘的根目录，要建一个文件夹（比如 D:\AgentRoom）" }
# ADR-003 §2a：不放进任何用户目录（低权限账号不该能读用户目录）
# 当前用户目录的上级、任何盘上的 \Users、这台电脑上每个账号的用户目录，都不行
$userRoots = @((Split-Path -Parent $env:USERPROFILE)) + @(Get-CimInstance Win32_UserProfile | ForEach-Object { $_.LocalPath })
foreach ($r in $userRoots) {
  if ($r -and ($HomeDir + "\").StartsWith($r.TrimEnd("\") + "\", [StringComparison]::OrdinalIgnoreCase)) { Fail "AgentRoom 不能放在用户目录（$r）下面" }
}
if ($HomeDir -match '^[A-Za-z]:\\Users(\\|$)') { Fail "AgentRoom 不能放在 Users 文件夹下面" }
$drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($HomeDir))
if ($drive.DriveFormat -ne "NTFS" -or $drive.DriveType -ne "Fixed") {
  Fail "$HomeDir 所在的盘是 $($drive.DriveFormat) / $($drive.DriveType)。必须是本机 NTFS 盘（FAT、exFAT、网络盘、可移动盘上权限不生效）"
}

# ---- 1b. 预检：会失败的检查都放在改账号、复制程序、改权限之前，避免装一半
# HomeDir 下面任何一处是 junction / 链接 / 挂载点都拒绝：icacls /T、robocopy、写文件都可能顺着它写到外面去
function Assert-NoReparse([string]$root) {
  if (-not (Test-Path -LiteralPath $root)) { return }
  $stack = [Collections.Generic.Stack[string]]::new()
  $stack.Push($root)
  while ($stack.Count -gt 0) {
    $dir = $stack.Pop()
    foreach ($item in @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop)) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail "$($item.FullName) 是链接、junction 或挂载点：AgentRoom 里面不能有。先删掉再装（以前装过旧版本、node\app、node\app.new 或 node\app.old 里有 node_modules 的，用 cmd 的 rmdir /s /q 删掉那个文件夹）" }
      if ($item.PSIsContainer) { $stack.Push($item.FullName) }  # 不进重解析点（上面已经拒绝），所以不会绕圈
    }
  }
}
Assert-NoReparse $HomeDir
# TokenReader 只能是一个具体的人（运行桌面端的账号），不能是一群人
if ($TokenReader -ne "") {
  try { $readerSid = ([Security.Principal.NTAccount]$TokenReader).Translate([Security.Principal.SecurityIdentifier]).Value }
  catch { Fail "找不到账号 $TokenReader" }
  # Everyone、已验证用户、交互式用户、Users、Guests
  # 只接受本机的一个用户账号，或者正在运行脚本的人自己：组（本机组、域组、内置组）、SYSTEM / 服务账号一律不行
  $isLocalUser = [bool](Get-LocalUser -SID $readerSid -ErrorAction SilentlyContinue)
  if (-not ($isLocalUser -or $readerSid -eq $me.User.Value)) {
    Fail "TokenReader 必须是本机的一个用户账号（运行桌面端的那个），不能是 $TokenReader"
  }
  # 以 SYSTEM / 服务账号运行脚本时 $me 自己就是服务账号：真人账号的 SID 是 S-1-5-21-…（本机、域、微软账号）或 S-1-12-1-…（Entra 账号），
  # 其他的（S-1-5-18/19/20、S-1-5-80-… 等）一律不行
  if (-not ($readerSid.StartsWith("S-1-5-21-") -or $readerSid.StartsWith("S-1-12-1-"))) { Fail "TokenReader 不能是系统或服务账号（$TokenReader）：要填运行桌面端的那个人的账号" }
  # 秘书和插件的节点账号也不行：她们不该读到别人的 Token。按 SID 解析回来的账号名判断，不看输入的写法
  $readerName = ([Security.Principal.SecurityIdentifier]$readerSid).Translate([Security.Principal.NTAccount]).Value
  if ($readerName -match '(^|\\)agentroom-') { Fail "TokenReader 不能是秘书或插件的节点账号（$readerName）" }
}
$memory = Join-Path $HomeDir "memory\$Agent"
$nodeApp = Join-Path $HomeDir "node\app"
# 新程序先放在 app.new 里准备好、校验好、设好权限，最后一步才换上；中途失败时 node\app 原样不动（其他秘书的节点也在用它）
$nodeAppNew = Join-Path $HomeDir "node\app.new"
$nodeAppOld = Join-Path $HomeDir "node\app.old"
$nodeMine = Join-Path $HomeDir "node\$Agent"
if (-not (Test-Path -LiteralPath $ConfigTemplate)) { Fail "找不到配置模板 $ConfigTemplate" }
# 节点打成一个文件（scripts/bundle.mjs），node\app 里不放 node_modules：pnpm 的包是 junction，和「AgentRoom 里不能有链接」冲突
& pnpm --dir $AppSource --filter "@room/agent-server" run bundle | Out-Null
$bundle = Join-Path $AppSource "apps\agent-server\dist\agent-server.mjs"
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $bundle)) { Fail "打包节点失败：先在 $AppSource 里运行 pnpm install --filter `"@room/agent-server...`"，再重试" }
# 要复制进 node\app 的只有 bundle 和 bin\：建账号、建文件夹之前先把源检查完，不合格就什么都不动
$binDir = Join-Path $AppSource "apps\agent-server\bin"
# bin\ 源目录里不能有链接：逐文件 hash 按路径前缀取相对路径，链接会让路径对不上，也可能把别处的文件复制进来
if (Test-Path -LiteralPath $binDir) {
  if ((Get-Item -LiteralPath $binDir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail "$binDir 是链接或 junction" }
  $binLink = Get-ChildItem -LiteralPath $binDir -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($binLink) { Fail "$binDir 里有链接或 junction：$($binLink.FullName)" }
}
# 配置、Token、.env 不能进 node\app（所有秘书都能读）。用 -like 逐个比文件名：Windows PowerShell 5.1 里
# Get-ChildItem -LiteralPath -Include 不按名字过滤，会把所有文件都当成匹配
$secretFiles = @("agent-server.config*.json", "agent-server.token", ".env*")
function Find-SecretFile([string]$dir) {
  if (-not (Test-Path -LiteralPath $dir)) { return $null }
  Get-ChildItem -LiteralPath $dir -Recurse -Force -File -ErrorAction SilentlyContinue |
    Where-Object { $n = $_.Name; @($secretFiles | Where-Object { $n -like $_ }).Count -gt 0 } | Select-Object -First 1
}
$leakedSource = Find-SecretFile $binDir
if ($leakedSource) { Fail "$binDir 里有不该复制到 node\app 的文件：$($leakedSource.FullName)" }
# Node 必须装在秘书账号读得到的地方（官方安装包装到 Program Files）
$nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { Fail "找不到 node.exe" }
$nodeMajor = [int]((& $nodeExe --version).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 22) { Fail "Node 版本太低（$(& $nodeExe --version)），要 22 或更高" }
# 命令行（Claude / Codex）给这位秘书单独装一份：江浩用 npm 装的在他自己的用户目录里（AppData\Roaming\npm），秘书账号读不到
$npmCmd = Join-Path (Split-Path -Parent $nodeExe) "npm.cmd"
if (-not (Test-Path -LiteralPath $npmCmd)) { Fail "找不到 $npmCmd（Node 的官方安装包会带 npm）" }
$cliPackage = @{ claude = "@anthropic-ai/claude-code"; codex = "@openai/codex" }[$Agent]
$cliDir = Join-Path $nodeMine "cli"
$cliCmd = Join-Path $cliDir "node_modules\.bin\$Agent.cmd"
foreach ($r in $userRoots) { if ($r -and $nodeExe.StartsWith($r.TrimEnd("\") + "\", [StringComparison]::OrdinalIgnoreCase)) { Fail "Node 装在用户目录里（$nodeExe），秘书账号读不到。请用官方安装包装到 Program Files" } }
$template = Get-Content -Raw -Encoding UTF8 $ConfigTemplate | ConvertFrom-Json
$profiles = [ordered]@{}
foreach ($p in $template.profiles.PSObject.Properties) {
  if (-not $p.Name.StartsWith("$Agent-")) { continue }  # 节点也会拒绝别人的 profile
  $p.Value.cwd = (Join-Path $nodeMine "sandbox")
  # 模板里写的裸命令名（codex / codex.cmd / codex.ps1）换成她自己那份的绝对路径；别的命令（比如 node）不动
  if ([IO.Path]::GetFileNameWithoutExtension([string]$p.Value.command) -eq $Agent) { $p.Value.command = $cliCmd }
  if ($p.Name -eq "$Agent-chat") {
    $p.Value | Add-Member -Force -NotePropertyName memory -NotePropertyValue ([ordered]@{ dir = "memory/$Agent"; provider = "folder" })
  }
  $profiles[$p.Name] = $p.Value
}
if ($profiles.Count -eq 0) { Fail "模板里没有 $Agent- 开头的 profile" }
# 第一段允许没有聊天 profile（现在的模板只有讨论 profile）：记忆文件夹照建，聊天 profile 和记忆配置在第二段加
$hasChat = $profiles.Contains("$Agent-chat")
$template.profiles = [pscustomobject]$profiles
$template.port = $Port
# 主控机上的节点 id 按 §2a：林离 controller-local-codex；C酱在江浩的电脑上，沿用模板里的 id
if ($Agent -eq "codex") { $template.nodeId = "controller-local-codex" }

# ---- 1.5 命令行：在建账号之前装好、试运行，装不上就什么都不动（只删这次新建的 cli 文件夹）
# 原生命令写 stderr 时，5.1 在 $ErrorActionPreference = Stop 下会直接抛错、跳过退出码检查：临时改成 Continue，输出合并成文字
function Invoke-Native([scriptblock]$run) {
  $saved = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  # stderr 行是 ErrorRecord：只取它的文字，免得显示成 PowerShell 的红色错误
  try { @(& $run 2>&1 | ForEach-Object { if ($_ -is [Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" } }) } finally { $ErrorActionPreference = $saved }
}
function Npm-Install([string[]]$specs, [string]$registry = "") {
  $extra = @(); if ($registry) { $extra = @("--registry=$registry") }
  $out = Invoke-Native { & $npmCmd install --prefix $cliDir --include=optional --no-fund --no-audit --loglevel=error @extra @specs }
  # 失败时只留最后 15 行，够看出原因
  return @{ ok = ($LASTEXITCODE -eq 0); out = (@($out | Select-Object -Last 15) -join "`n") }
}
# 先用 npm 配置的源（比如镜像），不行再用官方源试一次
function Npm-InstallWithFallback([string[]]$specs) {
  $r = Npm-Install $specs
  if (-not $r.ok) {
    Write-Host "  配置的 npm 源失败，改用 registry.npmjs.org 再试一次" -ForegroundColor Yellow
    $r = Npm-Install $specs "https://registry.npmjs.org"
  }
  return $r
}
# 这次新建的文件夹（从里到外）：失败时删掉 cli，外面几层只在空着的时候删
$cliNewDirs = @($cliDir, $nodeMine, (Join-Path $HomeDir "node"), $HomeDir) | Where-Object { -not (Test-Path -LiteralPath $_) }
function Fail-Cli($msg) {
  foreach ($d in $cliNewDirs) {
    if (-not (Test-Path -LiteralPath $d)) { continue }
    if ($d -eq $cliDir) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
    elseif (-not (Get-ChildItem -LiteralPath $d -Force)) { Remove-Item -LiteralPath $d -Force -ErrorAction SilentlyContinue }
  }
  if ($cliNewDirs -notcontains $cliDir) { Write-Host "  $cliDir 是以前装的，这次没装完可能不完整；节点还在用旧配置，下次重跑会补齐" -ForegroundColor Yellow }
  Fail $msg
}
Step "安装 $cliPackage 到 $cliDir"
# 已经装过就是升级到最新；npm 的普通安装不建链接（node\<秘书> 里也不能有链接，预检会查）
New-Item -ItemType Directory -Force -Path $cliDir | Out-Null
$r = Npm-InstallWithFallback @($cliPackage)
if (-not $r.ok -or -not (Test-Path -LiteralPath $cliCmd)) { Fail-Cli "安装 $cliPackage 失败。检查网络后重试：`n$($r.out)" }
# 平台原生包（比如 @openai/codex-win32-x64）是 optionalDependencies，镜像没同步时 npm 会悄悄跳过：缺了就按清单单独装，
# 配置的镜像装不上再试官方源
$arch = @{ AMD64 = "x64"; ARM64 = "arm64" }[$env:PROCESSOR_ARCHITECTURE]
$pkgJson = Join-Path $cliDir ("node_modules\" + $cliPackage.Replace("/", "\") + "\package.json")
$optional = (Get-Content -Raw -Encoding UTF8 $pkgJson | ConvertFrom-Json).PSObject.Properties["optionalDependencies"]
if ($arch -and $optional) {
  foreach ($dep in $optional.Value.PSObject.Properties) {
    if ($dep.Name -notlike "*win32-$arch*") { continue }
    if (Test-Path -LiteralPath (Join-Path $cliDir ("node_modules\" + $dep.Name.Replace("/", "\")))) { continue }
    Write-Host "  补装平台包 $($dep.Name)（$($dep.Value)）"
    $spec = "$($dep.Name)@$($dep.Value)"
    $r = Npm-InstallWithFallback @($spec)
    if (-not $r.ok) { Fail-Cli "补装 $spec 失败：`n$($r.out)" }
  }
}
$versionOut = Invoke-Native { & $cliCmd --version }
if ($LASTEXITCODE -ne 0 -or -not $versionOut) { Fail-Cli "$cliCmd 装好了但运行不了：`n$($versionOut -join "`n")" }
Write-Host "  $Agent 版本：$($versionOut[0])"

# ---- 2. 账号
$user = "agentroom-$Agent"
# 随机密码：32 字节随机数 + 固定的大小写 / 数字 / 符号后缀（满足复杂度要求）；不保存、不显示
$bytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$password = [Convert]::ToBase64String($bytes) + "aA1!"
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
foreach ($d in @($HomeDir, (Join-Path $HomeDir "memory"), $memory, $nodeMine, (Join-Path $nodeMine "sandbox"))) {
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

Step "准备新的节点程序 $nodeAppNew"
# 上次失败留下的 app.new / app.old 是本脚本自己复制的（预检已确认里面没有链接），直接删
if (-not (Test-Path -LiteralPath $nodeApp) -and (Test-Path -LiteralPath $nodeAppOld)) { Fail "node\app 不见了、app.old 还在：先把 app.old 改名回 app 再重试" }
foreach ($d in @($nodeAppNew, $nodeAppOld)) { if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force } }
New-Item -ItemType Directory -Path $nodeAppNew | Out-Null
# 只放打包好的节点和 bin\ 里的脚本：没有 node_modules、没有配置和 Token
Copy-Item -LiteralPath $bundle -Destination (Join-Path $nodeAppNew "agent-server.mjs")
if (Test-Path -LiteralPath $binDir) { Copy-Item -LiteralPath $binDir -Destination (Join-Path $nodeAppNew "bin") -Recurse }
# 校验：复制出来的和打包出来的逐字节一样
if ((Get-FileHash -LiteralPath $bundle).Hash -ne (Get-FileHash -LiteralPath (Join-Path $nodeAppNew "agent-server.mjs")).Hash) { Fail "复制节点程序不完整（app.new 里的和打包出来的不一样）" }
if (Test-Path -LiteralPath $binDir) {
  $want = @(Get-ChildItem -LiteralPath $binDir -Recurse -Force -File)
  $got = @(Get-ChildItem -LiteralPath (Join-Path $nodeAppNew "bin") -Recurse -Force -File)
  if ($want.Count -ne $got.Count) { Fail "复制 bin\ 不完整（应有 $($want.Count) 个文件，复制了 $($got.Count) 个）" }
  # 每个文件都对一遍内容（相对路径按 Get-Item 的完整路径算，AppSource 是相对路径时也对得上）
  $binFull = (Get-Item -LiteralPath $binDir).FullName.TrimEnd("\")
  foreach ($f in $want) {
    $copy = Join-Path (Join-Path $nodeAppNew "bin") $f.FullName.Substring($binFull.Length).TrimStart("\")
    if (-not (Test-Path -LiteralPath $copy) -or (Get-FileHash -LiteralPath $f.FullName).Hash -ne (Get-FileHash -LiteralPath $copy).Hash) { Fail "复制 bin\ 不完整：$copy 和源文件不一样" }
  }
}
$leaked = Find-SecretFile $nodeAppNew
if ($leaked) { Fail "app.new 里有不该复制的文件：$($leaked.FullName)" }

# ---- 4. 权限
# 每次都整份重建，不在旧的上面加：以前手工给过的、换掉的 TokenReader，重跑后都不再有权限
function Icacls-Ok { if ($LASTEXITCODE -ne 0) { Fail "设置权限失败：$args" } }
function Set-OnlyAcl([string]$path, [string[]]$grants, [switch]$Tree) {
  if ($Tree) { icacls $path /reset /T /C /Q | Out-Null; Icacls-Ok $path }  # 子项的显式权限也清掉，改成只继承
  icacls $path /inheritance:r /Q | Out-Null; Icacls-Ok $path
  # 去掉 /reset 之后可能还在的显式项：只留管理员组、SYSTEM 和下面列的
  $keep = @("*S-1-5-32-544:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F") + $grants
  $acl = Get-Acl -LiteralPath $path
  foreach ($rule in @($acl.Access | Where-Object { -not $_.IsInherited })) { [void]$acl.RemoveAccessRuleAll($rule) }
  Set-Acl -LiteralPath $path -AclObject $acl
  icacls $path /grant:r @keep /Q | Out-Null; Icacls-Ok $path
}
Step "设权限"
# 这台电脑上所有秘书的节点账号（不含以后的插件账号 agentroom-plg-*）：共用的文件夹给她们「能穿过、能读程序」
# 只认三个固定的名字、并且是启用的账号；不用通配符，免得旧的或手工建的同名前缀账号也被授权
$secretaries = @(Get-LocalUser | Where-Object { $_.Enabled -and $_.Name -in @("agentroom-claude", "agentroom-deepseek", "agentroom-codex") } | ForEach-Object { "$env:COMPUTERNAME\$($_.Name)" })
$traverse = @($secretaries | ForEach-Object { "${_}:(RX)" })          # 只这一层，不往下继承
$readApp = @($secretaries | ForEach-Object { "${_}:(OI)(CI)(RX)" })
# 根目录：关掉继承（很多盘根目录默认给「已验证用户」改子文件夹的权限）
Set-OnlyAcl $HomeDir (@("${owner}:(OI)(CI)F") + $traverse)
Set-OnlyAcl (Join-Path $HomeDir "memory") (@("${owner}:(OI)(CI)F") + $traverse)
Set-OnlyAcl (Join-Path $HomeDir "node") (@("${owner}:(OI)(CI)F") + $traverse)
# 程序树整棵重建：子文件上以前留下的写权限也要清掉（所有秘书都会执行这里的程序）。设在 app.new 上，换上去后就是这份
Set-OnlyAcl $nodeAppNew (@("${owner}:(OI)(CI)F") + $readApp) -Tree
# 这位秘书的记忆：整棵树重建。文件夹本身和 memory.json 她能读（不继承，所以 inbox / ext 她没有权限）
Set-OnlyAcl $memory @("${owner}:(OI)(CI)F", "${account}:(RX)") -Tree
icacls $settingsPath /grant:r "${account}:(R)" /Q | Out-Null; Icacls-Ok $settingsPath
foreach ($s in @("core", "notes", "journal")) { icacls (Join-Path $memory $s) /grant:r "${account}:(OI)(CI)(RX)" /Q | Out-Null; Icacls-Ok $s }
# 配置和 Token：整棵树重建，只有她和管理员（江浩不在这里，Token 另外单给）
Set-OnlyAcl $nodeMine @("${account}:(OI)(CI)(RX)") -Tree
icacls (Join-Path $nodeMine "sandbox") /grant:r "${account}:(OI)(CI)M" /Q | Out-Null; Icacls-Ok sandbox

# ---- 5. 配置和 Token

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
# Token 文件只继承 node\<秘书> 的权限（刚整棵树重建过），再按这次的 TokenReader 单给一份只读
icacls $tokenPath /reset /Q | Out-Null; Icacls-Ok $tokenPath
if ($TokenReader -ne "") {
  # 只给 Token 这一个文件只读，不给文件夹（ADR-003 §2a：桌面端以普通账号一键导入）
  icacls $tokenPath /grant:r "${TokenReader}:(R)" /Q | Out-Null; Icacls-Ok $tokenPath
  # 一路上的文件夹只给「穿过」（X，不继承、不能列目录），标准账号也能打开这个文件
  foreach ($d in @($HomeDir, (Join-Path $HomeDir "node"), $nodeMine)) { icacls $d /grant "${TokenReader}:(X)" /Q | Out-Null; Icacls-Ok $d }
}

# ---- 6. 计划任务
# 「不管是否登录都运行」要求账号有「作为批处理作业登录」（SeBatchLogonRight）。带密码注册任务时 Windows 不会自动给，
# 没有它任务能注册、schtasks /run 也报成功，但实际不会启动（LastTaskResult 267011）。用 LSA 接口加，不依赖系统语言
Step "授予 $user「作为批处理作业登录」"
if (-not ("AgentRoomLsa" -as [type])) { Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AgentRoomLsa {
  [StructLayout(LayoutKind.Sequential)] struct LsaString { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct LsaAttributes { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
  [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr system, ref LsaAttributes attributes, uint access, out IntPtr policy);
  [DllImport("advapi32.dll")] static extern uint LsaAddAccountRights(IntPtr policy, byte[] sid, LsaString[] rights, uint count);
  [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr policy);
  [DllImport("advapi32.dll")] static extern int LsaNtStatusToWinError(uint status);
  public static int Grant(byte[] sid, string right) {
    var attributes = new LsaAttributes();
    attributes.Length = Marshal.SizeOf(typeof(LsaAttributes));
    IntPtr policy;
    // POLICY_CREATE_ACCOUNT | POLICY_LOOKUP_NAMES
    uint status = LsaOpenPolicy(IntPtr.Zero, ref attributes, 0x10 | 0x800, out policy);
    if (status != 0) return LsaNtStatusToWinError(status);
    try {
      var name = new LsaString();
      name.Buffer = Marshal.StringToHGlobalUni(right);
      name.Length = (ushort)(right.Length * 2);
      name.MaximumLength = (ushort)(name.Length + 2);
      try { status = LsaAddAccountRights(policy, sid, new[] { name }, 1); } finally { Marshal.FreeHGlobal(name.Buffer); }
      return status == 0 ? 0 : LsaNtStatusToWinError(status);
    } finally { LsaClose(policy); }
  }
}
"@ }
$accountSid = ([Security.Principal.NTAccount]$account).Translate([Security.Principal.SecurityIdentifier])
$sidBytes = [byte[]]::new($accountSid.BinaryLength)
$accountSid.GetBinaryForm($sidBytes, 0)
$lsaError = [AgentRoomLsa]::Grant($sidBytes, "SeBatchLogonRight")
if ($lsaError -ne 0) { Fail "授予「作为批处理作业登录」失败（Windows 错误 $lsaError）" }

Step "注册计划任务 AgentRoom-$Agent"
$main = Join-Path $nodeApp "agent-server.mjs"
$action = New-ScheduledTaskAction -Execute $nodeExe -Argument "`"$main`"" -WorkingDirectory $nodeMine
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "AgentRoom-$Agent" -Action $action -Trigger $trigger -Settings $settings -User $account -Password $password -RunLevel Limited -Force | Out-Null

# ---- 防火墙：只放这个端口、只放专用网络
if (-not (Get-NetFirewallRule -DisplayName "AgentRoom $Agent $Port" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName "AgentRoom $Agent $Port" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private | Out-Null
}

# ---- 换上新程序：前面任何一步失败都不会走到这里，node\app 还是旧的
Step "换上新的节点程序"
if (Test-Path -LiteralPath $nodeApp) {
  # node\app 里有文件被占用时改名会失败：这时什么都没动，旧版本照常可用
  try { [IO.Directory]::Move($nodeApp, $nodeAppOld) } catch { Fail "node\app 正在被占用，没有替换，旧版本照常可用；关掉占用的程序后重试：$($_.Exception.Message)" }
}
try {
  [IO.Directory]::Move($nodeAppNew, $nodeApp)
} catch {
  if (Test-Path -LiteralPath $nodeAppOld) { [IO.Directory]::Move($nodeAppOld, $nodeApp) }
  Fail "换上新程序失败，已恢复旧的 node\app：$($_.Exception.Message)"
}
# 已经运行的节点不受影响（程序启动时读一次）；重启后用新版本。旧版本删不掉只提示，下次安装时再删
if (Test-Path -LiteralPath $nodeAppOld) {
  try { Remove-Item -LiteralPath $nodeAppOld -Recurse -Force } catch { Write-Host "  旧程序 $nodeAppOld 没删掉（可能有文件被占用），不影响使用；下次安装会再删" -ForegroundColor Yellow }
}

# ---- 7. 在这个账号下登录命令行
$login = switch ($Agent) {
  "claude" { "`"$cliCmd`"" }    # 第一次运行会让你登录 Claude 账号
  "codex" { "`"$cliCmd`" login" }
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
if (-not $hasChat) { Write-Host "  模板里还没有 $Agent-chat：记忆文件夹已建好，聊天 profile 和读记忆在 S-20 第二段加上" -ForegroundColor Yellow }
Write-Host "  节点：http://127.0.0.1:$Port（开机自动启动；现在启动：Start-ScheduledTask AgentRoom-$Agent）"
