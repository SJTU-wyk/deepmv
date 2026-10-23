#!/usr/bin/env bash
# DeepMV 一键部署脚本（Ubuntu 22.04 / 24.04，Debian 12 亦可）
#
# 用法：
#   有域名：  sudo bash install.sh --domain mv.example.com --email you@example.com
#   没域名：  sudo bash install.sh                （用服务器 IP + 自签证书）
#
# 脚本会做完这些事：装 Node 20 → 装依赖 → 构建前端 → 注册 systemd 服务
# → 装 Caddy 反向代理 → 自动申请 HTTPS 证书。
# 全程不需要人工编辑配置文件。

set -euo pipefail

DOMAIN=""
EMAIL=""
PORT=7821
ACCESS_KEY=""
INSTALL_DIR=/opt/deepmv
REPO_URL="${DEEPMV_REPO:-https://github.com/SJTU-wyk/deepmv.git}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email)  EMAIL="$2";  shift 2 ;;
    --key)    ACCESS_KEY="$2"; shift 2 ;;
    --port)   PORT="$2"; shift 2 ;;
    *) echo "未知参数：$1"; exit 1 ;;
  esac
done

log() { printf '\n[deepmv] %s\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "请用 sudo 运行：sudo bash install.sh --domain 你的域名"
  exit 1
fi

# ---------- 1. 系统依赖 ----------
log "安装系统依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git rsync ufw >/dev/null

# ---------- 2. Node 20 ----------
if ! command -v node >/dev/null 2>&1 || [[ $(node -v | cut -c2-3) -lt 18 ]]; then
  log "安装 Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
log "Node 版本：$(node -v)"

# ---------- 3. 拉代码 ----------
log "准备代码目录 $INSTALL_DIR"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  git -C "$INSTALL_DIR" pull --ff-only
else
  mkdir -p "$INSTALL_DIR"
  if [[ -f "$(dirname "$0")/package.json" ]]; then
    # 从当前目录安装（本地已有源码）
    rsync -a --exclude node_modules --exclude .git "$(dirname "$0")/" "$INSTALL_DIR/"
  else
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  fi
fi
cd "$INSTALL_DIR"

# ---------- 4. 构建 ----------
log "安装依赖并构建前端"
corepack enable >/dev/null 2>&1 || true
npm i -g pnpm@9 >/dev/null 2>&1
pnpm install --no-frozen-lockfile --config.strictDepBuilds=false
pnpm --filter @deepmv/web build
( cd server && npx tsc -p tsconfig.build.json )

# ---------- 5. 服务账号 ----------
if ! id deepmv >/dev/null 2>&1; then
  log "创建服务账号 deepmv"
  useradd --system --home "$INSTALL_DIR" --shell /usr/sbin/nologin deepmv
fi
mkdir -p "$INSTALL_DIR/server/share" "$INSTALL_DIR/server/data"
chown -R deepmv:deepmv "$INSTALL_DIR/server/share" "$INSTALL_DIR/server/data"

# 访问口令：不传就生成一个，写进 root 可读的文件
if [[ -z "$ACCESS_KEY" ]]; then
  ACCESS_KEY=$(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 24)
fi
cat > /etc/deepmv.env <<EOF
NODE_ENV=production
DEEPMV_MODE=public
DEEPMV_RATE=90
ALLOW_PROXY=0
DEEPMV_KEY=$ACCESS_KEY
EOF
chmod 600 /etc/deepmv.env

# ---------- 6. systemd ----------
log "注册 systemd 服务"
cat > /etc/systemd/system/deepmv.service <<EOF
[Unit]
Description=DeepMV
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=deepmv
Group=deepmv
WorkingDirectory=$INSTALL_DIR/server
Environment=NODE_ENV=production
EnvironmentFile=/etc/deepmv.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$INSTALL_DIR/server/share $INSTALL_DIR/server/data
MemoryMax=800M

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable deepmv >/dev/null 2>&1
systemctl restart deepmv
sleep 3

if ! systemctl is-active --quiet deepmv; then
  echo "服务启动失败，最近日志："
  journalctl -u deepmv -n 30 --no-pager
  exit 1
fi
log "后端已启动，监听 127.0.0.1:$PORT"

# ---------- 6b. 保活：看门狗 + 日志限额 ----------
log "配置健康检查看门狗"
chmod +x "$INSTALL_DIR/deploy/watchdog.sh" 2>/dev/null || true
cp "$INSTALL_DIR/deploy/systemd/deepmv-watchdog.service" /etc/systemd/system/ 2>/dev/null || true
cp "$INSTALL_DIR/deploy/systemd/deepmv-watchdog.timer" /etc/systemd/system/ 2>/dev/null || true
# systemd 的 Restart=always 只管进程崩溃，卡死不重启；timer 每 5 分钟敲一次健康检查
mkdir -p /etc/systemd/system
cat > /etc/systemd/system/deepmv-watchdog.service <<EOF
[Unit]
Description=DeepMV 健康检查
After=deepmv.service

[Service]
Type=oneshot
ExecStart=$INSTALL_DIR/deploy/watchdog.sh
Environment=DEEPMV_PORT=$PORT
EOF
systemctl daemon-reload
systemctl enable --now deepmv-watchdog.timer >/dev/null 2>&1
log "看门狗已启用：每 5 分钟检查一次，连续 3 次失败自动重启"

log "限制日志占用"
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/deepmv.conf <<EOF
[Journal]
SystemMaxUse=200M
SystemKeepFree=500M
MaxRetentionSec=1month
EOF
systemctl restart systemd-journald >/dev/null 2>&1 || true

# ---------- 7. Caddy 反代 + HTTPS ----------
log "配置 Caddy 反向代理"
apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
  | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
apt-get update -qq
apt-get install -y -qq caddy >/dev/null

if [[ -n "$DOMAIN" ]]; then
  SITE="$DOMAIN"
  TLS_BLOCK=""
  if [[ -n "$EMAIL" ]]; then
    TLS_BLOCK="  tls $EMAIL"
  fi
else
  SITE=":443"
  TLS_BLOCK="  tls internal"
fi

cat > /etc/caddy/Caddyfile <<EOF
{
  admin off
  email ${EMAIL:-admin@example.com}
}

$SITE {
$TLS_BLOCK
  encode gzip zstd

  header {
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "no-referrer-when-downgrade"
    -Server
  }

  reverse_proxy 127.0.0.1:$PORT {
    header_up X-Real-IP {remote_host}
  }
}
EOF

systemctl restart caddy
sleep 3
systemctl is-active --quiet caddy && log "Caddy 已启动" || {
  echo "Caddy 启动失败："
  journalctl -u caddy -n 20 --no-pager
}

# ---------- 8. 防火墙 ----------
log "配置防火墙"
ufw allow 22/tcp >/dev/null 2>&1 || true
ufw allow 80/tcp >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true

# ---------- 9. 自检 ----------
log "自检"
curl -sf "http://127.0.0.1:$PORT/api/health" && echo " ← 后端正常" || echo "后端无响应"
systemctl is-enabled --quiet deepmv && echo "开机自启：已开启" || echo "开机自启：未开启"
systemctl is-active --quiet deepmv-watchdog.timer && echo "看门狗：运行中" || echo "看门狗：未运行"

IP=$(curl -sS -m 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
echo
echo "==============================================="
echo "  部署完成"
echo "==============================================="
if [[ -n "$DOMAIN" ]]; then
  echo "  访问地址： https://$DOMAIN"
  echo "  注意：请确认域名 A 记录已指向 $IP，且服务器安全组已放行 80/443"
else
  echo "  访问地址： https://$IP  （自签证书，浏览器会提示不安全）"
  echo "  想用正式 HTTPS：重新运行并加 --domain 你的域名 --email 你的邮箱"
  echo "  服务器公网 IP：$IP"
fi
echo
echo "  访问口令： $ACCESS_KEY"
echo "  （存在 /etc/deepmv.env，分享给朋友时一起给出）"
echo
echo "  常用命令："
echo "    systemctl status deepmv            查看服务状态"
echo "    journalctl -u deepmv -f            看实时日志"
echo "    nano /etc/deepmv.env               改口令 / 限流，改完 systemctl restart deepmv"
echo "    systemctl list-timers deepmv*      看门狗下次检查时间"
echo "    df -h                              看磁盘（日志已限制在 200M）"
echo "==============================================="