// ============ 违禁词过滤模块 ============
// 词库可自行在数组里继续添加，命中即拦截

const BANNED_WORDS = [
  // 枪爆类
  "枪支", "买枪", "卖枪", "造枪", "弹药", "子弹", "手枪", "步枪", "霰弹枪",
  "炸药", "炸弹", "雷管", "引信", "制爆", "自制枪",
  // 毒品类
  "毒品", "吸毒", "冰毒", "海洛因", "大麻", "摇头丸", "k粉", "贩毒", "制毒", "溜冰",
  // 违法行为类
  "嫖娼", "卖淫", "赌博", "赌球", "赌钱", "洗钱", "行贿", "受贿",
  "邪教", "传销", "人口贩卖", "拐卖", "器官买卖", "军火",
  "黑客入侵", "病毒传播", "钓鱼网站",
];

// 谐音/变体映射：检测前先归一化，防绕过
const HOMOPHONE_MAP = {
  "木仓": "枪", "qiang": "枪", "火枪": "枪",
  "du品": "毒品", "d品": "毒品", "dp": "毒品", "毒 品": "毒品",
  "dama": "大麻", "叶子烟": "大麻",
  "du博": "赌博", "d博": "赌博", "白菜网": "赌博", "菠菜网": "赌博",
  "嫖 娼": "嫖娼", "piao娼": "嫖娼",
  " Hai洛因": "海洛因", "海洛因": "海洛因",
  "bing毒": "冰毒", "b毒": "冰毒",
};

function normalize(text) {
  let t = String(text).toLowerCase().replace(/\s+/g, "");
  for (const [k, v] of Object.entries(HOMOPHONE_MAP)) {
    t = t.split(k.toLowerCase()).join(v);
  }
  return t;
}

// 检测聊天内容，命中返回 { hit: true, word }
function checkContent(text) {
  const t = normalize(text);
  for (const w of BANNED_WORDS) {
    if (t.includes(w.toLowerCase())) return { hit: true, word: w };
  }
  return { hit: false };
}

// 用户名违禁检测（注册时用）
function checkUsername(name) {
  return checkContent(name);
}

module.exports = { checkContent, checkUsername, BANNED_WORDS };