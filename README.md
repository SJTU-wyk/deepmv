# DeepMV

影视资源导航站。规则驱动多源检索，读 HLS 清单确认真实分辨率，顺手把清单里插的广告切掉。

做它是想要一个开网页就能用的看片工具，能在电视盒子、旧笔记本、手机浏览器上跑起来。Kazumi 的规则体系很好，但它是 Flutter 客户端，我照它的思路重写了一个服务端版本。

在线实例：<https://deepmv.onrender.com>

## 项目结构

```
web/                 前端（React + Vite）
  src/
    api.ts           请求层：AbortController、序号守卫、去重、错误文案
    hooks/
      useAsyncData.ts  异步数据统一取法，防串台的核心
    pages/           Home / Search / Detail / Player / Collections / Sources
    components/      Poster、Feedback（骨架屏与提示条）
    upscale.ts       WebGL 锐化
server/              后端（Fastify + TypeScript）
  src/
    index.ts         入口与路由
    guard.ts         运行模式、口令、成本制限流
    cache.ts         TTL + LRU + 请求合并
    upstream.ts      按主机限流的并发闸门、重试退避
    breaker.ts       上游熔断器
    health.ts        线路可用性检查
    aggregate.ts     多源搜索与合并
    curated.ts       首页分区（按分区缓存 + 渐进返回）
    picks.ts         片单解析
    resolve.ts       全源择优
    adblock.ts       HLS 广告簇识别与清除
    proxy.ts         清单重写、CORS 探测、网页嗅探
    imgcache.ts      海报磁盘缓存
    log.ts           结构化日志
    rules/           内置源与自定义规则
mobile/android/      Android WebView 壳
deploy/              一键部署脚本与平台配置
```

## 最近一轮做了什么

线上跑起来之后暴露了四个问题，这轮逐个处理。

### 一、请求串台

现象：点了分类 A 还没回来又点 B，B 显示了之后 A 的迟到响应把页面盖回去。

原因有两层：请求没有取消机制，回调里也不检查「这次响应还是不是最新的」。

改法在 `web/src/api.ts` 和 `web/src/hooks/useAsyncData.ts`：

- 每个请求带一个自增序号，回调前比对，对不上直接丢弃。这是最终保证。
- 同时配 AbortController，发新请求时取消旧的。取消是尽力而为，浏览器不保证真中断，所以序号比对不能省。
- 组件卸载后不再写状态。
- loading 状态绑定当前请求，旧请求结束不会把 loading 关掉。
- 同一个 URL 在 800ms 内重复请求共享同一个 Promise，另有极短有效期缓存。

三个场景的复现测试（`node _race.mjs`）：

```
场景 1：三个请求并发，最后一次胜出        PASS
场景 2：旧请求更晚返回（典型串台）        PASS
场景 3：页面切走后不再写入                PASS
```

### 二、首页 77 秒

原来首页一次要把 11 个分区建完：13 个源 × 2 页 × 11 分区 ≈ 286 个上游请求，冷启动实测 77 秒，第一个人只能对着白屏等。

改成按分区独立缓存、按分区建、加总时限：

- 每个分区单独缓存（`curated.ts` 的 `sectionCache`）
- 请求进来只等 `DEEPMV_HOME_DEADLINE`（默认 9 秒），到点返回已就绪的分区
- 没就绪的在后台继续建，下次访问就有了 —— 用户感受到的是「越刷越全」
- 同分区并发只建一次（`sectionInflight`）

实测：

```
第 1 次   9035ms  分区 4  条目 98
第 2 次   2479ms  分区 7  条目 161
第 3 次     18ms  分区 7  条目 161（全部命中缓存）
```

### 三、搜索 24 秒

13 个源里有几个在国内能用、在海外必然超时。每次搜索都要等它们各自超时，而并发池只有 3 个槽位，这些必然失败的请求把槽位占满，把能用的源挤到后面。

三处改动：

**并发改成按主机限流。** 以前是一个全局信号量，只能同时 3 个请求。但 13 个源是 13 个不同主机，互相之间没有压力；真正该克制的是「同一个站别并发打太多次」。现在是全局 12、单主机 3。

**加熔断器。** 连续失败到阈值（默认 3 次）的源暂时摘出去，冷却期 5 分钟后半开试探。实测摘掉 4 个海外不可达的源之后，搜索从 6 秒降到 1.5 秒。

**加总时限。** `DEEPMV_SEARCH_DEADLINE` 默认 6 秒，到点返回已拿到的，没回来的标「响应超时」，不阻塞整页。

实测（连续 8 个不同关键词）：

```
教父        25ms  可用 9/13
活着         2ms  可用 9/13
让子弹飞   2427ms  可用 9/13
无间道     1610ms  可用 9/13
大话西游   1316ms  可用 9/13
```

### 四、限流误伤

原来每 IP 每分钟 90 次请求。一个人打开首页就会打出十几个请求（11 个分区 + 一批海报），加上翻分类、搜片名，正常使用很容易撞到 429。

改成按「成本」算：

| 接口 | 成本 | 理由 |
| --- | --- | --- |
| `/api/health` | 0 | 监控用 |
| `/api/img` | 0 | 海报走磁盘缓存，不消耗上游 |
| `/api/home` `/api/sources` | 1 | 一次就够 |
| `/api/detail` `/api/best-road` `/api/probe` | 2 | 会打上游 |
| `/api/search` `/api/best` | 4 | 要打十几个上游 |

两道闸：总预算 `DEEPMV_RATE`（默认 240 点/分）保护本机，昂贵接口 `DEEPMV_EXPENSIVE_RATE`（默认 60 点/分）保护上游。正常浏览一圈用不到 50 点。

确认过：项目里的 429 全部来自 DeepMV 自己的 `guard.ts`，没有把上游的限流转发出去。上游遇到 429 时由 `upstream.ts` 按 `Retry-After` 退避重试，最多两次。

### 五、线路可用性

`/api/health-check/:source/:id` 探测每条线路首集，结果三种状态：可用 / 未验证 / 暂不可用。

几条约束：

- 结果进缓存，正例 30 分钟、反例 5 分钟。不会每个用户每次访问都重探。
- 一次请求最多探 4 条（`DEEPMV_MAX_PROBES`），超过的保持「未验证」。
- 探测走并发闸门，不暴力扫地址。
- 超时不等于失效：判成「未验证」而不是「暂不可用」。
- 5xx 是对方临时故障，也不判失效。
- 403 / 404 / 410 才判「暂不可用」。

实测：

```
modum3u8     ok            200   1872ms
gsm3u8       ok            200   1199ms
播放源 3      ok            206     48ms
播放源 2      unavailable   404   3339ms
播放源 5      unverified      -      0ms（超过单次探测上限）
```

### 六、错误文案

以前接口报错会把 `{"error":"请求过于频繁"}` 原样显示成「加载失败：{...}」。

现在按状态码翻成人话，原始信息只进 console：

| 状态 | 显示 |
| --- | --- |
| 429 | 当前访问的人有点多，请稍后再试 |
| 502 / 504 | 数据源暂时不可用，换一个来源试试 |
| 404 | 没有找到相关内容 |
| 5xx | 服务器开小差了，请稍后再试 |

上游部分失败时（搜索 13 个源挂了 4 个），页面显示「13 个来源里有 4 个暂时取不到数据，下面显示的是其余来源的结果」，内容照常展示，不整页报错。

### 七、接口缓存

`server/src/cache.ts` 是带 TTL 的 LRU，外加请求合并（同一个 key 并发只打一次上游）。

| 数据 | TTL | 环境变量 |
| --- | --- | --- |
| 搜索结果 | 3 分钟 | `DEEPMV_SEARCH_TTL` |
| 分类列表 | 15 分钟 | — |
| 详情 | 10 分钟 | — |
| 首页分区 | 8 分钟 | `DEEPMV_HOME_TTL` |
| 线路健康 | 30 分钟（正例）/ 5 分钟（反例） | `DEEPMV_HEALTH_TTL` |
| 片单 | 6 小时 | `DEEPMV_PICK_TTL` |

容量上限：上游 400 条、健康 2000 条、首页 40 条。超了按最近最少使用淘汰，每分钟清一次过期项。

上游失败不写缓存 —— 错误结果被缓存住的话，上游恢复了这个 key 还是坏的。

`/api/status` 能看统计：

```json
{
  "memoryMB": 82,
  "limit": { "budget": 240, "expensiveBudget": 60, "trackedIps": 0 },
  "cache": { "upstream": { "entries": 126, "hits": 18, "misses": 163, "coalesced": 10 } },
  "breakers": [{ "id": "hdmoli", "state": "open", "failures": 3 }]
}
```

### 八、日志

只记值得看的，不刷屏：

- 请求：只记 4xx/5xx 和超过 `DEEPMV_SLOW_MS`（默认 1500ms）的
- 上游：只记失败和慢于 4 秒的
- 缓存命中率：每 5 分钟一行汇总，不是每个请求一行
- 永不记录：`DEEPMV_KEY`、Authorization、Cookie

`DEEPMV_LOG_LEVEL` 可调（debug / info / warn / error）。

## 部署

### Render（当前线上方式）

仓库里有 `render.yaml`，在 Render 选 New → Blueprint 指向仓库即可。

免费档闲置 15 分钟休眠，下次访问等 30~60 秒唤醒。为了不让冷启动更慢，公网模式默认不预热（`DEEPMV_WARMUP=0`），首页靠按分区渐进加载在 9 秒内出内容。

```
PORT          由 Render 注入，代码读 process.env.PORT
HOST          公网模式或检测到 RENDER/FLY_APP_NAME 时绑 0.0.0.0
健康检查      /api/health，Dockerfile 里跟着 ${PORT:-7821} 走
```

### 自己的服务器

```bash
curl -fsSL https://raw.githubusercontent.com/SJTU-wyk/deepmv/master/deploy/install.sh -o install.sh
sudo bash install.sh --domain mv.example.com --email you@example.com
```

装 Node、构建、注册 systemd、装 Caddy 自动 HTTPS、配防火墙、装健康看门狗、限制日志占用。详细步骤见 [deploy/AZURE.md](deploy/AZURE.md)。

### 本地

```bash
pnpm install --config.strictDepBuilds=false
pnpm build && pnpm start
```

打开 <http://127.0.0.1:7821>。本地模式只监听回环地址，同局域网的其他设备也连不上。

## 访问口令

机制是「开关」不是「限流」：

```
不设 DEEPMV_KEY   → 完全公开，谁拿到地址都能用
设了 DEEPMV_KEY   → 所有 /api/* 要带 ?key=xxx 或 X-DeepMV-Key 头
```

公开部署（Render 现在的状态）不设口令。私有部署想小范围分享：

```bash
# Render：在面板 Environment 里加 DEEPMV_KEY
# 自己的服务器：/etc/deepmv.env
DEEPMV_KEY=你的口令
```

`DEEPMV_KEY` 只在服务端读取，不会编译进前端产物。已经确认过 `web/src` 里没有任何密钥字符串，仓库历史里也没有误传的 `.env`、`.jks`。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查，公网模式唯一不需要口令的接口 |
| GET | `/api/status` | 内存、缓存、限流、熔断状态 |
| GET | `/api/home` | 首页分区，按分区缓存 |
| GET | `/api/search?q=` | 多源搜索，同名合并 |
| GET | `/api/detail/:source/:id` | 详情、线路（带已知健康状态）、选集 |
| GET | `/api/health-check/:source/:id` | 主动探测线路可用性 |
| GET | `/api/best?q=` | 全源找能播的最高画质 |
| GET | `/api/resolve?url=` | 返回 direct / manifest / proxy 三种播放模式 |
| GET | `/api/proxy?u=` | 清单代理与广告清除（公网默认关闭） |
| GET | `/api/img?u=` | 海报缓存 |
| GET | `/api/collections` | 片单 |
| GET | `/api/sources` | 已加载的源 |

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 7821 | 监听端口，平台会注入 |
| `HOST` | 见上文 | 监听地址 |
| `DEEPMV_MODE` | local | `public` 时关代理、加限流 |
| `DEEPMV_KEY` | 空 | 访问口令，空 = 公开 |
| `DEEPMV_RATE` | 240 | 每 IP 每分钟成本点 |
| `DEEPMV_EXPENSIVE_RATE` | 60 | 搜索类接口的独立额度 |
| `DEEPMV_UPSTREAM_CONCURRENCY` | 12 | 全局上游并发 |
| `DEEPMV_PER_HOST_LIMIT` | 3 | 单主机并发 |
| `DEEPMV_BREAKER_THRESHOLD` | 3 | 连续失败几次熔断 |
| `DEEPMV_BREAKER_COOLDOWN` | 300000 | 熔断冷却期（毫秒） |
| `DEEPMV_HOME_DEADLINE` | 9000 | 首页总时限 |
| `DEEPMV_SEARCH_DEADLINE` | 6000 | 搜索总时限 |
| `DEEPMV_MAX_PROBES` | 4 | 单次健康检查最多探几条 |
| `DEEPMV_WARMUP` | 0 | 启动预热，公网保持关闭 |
| `DEEPMV_LOG_LEVEL` | info | debug / info / warn / error |
| `ALLOW_PROXY` | 0（public） | 公网模式是否开放视频代理 |

## 播放源

内置 13 条规则：

| id | 名称 | 适配器 | 备注 |
| --- | --- | --- | --- |
| modu | 魔都资源 | maccms | 直连 CORS 通，实测 1080P |
| rycz | 日月采集 | maccms | 直连 CORS 通 |
| guangsu | 光速资源 | maccms | 直连 CORS 通 |
| zuid | 最大资源 | maccms | 片库大 |
| ffzy | 非凡资源 | maccms | 更新快 |
| bdzy | 百度资源 | maccms | 有 4K 专区、邵氏片库 |
| wujin | 无尽资源 | maccms | Netflix 分区 |
| lzi | 量子资源 | maccms | 老片多 |
| ddys | 低端影视 | ddys | JSON API，带网盘资源 |
| archive | Internet Archive | archive | 公有领域老片 |
| libvio | LIBVIO | xpath | 地区限制，海外不可达 |
| hdmoli | HDMoli | maccms | 地区限制，海外不可达 |
| cupfox | 茶杯狐 | maccms | 地区限制，海外不可达 |

后三个在国内能用、海外必然超时，会被熔断器自动摘掉，不影响其它源。加自己的源：扔个 JSON 到 `server/rules/custom/`。

## 画质

站点标签写的「HD」「超清」不能信。同一部《霸王别姬》，有的源标 1080P，清单里只有 1280x692。

所以读清单：HLS master playlist 里的 `RESOLUTION=1920x1080` 是片源自己声明的，比页面标签可靠。

浏览器里还能开一层 WebGL 处理：按局部梯度分两路，平坦区域平滑压色块，边缘区域沿边缘锐化。画布按倍率放大（1.5x / 2x），实测 1920x1040 的源在 2x 档下画布是 3840x2080。

它不是 AI 超分，不能让 540P 变成真 1080P。

## 广告分两种

**拼进 m3u8 清单的广告分片** —— 能删。

```
主片  /20240924/.../2000kb/hls    10821 秒，5485 个唯一分片
广告  /20261009/.../10152kb/hls    176 秒，9 个分片各重复 10 次
```

判据是分片 URI 重复、某路径簇分片种类极少却占大量槽位、总时长远小于主片且被拆散插入。`adblock.ts` 按这个删，那部片删掉 90 个分片 / 176 秒，正片 180.3 分钟完整保留。

**烧进视频画面的广告** —— 删不掉。片源方转码时就把图烧进了像素，跟清单没关系。只能换源。

## 说明

片源来自公开的影视数据接口，接口由第三方维护，可用性不由本项目控制。项目不做破解、不去 DRM、不碰盗链鉴权，只做接口聚合和画质甄别。

影视内容版权归各权利人所有，本项目仅供本地技术验证使用。
