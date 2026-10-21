#!/usr/bin/env bash
# 把本仓库的补丁打到「当前 DSH 正在用的那份安装副本」上。
#
# 插件从市场/npm 重装后，安装副本会回到上游原样，本地改动全部丢失；
# 这个脚本让补丁可以一键重打，不必再手工改一遍文件。
#
# 用法：
#   scripts/apply-patches.sh                 # 打补丁（默认目标 = DSH 桌面 profile）
#   scripts/apply-patches.sh --check         # 只检查能不能打，不写文件
#   scripts/apply-patches.sh --target <dir>  # 指定安装副本目录（含 lib/ 的那层）
#
# 定位目标的优先级：
#   1. --target 传入的目录
#   2. $DSH_PROFILE_DIR
#   3. $DSH_HOME/profiles/desktop/node_modules/dsh-workbuddy-trae-qoder-connect
#
# 依赖：git（用 `git apply`，因此也能处理补丁里的上下文与二进制安全）；
#       不需要本仓库是 git 仓库。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PATCH_DIR="$ROOT/patches"

# 与插件 package.json 的 name 保持一致；换包名时改这里。
PKG="dsh-workbuddy-trae-qoder-connect"

CHECK=0
TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check)  CHECK=1; shift ;;
    --target) TARGET="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$1（用 --help 看用法）" >&2; exit 2 ;;
  esac
done

if [ -z "$TARGET" ]; then
  if [ -n "${DSH_PROFILE_DIR:-}" ]; then
    TARGET="$DSH_PROFILE_DIR/node_modules/$PKG"
  else
    HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
    TARGET="$HOME_DIR/profiles/desktop/node_modules/$PKG"
  fi
fi

if [ ! -d "$TARGET/lib" ]; then
  echo "找不到安装副本：$TARGET" >&2
  echo "（该目录下应有 lib/；用 --target 指定插件安装目录）" >&2
  exit 3
fi

echo "目标：$TARGET"

shopt -s nullglob
PATCHES=("$PATCH_DIR"/*.patch)
if [ ${#PATCHES[@]} -eq 0 ]; then
  echo "patches/ 目录里没有 .patch 文件" >&2
  exit 4
fi

applied=0
skipped=0
for p in "${PATCHES[@]}"; do
  name="$(basename "$p")"

  # 已打过：反向检查能干净撤销，就说明这份补丁已经在目标里生效过。
  if git -C "$TARGET" apply --reverse --check "$p" 2>/dev/null; then
    echo "  已应用    $name"
    skipped=$((skipped + 1))
    continue
  fi

  if [ "$CHECK" -eq 1 ]; then
    if git -C "$TARGET" apply --check "$p" 2>/dev/null; then
      echo "  可打      $name"
    else
      echo "  打不上    $name（目标文件与补丁基线不一致：插件可能已升级，需要重新生成补丁）" >&2
      exit 5
    fi
    continue
  fi

  if git -C "$TARGET" apply "$p"; then
    echo "  已打上    $name"
    applied=$((applied + 1))
  else
    echo "  失败      $name" >&2
    echo "  目标文件与补丁基线不一致。若插件刚重装/升级，请基于新版本重新生成补丁。" >&2
    exit 6
  fi
done

if [ "$CHECK" -eq 1 ]; then
  echo "检查完成（未写入任何文件）。"
  exit 0
fi

echo "完成：新打 $applied 个，原本就已生效 $skipped 个。"
cat <<'NOTE'

接下来：
  1. 插件代码改动不会热加载（Node 的 ESM 模块按进程缓存），需要**完全重启 DSH**
     —— 托盘退出，不是刷新页面。
  2. 重启后确认补丁真的在跑：
       cat ~/.dsh/.workbuddy-host-heartbeat.json
     其中 "patch" 字段应为 cn-prompt-prefix-gate@2026-10-21c。
NOTE
