# 部署方式

按你的条件选一条，三条路都能得到别人能打开的网址。

| 方式 | 需要什么 | 得到什么 | 适合 |
| --- | --- | --- | --- |
| 自己的服务器 | 一台 Linux（你已有的 Azure 免费机器就够） | 自己的域名 + 正式 HTTPS | 长期公开 |
| Render 免费档 | 一个 GitHub 账号 | https://xxx.onrender.com | 先跑起来给人看 |
| Fly.io | 信用卡验证（免费额度内不扣费） | https://xxx.fly.dev | 不想自己运维 |

---

## 一、自己的服务器（推荐）

服务器上执行一条命令：

```bash
# 有域名
sudo bash deploy/install.sh --domain mv.example.com --email you@example.com

# 没域名，先用 IP 跑通
sudo bash deploy/install.sh
```

脚本做完这些：装 Node 20 → 拉代码 → 构建前端 → 注册 systemd 服务 → 装 Caddy 反代 → 申请 HTTPS 证书 → 配防火墙。跑完会把访问地址和访问口令打印出来。

**部署前要确认两件事**：

1. 域名 A 记录指向服务器公网 IP（没有域名可跳过）
2. 云厂商安全组放行 80 和 443（Azure 在「网络 → 网络安全组」里加）

改配置：`nano /etc/deepmv.env`，改完 `systemctl restart deepmv`。

**为什么默认关掉视频代理**：Azure 免费额度约 100 GB 出站。一部 1080P 电影 2~4 GB，走服务器中转，25 部片就把整月流量吃光。关掉之后服务器只返回几十 KB 的 JSON，视频由观众自己的设备直连片源。这个取舍写在 `server/src/guard.ts` 里。

想开代理（内网自用可以）：把 `ALLOW_PROXY` 改成 `1`。

---

## 二、Render 免费档

仓库里已有 `render.yaml`。在 Render 选 New → Blueprint → 指向你的仓库，它会照配置建好服务。

免费档的机器闲置 15 分钟会休眠，下次访问要等 30~60 秒唤醒。适合先给人看，不适合当正式站点。

---

## 三、Fly.io

```bash
fly launch --copy-config --no-deploy
fly secrets set DEEPMV_KEY=你自己想的口令
fly deploy
```

免费额度是 3 台 256MB 实例，配置里已经设成不休眠。

---

## 四、只在本机用

```bash
pnpm install --config.strictDepBuilds=false
pnpm build && pnpm start
```

打开 http://127.0.0.1:7821。默认只监听回环地址，同局域网的其他设备也访问不到——这是有意的。

---

## 公开访问前要设的东西

不设 `DEEPMV_KEY` 的话，知道你网址的人都能用，也会消耗你的服务器资源。建议设一个口令，分享链接时一起给出：

```bash
# /etc/deepmv.env
DEEPMV_KEY=你的口令
DEEPMV_RATE=90          # 每 IP 每分钟请求上限
ALLOW_PROXY=0           # 公网环境保持关闭
```
