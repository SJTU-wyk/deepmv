# 自定义规则

把 Kazumi 格式的 JSON 规则放进这个目录即可热加载（重启服务生效）。

最小示例：

```json
{
  "name": "示例站点",
  "version": "1.0",
  "type": "movie",
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

- `adapter`: `maccms`（苹果CMS JSON/XML 接口）、`xpath`（网页选择器）、`archive`（Internet Archive）
- 选择器支持 Kazumi 常用子集：`//`、`@attr`、`text()`、`[n]`、`[@a]`、`[@a='v']`、`[contains(@a,'v')]`、`[not(...)]`
- `baseURL` 指向苹果CMS 站点根时，自动拼 `/api.php/provide/vod/`
