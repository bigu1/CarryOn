#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js。请先安装 22 或以上版本，再重新打开「启动续上」。不要改系统 PATH 以外的全局设置。"
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "当前 Node 是 $(node -v)，续上需要 22 或以上。"
  exit 1
fi

if [ ! -d "$ROOT/node_modules" ]; then
  echo "还没有安装本项目依赖。请在项目目录运行：npm install"
  echo "这只会装到本项目，不会改你的全局软件。"
  exit 1
fi

DATA_DIR="${XUSHANG_DATA_DIR:-$ROOT/data}"
mkdir -p "$DATA_DIR"
PID_FILE="${XUSHANG_PID_FILE:-$DATA_DIR/xushang.pid}"
PORT_FILE="${XUSHANG_PORT_FILE:-$DATA_DIR/xushang.port}"

# 已有本程序在跑就直接打开，不杀进程、不先换端口
if [ -f "$PID_FILE" ]; then
  OLD=$(cat "$PID_FILE" || true)
  if [ -n "${OLD:-}" ] && kill -0 "$OLD" 2>/dev/null; then
    if node "$ROOT/scripts/instance-owner.mjs" "$OLD" "$ROOT" "$PID_FILE"; then
      OLDPORT=$(cat "$PORT_FILE" 2>/dev/null || true)
      OLDPORT="${OLDPORT:-${XUSHANG_PORT:-43173}}"
      echo "续上已在运行：http://127.0.0.1:$OLDPORT"
      exit 0
    fi
  fi
fi

if [ ! -f "$ROOT/dist/index.html" ]; then
  echo "正在准备页面…"
  npx --no-install vite build
fi

is_free() {
  # 不依赖 ss/nc（本环境两者都可能不在 PATH）。探测失败视为占用，避免误判后崩溃。
  node --input-type=commonjs -e 'const net=require("net"); const p=Number(process.argv[1]); const s=net.createServer(); s.once("error",()=>process.exit(1)); s.listen(p,"127.0.0.1",()=>s.close(()=>process.exit(0)));' "$1"
}

export NODE_ENV=production
export XUSHANG_HOST=127.0.0.1
export XUSHANG_PID_FILE="$PID_FILE"
export XUSHANG_PORT_FILE="$PORT_FILE"

PORT=${XUSHANG_PORT:-43173}
TRIES=0
STARTED=0
while [ "$TRIES" -lt 20 ]; do
  if ! is_free "$PORT"; then
    echo "端口 $PORT 已被占用，改试下一个。不会结束占用它的程序。"
    PORT=$((PORT + 1))
    TRIES=$((TRIES + 1))
    continue
  fi
  export XUSHANG_PORT="$PORT"
  npx --no-install tsx "$ROOT/src/server/index.ts" &
  echo $! > "$PID_FILE"
  echo "$PORT" > "$PORT_FILE"
  sleep 0.6
  if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    STARTED=1
    break
  fi
  echo "端口 $PORT 没能打开，改试下一个。不会结束占用它的程序。"
  rm -f "$PID_FILE"
  PORT=$((PORT + 1))
  TRIES=$((TRIES + 1))
done

if [ "$STARTED" -ne 1 ]; then
  echo "找不到可用端口，续上没有启动。占用原端口的程序未被结束。"
  exit 1
fi

URL="http://127.0.0.1:$PORT"
echo "续上已打开：$URL"
if [ "${XUSHANG_NO_OPEN:-0}" = "1" ]; then
  :
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 || true
elif command -v open >/dev/null 2>&1; then
  open "$URL" || true
fi
wait
