# DeepMV

影视聚合播放器。规则驱动多源检索，播放前读一遍 HLS 清单确认真实分辨率，顺手把片源里插的广告切掉。

起因是想要一个能在电视盒子、旧笔记本、手机浏览器上都能用的看片工具。Kazumi 的思路很好，但它是 Flutter 客户端，我只想开个网页就能用，就照它的规则体系重写了一个服务端版本。

## 先部署，再看别的

这个项目本来就是为了让别人也能访问，所以部署放在最前面。

### 有自己的服务器（推荐，长期公开用这台）

Ubuntu 22.04 / 24.04 或 Debian 12，一行命令：

> 用微软云的话看 [deploy/AZURE.md](deploy/AZURE.md)，从建虚拟机到 24 小时保活都有步骤，包括哪里确认自动关闭有没有关掉。


```bash
git clone https://github.com/SJTU-wyk/deepmv.git
cd deepmv
sudo bash deploy/install.sh --domain mv.example.com --email you@example.com
```

没域名就 `sudo bash deploy/install.sh`，先用 IP 加自签证书跑通。

脚本装 Node 20、构建前端、注册 systemd、装 Caddy 反代、申请证书、配防火墙，跑完把访问地址和访问口令打印出来。第二次运行会 git pull 后重新构建，可以当更新用。

部署前确认两件事：域名的 A 记录指向服务器公网 IP；云厂商安全组放行 80 和 443。Azure 的在「网络 → 网络安全组」里加。

### 没有服务器

仓库里有 `render.yaml`。在 Render 选 New → Blueprint，指向这个仓库，几分钟后拿到一个 https 地址。免费档闲置 15 分钟会休眠，下次访问要等半分钟唤醒，给人看一眼够用。

也可以 `fly launch --copy-config`，免费额度是 3 台 256MB 实例，不会休眠。

### 只在自己电脑上跑

```bash
pnpm install --config.strictDepBuilds=false
pnpm build && pnpm start
```

打开 http://127.0.0.1:7821。默认只监听回环地址，同一个局域网的其他设备也连不上。

### 公开访问前设一个口令

不设 `DEEPMV_KEY` 的话，知道地址的人都能用你的服务器。设上之后所有接口要带 `?key=`：

```bash
# /etc/deepmv.env
DEEPMV_KEY=你的口令
DEEPMV_RATE=90          # 每 IP 每分钟请求上限
ALLOW_PROXY=0           # 公网保持关闭，原因见下
```

**为什么默认关掉视频代理**：Azure 免费额度大概 100 GB 出站流量，一部 1080P 电影 2 到 4 GB。如果观众的每一帧视频都从你的服务器过一遍，二十几部片就把整月额度吃光。

关掉代理后，服务器只返回几十 KB 的 JSON，视频由观众自己的设备直连片源 CDN。这个取舍在 `server/src/guard.ts` 里。内网自用想开代理，把 `ALLOW_PROXY` 改成 1。

## 画质这件事

站点标签写的「HD」「超清」「蓝光」不能信。同一部《霸王别姬》，有的源标着 1080P，实际清单里只有 1280x692。

所以要读清单。HLS 的 master playlist 里有 `RESOLUTION=1920x1080` 这样的字段，这是片源自己声明的，比页面上印的标签可靠。详情页打开时会自动探一遍每条线路的首集，把不可用的直接标出来。

实测：

```
霸王别姬 → 光速资源 1080P 1920x1080 [直连]
流浪地球 → 魔都资源 2K   3840x1608 [直连]
奥本海默 → 魔都资源 1080P 1920x1080 [直连]
```

全源找最高画质走 `/api/best`：把同一部片在所有源里跑一遍，并发探测每条线路的首集，按真实高度排序返回。详情页有个按钮，当前源低于 1080P 时会自动提示切换到更高的。

浏览器里还能开一层 WebGL 处理。它按局部梯度分两路走：平坦区域做加权平滑，压掉老片源的色块和振铃；边缘区域沿边缘锐化，线条不糊。画布会按倍率放大（标准 1.5x，强力 2x），比如 1920x1040 的源在强力档下画布是 3840x2080，再交给浏览器缩到窗口。

要说清楚它做不到什么：这不是 AI 模型超分，不能把 540P 变成真 1080P。它做的是着色器级别的放大加锐化，老片源开强力档观感干净一些、线条清楚一些。目前 540P 的源用完仍然是 540P 的信息量。

**想让 540P 源真的变成 1080P，只有一道路：用原生播放器。** 浏览器受 WebGL 和 MSE 限制，拿不到解码后的帧做多帧重建。Kazumi 用 media_kit（libmpv）就是因为 mpv 能挂 Anime4K 这类真正的超分着色器链。桌面端要做这件事有两个选择：把前端重写成 Flutter + media_kit，或者在现有桌面壳里调用用户本机的 mpv 并注入 Anime4K 配置。后者工作量小得多，也复用现有的规则与聚合逻辑。

## 广告分两种，只有一种能删

**第一种：拼进 m3u8 清单的广告分片。** 这个能删。

拿《奥本海默》的清单举例，里面有两个完全不同路径的分片簇：

```
主片  /20240924/5pBdFnaw/2000kb/hls    10821 秒，5485 个唯一分片
广告  /20261009/KqUe4B8N/10152kb/hls    176 秒，9 个分片各重复 10 次
```

19 个 `#EXT-X-DISCONTINUITY` 插入点。判据不用关键词，看三件事：分片 URI 有没有重复（正常片源不会重复同一个 .ts）、某个路径簇是不是分片种类极少却占了很多槽位、这个簇的总时长是不是远小于主片还被拆散插在中间。

`server/src/adblock.ts` 按这个规则删，那部片删掉 90 个分片、176 秒，正片 180.3 分钟完整留着。响应头会带 `x-deepmv-ads-removed: 90`。

**第二种：烧进视频画面里的广告。** 这个删不掉。

实测截图里能看到"本片由 69242.com 赞助发布"「主营：棋牌 体育 真人娱乐」压在字幕位置上。这是片源方在转码时就把图烧进了像素，跟清单没关系，任何前端过滤都拿它没办法。

能做的只有两件事：一是换源，选片库里比较干净的站点（低端影视这类做索引的通常不烧）；二是播放页会标一个「画面广告 · 建议换源」，提示观众当前源的片源质量可能不高。

## 卡顿是怎么修的

第一版很卡。查下来是三个原因叠在一起。

分片走了服务端中转。同一片 361KB 的内容，浏览器直连 CDN 是 806ms，过一遍 Node 是 1859ms。改成只有「下一层清单」走服务端（因为广告要在那里重写），分片一律直连。一部电影 5000 多个分片，只有 1 个清单过代理。

播放进度每秒 setState 四次，每次都把整棵组件树重渲染一遍，包括几百个选集按钮。改成用 ref 加 `requestAnimationFrame` 直接改 DOM，只在切集、暂停、报错这些真的要重绘的时候才动 React 状态。

首页 JS 一个包 839 KB，hls.js 占了大头，而首页根本用不到。改成路由级分割，hls.js 只在进播放页时下载，首页降到 220 KB。海报图也做了服务端磁盘缓存，第一次回源 0.8 到 2 秒，之后 27ms。

长列表加了 `content-visibility: auto`，屏幕外的分区不参与布局。

## 播放源

内置 13 条规则，默认启用 10 个：

默认启用的 10 个：

| id | 名称 | 类型 | 备注 |
| --- | --- | --- | --- |
| modu | 魔都资源 | maccms | 直连 CORS 通，1080P |
| rycz | 日月采集 | maccms | 直连 CORS 通 |
| guangsu | 光速资源 | maccms | 直连 CORS 通，新片快 |
| zuid | 最大资源 | maccms | 片库大，部分 CDN 限地区 |
| ffzy | 非凡资源 | maccms | 更新快 |
| bdzy | 百度资源 | maccms | 有 4K 电影专区、邵氏片库 |
| wujin | 无尽资源 | maccms | Netflix 分区、邵氏片库 |
| lzi | 量子资源 | maccms | 老片多 |
| archive | Internet Archive | archive | 公有领域欧美老片 |
| ddys | 低端影视 | ddys | 正经 JSON API，6 条线路起步，另带网盘资源 |

默认关闭的 3 个（规则写好了，但海外 IP 打不开，中国大陆应该可用）：

| id | 名称 | 为什么默认关 |
| --- | --- | --- |
| libvio | LIBVIO | Cloudflare 防护 + 地区限制 |
| hdmoli | HDMoli | 返回 "Access denied by geographic restriction" |
| cupfox | 茶杯狐 | 海外不通 |

这三条确认能访问之后，把 `presets.json` 里的 `enabled` 改成 `true` 再重启即可。

每个源在 `presets.json` 里标了 `cors`。标记为 true 的表示 CDN 会给 `Access-Control-Allow-Origin`，浏览器能直连，`/api/best` 会优先探这些。

这些是公开的苹果 CMS 采集接口。接口地址和可用性由第三方决定，随时可能失效，失效了换一条规则就行。

### 加自己的源

扔个 JSON 到 `server/rules/custom/`，重启或者 `POST /api/sources/reload`。

苹果 CMS 接口的最简单，只要 baseURL 和分区映射：

```json
{
  "id": "mysource",
  "name": "我的源",
  "baseURL": "https://api.example.com",
  "adapter": "maccms",
  "categoryMap": {
    "westernMovie": ["6", "7", "8"],
    "cnTv": ["13"]
  }
}
```

网页站要用 XPath 规则，选择器语法和 Kazumi 一样：

```json
{
  "name": "网页站",
  "baseURL": "https://example.com",
  "adapter": "xpath",
  "searchURL": "https://example.com/search?q=@keyword",
  "searchList": "//div[@class=\"item\"]",
  "searchName": "//h3/text()",
  "searchResult": "//a/@href",
  "chapterRoads": "//div[contains(@class,\"playlist\")]",
  "chapterResult": ".//a/@href"
}
```

选择器支持 `//`、`@attr`、`text()`、`[n]`、`[@a]`、`[@a='v']`、`[contains(@a,'v')]`、`[starts-with]`、`[not(...)]`。自己写的引擎在 `server/src/xpath.ts`，没引第三方库。

## 接口

| 方法 | 路径 | 做什么 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查，公网模式下唯一不需要口令的接口 |
| GET | `/api/home` | 首页 11 个分区，15 分钟缓存 |
| GET | `/api/search?q=` | 多源搜索，同名条目合并 |
| GET | `/api/detail/:source/:id` | 详情、线路、选集 |
| GET | `/api/best?q=` | 全源找能播的最高画质 |
| GET | `/api/best-road/:source/:id` | 单条目内每条线路的真实分辨率 |
| GET | `/api/probe?url=` | 探一个 m3u8 的 RESOLUTION |
| GET | `/api/resolve?url=` | 返回 direct / manifest / proxy 三种播放模式 |
| GET | `/api/proxy?u=` | 清单代理与广告清除 |
| GET | `/api/img?u=` | 海报缓存 |
| GET | `/api/collections` | 精选片单 |
| GET | `/api/img?u=` | 海报磁盘缓存 |
| POST | `/api/share/rules` | 上传规则，需要口令 |

`/api/resolve` 返回的 `mode` 决定播放方式：

```
direct    CDN 有 CORS 头，浏览器直连，服务端不参与
manifest  浏览器直连，但清单走服务端清广告（分片仍直连）
proxy     CDN 没有 CORS 头，整条走中转
```

## 目录

```
server/
  src/
    xpath.ts        精简 XPath 引擎
    adapters/       maccms / xpath / archive 三种适配器
    aggregate.ts    多源合并、相关性打分、超时控制
    probe.ts        读 HLS 清单拿真实分辨率
    adblock.ts      广告簇识别与清除
    proxy.ts        清单重写、CORS 探测、网页嗅探
    imgcache.ts     海报磁盘缓存
    resolve.ts      全源择优
    guard.ts        运行模式、限流、口令
    picks.ts        片单解析
  rules/
    presets.json    内置源
    custom/         自定义规则
web/
  src/
    pages/          Home / Search / Detail / Player / Collections / Sources
    upscale.ts      WebGL 锐化
    api.ts
deploy/
  install.sh        一键部署
  README.md         三种部署方式对比
mobile/android/     Android WebView 壳
```

## 打包

推 tag 触发 GitHub Actions，七个任务并行：verify、web、windows、linux、docker、android、release，实测 2 分 56 秒跑完。

产物挂在 Releases：

| 文件 | 大小 |
| --- | --- |
| deepmv-android-v0.1.0-unsigned.apk | 0.6 MB |
| deepmv-windows-v0.1.0.zip | 0.3 MB |
| deepmv-linux-v0.1.0.tar.gz | 0.29 MB |
| deepmv-web-v0.1.0.tar.gz | 0.25 MB |
| ghcr.io/sjtu-wyk/deepmv:latest | Docker 镜像 |

三点提醒：

GHCR 的包默认私有，要让别人匿名 `docker pull`，去 GitHub 的 Your packages → deepmv → Package settings 改成 Public。现在直接访问会返回 401，是权限拦截不是构建失败。

APK 目前没签名，文件名带 `-unsigned`。想自动签名，在仓库 Secrets 里加 `ANDROID_KEYSTORE_BASE64`、`ANDROID_KEY_ALIAS`、`ANDROID_KEYSTORE_PASSWORD`。

iOS 和 macOS 包需要 macOS runner，本地 Windows 编不了，得走 Actions。

流水线踩过的坑记在 `docs/DEPLOY.md` 里，主要是 GitHub 不允许在 `if` 里用 `secrets` 上下文、GHCR 不接受含大写的用户名、Android 那几个 action 在 Node 24 runner 上会崩。

## 关于 Kazumi

读它的源码时确认了几件事，我原本也以为它有什么中转服务器。

它没有服务端，纯客户端。全仓库搜不到 torrent、magnet、ed2k、xunlei 相关的依赖或代码，也不碰 BT 资源。

它快是因为用 media_kit（libmpv）做原生播放器。原生播放器不受 CORS 约束，可以带 UA 和 Referer 直连片源 CDN，所以既不用中转也没有跨域问题。

DeepMV 是网页版，受 CORS 约束，CDN 不给头的时候浏览器拿不到数据，必须有一层判断。这就是 `/api/resolve` 那个 direct / manifest / proxy 的由来。

它的多源来自规则仓库，KazumiRules 里 17 条规则，每条指一个站点。

## 说明

片源来自公开的采集接口，接口由第三方维护，可用性不由本项目控制。项目不做破解、不去 DRM、不碰盗链鉴权，只做接口聚合和画质甄别。

影视内容版权归各权利人所有，本项目仅供本地技术验证使用。