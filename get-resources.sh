#!/usr/bin/env bash
# 下载「外交官」所需的全部二进制资源（macOS / Linux）
# 用法：bash get-resources.sh
set -euo pipefail
R="$(cd "$(dirname "$0")" && pwd)"
NODE="v26.13.1"
GIT="2.56.1"
MIRROR_NODE="https://cdn.npmmirror.com/binaries/node/${NODE}"
MIRROR_GIT="https://cdn.npmmirror.com/binaries/git-for-windows/v${GIT}.windows.1"

mkdir -p "$R/resources/windows" "$R/resources/macos" "$R/resources/linux" "$R/resources/npm-packages"

get() {
  local url="$1" out="$2"
  if [ -f "$out" ]; then echo "跳过（已存在）: $out"; return; fi
  echo "下载: $url"
  curl -sSL --noproxy '*' -o "$out" "$url"
  echo "  完成 $(wc -c < "$out") 字节"
}

get "$MIRROR_NODE/node-${NODE}-x64.msi"          "$R/resources/windows/node-${NODE}-x64.msi"
get "$MIRROR_NODE/node-${NODE}.pkg"              "$R/resources/macos/node-${NODE}.pkg"
get "$MIRROR_NODE/node-${NODE}-linux-x64.tar.xz" "$R/resources/linux/node-${NODE}-linux-x64.tar.xz"
get "$MIRROR_GIT/Git-${GIT}-64-bit.exe"          "$R/resources/windows/Git-${GIT}-64-bit.exe"

echo "打包 npm 包…"
( cd "$R/resources/npm-packages" && npm pack @earendil-works/pi-coding-agent --pack-destination . >/dev/null && npm pack remote-pi --pack-destination . >/dev/null )

echo
echo "全部就绪。"
ls -lhR "$R/resources" | head -30
