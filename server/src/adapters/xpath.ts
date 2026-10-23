import { fetchText, loadHtml, stripHtml } from '../http.js';
import { selectNodes, selectValue } from '../xpath.js';
import { type Rule, type SearchItem, type DetailResult, type Road, parseQuality, maxQuality } from '../types.js';

/** Kazumi 风格 XPath 规则适配器：搜索 -> 详情页 -> 线路/剧集 */
function absolute(base: string, href: string | null): string {
  if (!href) return '';
  try { return new URL(href, base).toString(); } catch { return href; }
}

export async function search(rule: Rule, keyword: string, page = 1): Promise<SearchItem[]> {
  const tpl = rule.searchURL || '';
  const url = tpl
    .replace(/@keyword/g, encodeURIComponent(keyword))
    .replace(/@page/g, String(page))
    .replace(/\{keyword\}/g, encodeURIComponent(keyword));
  const html = await fetchText(url, { referer: rule.referer || rule.baseUrl, userAgent: rule.userAgent, headers: rule.headers });
  const doc = loadHtml(html);
  const listPath = rule.searchList || '//a[@href]';
  const items = selectNodes(doc, listPath);
  const out: SearchItem[] = [];
  for (const node of items) {
    const title = selectValue(node, rule.searchName || './@title') || selectValue(node, './/text()') || '';
    const href = selectValue(node, rule.searchResult || './@href') || '';
    if (!title || !href) continue;
    const quality = parseQuality(title);
    out.push({
      source: rule.id,
      sourceName: rule.name,
      id: absolute(rule.baseUrl, href),
      title: title.replace(/\s+/g, ' ').trim(),
      url: absolute(rule.baseUrl, href),
      quality,
    });
  }
  return out;
}

export async function detail(rule: Rule, id: string): Promise<DetailResult | null> {
  const url = /^https?:/.test(id) ? id : absolute(rule.baseUrl, id);
  const html = await fetchText(url, { referer: rule.referer || rule.baseUrl, userAgent: rule.userAgent, headers: rule.headers });
  const doc = loadHtml(html);
  const title = selectValue(doc, rule.searchName || '//title') || doc.title || '';
  const roads: Road[] = [];
  const roadNodes = selectNodes(doc, rule.chapterRoads || '//div[contains(@class,"play")]');
  roadNodes.forEach((road, index) => {
    const episodes: any[] = [];
    const eps = selectNodes(road, rule.chapterResult || './/a[@href]');
    for (const ep of eps) {
      const name = (ep.textContent || '').trim() || '第' + (episodes.length + 1) + '集';
      const href = absolute(url, ep.getAttribute('href'));
      if (!href) continue;
      episodes.push({ name, url: href, quality: parseQuality(name, href) });
    }
    if (episodes.length) {
      roads.push({ name: '线路' + (index + 1), episodes, bestQuality: maxQuality(episodes.map((e: any) => e.quality)) });
    }
  });
  return {
    source: rule.id,
    sourceName: rule.name,
    id,
    title: stripHtml(title),
    intro: stripHtml(selectValue(doc, '//div[contains(@class,"desc")]') || ''),
    roads: roads.sort((a, b) => b.bestQuality.height - a.bestQuality.height),
  };
}
