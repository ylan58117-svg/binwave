'use strict';

/* ==========================================================================
   ai.js — 库内语义检索（本地规则）+ 给外部 Agent 的提示词与回包解析

   设计目标：声音设计师用中文描述一个还不存在的声音（"硬底鞋在瓷砖走廊慢走"），
   库里的素材名却基本是英文（UCS 命名，如 FOLEY_Footsteps_Tile_Slow_01.wav）。
   所以这里做两件事：

   1. 本地本体匹配：中文概念 -> 英文词根 -> 素材名/分类/标签/路径的打分。
      不联网、不要 key 也能用，结果是"候选排序 + 为什么匹配"。
   2. 把本地召回的前 N 条交给外部 Agent（DeepSeek / 任意 OpenAI 兼容接口）
      重排并给理由；Agent 只能在候选里挑，避免它编出不存在的文件名。

   这个模块不碰 DOM，可以单独用 ELECTRON_RUN_AS_NODE 跑测试。
   ========================================================================== */

// ---------------------------------------------------------------------------
// 概念表
//
// zh: 用户可能打出来的中文片段（子串匹配）
// en: 素材名里的英文词根（按 token 前缀匹配，所以 "foot" 能命中 footsteps）
// w : 概念权重——越"具体"的给越高，泛词（氛围、紧张）给低，免得它们吃掉排序
// ---------------------------------------------------------------------------
export const CONCEPTS = [
  // ---- 恐怖 / 氛围 ----
  { id: 'horror', label: '恐怖/诡异', w: 1.5,
    zh: ['恐怖', '诡异', '阴森', '惊悚', '幽灵', '鬼', '灵异', '不祥', '邪门', '悬疑', '毛骨悚然', '压迫'],
    en: ['horror', 'eerie', 'creepy', 'sinister', 'ghost', 'haunt', 'demon', 'dread', 'unsettl', 'scare', 'sting', 'ritual', 'occult', 'spectral', 'nightmare', 'sinister'] },
  { id: 'tension', label: '紧张/悬念', w: 0.9,
    zh: ['紧张', '悬念', '危机', '不安'],
    en: ['tension', 'tense', 'suspense', 'thrill', 'rising', 'ominous'] },
  { id: 'waterphone', label: '水琴/弓弦金属', w: 1.8,
    zh: ['水琴', '弓弦', '金属摩擦', '钢片', '玻璃琴', '歌唱碗'],
    en: ['waterphone', 'bowed', 'bow', 'singing', 'harmonica', 'scrape', 'friction'] },
  { id: 'whisper', label: '低语/耳语', w: 1.2,
    zh: ['低语', '耳语', '窃窃私语', '呢喃'],
    en: ['whisper', 'murmur', 'chant'] },
  { id: 'drone', label: '持续低频/嗡鸣', w: 1.0,
    zh: ['持续低频', '低频', '嗡鸣', '持续音', '底噪'],
    en: ['drone', 'hum', 'rumble', 'sub', 'low'] },

  // ---- 具体动作 / 拟音 ----
  { id: 'knock', label: '敲门/叩击', w: 1.7,
    zh: ['敲门', '叩', '敲打', '拍门', '敲击'],
    en: ['knock', 'rap', 'tap', 'thump'] },
  { id: 'door', label: '门/吱呀', w: 1.3,
    zh: ['门', '吱呀', '合页', '门框'],
    en: ['door', 'creak', 'hinge', 'slam', 'gate'] },
  { id: 'drop', label: '掉落/坠落', w: 1.6,
    zh: ['掉落', '落下', '坠落', '跌落', '倒塌', '倒地'],
    en: ['drop', 'fall', 'fell', 'tumble', 'collapse', 'topple', 'slump'] },
  { id: 'smash', label: '摔碎/破碎', w: 1.8,
    zh: ['摔碎', '破碎', '碎裂', '玻璃碎', '砸', '爆裂', '分崩'],
    en: ['smash', 'shatter', 'break', 'debris', 'crash', 'broken', 'fracture', 'shard'] },
  { id: 'footstep', label: '脚步', w: 1.9,
    zh: ['脚步', '走路', '步行', '鞋', '靴', '踏步', '足音', '慢走', '行走'],
    en: ['footstep', 'foot', 'step', 'walk', 'heel', 'shoe', 'boot', 'stomp', 'sneaker'] },
  { id: 'tile', label: '瓷砖/硬质地面', w: 1.5,
    zh: ['瓷砖', '地砖', '陶瓷', '大理石', '水泥', '混凝土', '石板', '油毡', '硬地'],
    en: ['tile', 'tiled', 'ceramic', 'marble', 'concrete', 'linoleum', 'hard'] },
  { id: 'corridor', label: '走廊/通道', w: 1.4,
    zh: ['走廊', '过道', '通道', '楼道', '楼梯间', '巷道', '狭长', '狭窄'],
    en: ['corridor', 'hallway', 'hall', 'passage', 'stairwell', 'alley', 'narrow'] },
  { id: 'room', label: '房间/室内', w: 0.8,
    zh: ['房间', '室内', '屋子'],
    en: ['room', 'interior', 'indoor', 'apartment'] },

  // ---- 空间 / 混响（用户需求里最常见的约束）----
  { id: 'reverb', label: '混响/尾音', w: 1.6,
    zh: ['混响', '回响', '回声', '尾音', '残响', '空间感'],
    en: ['reverb', 'reverber', 'echo', 'tail', 'reflection', 'wet', 'cavern'] },
  { id: 'early', label: '早期反射', w: 1.5,
    zh: ['早期反射', '早期', '直达声', '反射'],
    en: ['early', 'reflection', 'slap', 'direct'] },
  { id: 'dry', label: '干声/近距', w: 1.3,
    zh: ['干声', '干净', '近距离', '贴耳', '近场', '无混响'],
    en: ['dry', 'close', 'near', 'intimate', 'tight'] },
  { id: 'distant', label: '远处/远场', w: 1.1,
    zh: ['远处', '遥远', '远场', '远方'],
    en: ['distant', 'far', 'depth', 'recede'] },

  // ---- 材质 ----
  { id: 'metal', label: '金属', w: 1.2,
    zh: ['金属', '铁', '钢', '铜', '铝', '铃'],
    en: ['metal', 'metallic', 'steel', 'iron', 'brass', 'copper', 'bell', 'anvil'] },
  { id: 'wood', label: '木头', w: 1.2,
    zh: ['木头', '木质', '木箱', '木门'],
    en: ['wood', 'wooden', 'timber', 'plank', 'log'] },
  { id: 'glass', label: '玻璃', w: 1.3,
    zh: ['玻璃', '酒杯', '灯泡'],
    en: ['glass', 'bottle', 'bulb', 'window'] },
  { id: 'plastic', label: '塑料/合成', w: 1.0,
    zh: ['塑料', '合成材料'],
    en: ['plastic', 'synthetic', 'pvc'] },
  { id: 'stone', label: '石头/沙砾', w: 1.2,
    zh: ['石头', '岩石', '碎石', '沙砾', '土'],
    en: ['stone', 'rock', 'gravel', 'rubble', 'sand', 'dirt', 'soil', 'pebble'] },
  { id: 'fabric', label: '布料/皮革', w: 1.0,
    zh: ['布', '织物', '衣服', '丝绸', '皮革'],
    en: ['cloth', 'fabric', 'textile', 'silk', 'leather', 'denim'] },
  { id: 'water', label: '水', w: 1.2,
    zh: ['水', '水声', '水滴', '浪', '溅', '潮'],
    en: ['water', 'liquid', 'splash', 'drip', 'wave', 'pour', 'bubble'] },
  { id: 'fire', label: '火', w: 1.1,
    zh: ['火', '火焰', '燃烧', '篝火'],
    en: ['fire', 'flame', 'burn', 'ember', 'torch'] },
  { id: 'wind', label: '风', w: 1.1,
    zh: ['风', '风声', '阵风', '呼啸'],
    en: ['wind', 'gust', 'breeze', 'howl', 'whistle'] },
  { id: 'rain', label: '雨', w: 1.1,
    zh: ['雨', '暴雨'],
    en: ['rain', 'downpour', 'drizzle', 'storm'] },
  { id: 'thunder', label: '雷', w: 1.2,
    zh: ['雷', '打雷'],
    en: ['thunder', 'lightning'] },
  { id: 'snow', label: '雪/冰', w: 1.0,
    zh: ['雪', '冰'],
    en: ['snow', 'ice', 'frost'] },

  // ---- 生物 ----
  { id: 'animal', label: '动物', w: 1.1,
    zh: ['动物', '狗', '猫', '鸟', '马', '牛', '虫', '狼', '乌鸦', '鼠'],
    en: ['animal', 'dog', 'cat', 'bird', 'horse', 'crow', 'wolf', 'insect', 'rat', 'cow'] },
  { id: 'human', label: '人声', w: 1.1,
    zh: ['人声', '人群', '说话', '笑', '尖叫', '喘', '呼吸', '喊'],
    en: ['human', 'voice', 'crowd', 'people', 'laugh', 'scream', 'breath', 'shout', 'grunt'] },
  { id: 'creature', label: '怪物/巨兽', w: 1.3,
    zh: ['怪物', '巨兽', '野兽', '嘶吼'],
    en: ['creature', 'monster', 'beast', 'growl', 'roar', 'snarl'] },
  { id: 'child', label: '小孩', w: 1.0,
    zh: ['小孩', '儿童', '婴儿', '童声'],
    en: ['child', 'kid', 'baby', 'children'] },

  // ---- 机械 / 电子 ----
  { id: 'machine', label: '机械', w: 1.2,
    zh: ['机械', '机器', '引擎', '马达', '电机', '伺服', '液压', '机器人', '齿轮'],
    en: ['machine', 'engine', 'motor', 'servo', 'hydraulic', 'robot', 'gear', 'mech', 'piston'] },
  { id: 'electric', label: '电子/电流', w: 1.1,
    zh: ['电子', '电流', '电', '电流声', '嗡'],
    en: ['electric', 'electro', 'buzz', 'hum', 'static', 'glitch', 'zap'] },
  { id: 'weapon', label: '武器/爆炸', w: 1.3,
    zh: ['枪', '武器', '刀', '剑', '弓', '爆炸', '炮'],
    en: ['gun', 'weapon', 'sword', 'knife', 'explosion', 'blast', 'shot', 'rifle', 'cannon'] },
  { id: 'impact', label: '撞击/重击', w: 1.4,
    zh: ['撞击', '冲击', '重击', '锤', '猛击'],
    en: ['impact', 'hit', 'strike', 'punch', 'hammer', 'slam', 'thud'] },
  { id: 'friction', label: '摩擦/刮擦', w: 1.2,
    zh: ['摩擦', '刮', '蹭', '拖'],
    en: ['friction', 'scrape', 'scrub', 'rub', 'drag', 'slide'] },

  // ---- 转场 / UI ----
  { id: 'whoosh', label: '呼啸/转场', w: 1.2,
    zh: ['呼啸', '转场', '掠过', '风切', '过渡'],
    en: ['whoosh', 'swoosh', 'swish', 'transition', 'riser', 'passby', 'flyby'] },
  { id: 'ui', label: '界面音', w: 1.0,
    zh: ['界面', '提示音', '点击', '按钮', '通知'],
    en: ['ui', 'interface', 'click', 'beep', 'notification', 'button', 'menu', 'error'] },
  { id: 'alarm', label: '警报', w: 1.2,
    zh: ['警报', '警笛', '报警'],
    en: ['alarm', 'siren', 'warning', 'alert', 'klaxon'] },
  { id: 'phone', label: '电话/铃', w: 1.0,
    zh: ['电话', '手机', '铃响'],
    en: ['phone', 'telephone', 'ring', 'ringtone'] },
  { id: 'clock', label: '钟表/滴答', w: 1.0,
    zh: ['钟', '表', '滴答'],
    en: ['clock', 'tick', 'tock', 'alarm', 'watch'] },

  // ---- 音色 / 音乐 ----
  { id: 'scifi', label: '科幻', w: 1.2,
    zh: ['科幻', '未来', '太空', '外星', '飞船', '激光'],
    en: ['sci-fi', 'scifi', 'space', 'alien', 'spaceship', 'laser', 'futuristic'] },
  { id: 'magic', label: '魔法', w: 1.1,
    zh: ['魔法', '法术', '施法', '奇幻'],
    en: ['magic', 'spell', 'arcane', 'fantasy', 'shimmer'] },
  { id: 'synth', label: '合成器/音调', w: 1.0,
    zh: ['合成', '音调', '和弦', '低音', '鼓点', '节拍'],
    en: ['synth', 'bass', 'pad', 'chord', 'beat', 'loop', 'arp'] },
  { id: 'music', label: '音乐/旋律', w: 1.0,
    zh: ['音乐', '旋律', '节奏'],
    en: ['music', 'melody', 'rhythm', 'tempo', 'score'] },
  { id: 'ambience', label: '环境氛围', w: 0.8,
    zh: ['环境', '氛围', '背景', '底噪', '场'],
    en: ['ambience', 'ambient', 'atmos', 'background', 'bed', 'tone'] },
  { id: 'old', label: '老旧/复古', w: 0.9,
    zh: ['老旧', '破旧', '复古', '年代感', '锈'],
    en: ['old', 'vintage', 'retro', 'antique', 'rusty', 'worn'] },
  { id: 'vehicle', label: '交通工具', w: 1.2,
    zh: ['车', '汽车', '摩托', '火车', '飞机', '船'],
    en: ['car', 'vehicle', 'motorcycle', 'train', 'plane', 'boat', 'truck', 'tire'] }
];

// 否定词：出现在概念前一小段里，就当成"要避开这个"
const NEG = ['不要', '不能', '没有', '不用', '无需', '避免', '别', '无', '去掉', '减去', '不'];

// 字段权重：名字最可信，标签和路径次之
const FIELD_W = [1.0, 0.7, 0.6, 0.35];
const FIELD_MAX = FIELD_W.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------
// 分词 / 文档
// ---------------------------------------------------------------------------
const TOKEN_RE = /[a-z0-9]+/g;

function tokensOf(text) {
  const out = new Set();
  const s = (text || '').toLowerCase();
  let m;
  while ((m = TOKEN_RE.exec(s))) {
    let t = m[0];
    if (t.length > 3) {
      if (t.endsWith('ies')) t = t.slice(0, -3) + 'y';
      else if (t.endsWith('es') && !t.endsWith('ses')) t = t.slice(0, -2);
      else if (t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
    }
    out.add(t);
  }
  return out;
}

function tagText(it) {
  const parts = [];
  const t = it.meta && it.meta.tags;
  if (t && typeof t === 'object') {
    for (const k of Object.keys(t)) {
      const v = t[k];
      if (typeof v === 'string' || typeof v === 'number') parts.push(String(v));
      else if (Array.isArray(v)) parts.push(v.join(' '));
    }
  }
  for (const g of (it.meta && it.meta.tagGroups) || []) {
    for (const row of g.rows || []) if (row[1]) parts.push(String(row[1]));
  }
  return parts.join(' ');
}

/** 一个条目的检索文档：保留原文（给中文子串用）和 token 集合（给英文词根用）。 */
function docFor(it) {
  if (it._aiDoc) return it._aiDoc;
  const ucs = it.ucs ? [it.ucs.category, it.ucs.sub, it.ucs.desc].filter(Boolean).join(' ') : '';
  const texts = [
    (it.name || '').replace(/\.[^.]+$/, ''),
    ucs,
    tagText(it),
    it.dir || ''
  ].map((s) => String(s).toLowerCase());
  const fields = texts.map((text, i) => ({ text, tokens: tokensOf(text), w: FIELD_W[i] }));
  const all = new Set();
  for (const f of fields) for (const t of f.tokens) all.add(t);
  it._aiDoc = { fields, all, blob: texts.join(' ') };
  return it._aiDoc;
}

/** 名字、分类等改过以后要重新生成文档。 */
export function invalidateDoc(it) {
  if (!it) return;
  delete it._aiDoc;
  delete it._aiFam;
}

// ---------------------------------------------------------------------------
// 查询解析
// ---------------------------------------------------------------------------
function isNegated(q, at) {
  const from = Math.max(0, at - 10);
  const before = q.slice(from, at);
  return NEG.some((n) => before.includes(n));
}

/**
 * 把一句中文/英文需求拆成"要什么"和"避开什么"。
 * 返回 { items: [{concept, neg, w}], literals: [英文词], labels: [...] }
 */
export function parseQuery(query) {
  const q = String(query || '').toLowerCase();
  const items = [];
  const seen = new Set();

  for (const c of CONCEPTS) {
    let at = -1;
    for (const z of c.zh) {
      const i = q.indexOf(z);
      if (i >= 0 && (at < 0 || i < at)) at = i;
    }
    for (const e of c.en) {
      const re = new RegExp('(^|[^a-z0-9])' + e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[a-z0-9]*', 'g');
      const m = re.exec(q);
      if (m) {
        const i = m.index + m[1].length;
        if (at < 0 || i < at) at = i;
      }
    }
    if (at < 0) continue;
    const key = c.id + (isNegated(q, at) ? '-neg' : '');
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ concept: c, neg: isNegated(q, at), w: c.w });
  }

  // 概念表里没有的英文词也要能命中（素材名里的专有词）
  const literals = [];
  const known = new Set();
  for (const c of CONCEPTS) for (const e of c.en) known.add(e);
  let m;
  const re = /[a-z0-9]{3,}/g;
  while ((m = re.exec(q))) {
    const t = m[0];
    if (known.has(t)) continue;
    if (NEG.some((n) => /[a-z]/.test(n) && q.slice(Math.max(0, m.index - 10), m.index).includes(n))) continue;
    if (!literals.includes(t)) literals.push(t);
  }

  return {
    items,
    literals,
    positive: items.filter((i) => !i.neg),
    negative: items.filter((i) => i.neg),
    labels: items.map((i) => (i.neg ? '避开 ' : '') + i.concept.label)
  };
}

// ---------------------------------------------------------------------------
// 打分
// ---------------------------------------------------------------------------
function conceptHit(concept, doc) {
  const hits = [];
  for (const f of doc.fields) {
    let hit = false;
    for (const z of concept.zh) if (f.text.includes(z)) { hit = true; break; }
    if (!hit) {
      for (const e of concept.en) {
        for (const t of f.tokens) {
          if (t === e || (e.length >= 3 && t.startsWith(e))) { hit = true; break; }
        }
        if (hit) break;
      }
    }
    if (hit) hits.push(f.w);
  }
  return hits;
}

/**
 * 在 items 里按需求打分排序。
 * @returns {{results: Array<{item, score, pct, reasons, hits}>, parsed, matched}}
 */
export function searchLibrary(items, query, opts = {}) {
  const limit = opts.limit || 80;
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 0.02;
  const extraTerms = (Array.isArray(opts.extraTerms) ? opts.extraTerms : [])
    .map((t) => String(t || '').trim())
    .filter(Boolean);
  const extraAvoid = (Array.isArray(opts.extraAvoid) ? opts.extraAvoid : [])
    .map((t) => String(t || '').trim())
    .filter(Boolean);
  const parsed = parseQuery(query);
  const pool = Array.isArray(items) ? items : [];
  if (!parsed.items.length && !parsed.literals.length && !extraTerms.length) {
    return { results: [], parsed, total: pool.length };
  }

  const posW = parsed.positive.reduce((s, i) => s + i.w, 0) || 1;
  const results = [];

  for (const it of pool) {
    const doc = docFor(it);
    let score = 0;
    const reasons = [];
    const hitIds = [];

    for (const entry of parsed.items) {
      const hits = conceptHit(entry.concept, doc);
      if (!hits.length) continue;
      const raw = hits.reduce((a, b) => a + b, 0) / FIELD_MAX;
      if (entry.neg) {
        score -= entry.w * 1.6 * raw;
      } else {
        score += entry.w * raw;
        reasons.push(entry.concept.label);
        hitIds.push(entry.concept.id);
      }
    }

    for (const lit of parsed.literals) {
      let best = 0;
      for (const f of doc.fields) {
        for (const t of f.tokens) {
          if (t === lit || t.startsWith(lit)) { best = Math.max(best, f.w); break; }
        }
      }
      if (best) {
        score += 0.5 * best;
        if (!reasons.length) reasons.push(lit);
      }
    }

    // Agent 扩出来的词只当「辅证」：权重压到原句概念命中的 45% 并封顶，
    // 作用是扩大召回（点名到词的也能捞上来），不是让它盖过原始需求。
    if (extraTerms.length) {
      let ex = 0;
      let firstHit = '';
      for (const term of extraTerms) {
        const w = termWeight(doc, term);
        if (!w) continue;
        ex += w;
        if (!firstHit) firstHit = term;
      }
      if (ex > 0) {
        score += Math.min(1.1, ex * 0.45);
        if (firstHit && !reasons.includes(firstHit)) reasons.push(firstHit);
      }
    }
    for (const term of extraAvoid) {
      if (termWeight(doc, term)) score -= 0.35;
    }

    if (score <= minScore) continue;
    // 归一化：正概念全中、且都在名字里时接近 1
    const norm = Math.min(1, score / (posW * 1.15));
    results.push({
      item: it,
      score: norm,
      pct: Math.round(norm * 100),
      reasons,
      hits: hitIds
    });
  }

  results.sort((a, b) => b.score - a.score || String(a.item.name).localeCompare(String(b.item.name)));
  return { results: results.slice(0, limit), parsed, total: pool.length };
}

/** 一个检索词在条目里的命中强度（0..1，按命中字段的权重取最大）。 */
function termWeight(doc, term) {
  const t = String(term || '').toLowerCase().trim();
  if (!t) return 0;
  const isLatin = /^[a-z0-9 .'&()-]+$/.test(t);
  let best = 0;
  if (isLatin) {
    const parts = t.split(/[^a-z0-9]+/).filter(Boolean);
    if (!parts.length) return 0;
    for (const f of doc.fields) {
      for (const tok of f.tokens) {
        if (parts.every((p) => tok.includes(p))) { best = Math.max(best, f.w); break; }
      }
    }
    return best;
  }
  for (const f of doc.fields) {
    if (f.text.includes(t)) best = Math.max(best, f.w);
  }
  return best;
}

// ---------------------------------------------------------------------------
// Agent（OpenAI 兼容 /chat/completions）
// ---------------------------------------------------------------------------

/** 给模型看的精简候选行：省 token，也让它只能在这几条里挑。 */
export function candidateRows(results, max = 60) {
  return results.slice(0, max).map((r) => {
    const it = r.item;
    const m = it.meta || {};
    const why = Array.isArray(r.reasons) && r.reasons.length ? r.reasons : r.reason ? [r.reason] : [];
    return [
      it.path,
      it.name,
      it.ucs ? [it.ucs.category, it.ucs.sub].filter(Boolean).join('/') : '',
      (it.ucs && it.ucs.desc) || '',
      Number.isFinite(m.duration) ? Math.round(m.duration * 10) / 10 : 0,
      m.sampleRate || 0,
      m.channels || 0,
      why.join(' ')
    ];
  });
}

export function buildAgentMessages(query, rows, opts = {}) {
  const target = opts.target ? `\n当前选中的素材：${opts.target}` : '';
  const system = [
    '你是影视/游戏声音设计的素材检索助手。',
    '用户给出一段中文需求，和一个候选素材数组。你只能从候选里挑，不许编造候选之外的条目。',
    '判断时要考虑：声音主体（什么在发声）、材质、动作方式、空间大小与混响、录音距离、情绪。',
    '如果用户明确说"不要/避免"某个特征，就不要推带这个特征的素材。',
    '只输出 JSON，不要解释、不要代码块，格式：',
    '{"picks":[{"id":"候选里第 0 个字段的完整路径","score":0-100,"reason":"一句中文理由"}],"note":"可选，一句话总结"}',
    '按符合度从高到低排序，最多 12 条；没有合适的就返回空数组。'
  ].join('\n');

  const legend = '字段顺序：[id, 名称, UCS分类, 描述, 时长秒, 采样率, 声道, 本地命中词]';
  const user = [
    '需求：' + query + target,
    legend,
    '候选 JSON：' + JSON.stringify(rows),
    '再提醒一次：id 必须是候选里出现的完整路径，只输出 JSON。'
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

/** 从模型的回包里抠出 picks，容忍 ```json 代码块、前后废话。 */
export function parseAgentReply(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return { picks: [], note: '', error: '模型没有返回 JSON' };
  let obj;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { picks: [], note: '', error: 'JSON 解析失败' };
  }
  const picks = Array.isArray(obj.picks) ? obj.picks : (Array.isArray(obj.results) ? obj.results : []);
  const clean = [];
  for (const p of picks) {
    if (!p) continue;
    const id = p.id || p.path || p.name;
    if (typeof id !== 'string' || !id) continue;
    const score = Number(p.score);
    clean.push({
      id,
      score: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 50,
      reason: typeof p.reason === 'string' ? p.reason : ''
    });
  }
  return { picks: clean, note: typeof obj.note === 'string' ? obj.note : '', error: '' };
}

/** 把 Agent 的 picks 映射回条目（允许模型返回相对宽松的 id）。 */
export function resolvePicks(picks, items) {
  const byPath = new Map();
  const byName = new Map();
  for (const it of items) {
    byPath.set(it.path, it);
    byPath.set(it.path.replace(/\\/g, '/'), it);
    byName.set(it.name, it);
  }
  const out = [];
  for (const p of picks) {
    const it = byPath.get(p.id) || byPath.get(p.id.replace(/\//g, '\\')) || byName.get(p.id) || byName.get(baseName(p.id));
    if (!it) continue;
    if (out.some((o) => o.item === it)) continue;
    out.push({ item: it, score: p.score / 100, pct: Math.round(p.score), reason: p.reason, agent: true });
  }
  return out;
}

function baseName(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i < 0 ? p : p.slice(i + 1);
}

// ---------------------------------------------------------------------------
// 连上 Agent 之后的两条路：
//   1) 扩词：模型把中文需求翻成检索词 → 本地对**整个库**重新打分（不再只看原句命中）
//   2) 全库扫描：把整库的名字分段发给模型逐段看（慢、费 token，但看得最全）
// ---------------------------------------------------------------------------

/** 第一步：让模型把需求拆成可以直接在素材名/分类里匹配的词。 */
export function buildExpandMessages(query) {
  const system = [
    '你是声音素材库的检索规划器。用户用中文描述他要的声音，你要把它拆成能直接在素材名/分类/描述里匹配的关键词。',
    '素材库以英文命名为主（例：VEHElec_Scooter-EXTERIOR Cornering Slow 01），也混有中文分类。',
    '要求：',
    '1) 按维度拆：声音主体 / 材质对象 / 动作方式 / 速度 / 空间与距离 / 混响与尾音。每个维度都要给词。',
    '2) 每个维度给英文词 2~4 个、中文词 1~2 个；同义词、近义词、上位词都列上。',
    '   例如「瓷砖」→ 瓷砖、地砖、tile、ceramic、porcelain；「硬底鞋」→ 硬底鞋、皮鞋、hardshoe、heel、hard sole。',
    '3) 用户说「不要/避免」的特征放进 avoid，不要放进 terms。',
    '4) 只写词或短语（1~3 个单词），不要整句。',
    '5) 另外给两类「范围提示」，用来在命名里没有这些词时也能召回：',
    '   where：这件事物通常出现在哪一类素材里（例：「狗叫」→ 动物、animal、creature、pet；「地铁」→ 交通、vehicle、train、station）。',
    '   keywords：最具体的对象名与拟声词（例：「狗叫」→ dog、犬、bark、howl、growl）。',
    '   这两个字段宁多勿少，但要具体；不要写「声音」「音效」这种空词。',
    '只输出 JSON，不要解释、不要代码块：',
    '{"terms":["..."],"avoid":["..."],"where":["..."],"keywords":["..."],"note":"一句话说你要找什么"}',
    'terms 最多 40 个，avoid 最多 10 个，where 最多 12 个，keywords 最多 16 个。'
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: '需求：' + String(query || '') + '\n只输出 JSON。' }
  ];
}

/** 抠出 {terms, avoid, note}，容忍代码块和前后废话。 */
export function parseExpandReply(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return { terms: [], avoid: [], note: '', error: '模型没有返回 JSON' };
  let obj;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { terms: [], avoid: [], note: '', error: 'JSON 解析失败' };
  }
  const clean = (v, max) =>
    (Array.isArray(v) ? v : [])
      .filter((t) => typeof t === 'string')
      .map((t) => t.trim())
      .filter((t) => t && t.length <= 40)
      .slice(0, max);
  return {
    terms: clean(obj.terms, 40),
    avoid: clean(obj.avoid, 10),
    // 范围提示：素材名里没出现这些词时，也能靠它们把候选捞回来（见 app.js 的 aiRecallByHints）
    where: clean(obj.where, 12),
    keywords: clean(obj.keywords, 16),
    note: typeof obj.note === 'string' ? obj.note : '',
    error: ''
  };
}

/**
 * 看图取声：把一张参考图（data URL）加上用户写的文字要求，一起交给视觉模型。
 * 要求模型先说清画面里会出现什么声音，再给能在英文命名素材库里匹配的词。
 */
export function buildImageMessages(query, dataUrl) {
  const system = [
    '你是影视/游戏的声音设计助手。用户给你一张参考图（可能还附带一句要求），你要判断这个画面里会出现什么声音。',
    '分三层想：① 环境层（空间、天气、远近、混响感、房间大小）；② 实体层（画面里能看到的物体、材质、动作，会发出什么拟音）；③ 细节层（画面看不到但该场景里很可能有的小声音，比如远处车流、钟表、风扇、窗帘）。',
    '然后把这些声音换成能在这类素材库里匹配的检索词。素材库以英文命名为主（例：AMB_Forest Birds Loop）、也混有中文分类。',
    '要求：',
    '1) sounds 写 4~8 条「可能会出现的声音」，每条 6~14 个汉字，具体到材质/动作/距离，不要写「环境音」这种空话。',
    '2) terms 写 12~30 个检索词，每条 1~3 个单词，中英都要（英文优先），覆盖上面的三层。',
    '3) 如果用户文字里说了「不要/避免」，那类词放进 avoid。',
    '4) 画面明显很安静（室内、清晨、自然）时，note 里写明偏安静，并避免爆炸/枪声/尖叫这类。',
    '只输出 JSON，不要解释、不要代码块：',
    '{"scene":"一句话说清这是什么场景","sounds":["..."],"terms":["..."],"avoid":["..."],"note":"一句话说明要找什么"}'
  ].join('\n');
  const ask = String(query || '').trim();
  const user = [
    {
      type: 'text',
      text: ask
        ? '用户的要求：' + ask + '\n结合这张图，按上面的要求只输出 JSON。'
        : '用户没写要求，你按画面自己判断该配什么声音，只输出 JSON。'
    },
    { type: 'image_url', image_url: { url: String(dataUrl || '') } }
  ];
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

/** 抠出 {scene, sounds, terms, avoid, note}，容忍代码块和前后废话。 */
export function parseImageReply(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { scene: '', sounds: [], terms: [], avoid: [], note: '', error: '模型没有返回 JSON' };
  }
  let obj;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { scene: '', sounds: [], terms: [], avoid: [], note: '', error: 'JSON 解析失败' };
  }
  const clean = (v, max, limit) =>
    (Array.isArray(v) ? v : [])
      .filter((t) => typeof t === 'string')
      .map((t) => t.trim())
      .filter((t) => t && t.length <= limit)
      .slice(0, max);
  return {
    scene: typeof obj.scene === 'string' ? obj.scene.trim().slice(0, 120) : '',
    sounds: clean(obj.sounds, 8, 40),
    terms: clean(obj.terms, 30, 40),
    avoid: clean(obj.avoid, 10, 40),
    note: typeof obj.note === 'string' ? obj.note.trim().slice(0, 120) : '',
    error: ''
  };
}

/** 扫描用的最省字符表示：[段内序号, 名字, 分类]。 */
function scanRow(it, idx) {
  const name = String(it.name || '').replace(/\.[^.]+$/, '').slice(0, 58);
  const cat = it.ucs ? [it.ucs.category, it.ucs.sub].filter(Boolean).join('/') : (it.dir || '');
  return [idx, name, String(cat).slice(0, 26)];
}

/** 第二步（可选）：把库里一段素材名发给模型，让它直接点名。 */
export function buildScanMessages(query, items, opts = {}) {
  const start = Math.max(0, Math.floor(opts.start || 0));
  const count = Math.max(1, Math.floor(opts.count || 1000));
  const pool = Array.isArray(items) ? items : [];
  const slice = pool.slice(start, start + count);
  const rows = slice.map((it, i) => scanRow(it, i));
  const system = [
    '你是影视/游戏声音设计的素材检索助手。',
    '用户给出一段需求，和素材库里连续的一段素材名单。你只能从这段名单里挑，不许编造。',
    '判断要考虑：声音主体、材质、动作方式、空间与混响、录音距离、情绪。',
    '名单只有名字和分类，没有试听；名字里带的信息（如 Hardshoe / Tile / Corridor / Slow）就是主要依据。',
    '用户说「不要/避免」的特征，就不要推带这个特征的素材。',
    '只输出 JSON，不要解释、不要代码块：',
    '{"picks":[{"i":段内序号,"s":0-100,"r":"一句中文理由"}],"note":"可选，一句话"}',
    '最多 20 条，按符合度从高到低；一条都不合适就返回 {"picks":[]}。'
  ].join('\n');
  const user = [
    '需求：' + String(query || ''),
    '这一段是素材库的第 ' + (start + 1) + '~' + (start + slice.length) + ' 条（全库共 ' + pool.length + ' 条）。',
    '字段顺序：[段内序号, 名称, 分类]',
    JSON.stringify(rows),
    '再提醒一次：i 必须是名单里出现过的段内序号，只输出 JSON。'
  ].join('\n');
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    start,
    count: slice.length
  };
}

/** 抠出扫描结果里的 picks（段内序号）。 */
export function parseScanReply(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return { picks: [], note: '', error: '模型没有返回 JSON' };
  let obj;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { picks: [], note: '', error: 'JSON 解析失败' };
  }
  const picks = Array.isArray(obj.picks) ? obj.picks : [];
  const clean = [];
  for (const p of picks) {
    if (!p) continue;
    const idx = Number(p.i);
    if (!Number.isFinite(idx)) continue;
    const score = Number(p.s ?? p.score);
    clean.push({
      i: Math.max(0, Math.floor(idx)),
      score: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 50,
      reason: typeof p.r === 'string' ? p.r : (typeof p.reason === 'string' ? p.reason : '')
    });
  }
  return { picks: clean, note: typeof obj.note === 'string' ? obj.note : '', error: '' };
}

// ---------------------------------------------------------------------------
// 声类（给「安静取向」的查询做前置过滤用）
// ---------------------------------------------------------------------------
// 每个声类是一组线索词：命中越多，说明这条素材越偏向这一族。
// intense 是「强冲突」：爆炸、重击、尖叫、警报、转场提示音；
// calm 是「安静/自然」：公园、草原、风、环境底噪、轻细节。
export const FAMILIES = [
  { id: 'explosion', label: '爆炸', kind: 'intense',
    zh: ['爆炸', '爆破', '爆裂', '炸药', '轰隆', '炮火', '轰鸣'],
    en: ['explosion', 'explode', 'blast', 'bomb', 'detonat', 'boom', 'braam', 'sub boom'] },
  { id: 'impact', label: '重击', kind: 'intense',
    zh: ['重击', '撞击', '冲击', '砸', '重物', '撞击声', '轰击'],
    en: ['impact', 'slam', 'smash', 'crash', 'thud', 'stomp', 'punch', 'hammer', 'hit hard'] },
  { id: 'scream', label: '尖叫', kind: 'intense',
    zh: ['尖叫', '嘶吼', '惊叫', '惨叫', '咆哮', '哀嚎', '叫喊'],
    en: ['scream', 'shriek', 'screech', 'yell', 'roar', 'snarl', 'cry'] },
  { id: 'stinger', label: '转场提示音', kind: 'intense',
    zh: ['转场', '预告', '片头', '提示音', '震撼', '冲击音'],
    en: ['trailer', 'stinger', 'riser', 'transition', 'whoosh hit', 'swoosh hit', 'cinematic hit'] },
  { id: 'alarm', label: '警报', kind: 'intense',
    zh: ['警报', '警笛', '报警', '防空', '紧急'],
    en: ['alarm', 'siren', 'klaxon', 'warning', 'emergency'] },
  { id: 'weapon', label: '武器', kind: 'intense',
    zh: ['枪声', '炮', '射击', '武器', '弹药', '榴弹'],
    en: ['gun', 'rifle', 'shotgun', 'cannon', 'artillery', 'grenade', 'weapon'] },
  { id: 'horrorhit', label: '惊吓点', kind: 'intense',
    zh: ['惊吓', '惊悚', '鬼叫', '嘶鸣', '阴森'],
    en: ['jumpscare', 'horror sting', 'scare hit', 'eerie hit', 'dissonant'] },
  { id: 'nature', label: '自然户外', kind: 'calm',
    zh: ['公园', '草原', '草地', '森林', '树林', '田野', '乡间', '海滩', '海边', '湖', '山', '自然', '户外', '清晨', '黄昏', '阳光', '微风', '鸟'],
    en: ['park', 'meadow', 'grass', 'field', 'forest', 'woodland', 'nature', 'outdoor', 'beach', 'shore', 'lake', 'mountain', 'breeze', 'bird', 'dawn', 'sunny', 'countryside'] },
  { id: 'ambient', label: '环境底噪', kind: 'calm',
    zh: ['环境', '氛围', '空气感', '底噪', '房间声', '空间声', '背景'],
    en: ['ambience', 'ambient', 'atmos', 'room tone', 'air', 'bed', 'background', 'atmosphere'] },
  { id: 'soft', label: '轻柔细节', kind: 'calm',
    zh: ['轻', '柔', '细微', '安静', '宁静', '舒适', '安逸', '温暖', '温柔', '近距', '小声'],
    en: ['soft', 'gentle', 'subtle', 'quiet', 'calm', 'warm', 'cozy', 'light', 'delicate', 'close'] }
];

const FAMILY_BY_ID = new Map(FAMILIES.map((f) => [f.id, f]));
const INTENSE_IDS = FAMILIES.filter((f) => f.kind === 'intense').map((f) => f.id);
const CALM_IDS = FAMILIES.filter((f) => f.kind === 'calm').map((f) => f.id);

// 查询里的「安静取向」和「强冲突取向」用词
const MOOD_CALM = [
  '安静', '宁静', '安逸', '舒适', '平和', '平静', '悠闲', '慵懒', '温暖', '轻柔', '温柔',
  '清晨', '傍晚', '阳光', '微风', '公园', '草原', '草地', '森林', '树林', '田野', '乡间',
  '海边', '海滩', '自然', '户外', '治愈', '放松', '舒缓', '睡', '读书', '咖啡', '野餐'
];
const MOOD_NATURE = [
  '公园', '草原', '草地', '森林', '树林', '田野', '乡间', '海边', '海滩', '湖', '山',
  '自然', '户外', '鸟', '风', '雨', '溪', '河', '阳光', '清晨', '黄昏'
];
const MOOD_INTENSE = [
  '爆炸', '尖叫', '震撼', '激烈', '冲击', '战斗', '打斗', '动作', '紧张', '惊悚', '暴力',
  '破坏', '撞击', '武器', '枪', '警报', '恐怖', '吓'
];

/** 这条素材在各声类上的命中次数（缓存在条目上）。 */
function familyHits(it) {
  if (it._aiFam) return it._aiFam;
  const doc = docFor(it);
  const blob = doc.blob;
  const tokens = doc.all;
  const out = {};
  for (const f of FAMILIES) {
    let n = 0;
    for (const z of f.zh) if (blob.includes(z)) n++;
    for (const e of f.en) {
      for (const t of tokens) {
        if (t === e || (e.length >= 4 && t.startsWith(e))) { n++; break; }
      }
    }
    out[f.id] = n;
  }
  it._aiFam = out;
  return out;
}

/** 条目改过以后清掉声类缓存。 */
export function invalidateFamilies(it) {
  if (it) delete it._aiFam;
}

const sumOf = (hits, ids) => ids.reduce((s, id) => s + (hits[id] || 0), 0);

/** 库名/目录名里直接写着「爆炸、武器、HIT」这种强冲突词的次数。 */
function nameCueHits(name) {
  const s = String(name || '').toLowerCase();
  if (!s) return 0;
  let n = 0;
  for (const f of FAMILIES) {
    if (f.kind !== 'intense') continue;
    let hit = false;
    for (const z of f.zh) if (s.includes(z)) { hit = true; break; }
    if (!hit) {
      for (const e of f.en) {
        if (e.length >= 3 && s.includes(e)) { hit = true; break; }
      }
    }
    if (hit) n++;
  }
  return n;
}

/** 库名里写着「公园、草原、风」这类安静线索就不动它。 */
function nameCalmHits(name) {
  const s = String(name || '').toLowerCase();
  if (!s) return 0;
  let n = 0;
  for (const f of FAMILIES) {
    if (f.kind !== 'calm') continue;
    let hit = false;
    for (const z of f.zh) if (s.includes(z)) { hit = true; break; }
    if (!hit) {
      for (const e of f.en) {
        if (e.length >= 3 && s.includes(e)) { hit = true; break; }
      }
    }
    if (hit) n++;
  }
  return n;
}

/**
 * 判断这句需求更偏「安静/自然」还是「强冲突」。
 * 只做关键词判断，不花 token；模型给的词仍然照常参与打分。
 */
export function classifyQuery(query) {
  const q = String(query || '').toLowerCase();
  const calm = MOOD_CALM.filter((w) => q.includes(w));
  const nature = MOOD_NATURE.filter((w) => q.includes(w));
  const intense = MOOD_INTENSE.filter((w) => q.includes(w));
  const parsed = parseQuery(query);
  const strongConcepts = new Set(['weapon', 'impact', 'horror', 'tension', 'creature', 'smash', 'alarm']);
  const strongHit = parsed.positive.some((p) => strongConcepts.has(p.concept.id));
  let mood = 'neutral';
  if (intense.length > calm.length || (strongHit && !calm.length && !nature.length)) mood = 'intense';
  else if (calm.length || nature.length) mood = 'calm';
  return {
    mood,
    calm: mood === 'calm',
    nature: nature.length > 0,
    cues: { calm, nature, intense }
  };
}

/**
 * 按需求取向筛掉「整库都跟需求对着干」的素材。
 * 只有安静/自然取向才会动手：按库（libraryOf 给的键）抽样统计强冲突占比，
 * 一整库几乎都是爆炸/尖叫/转场、且没有安静类线索的，整库跳过；
 * 剩下的库里再把「自己就是强冲突、而且毫无安静线索」的单条剔掉。
 * @returns {{keep:Array, dropped:number, kept:number, libs:Array<{key,items,intense}>, labels:string[]}}
 */
export function planPrune(items, intent, opts = {}) {
  const pool = Array.isArray(items) ? items : [];
  const libraryOf = typeof opts.libraryOf === 'function' ? opts.libraryOf : () => '';
  if (!intent || intent.mood !== 'calm' || pool.length < 40) {
    return { keep: pool, dropped: 0, kept: pool.length, libs: [], labels: [] };
  }

  const groups = new Map();
  for (const it of pool) {
    const key = libraryOf(it) || '';
    let g = groups.get(key);
    if (!g) { g = { key, items: [], intense: 0, calm: 0 }; groups.set(key, g); }
    g.items.push(it);
  }

  const libs = [];
  for (const g of groups.values()) {
    // 大库抽样即可，免得为了 9 千条素材做全量统计
    const step = g.items.length > 240 ? Math.ceil(g.items.length / 240) : 1;
    let intense = 0;
    let calmish = 0;
    let n = 0;
    for (let i = 0; i < g.items.length; i += step) {
      const hit = familyHits(g.items[i]);
      n++;
      const intenHit = sumOf(hit, INTENSE_IDS);
      const calmHit = sumOf(hit, CALM_IDS);
      if (intenHit >= 2 && calmHit === 0) intense++;
      else if (intenHit === 0) calmish++;
    }
    g.ratio = n ? intense / n : 0;
    g.calmRatio = n ? calmish / n : 0;
    g.nameIntense = nameCueHits(g.key);
    g.nameCalm = nameCalmHits(g.key);
    // 一整库几乎都是强冲突（≥70%）就整库跳过；
    // 库名自己就写着爆炸/武器/HIT、而且强冲突占比也不低（≥35%）的，同样跳过。
    if (g.nameCalm > 0) continue;
    if ((g.ratio >= 0.7 && g.calmRatio < 0.15) || (g.nameIntense >= 1 && g.ratio >= 0.35)) libs.push(g);
  }

  if (!libs.length) return { keep: pool, dropped: 0, kept: pool.length, libs: [], labels: [] };

  const skip = new Set(libs.map((g) => g.key));
  const keep = [];
  let dropped = 0;
  const labelSet = new Map();
  for (const it of pool) {
    if (skip.has(libraryOf(it) || '')) {
      dropped++;
      const hit = familyHits(it);
      for (const id of INTENSE_IDS) {
        if ((hit[id] || 0) > 0) {
          const f = FAMILY_BY_ID.get(id);
          labelSet.set(id, (labelSet.get(id) || 0) + 1);
        }
      }
      continue;
    }
    const hit = familyHits(it);
    const intenHit = sumOf(hit, INTENSE_IDS);
    const calmHit = sumOf(hit, CALM_IDS);
    if (intenHit >= 2 && calmHit === 0) {
      dropped++;
      for (const id of INTENSE_IDS) {
        if ((hit[id] || 0) > 0) labelSet.set(id, (labelSet.get(id) || 0) + 1);
      }
      continue;
    }
    keep.push(it);
  }

  const labels = [...labelSet.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([id]) => FAMILY_BY_ID.get(id).label);

  return {
    keep,
    dropped,
    kept: keep.length,
    libs: libs.map((g) => ({ key: g.key, items: g.items.length, intense: Math.round(g.ratio * 100) })),
    labels
  };
}

// ---------------------------------------------------------------------------
// 快捷示例
// ---------------------------------------------------------------------------
export const PRESETS = [
  {
    label: '恐怖氛围',
    text: '恐怖氛围：像水琴一样的诡异金属共鸣，加上诡异的敲门声、阴沉的物品掉落和玻璃摔碎'
  },
  {
    label: '硬底鞋·瓷砖走廊',
    text: '一个人穿硬底鞋，在铺了瓷砖的狭窄走廊里缓慢行走；要有明显的早期反射，但不要有太长的混响尾音'
  },
  {
    label: '金属撞击',
    text: '沉重的金属撞击，带一点尾音，不要电子音'
  }
];
