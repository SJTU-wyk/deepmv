# 部署到微软云（Azure）

从一台空的 Azure 虚拟机到别人能打开你的网址，全程约 15 分钟。

## 一、先弄清楚你的免费额度

Azure 不同渠道的额度不一样（学生订阅 / 新用户 12 个月 / 即用即付），**先去这三处把数字抄下来**：

```
Portal → 虚拟机 → 概述            看机型（B1s / B2ats_v2 这类）
Portal → 成本管理 + 计费 → 成本分析   看出站流量用了多少
Portal → 订阅 → 用量 + 配额         看剩余额度
```

公开文档长期写的是「12 个月内每月 750 小时 B1s + 100 GB 出站」，但这不是承诺，以你订阅页面显示的为准。

**750 小时是什么概念**：一个月 730 小时，所以一台机器 7×24 开着刚好不超。

**100 GB 出站是真正的约束**。一部 1080P 电影 2 到 4 GB，如果观众的每一帧视频都从你的服务器过一遍，二十几部就把整月额度吃光。所以 DeepMV 在公网模式下默认关掉视频代理（`ALLOW_PROXY=0`），服务器只返回几十 KB 的 JSON，视频由观众自己的设备直连片源 CDN。这是让免费机器能撑住的关键。

## 二、建虚拟机

Portal → 虚拟机 → 创建 → Azure 虚拟机。

| 项目 | 填什么 |
| --- | --- |
| 映像 | Ubuntu Server 24.04 LTS（或 22.04） |
| 大小 | **B1s**（1 核 1G，免费档机型）或 B2ats_v2（更宽裕） |
| 身份验证 | SSH 公钥。没有的话本地跑 `ssh-keygen -t ed25519`，把 `~/.ssh/id_ed25519.pub` 内容粘进去 |
| 用户名 | 随便，比如 `azureuser` |
| 入站端口 | 勾选 **SSH(22)、HTTP(80)、HTTPS(443)** |
| 磁盘 | 默认就行，标准 SSD 32G 够用 |

**自动关闭要在两个地方确认**：

1. 创建向导的「管理」标签页 → 自动关闭 → **取消勾选**
2. 建好之后进「操作」→ 自动关闭 → 确认状态是「关闭」

没关的话机器每天到点自己停机，别人访问就是 502。

## 三、域名（可选但强烈建议）

没有域名只能用 IP 加自签证书，浏览器会弹「不安全」的警告，很多人看到就走了。

1. 买一个域名（阿里云、腾讯云、Namecheap 都行，几十块一年）
2. 加一条 A 记录：`mv.你的域名.com` → 虚拟机的公网 IP
3. 等几分钟，`ping mv.你的域名.com` 能通就行

Azure 的 IP 默认是动态的，重启后可能变。想让 IP 固定，进「网络 → 公共 IP 地址 → 配置」，把分配方式改成**静态**。

## 四、连上去装

在自己电脑的终端里：

```bash
ssh azureuser@你的公网IP
```

连上之后，一条命令装完：

```bash
# 有域名
curl -fsSL https://raw.githubusercontent.com/SJTU-wyk/deepmv/master/deploy/install.sh -o install.sh
sudo bash install.sh --domain mv.你的域名.com --email 你的邮箱@example.com

# 没域名，先用 IP 跑通
sudo bash install.sh
```

脚本会依次做完：装 Node 20 → 拉代码 → 构建前端 → 注册 systemd 服务 → 装健康检查看门狗 → 限制日志占用 → 装 Caddy 反向代理 → 申请 HTTPS 证书 → 配防火墙。

跑完最后一屏会打印：

```
===============================================
  部署完成
===============================================
  访问地址： https://mv.你的域名.com
  访问口令： xxxxxxxxxxxxxxxxxxxxxxxx
===============================================
```

**把访问口令记下来**，分享给朋友时要一起给。

### 如果脚本报错

先把输出整段发我。几个常见情况：

| 现象 | 原因 |
| --- | --- |
| `apt-get` 卡住不动 | Azure 默认源慢，换个国内镜像源再跑 |
| Caddy 起不来 | 80/443 没放行，或者域名还没解析到这台机器 |
| 证书申请失败 | 域名解析没生效，等 10 分钟再 `systemctl restart caddy` |
| 页面能开但搜索没结果 | 片源被墙或对方站点挂了，正常现象，换个源 |

## 五、确认 24 小时在跑

装完的四层保活：

| 层 | 做什么 | 怎么验证 |
| --- | --- | --- |
| systemd `Restart=always` | 进程崩了自动拉起 | `systemctl status deepmv` 看是否 active |
| systemd `enable` | 机器重启后自动启动 | `systemctl is-enabled deepmv` |
| 看门狗 timer | 每 5 分钟敲一次健康检查，连续 3 次失败重启。处理「进程活着但卡死」 | `systemctl list-timers deepmv*` |
| journald 限额 | 日志最多占 200M，防止磁盘写满 | `df -h` 看使用率 |

一条命令看全部：

```bash
systemctl status deepmv --no-pager | head -8
systemctl list-timers 'deepmv*' --no-pager
curl -s localhost:7821/api/health
df -h /
```

### 想再稳一点

**Azure 的「引导诊断」开着不管用**，日志在 Portal 上看。真要排查时进「帮助 → 引导诊断」。

**加个免费的可用性监控**：UptimeRobot 或 BetterStack 都提供免费额度，每 5 分钟 curl 一次 `https://你的域名/api/health`，挂了发邮件。这比自己盯着省事。注意 `/api/health` 是公网模式下唯一不需要口令的接口，专门留给监控用的。

**内存不够会被 OOM 杀掉**。B1s 只有 1G，系统加 Caddy 大概占 300M，服务本身限制在 800M。如果真的频繁重启，先 `free -m` 看剩余，再考虑换 B2ats_v2。

## 六、日常维护

### 更新代码

```bash
cd /opt/deepmv
sudo git pull
sudo bash deploy/install.sh --domain mv.你的域名.com --email 你的邮箱@example.com
```

重复跑是安全的，脚本会跳过已装的依赖，只重新构建和重启。注意第二次跑会**重新生成访问口令**，想保留就把 `/etc/deepmv.env` 里的 `DEEPMV_KEY` 先抄下来，跑完再改回去。

### 改配置

```bash
sudo nano /etc/deepmv.env
```

常用项：

```bash
DEEPMV_KEY=你的口令          # 清空 = 任何人可访问
DEEPMV_RATE=90              # 每 IP 每分钟请求上限
ALLOW_PROXY=0               # 公网保持 0，原因见第一节
DEEPMV_CORS=               # 留空 = 允许所有来源；设了就只允许列出的
```

改完 `sudo systemctl restart deepmv`。

### 看日志

```bash
journalctl -u deepmv -f              # 服务日志
journalctl -u deepmv-watchdog -n 20  # 看门狗最近的动作
journalctl -u caddy -n 20            # 反向代理
```

### 磁盘满了

```bash
sudo journalctl --vacuum-size=100M   # 清日志
du -sh /opt/deepmv/server/data       # 海报缓存，可以整个删掉，会自动重建
```

海报缓存上限默认 300M，改 `/etc/deepmv.env` 里的 `DEEPMV_IMG_CACHE_MB`。

## 七、给别人用之前想一下

**流量**：关掉视频代理后，一次访问大约几十 KB。100 GB 出站够几百万人次，正常分享不用担心。但如果有人反复刷首页（每次 11 个分区的聚合请求），会消耗服务器 CPU 和上游的采集接口。`DEEPMV_RATE=90` 是每 IP 每分钟的上限，觉得被刷就调低。

**口令**：不设 `DEEPMV_KEY` 就是完全公开，搜索引擎爬到就有一堆陌生人用。想小范围分享就设一个，给谁的链接带上 `?key=你的口令`，前端会把口令存在浏览器里。

**合法性**：这个项目只做接口聚合和画质甄别，不做破解、不去 DRM、不碰盗链鉴权。片源来自公开的采集接口，接口由第三方维护。影视内容版权归各权利人所有，公开分享前请自行判断当地的适用规定。
