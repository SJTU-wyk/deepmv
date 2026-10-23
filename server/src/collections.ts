/**
 * 精选片单：人工整理的「国产经典高分 / 欧美影史名片 / 高分剧集」。
 * 片单只存片名，播放来源由多源搜索实时解析，因此片单不会失效，也不绑定任何单一站点。
 */
export interface Collection {
  id: string;
  title: string;
  subtitle: string;
  cover: string;
  titles: { title: string; year?: string; note?: string }[];
}

export const COLLECTIONS: Collection[] = [
  {
    id: 'cn-classic',
    title: '国产经典 · 修复级',
    subtitle: '1990s 前后华语影史名片，按片名全源检索',
    cover: 'https://img.lzipic.com/upload/vod/20220608-1/28e41749b083538baee4e67893f039b4.jpg',
    titles: [
      { title: '霸王别姬', year: '1993' }, { title: '活着', year: '1994' }, { title: '阳光灿烂的日子', year: '1994' },
      { title: '大红灯笼高高挂', year: '1991' }, { title: '黄土地', year: '1984' }, { title: '芙蓉镇', year: '1987' },
      { title: '英雄本色', year: '1986' }, { title: '无间道', year: '2002' }, { title: '花样年华', year: '2000' },
      { title: '重庆森林', year: '1994' }, { title: '春光乍泄', year: '1997' }, { title: '阿飞正传', year: '1990' },
      { title: '大话西游之大圣娶亲', year: '1995' }, { title: '东邪西毒', year: '1994' }, { title: '倩女幽魂', year: '1987' },
      { title: '少林寺', year: '1982' }, { title: '城南旧事', year: '1983' }, { title: '牧马人', year: '1982' },
      { title: '高山下的花环', year: '1984' }, { title: '天云山传奇', year: '1981' }, { title: '黑炮事件', year: '1986' },
      { title: '孩子王', year: '1987' }, { title: '盗马贼', year: '1986' }, { title: '一一', year: '2000' },
    ],
  },
  {
    id: 'cn-tv-classic',
    title: '国产剧 · 高分经典',
    subtitle: '四大名著 / 年代剧 / 封神级国剧',
    cover: 'https://img.lzipic.com/upload/vod/20220608-1/28e41749b083538baee4e67893f039b4.jpg',
    titles: [
      { title: '西游记', year: '1986' }, { title: '红楼梦', year: '1987' }, { title: '三国演义', year: '1994' },
      { title: '水浒传', year: '1998' }, { title: '走向共和', year: '2003' }, { title: '大明王朝1566', year: '2007' },
      { title: '雍正王朝', year: '1999' }, { title: '康熙王朝', year: '2001' }, { title: '亮剑', year: '2005' },
      { title: '士兵突击', year: '2006' }, { title: '我的团长我的团', year: '2009' }, { title: '潜伏', year: '2009' },
      { title: '武林外传', year: '2006' }, { title: '我爱我家', year: '1993' }, { title: '编辑部的故事', year: '1992' },
      { title: '漫长的季节', year: '2023' }, { title: '父母爱情', year: '2014' }, { title: '闯关东', year: '2008' },
      { title: '大宅门', year: '2001' }, { title: '琅琊榜', year: '2015' }, { title: '甄嬛传', year: '2011' },
      { title: '天道', year: '2008' }, { title: '走向光明' }, { title: '人间正道是沧桑', year: '2009' },
    ],
  },
  {
    id: 'western-classic',
    title: '欧美影史名片',
    subtitle: '好莱坞黄金时代到当代作者电影',
    cover: 'https://ry-pic.com/upload/vod/20240815-1/a509f53eaa51296a5395a4a9ddfc3c43.jpg',
    titles: [
      { title: '教父' }, { title: '教父2' }, { title: '肖申克的救赎' }, { title: '低俗小说' }, { title: '阿甘正传' },
      { title: '辛德勒的名单' }, { title: '现代启示录' }, { title: '2001太空漫游' }, { title: '银翼杀手' },
      { title: '盗梦空间' }, { title: '星际穿越' }, { title: '黑暗骑士' }, { title: '搏击俱乐部' }, { title: '美国往事' },
      { title: '好家伙' }, { title: '出租车司机' }, { title: '愤怒的公牛' }, { title: '闪灵' }, { title: '发条橙' },
      { title: '七宗罪' }, { title: '沉默的羔羊' }, { title: '记忆碎片' }, { title: '禁闭岛' }, { title: '荒野猎人' },
    ],
  },
  {
    id: 'western-tv-classic',
    title: '欧美剧 · 口碑长剧',
    subtitle: 'HBO / AMC / Netflix 高分剧集',
    cover: 'https://fffgood.com/upload/vod/20230207-1/fba27ae445a83f90c4bc6156f93b6c8d.jpg',
    titles: [
      { title: '绝命毒师' }, { title: '风骚律师' }, { title: '权力的游戏' }, { title: '黑道家族' }, { title: '火线' },
      { title: '切尔诺贝利' }, { title: '真探' }, { title: '西部世界' }, { title: '纸牌屋' }, { title: '毒枭' },
      { title: '越狱' }, { title: '老友记' }, { title: '生活大爆炸' }, { title: '摩登家庭' }, { title: '怪奇物语' },
      { title: '王冠' }, { title: '唐顿庄园' }, { title: '神探夏洛克' }, { title: '黑镜' }, { title: '硅谷' },
    ],
  },
];

export function getCollection(id: string): Collection | undefined {
  return COLLECTIONS.find((c) => c.id === id);
}