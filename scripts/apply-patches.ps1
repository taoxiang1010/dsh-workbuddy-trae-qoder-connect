#Requires -Version 5.1
<#
.SYNOPSIS
  把本仓库的补丁打到「当前 DSH 正在用的那份安装副本」上。

.DESCRIPTION
  插件从市场/npm 重装后，安装副本会回到上游原样，本地改动全部丢失；
  这个脚本让补丁可以一键重打，不必再手工改一遍文件。

  用 git apply 实现，因此不需要本仓库是 git 仓库；目标目录也不需要是
  git 仓库（脚本内部会临时初始化一个，用完即清理）。

.PARAMETER Check
  只检查能不能打，不写文件。

.PARAMETER Target
  指定安装副本目录（含 lib/ 的那一层）。缺省按 DSH_PROFILE_DIR /
  DSH_HOME 推断。

.EXAMPLE
  .\scripts\apply-patches.ps1 -Check
  .\scripts\apply-patches.ps1
  .\scripts\apply-patches.ps1 -Target "D:\somewhere\node_modules\dsh-workbuddy-trae-qoder-connect"
#>
[CmdletBinding()]
param(
  [switch]$Check,
  [string]$Target
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$PatchDir = Join-Path $Root 'patches'
$Pkg = 'dsh-workbuddy-trae-qoder-connect'

if (-not $Target) {
  if ($env:DSH_PROFILE_DIR) {
    $Target = Join-Path $env:DSH_PROFILE_DIR "node_modules\$Pkg"
  } else {
    $HomeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
    $Target = Join-Path $HomeDir "profiles\desktop\node_modules\$Pkg"
  }
}

if (-not (Test-Path (Join-Path $Target 'lib'))) {
  Write-Error "找不到安装副本：$Target（该目录下应有 lib\；用 -Target 指定插件安装目录）"
  exit 3
}
Write-Host "目标：$Target"

$patches = Get-ChildItem -Path $PatchDir -Filter '*.patch' | Sort-Object Name
if (-not $patches) {
  Write-Error "patches\ 目录里没有 .patch 文件"
  exit 4
}

# git apply 需要在仓库内工作；目标通常不是仓库，临时建一个用完即删。
$TempRepo = Join-Path $env:TEMP ("wb-apply-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$AppliedCount = 0
$AlreadyCount = 0

function Invoke-GitApply {
  param([string]$PatchPath, [switch]$Reverse, [switch]$CheckOnly)
  $gitArgs = @('-C', $TempRepo, 'apply')
  if ($Reverse) { $gitArgs += '--reverse' }
  if ($CheckOnly) { $gitArgs += '--check' }
  $gitArgs += $PatchPath
  # git 把诊断写到 stderr；这是正常的探测输出，用临时文件接住，
  # 避免 PowerShell 把 native stderr 提升成 ErrorRecord 中断脚本。
  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & git @gitArgs > $tmp 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    $text = [System.IO.File]::ReadAllText($tmp)
  } finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }
  return [pscustomobject]@{ Ok = ($code -eq 0); Output = $text.Trim() }
}

try {
  New-Item -ItemType Directory -Force -Path $TempRepo | Out-Null
  & git -C $TempRepo init -q | Out-Null
  & git -C $TempRepo config core.autocrlf false
  & git -C $TempRepo config user.email 'patch@local'
  & git -C $TempRepo config user.name 'patch'

  # 把目标文件按原相对路径复制进去并提交，作为补丁基线
  $files = @(
    'lib\providers\workbuddy\variants-CnrmSn0Q.js',
    'lib\providers\trae\index.js'
  )
  foreach ($f in $files) {
    $src = Join-Path $Target $f
    if (Test-Path $src) {
      $dst = Join-Path $TempRepo $f
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
      Copy-Item $src $dst -Force
    }
  }
  & git -C $TempRepo add -A | Out-Null
  & git -C $TempRepo commit -q -m 'baseline' | Out-Null

  foreach ($p in $patches) {
    $name = $p.Name

    # 已打过：反向检查能干净撤销，就说明这份补丁已在目标里生效
    $rev = Invoke-GitApply -PatchPath $p.FullName -Reverse -CheckOnly
    if ($rev.Ok) {
      Write-Host "  已应用    $name"
      $AlreadyCount++
      continue
    }

    $chk = Invoke-GitApply -PatchPath $p.FullName -CheckOnly
    if (-not $chk.Ok) {
      Write-Error "  打不上    $name`n$($chk.Output)`n目标文件与补丁基线不一致：插件可能已升级，需要基于新版本重新生成补丁。"
      exit 5
    }

    if ($Check) {
      Write-Host "  可打      $name"
      continue
    }

    $app = Invoke-GitApply -PatchPath $p.FullName
    if (-not $app.Ok) {
      Write-Error "  失败      $name`n$($app.Output)"
      exit 6
    }
    Write-Host "  已打上    $name"
    $AppliedCount++
  }

  # 把打过补丁的文件写回目标
  if (-not $Check -and $AppliedCount -gt 0) {
    foreach ($f in $files) {
      $src = Join-Path $TempRepo $f
      if (Test-Path $src) {
        Copy-Item $src (Join-Path $Target $f) -Force
      }
    }
  }
}
finally {
  if (Test-Path $TempRepo) { Remove-Item $TempRepo -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($Check) {
  Write-Host "检查完成（未写入任何文件）。"
  exit 0
}

$note = @'
接下来：
  1. 插件代码改动不会热加载（Node 的 ESM 模块按进程缓存），需要完全重启 DSH
     -- 托盘退出，不是刷新页面。
  2. 重启后确认补丁真的在跑：
       cat ~/.dsh/.workbuddy-host-heartbeat.json
     其中 "patch" 字段应为 cn-prompt-prefix-gate@2026-10-21c。
'@
Write-Host "完成：新打 $AppliedCount 个，原本就已生效 $AlreadyCount 个。"
Write-Host $note
