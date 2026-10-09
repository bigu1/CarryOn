#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
PID_FILE="${XUSHANG_PID_FILE:-${XUSHANG_DATA_DIR:-$ROOT/data}/xushang.pid}"
INDEX="$ROOT/src/server/index.ts"

if [ ! -f "$PID_FILE" ]; then
  echo "没有找到CarryOn 的进程记录，什么也没有结束。"
  exit 0
fi

PID=$(cat "$PID_FILE")
if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
  rm -f "$PID_FILE"
  echo "CarryOn 已经不在运行。"
  exit 0
fi

if ! node "$ROOT/scripts/instance-owner.mjs" "$PID" "$ROOT" "$PID_FILE"; then
  echo "无法确认进程 ${PID} 属于本实例 CarryOn，没有结束它。"
  exit 1
fi

kill "$PID"
rm -f "$PID_FILE"
# bash 3.2 + set -u：裸 $PID 紧贴全角括号会当成未绑定变量，echo 失败退出码 1（kill 已发生）
echo "已停止 CarryOn（进程 ${PID}）。"
