# 生成"便携版"：dist\SoundBin\SoundBin.exe
# 用法（在项目根目录）：powershell -ExecutionPolicy Bypass -File build_dist.ps1
#
# 原理：Electron 本身就是一个能跑任意 app 的运行时。把 runtime\ 整个拷一份，
# 把 electron.exe 改名成 SoundBin.exe，再把源码放进 resources\app\，
# SoundBin.exe 启动时就会加载 resources\app\package.json 里指定的 src\main.js。
# 不需要 npm、不需要联网装 electron-builder。
#
# 2026-10-22 改：以前是「把 data\ 挪到 TEMP、打完再挪回来」，现在改成原地只更新程序文件。
# 原因：Pro Tools 会一直握着 data\cache\clips\ 里拖过去的裁剪副本；只要有一个句柄没放，
# 整个 data 目录就改不了名（Move-Item 报 IOException），而清单这时已经被挪到 TEMP 里一半了。
# 现在 data\ 完全不碰，清理时只删程序文件，用户清单和缓存原地不动。
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = Join-Path $root 'dist\SoundBin'
$runtime = Join-Path $root 'runtime'
$data = Join-Path $dist 'data'

if (-not (Test-Path (Join-Path $runtime 'electron.exe'))) {
  throw "找不到 runtime\electron.exe，请确认在 SoundBin 项目根目录运行"
}

# 打包期间绝对不能有实例在跑：运行中的实例会在退出时把内存里的清单写回 data\。
# 2026-10-22 发生过一次：用户开着 dist 版时重打包，42 条素材被空清单覆盖
# （靠 library.json.beforeempty 才救回来）。所以这里直接拒绝。
$running = @(Get-CimInstance Win32_Process -Filter "Name='SoundBin.exe' OR Name='electron.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($dist, [StringComparison]::OrdinalIgnoreCase) })
if ($running.Count -gt 0) {
  $pids = ($running | ForEach-Object { $_.ProcessId }) -join ', '
  throw ("SoundBin 正在运行（PID " + $pids + "），请先关掉再打包，否则可能覆盖 data\ 里的清单")
}

New-Item -ItemType Directory -Path $dist -Force | Out-Null

Write-Host "清理 $dist 里的程序文件（data\ 原地不动）"
# 只删运行时该有的东西，绝不动 data\
$keepName = 'data'
Get-ChildItem -LiteralPath $dist -Force | Where-Object { $_.Name -ne $keepName } | ForEach-Object {
  try {
    Remove-Item -LiteralPath $_.FullName -Recurse -Force
  } catch {
    throw ("删不掉 " + $_.FullName + "，可能还有程序在使用；先全部关掉再试一次")
  }
}

Write-Host "复制 runtime（约 360 MB，需要几十秒）"
Copy-Item (Join-Path $runtime '*') $dist -Recurse -Force
Remove-Item (Join-Path $dist 'resources\default_app.asar') -Force -ErrorAction SilentlyContinue

Write-Host "打包源码到 resources\app"
$appDir = Join-Path $dist 'resources\app'
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
# 只拷源码本体，别把 *.bak*、*.tmp 之类的备份/临时文件一起发出去
Copy-Item (Join-Path $root 'src') (Join-Path $appDir 'src') -Recurse -Force
# 剔除备份/临时文件（用 Where-Object 逐个判断，绝不用 -Include 直接喂 Remove-Item：
# 5.1 里 -Include 的匹配行为和预期不一致，曾把 src 下的文件全删空过）
$junk = @(Get-ChildItem -LiteralPath (Join-Path $appDir 'src') -Recurse -File -Force |
  Where-Object { $_.Name -match '\.(bak[0-9]*|tmp|orig)$' })
foreach ($f in $junk) { Remove-Item -LiteralPath $f.FullName -Force }
if ($junk.Count -gt 0) { Write-Host ("剔除 " + $junk.Count + " 个备份文件") }
$srcCount = @(Get-ChildItem -LiteralPath (Join-Path $appDir 'src') -Recurse -File).Count
if ($srcCount -lt 9) { throw ("打包后 src 只有 " + $srcCount + " 个文件，源目录应当有至少 9 个，停止") }
Copy-Item (Join-Path $root 'package.json') (Join-Path $appDir 'package.json') -Force

# VST 插件渲染要用到内置 Python 运行时（pyrt\ → resources\py\，约 80 MB）
$pyrt = Join-Path $root 'pyrt'
if (Test-Path $pyrt) {
  Write-Host "复制内置 Python 运行时（约 80 MB）"
  $pyDir = Join-Path $dist 'resources\py'
  New-Item -ItemType Directory -Path $pyDir -Force | Out-Null
  Copy-Item (Join-Path $pyrt '*') $pyDir -Recurse -Force
  if (-not (Test-Path (Join-Path $pyDir 'python.exe'))) { throw "resources\py\python.exe 没复制成功" }
}
Copy-Item (Join-Path $root 'README.md') (Join-Path $dist 'README.md') -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $root '快捷键.md') (Join-Path $dist '快捷键.md') -Force -ErrorAction SilentlyContinue

Write-Host "重命名 electron.exe -> SoundBin.exe"
Remove-Item (Join-Path $dist 'SoundBin.exe') -Force -ErrorAction SilentlyContinue
Move-Item (Join-Path $dist 'electron.exe') (Join-Path $dist 'SoundBin.exe')

Write-Host ""
if (Test-Path $data) {
  $lib = Join-Path $data 'library.json'
  if (Test-Path $lib) {
    Write-Host ("原有 data\ 原地保留（library.json " + (Get-Item $lib).Length + " 字节，没动过）")
  } else {
    Write-Host "原有 data\ 原地保留（里面还没有 library.json）"
  }
} else {
  Write-Host "data\ 还不存在，首次启动会自动创建"
}
Write-Host "完成：$dist\SoundBin.exe"
Write-Host "清单和缓存放在 $dist\data\，整个 SoundBin 文件夹可以拷走。"
