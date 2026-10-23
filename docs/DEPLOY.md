# 部署与分平台打包

这份文档回答三个问题：**哪些在你电脑上做、哪些必须上服务器、哪些只能在云 CI 里做。**

---

## 一、先分清三种「运行位置」

| 位置 | 是什么 | 能做什么 | 代价 |
| --- | --- | --- | --- |
| **本地电脑** | `node dist/index.js`，只监听 127.0.0.1 | 开发、调试、自己看片、跑探测 | 电费；关了电脑就没了 |
| **云服务器** | 一台常开的 Linux，跑同一个程序 | 让别人 7×24 访问、做规则仓库、生成 APK | 免费额度有限、流量贵 |
| **GitHub Actions** | 临时云机器，一次跑几十分钟 | 交叉编译 Win/macOS/Linux/Android 包 | 免费额度、打包慢 |

**决定性原则：播放器需要的带宽是给「看的人」的，不是给服务器的。** 服务器只做「目录 + 解析」这一层，几十 KB 的 JSON；视频流走用户端直连片源。这样一台 1 核 1G 的免费机器就能撑住几百人日常使用。

---

## 二、逐项对照

### 完全可以在本地电脑做的

| 事项 | 怎么做 | 说明 |
| --- | --- | --- |
| 开发与调试 | `pnpm dev` | 前端 7822 热更新，后端 7821 |
| 自己看片 | `pnpm build && pnpm start` | 本地模式监听 127.0.0.1，外网连不上 |
| 规则调通 | 改 `server/rules/custom/*.json` | 存盘后 POST `/api/sources/reload` |
| 画质探测 | 详情页自动做 | 读 HLS master playlist 的 RESOLUTION |
| 打 Windows 包 | `pnpm build` + zip | Actions 里也能做，但本地 30 秒就完事 |
| 生成签名密钥 | `keytool`（Android）、`openssl`（其他） | 私钥只在本地，**绝对不要提交** |
| 跑 Docker 镜像 | 本机装 Docker Desktop | 验证完再推 |

### 必须上服务器（或至少一台常开机器）

| 事项 | 为什么 |
| --- | --- |
| 给别人用 | 你电脑关机，链接就死 |
| HTTPS 证书 | Let's Encrypt 要能访问 80/443 验证域名 |
| 规则仓库 | 别人要能随时拉规则，得有个稳定地址 |
| 定时刷新首页缓存 | 不然第一个访问的人等 14 秒 |
| 访问日志 / 反滥用 | 需要公网入口才能观察 |

### 只能在云 CI 里做的

| 事项 | 为什么本地做不了 |
| --- | --- |
| **iOS 打包** | 必须有 macOS + Xcode，Windows 上无解 |
| **macOS .dmg** | 同上 |
| **Linux 二进制** | 交叉编译 glibc 依赖很痛，CI 上原生编译最省事 |
| Android 签名包 | 本地也能做，但密钥放 CI secret 更安全 |

### 你申请的那台微软免费服务器

Azure 免费账户的典型额度（以你开户时的条款为准）：

- **B1s / B2ats_v2 等小机型 750 小时/月**，Linux 或 Windows 任选
- **出站流量约 100 GB/月**（超出按量计费）
- 65+ 项常驻免费服务（含少量 Functions、Storage）

**关键限制：100 GB 出站流量。** 一部 1080P 电影 2~4 GB，也就是说：

- 走「服务器代理视频」：**25~50 部电影就把整月流量吃光**
- 走「服务器只给目录 + 直链」：一部电影只消耗几十 KB 的 JSON，**100 GB 能服务几十万人次**

这就是 DeepMV 在公网模式默认关闭 `/api/proxy` 的原因——不是功能阉割，是这台机器扛不住代理流量。实测关掉代理后，一台 B1s 的内存占用稳定在 200 MB 以内。

---

## 三、上手顺序

### 第 1 步：GitHub（本地做）

```bash
cd deepmv
git init
git add .
git commit -m "feat: DeepMV 影视聚合客户端"
gh repo create deepmv --public --source=. --push
```

仓库名可以叫 `deepmv`，公开或私有都行。公开仓库的 Actions 免费额度是**无限**的（私有仓库 2000 分钟/月）。

### 第 2 步：Windows / Linux / Web 包（GitHub Actions 自动做）

推 tag 就触发：

```bash
git tag v0.1.0
git push origin v0.1.0
```

Actions 会并行产出：

- `deepmv-web-v0.1.0.tar.gz`（静态站点包）
- `deepmv-windows-v0.1.0.zip`（解压双击 start.cmd）
- `deepmv-linux-v0.1.0.tar.gz`（配 systemd unit）
- `ghcr.io/<你的账号>/deepmv:latest`（Docker 镜像）

### 第 3 步：Android（本地或 CI）

本地：

```bash
cd mobile/android
gradlew assembleRelease -PserverUrl=https://deepmv.example.com
```

需要本机装 JDK 17 + Android SDK（约 4 GB）。不想装就走 CI，在仓库 Settings → Actions → General 里配三个 secret：

| Secret | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 deepmv.jks` 的结果 |
| `ANDROID_KEY_ALIAS` | keytool 里的 alias |
| `ANDROID_KEYSTORE_PASSWORD` | 密钥库密码 |

### 第 4 步：iOS（只能 CI）

iOS 壳需要 Xcode 工程。最小做法是用 Capacitor：

```bash
cd web
pnpm add -D @capacitor/cli @capacitor/core
npx cap init DeepMV app.deepmv.client --web-dir=dist
npx cap add ios
```

然后在 Actions 里加 `macos-latest` 的 job 跑 `xcodebuild`。**没有 Apple 开发者账号的话**，装到真机只能自签名 7 天，或者干脆用 Safari「添加到主屏幕」（PWA），体验已经接近原生。

### 第 5 步：服务器（第 2 步之后）

以 Ubuntu 22.04 为例，三条命令：

```bash
# 1. 拉镜像
docker pull ghcr.io/<你的账号>/deepmv:latest

# 2. 起服务（只绑回环，不直接暴露）
DEEPMV_KEY=你的口令 docker compose up -d

# 3. 反代 + HTTPS
sudo apt install -y caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # 改域名
sudo systemctl reload caddy
```

---

## 四、安全：公网部署必做

DeepMV 有两类接口，风险完全不同：

| 接口 | 风险 | 公网处理 |
| --- | --- | --- |
| `/api/search` `/api/detail` `/api/home` | 只读聚合，替你访问固定几个采集站 | 保留，加限流 |
| `/api/proxy` | **替任何人取任意 URL**，等于开放代理 | **默认关闭**（`ALLOW_PROXY=0`） |
| `/api/share/rules` (POST) | 写文件 | 公网下必须配 `DEEPMV_KEY` |

已经内置的三道防线：

1. **监听地址**：本地模式只绑 `127.0.0.1`，别人的机器物理上连不上
2. **令牌桶**：每 IP 每分钟 N 次（`DEEPMV_RATE`，公网默认 90）
3. **口令**：设了 `DEEPMV_KEY` 后，所有接口都要带 `?key=` 或 `X-DeepMV-Key`

实测（公网模式 + 口令）：

```
/api/health              200   健康检查保持开放，给监控用
/api/proxy?u=...         403   默认禁止开放代理
/api/home                403   没口令
/api/home?key=test...    200   有口令
连打 100 次 /api/sources  → 11 次 429，令牌桶生效
```

**额外建议**：

- `deploy/systemd/deepmv.service` 里已经加了 `ProtectSystem=strict` `NoNewPrivileges` `MemoryMax=700M`，即使服务被拿下也翻不出目录、撑不爆内存
- 口令别写在 `compose.yml` 里，用 `/etc/deepmv.env`（`chmod 600`）
- 不要给 7821 端口开公网安全组，只让 Caddy/Nginx 反代
- Azure 免费机器建议开 `Microsoft Defender` 的免费层，只看不做处置

---

## 五、便捷性：让人愿意用

| 手段 | 效果 |
| --- | --- |
| Cloudflare 免费 CDN | 静态资源全球加速，缓存命中率 90%+，服务器出站流量几乎归零 |
| 首页 stale-while-revalidate | 有人访问就返回旧缓存 + 后台刷新，永远 3 ms 响应 |
| 片单预热 | 启动时后台跑 4 个片单，第一个用户进来就有内容 |
| Docker 一行命令 | `docker run -p 7821:7821 ghcr.io/...` |
| 规则热加载 | 改 JSON 不用重启，`POST /api/sources/reload` |
| PWA | 手机「添加到主屏幕」，全屏无地址栏 |

---

## 六、费用预期

| 项目 | 免费额度 | 超出后 |
| --- | --- | --- |
| Azure B1s | 750 小时/月（够 1 台常开） | 约 ¥30/月 |
| Azure 出站 | 100 GB/月 | 约 ¥0.5/GB |
| GitHub Actions（公开仓库） | 无限 | — |
| GitHub Actions（私有仓库） | 2000 分钟/月 | $0.008/分钟 |
| Let's Encrypt 证书 | 免费 | — |
| Cloudflare 免费版 | 免费 | — |
| 域名 | — | ¥30~80/年 |

**结论：只做「目录 + 解析」的话，这台免费机器 + 免费 CDN，一年零元可以跑起来。** 一旦开启视频代理，100 GB 出站大概一周就见底。
