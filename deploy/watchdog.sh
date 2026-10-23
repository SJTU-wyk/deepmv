#!/usr/bin/env bash
# 健康检查看门狗。
#
# systemd 的 Restart=always 只能处理「进程崩了」。
# 进程活着但卡死（比如事件循环被某个请求堵住）时它不会动手，
# 所以要有个东西定期敲一下 /api/health，连续失败就重启。
#
# 安装见 deploy/systemd/，配一个 5 分钟跑一次的 systemd timer。

set -uo pipefail

PORT="${DEEPMV_PORT:-7821}"
FAIL_FILE=/var/lib/deepmv-watchdog.fails
MAX_FAILS=3

mkdir -p "$(dirname "$FAIL_FILE")"
touch "$FAIL_FILE"
fails=$(cat "$FAIL_FILE" 2>/dev/null || echo 0)

if curl -sf -m 8 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "0" > "$FAIL_FILE"
  logger -t deepmv-watchdog "健康检查通过"
  exit 0
fi

fails=$((fails + 1))
echo "$fails" > "$FAIL_FILE"
logger -t deepmv-watchdog "健康检查失败，第 $fails 次"

if [ "$fails" -ge "$MAX_FAILS" ]; then
  logger -t deepmv-watchdog "连续 $MAX_FAILS 次失败，重启 deepmv"
  systemctl restart deepmv
  echo "0" > "$FAIL_FILE"
fi
