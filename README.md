# DeepMV

> 受 [Kazumi](https://github.com/Predidit/Kazumi) 的「规则驱动」思路启发做的**影视聚合客户端**，聚焦欧美电影剧集与国产经典高分片库，画质优先级贯穿全链路。

DeepMV = **规则引擎 + 多源聚合 + 真实画质探测 + 本地超分播放器**。
它不像普通采集壳那样只在某个站点里搜，而是把同一部片在所有片源里横向比一遍，**只信 HLS 清单里的 `RESOLUTION`，不信站点自报的「HD / 超清 / 蓝光」标签**，最后把能播且分辨率最高的那条线路交给你。

---

## 从 Kazumi 学到的东西

| Kazumi 的做法 | DeepMV 的对应实现 |
| --- | --- |
| 一条规则最多五行 XPath，只支持 `//` 开头的选择器 | `server/src/xpath.ts`：自实现精简 XPath 引擎，支持 `//` `@attr` `text()` `[n]` `[@a]` `[@a='v']` `[contains(@a,'v')]` `[starts-with]` `[not(...)]` |
| 规则分 XPath 规则 / API 规则，可混搭 | `server/src/adapters/`：`maccms`（苹果 CMS JSON/XML 接口）、`xpath`（网页选择器）、`archive`（Internet Archive）三种适配器，一条规则可自由选择 |
| 规则仓库导入、剪贴板导入、分享链接 | `server/rules/presets.json` 内置片源 + `server/rules/custom/*.json` 目录热加载自定义规则 |
| 视频嗅探（把规则带到播放页，程序自己找媒体流） | `server/src/proxy.ts` 的 `sniffFromPage()`：正则 + JSON 字段扫描出 m3u8/mp4 直链 |
| Anime4K 实时超分 | `web/src/upscale.ts`：WebGL 片上高斯低通 + 高频回注 + S 曲线，三档（关 / 标准 / 强力） |
| Flutter 跨端 | 改成 **Node 服务 + 浏览器前端**，任何设备开浏览器就能用（含电视盒子） |

差异点：Kazumi 只求「能播」，DeepMV 多做了**分辨率真伪校验**和**跨源自动择优**，这正是「分辨率要最高最好」的实现方式。

---

## 功能

- **首页聚合**：欧美电影 / 欧美剧集 / 国产电影 / 国产剧集 / 高分 8.0+ / 国产经典 / 口碑国剧 / 欧美经典 / 口碑美剧 / 邵氏港片 / 纪录片，11 个分区；多源合并去重、同剧多季折叠，按豆瓣分（差 ≥0.3 才换位）→ 画质 → 多源覆盖度排序
- **全源搜索**：7 个源并行检索，同名条目自动合并，卡片角标显示「+N 源」
- **详情页真实探测**：进入详情自动探测每条线路首集的 HLS master playlist，读出 `RESOLUTION=1920x1080` 这类真实分辨率，不可用的线路直接标「不可用」
- **全源找最高画质**：一键把同一部片在所有源里跑一遍，返回能播且分辨率最高的那条
- **整源失效自动切换**：当前源全部线路 403/404 时，自动跳到其它源里最高的那条，不需要手动找
- **播放器**：hls.js + 原生 HLS 回退、10 秒快进快退、倍速、选集、线路切换、键盘快捷键（空格 / ←→ / N）
- **本地超分**：WebGL 实时处理，1080P 以下片源提升明显
- **精选片单**：国产经典（霸王别姬、活着、阳光灿烂的日子…）、国产剧高分经典（西游记 1986、红楼梦 1987、大明王朝 1566、走向共和…）、欧美影史名片、欧美口碑长剧；片单只存「片名 + 年份」，播放源多源实时解析并严格按年份对齐，永不失效
- **历史 / 收藏**：本地 localStorage

已修的画质相关细节：
- 采集站的「HD / 超清 / 蓝光」标签一律按 1080P 计，但**不会被当成结论**，最终以探测结果为准
- `/share/` 形式的分享页线路（ffzy 等站点）在解析阶段就丢掉，不再占用线路位
- 成人分区（伦理 / 里番 / 三级）在适配器层过滤，片库保持干净
- 搜索结果按纯片名匹配度打分（完全一致 100 / 前缀 80 / 包含 60），「奥本海默」不会再被「终结一切战争：奥本海默和原子弹」挤掉

---

## 已验证的事实（不是承诺）

| 检查 | 结果 |
| --- | --- |
| 首页 11 个分区 | 全部有数据，暖缓存响应 2~6 ms |
| `/api/best?q=奥本海默` | 3.7 s 内返回「魔都资源 1080P 1920×1080」，另带 1 条备选 |
| `/api/best?q=霸王别姬` | 返回「魔都资源 540P 1280×692」——站点自报 HD，实测只有 540P，正是这套探测要解决的 |
| 播放器 | `videoWidth=1920 videoHeight=1080`，`currentTime` 正常推进，时长 10996 s |
| 本地超分 | 切到「超分标准」后 canvas 1920×1080 接管画面，video 隐藏，画面正常输出 |
| `/api/proxy` | 200，m3u8 与分片均可走代理播放 |

## 平台矩阵

| 平台 | 产物 | 在哪做 | 命令 |
| --- | --- | --- | --- |
| Web | 静态包 / 直接跑服务 | 本地 | `pnpm build && pnpm start` |
| Docker | `ghcr.io/<你>/deepmv` | 本地或 CI | `docker compose up -d` |
| Windows | 便携 zip | 本地 / Actions | 解压双击 `start.cmd` |
| Linux | tar.gz + systemd unit | Actions（交叉编译） | 见 `deploy/systemd/` |
| Android | APK | 本地（JDK17+SDK）/ Actions | `gradlew assembleRelease` |
| iOS | IPA | **只能 GitHub Actions（macOS runner）** | 见 `docs/DEPLOY.md` |
| macOS | dmg | **只能 GitHub Actions（macOS runner）** | 同上 |

推一个 tag 就会自动构建并发布：

```bash
git tag v0.1.0 && git push origin v0.1.0
```

本地 vs 服务器 vs CI 的完整分工、Azure 免费额度怎么算、公网安全怎么做，全写在 **[docs/DEPLOY.md](docs/DEPLOY.md)**。

## 快速开始

```bash
# 1. 安装依赖（Node 18+ / pnpm）
pnpm install --config.strictDepBuilds=false

# 2. 开发模式（前端 7822 热更新，后端 7821）
pnpm dev

# 3. 生产模式：先构建再启动（单端口 7821 同时托管前端与 API）
pnpm build
pnpm start
```

打开 <http://127.0.0.1:7821>。

Windows 下双击 `start.cmd` 也行。

---

## 规则格式

和 Kazumi 一样，一条规则描述「怎么搜、怎么拿线路」。DeepMV 的扩展字段是 `adapter` 和 `categoryMap`。

```json
{
  "name": "某采集站",
  "version": "1.0",
  "type": "movie",
  "baseURL": "https://api.example.com",
  "adapter": "maccms",
  "bestQuality": "1080P",
  "categoryMap": {
    "westernMovie": ["6", "7", "8"],
    "westernTv": ["16"],
    "cnMovie": ["6", "11"],
    "cnTv": ["13"],
    "fourK": ["62"]
  }
}
```

XPath 规则（`adapter: "xpath"`）：

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

- `baseURL` 指向苹果 CMS 站点根时，自动拼 `/api.php/provide/vod/`
- 自定义规则放到 `server/rules/custom/`，重启或 POST `/api/sources/reload` 生效
- 选择器语义与 Kazumi 一致：`searchName` / `searchResult` 相对 `searchList` 节点取；`chapterResult` 相对 `chapterRoads` 节点取

---

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/sources` | 已加载规则列表 |
| POST | `/api/sources/reload` | 重载 `server/rules` |
| GET | `/api/home?refresh=1` | 首页分区（15 分钟缓存） |
| GET | `/api/search?q=` | 多源搜索 + 合并 |
| GET | `/api/detail/:source/:id` | 详情 + 线路 + 选集 |
| GET | `/api/best?q=&skip=` | **全源找能播的最高画质** |
| GET | `/api/best-road/:source/:id` | 单条目内各线路真实分辨率 |
| GET | `/api/probe?url=` | 探测单个 m3u8 的 RESOLUTION |
| GET | `/api/resolve?url=` | 直链直用 / 网页嗅探 |
| GET | `/api/proxy?u=` | HLS 代理（重写片段与密钥 URI，解决跨域与 Referer 校验） |
| GET | `/api/collections` / `/api/collections/:id` | 精选片单 |

`/api/best` 是核心：并行拉取同名条目在所有源的线路 → 并发探测每条首集 → 按真实高度排序，返回 `best` 与 `alternatives`。

---

## 目录

```
deepmv/
├── server/
│   ├── rules/
│   │   ├── presets.json        # 内置片源规则
│   │   └── custom/             # 自定义规则（Kazumi 格式可直接放进来）
│   └── src/
│       ├── index.ts            # Fastify 入口 + 全部路由
│       ├── xpath.ts            # 精简 XPath 引擎
│       ├── http.ts             # 抓取 / 缓存 / 苹果CMS XML 解析
│       ├── adapters/           # maccms / xpath / archive
│       ├── aggregate.ts        # 多源合并、相关性、超时控制
│       ├── curated.ts          # 首页分区
│       ├── collections.ts      # 精选片单定义
│       ├── picks.ts            # 片单解析（片名 → 可播源）
│       ├── resolve.ts          # 全源择优
│       ├── probe.ts            # HLS 分辨率探测
│       └── proxy.ts            # HLS 代理 + 网页嗅探
└── web/
    └── src/
        ├── pages/              # Home / Search / Detail / Player / Collections / Sources
        ├── components/Poster.tsx
        ├── upscale.ts          # WebGL 超分
        └── styles.css
```

---

## 说明

- 片源来自公开的采集接口，接口地址、可用性由第三方决定，随时可能失效；失效时换一条规则即可
- 不做破解、不去 DRM、不碰盗链鉴权，只做「把公开接口里已有的线路聚合好、把真实画质挑出来」
- 影视内容版权归各权利人所有，本项目仅供本地学习、接口联调与个人技术验证使用