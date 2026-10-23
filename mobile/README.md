# 移动端打包（Android / iOS）

DeepMV 的主体是 Web 应用，装成 App 有两条路。这里给的是 **WebView 壳**：把现有站点原样装进原生外壳，代码零改动，播放走系统解码器。

## 为什么不用 Flutter 重写

Kazumi 用 Flutter 是因为它要从零做播放器、弹幕、一起看这些重活。DeepMV 的播放全部交给 hls.js + 浏览器 H.264 硬解，重写成 Flutter 只会把已经跑通的 11 个页面再实现一遍。WebView 壳的代价是动画略钝、后台可能暂停；收益是**改一次代码，五个平台同时更新**。

## Android

```bash
cd mobile/android
# 改 app/build.gradle 里的 SERVER_URL 指向你的站点
gradlew assembleRelease        # 需要本机装 JDK 17 + Android SDK
```

- 输出：`app/build/outputs/apk/release/app-release-unsigned.apk`
- 签名：`keytool -genkey -v -keystore deepmv.jks -alias deepmv -keyalg RSA -keysize 2048 -validity 10000`
- `applicationId` 建议反向域名，例如 `app.deepmv.client`
- 最低 API 24（Android 7.0），覆盖 99% 在用设备

## iOS

iOS 必须用 macOS + Xcode 打包，**这是唯一无法在本地 Windows 上完成的平台**。

- 没有 Mac：用 GitHub Actions 的 `macos-latest` runner（私有仓库免费额度 2000 分钟/月）
- 自签名装真机需要 Apple 开发者账号（免费账号 7 天有效期，付费 99 美元/年）
- 或者：直接用 Safari「添加到主屏幕」，PWA 模式体验接近原生，但无法上 App Store

## 都只想要网页版

那就什么都不用做。手机浏览器打开站点，点「添加到主屏幕」即可。
