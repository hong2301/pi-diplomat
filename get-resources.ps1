# 下载「外交官」所需的全部二进制资源（Windows PowerShell）
# 用法：powershell -ExecutionPolicy Bypass -File .\get-resources.ps1
$ErrorActionPreference = 'Stop'
$R = Split-Path -Parent $MyInvocation.MyCommand.Path
$NODE = 'v26.13.1'
$GIT  = '2.56.1'
$MIRROR_NODE = "https://cdn.npmmirror.com/binaries/node/$NODE"
$MIRROR_GIT  = "https://cdn.npmmirror.com/binaries/git-for-windows/v$GIT.windows.1"

New-Item -ItemType Directory -Force -Path "$R\resources\windows","$R\resources\macos","$R\resources\linux","$R\resources\npm-packages" | Out-Null

function Get-File($url, $out) {
  if (Test-Path $out) { Write-Host "跳过（已存在）: $out"; return }
  Write-Host "下载: $url"
  curl.exe -sSL --ssl-no-revoke --noproxy "*" -o $out $url
  if ($LASTEXITCODE -ne 0) { throw "下载失败: $url" }
  $size = (Get-Item $out).Length
  Write-Host ("  完成 {0:N0} 字节" -f $size)
}

# node
Get-File "$MIRROR_NODE/node-$NODE-x64.msi"            "$R\resources\windows\node-$NODE-x64.msi"
Get-File "$MIRROR_NODE/node-$NODE.pkg"                "$R\resources\macos\node-$NODE.pkg"
Get-File "$MIRROR_NODE/node-$NODE-linux-x64.tar.xz"   "$R\resources\linux\node-$NODE-linux-x64.tar.xz"

# git for windows
Get-File "$MIRROR_GIT/Git-$GIT-64-bit.exe"            "$R\resources\windows\Git-$GIT-64-bit.exe"

# npm 包（版本锁定用）
Push-Location "$R\resources\npm-packages"
npm pack @earendil-works/pi-coding-agent --pack-destination . 2>&1 | Out-Null
npm pack remote-pi --pack-destination . 2>&1 | Out-Null
Pop-Location

Write-Host ""
Write-Host "全部就绪。校验 model 无关，本包只需 node/git/npm 包。"
Get-ChildItem -Recurse "$R\resources" -File | Where-Object { $_.Length -gt 100000 } |
  Select-Object @{n='大小MB';e={[math]::Round($_.Length/1MB,1)}}, FullName | Format-Table -AutoSize
