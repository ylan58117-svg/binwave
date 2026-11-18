'use strict';

/* ==========================================================================
   SoundBin — renderer
   ========================================================================== */

import {
  PRESETS,
  parseQuery,
  searchLibrary,
  candidateRows,
  buildAgentMessages,
  parseAgentReply,
  resolvePicks,
  invalidateDoc,
  buildExpandMessages,
  parseExpandReply,
  buildScanMessages,
  parseScanReply,
  buildImageMessages,
  parseImageReply,
  classifyQuery,
  planPrune,
  invalidateFamilies
} from './ai.js';

import {
  FX_DEFAULTS,
  clampFx,
  createFxChain,
  renderOffline,
  encodeWav24,
  bufferPeakDb
} from './fx.js';

import {
  SAMPLER_DEFAULTS,
  clampSampler,
  samplerWindow,
  samplerSig,
  playSamplerNote,
  renderSampler,
  KEY_MAP
} from './sampler.js';

import { SYNTH_DEFAULTS, clampSynth, decodeBuffer, buildBed, buildTexture, clampTexture } from './synth.js';

const sb = window.sb;

// 界面心跳：主进程靠它区分「窗口黑掉但进程还在」和「只是我太慢」。
// 用 setInterval 而不是 rAF：窗口还没 show 的时候 rAF 根本不跑，
// 大库启动那十几秒会被误判成卡死。主线程真被卡住时定时器同样停摆，所以指标照样准。
(function uiHeartbeat() {
  const beat = () => {
    try { sb.send('ui:alive'); } catch { /* preload 没挂上也别炸 */ }
  };
  beat();
  setInterval(beat, 400);
})();

const $ = (id) => document.getElementById(id);

const ROW_H = 31;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const pad = (n, w = 2) => String(Math.floor(Math.abs(n))).padStart(w, '0');

function fmtTC(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor(sec / 60) % 60;
  const s = Math.floor(sec) % 60;
  const ms = Math.round((sec - Math.floor(sec)) * 1000) % 1000;
  return h > 0
    ? `${h}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`
    : `${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

function fmtDur(sec) {
  if (!sec || !Number.isFinite(sec)) return '—';
  if (sec >= 3600) {
    return `${Math.floor(sec / 3600)}:${pad(Math.floor(sec / 60) % 60)}:${pad(Math.floor(sec) % 60)}`;
  }
  return `${Math.floor(sec / 60)}:${pad(Math.floor(sec) % 60)}.${pad(Math.round((sec % 1) * 1000) % 1000, 3)}`;
}

function fmtSize(b) {
  if (!b || b < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const s = v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : String(Math.round(v));
  return `${s} ${units[i]}`;
}

function fmtRate(hz) {
  if (!hz) return '—';
  const k = hz / 1000;
  return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
}

function fmtChannels(n) {
  if (!n) return '—';
  if (n === 1) return '1';
  if (n === 2) return '2';
  if (n === 6) return '5.1';
  if (n === 8) return '7.1';
  return String(n);
}

const dbToGain = (db) => (db <= -60 ? 0 : Math.pow(10, db / 20));

/**
 * Drawing-only gain for the waveform. Takes a high percentile of |peak| rather
 * than the absolute max so one stray transient does not squash the whole file,
 * then snaps to a power of two so the look is stable between reloads.
 */
function computeWaveGain(peaks) {
  if (!peaks || !peaks.data || !peaks.data.length) return 1;
  const n = peaks.data.length;
  const stride = Math.max(1, Math.ceil(n / 24000));
  const vals = [];
  for (let i = 0; i + 1 < n; i += stride) {
    const a = Math.abs(peaks.data[i] || 0);
    const b = Math.abs(peaks.data[i + 1] || 0);
    const m = a > b ? a : b;
    if (m) vals.push(m);
  }
  if (vals.length < 8) return 1;
  vals.sort((a, b) => a - b);
  const p = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.998))];
  if (!p || p < 4) return 1;
  const g = (0.94 * 32767) / p;
  return Math.min(64, Math.max(1, Math.pow(2, Math.round(Math.log2(g)))));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toUpperCase();
}

function baseName(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i < 0 ? p : p.slice(i + 1);
}

function dirName(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i <= 0 ? '' : p.slice(0, i);
}

// Deterministic category colour so the same UCS category always looks the same.
const PALETTE = [
  '#5fd0a8', '#63b3ff', '#ffb454', '#c792ea', '#ff8a80',
  '#8ed081', '#4dd0e1', '#f4a3c8', '#b8c4d0', '#dce775',
  '#ffab91', '#9fa8da'
];
function colorForCategory(cat) {
  let h = 0;
  for (let i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// ---------------------------------------------------------------------------
// UCS parsing: Category_SubCategory_Description_Number
// ---------------------------------------------------------------------------
function parseUcs(name) {
  const base = name.replace(/\.[^.]+$/, '');
  const parts = base.split('_');
  if (parts.length < 3) return null;
  const last = parts[parts.length - 1];
  if (!/^\d{1,4}$/.test(last)) return null;
  const category = parts[0];
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(category)) return null;
  return {
    category: category.toUpperCase(),
    sub: parts[1] || '',
    desc: parts.slice(2, -1).join('_'),
    num: Number(last)
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  items: [],
  byPath: new Map(),
  view: [],

  selection: new Set(),
  focusPath: null,

  // 暂存区（1.8.0）：跨「检索 / 相似波形」收集起来的素材路径，一次拖出到 DAW。
  bin: [],

  filter: { type: 'all', value: null },
  search: '',
  sort: { key: 'addedAt', dir: 1 },

  // User-created libraries. An item may live in several; deleting one only
  // drops the tag, never the file or the item itself.
  collections: [],

  // Main category per item (exactly one, or none). Seeded from the UCS name
  // but fully editable: rename, delete, create, and drag clips onto one.
  categories: [],
  // 分类现在是树：每条记录可以有 parentId，侧栏用倒三角展开子分类。
  // 这里记住哪些文件夹被收起了（存进 library.json）。
  collapsedCats: [],
  // UCS prefixes whose auto-category was deleted on purpose. Without this a
  // re-import would silently recreate the category the user just removed.
  hiddenCategoryAutos: [],

  // Ctrl/Shift-click multi-selection of libraries or categories, so several can
  // be merged or deleted at once. Kept separate from `filter` because the list
  // shows the union of everything selected while this is active.
  sideSelection: { type: null, ids: new Set(), anchor: null },

  gainDb: 0,
  muted: false,
  loop: false,
  mono: false,

  waveHeight: 208,
  // Field recordings are often 20-40 dB below full scale; drawing them at true
  // amplitude makes the waveform look like a flat line. Auto-gain scales the
  // drawing only — playback level is untouched.
  waveAutoGain: true,
  settingsOpen: false,
  infoOpen: false,
  // 点一条音频就自动把右侧信息栏顶出来；用户手动关掉后置 false（存进 settings）
  autoInfo: true,
  // 鼠停即试听：默认开，可以在设置里关（存进 settings）
  hoverAudition: true,
  // 悬停多久开始播（秒）。用户可调，默认 0.3
  hoverDelay: 0.3,
  sideWNarrow: 132,
  // 侧栏宽度（拖动 —— 需求 1）
  sideW: 228,
  // 表头列宽（px，11 列，最后一列是"路径"的最小宽度）。
  // null = 用 CSS 里的默认比例；用户拖动表头后变成具体像素并存进 library.json。
  colWidths: null,

  currentPath: null,
  playing: false,
  loading: false,

  // 贴边隐藏：窗口几何由主进程负责，这里只留用户偏好和当前模式
  dock: { enabled: false, edge: 'right', width: 480, hidden: false, docked: false },

  // 播放链上的效果器参数（随 library.json 的 settings 持久化）
  fx: { ...FX_DEFAULTS },

  // 内置采样器参数（同样是"处理当前素材"的一组旋钮）
  sampler: { ...SAMPLER_DEFAULTS },

  // Agent 语义检索面板
  agentProfiles: { active: '', profiles: [] },
  ai: {
    open: false,
    query: '',
    results: [],
    parsed: null,
    expand: null,
    deep: false,
    only: false,
    busy: false,
    note: '',
    image: null,
    imageScene: '',
    imageError: '',
    sounds: [],
    // 上一次「看图」的结果缓存：改完文字再检索时直接复用，不再赌第二次看图能不能成功
    // （以前第二次看图一旦失败，画面描述就被清空，看起来就像「图片丢了」）
    look: null,
    forceLook: false,
    // 连上 Agent 后默认不再拿本地命中当门槛：候选由模型给的 where/keywords 去全库捞，
    // 本地命中只在勾选「附带本地命中」时附在后面（老用户存的设置会覆盖这个默认值）
    keepLocal: false,
    offline: false,         // 勾上就不发送给 AI，只用本地命中
    // 语义检索历史（手动保存），持久化在 library.json 的 aiHistory 里
    // 自动记录的检索历史 / 手动保存的检索
    history: [],
  tab: 'search',
    saved: [],
    // 'none' = 看结果；'history' / 'saved' = 看对应的列表
    histView: 'none',
    // 设置抽屉上次停在哪个分区：general / data / ai
    settingsTab: 'general'
  },

  lastRemoved: null
};

const settings = {
  toLibrary() {
    return {
      gainDb: state.gainDb,
      muted: state.muted,
      loop: state.loop,
      mono: state.mono,
      waveHeight: state.waveHeight,
      waveAutoGain: state.waveAutoGain,
      colWidths: state.colWidths ? state.colWidths.slice() : null,
      fx: { ...state.fx },
      sampler: { ...state.sampler },
      dock: { enabled: state.dock.enabled, edge: state.dock.edge, width: state.dock.width },
      ai: { keepLocal: !!state.ai.keepLocal, offline: !!state.ai.offline },
      ui: { autoInfo: !!state.autoInfo, sideW: Math.round(state.sideW), sideWNarrow: Math.round(state.sideWNarrow || 132), hoverAudition: !!state.hoverAudition, hoverDelay: Number(state.hoverDelay) || 0.3 }
    };
  }
};

let saveTimer = null;
// 清单加载完之前一律不写盘：页面刚启动时 state.items 还是空的，这时候任何一次
// 保存都会把磁盘上有内容的清单盖成空清单（22:42 那次事故就是这么来的）。
let libraryReady = false;
// 只有「用户自己把条目删光」才允许写空清单。别处（加载失败、列表还没恢复完）
// 都是空数组，但那不是用户的意图。
let emptyByUser = false;
function scheduleSave() {
  if (!libraryReady) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveLibraryNow, 700);
}

async function saveLibraryNow() {
  saveTimer = null;
  if (!libraryReady) return;
  const payload = {
    version: 3,
    items: state.items.map((it) => ({
      path: it.path,
      name: it.name,
      size: it.size,
      mtimeMs: it.mtimeMs,
      addedAt: it.addedAt,
      meta: it.meta || null,
      collections: it.collections.slice(),
      categoryId: it.categoryId || null,
      trim: it.trim || null,
      // 波形指纹（相似度搜索用）：64 个归一化包络值 + 64 段过零率 + 峰值哈希
      fp: it.fp || null,
      zcr: it.zcr || null,
      fpHash: it.fpHash || null
    })),
    collections: state.collections.map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt })),
    categories: state.categories.map((c) => ({
      id: c.id,
      name: c.name,
      parentId: c.parentId || null,
      auto: c.auto || null,
      pinned: c.pinned || null
    })),
    collapsedCategories: state.collapsedCats.slice(),
    hiddenCategoryAutos: state.hiddenCategoryAutos.slice(),
    // 语义检索历史（最多 40 条，只存路径与模型给的理由，不存整条素材）
    aiHistory: state.ai.history.slice(0, AI_HISTORY_MAX),
    aiSaved: state.ai.saved.slice(0, AI_SAVED_MAX),
      settingsTab: state.ai.settingsTab,
    settings: settings.toLibrary()
  };
  // 自己序列化再发字符串：102k 条时直接发对象会让 IPC 的结构化克隆吃掉
  // ~390ms（实测），发字符串只要 28ms 的 stringify + 一次拷贝。
  let json;
  try {
    json = JSON.stringify(payload);
  } catch (err) {
    toast('保存清单失败：' + (err && err.message ? err.message : err));
    return;
  }
  const allowEmpty = payload.items.length === 0 && emptyByUser;
  const ok = await sb.invoke('library:save', { json, itemCount: payload.items.length, allowEmpty });
  // 主进程会拒绝「读到的是空、却要拿空清单盖掉有内容的清单」这种写入。
  // 这时候磁盘上那份旧清单还在，界面上的东西只是没落盘，得让用户知道。
  if (ok === false) {
    if (!saveWarned) {
      saveWarned = true;
      toast('清单这次没写进磁盘：为了不覆盖磁盘上已经存好的内容，这一下先停下了。磁盘上的清单没动。', { ms: 9000 });
    }
  } else if (payload.items.length) {
    // 写到有内容的清单之后，「空」就不再是用户意图了
    emptyByUser = false;
  }
}

let saveWarned = false;

// ---------------------------------------------------------------------------
// Item factory
// ---------------------------------------------------------------------------
let seq = 0;
function makeItem(file) {
  const p = file.path;
  const name = file.name || baseName(p);
  const ucs = parseUcs(name);
  const it = {
    id: p,
    path: p,
    name,
    dir: dirName(p),
    size: file.size || 0,
    mtimeMs: file.mtimeMs || 0,
    addedAt: Date.now() + (seq++),
    meta: file.meta || null,
    playPath: null,
    playable: true,
    // A restored library entry carries metadata but no peaks: waveform data
    // lives in the main-process cache, so it always has to be re-fetched.
    analysis: !file.needsAnalysis && file.meta ? 'ready' : 'idle',
    peaks: null,
    peaksState: 'idle',
    missing: false,
    ucs,
    // Main category: one per item, editable. Resolved by ensureCategory().
    categoryId: file.categoryId || null,
    // User-made collections this item lives in (ids). Empty = only in "all".
    collections: Array.isArray(file.collections) ? file.collections.slice() : [],
    trim: file.trim && file.trim.end > file.trim.start ? { start: file.trim.start, end: file.trim.end } : null,
    fp: Array.isArray(file.fp) && file.fp.length === FP_BINS ? file.fp : null,
    zcr: Array.isArray(file.zcr) ? file.zcr : null,
    fpHash: typeof file.fpHash === 'string' ? file.fpHash : null,
    haystack: ''
  };
  rebuildHaystack(it);
  return it;
}

function rebuildHaystack(it) {
  const parts = [
    it.name,
    it.ucs ? it.ucs.category : '',
    it.ucs ? it.ucs.sub : '',
    it.ucs ? it.ucs.desc : '',
    it.dir
  ];
  const t = it.meta && it.meta.tags;
  if (t) for (const k of Object.keys(t)) if (t[k]) parts.push(String(t[k]));
  const groups = (it.meta && it.meta.tagGroups) || [];
  for (const g of groups) for (const row of g.rows) if (row[1]) parts.push(String(row[1]));
  it.haystack = parts.join(' ').toLowerCase();
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------
class Player {
  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);

    this.el = new Audio();
    this.el.crossOrigin = 'anonymous';
    this.el.preload = 'auto';

    this.src = this.ctx.createMediaElementSource(this.el);
    this.src.connect(this.gain);

    // Mono fold-down path
    this.splitter = this.ctx.createChannelSplitter(2);
    this.halfL = this.ctx.createGain(); this.halfL.gain.value = 0.5;
    this.halfR = this.ctx.createGain(); this.halfR.gain.value = 0.5;
    this.monoSum = this.ctx.createGain();
    this.monoSum.channelCount = 1;
    this.monoSum.channelCountMode = 'explicit';
    this.monoSum.channelInterpretation = 'speakers';
    this.splitter.connect(this.halfL, 0);
    this.splitter.connect(this.halfR, 1);
    this.halfL.connect(this.monoSum);
    this.halfR.connect(this.monoSum);
    this.monoSum.connect(this.gain);

    // 效果器链（默认旁通）：fx.output 固定在 gain 之前，
    // 启用时才把 src / monoSum 从 gain 改接到 fx.input。
    this.fx = createFxChain(this.ctx, state.fx);
    this.fx.output.connect(this.gain);
    this.fxOn = false;
    if (state.fx.enabled) this.setFx(true);

    this.onEnded = null;
    this.onError = null;
    this.onLoaded = null;
    this.url = null;
    // 播放入口区间（秒）：被修剪过的素材只播 [clipStart, clipEnd]
    this.clipStart = null;
    this.clipEnd = null;

    this.el.addEventListener('ended', () => this.onEnded && this.onEnded());
    this.el.addEventListener('error', () => {
      const e = this.el.error;
      this.onError && this.onError(e ? `解码失败 (code ${e.code})` : '加载失败');
    });
    this.el.addEventListener('loadedmetadata', () => this.onLoaded && this.onLoaded());
  }

  get currentTime() { return this.el.currentTime || 0; }
  get duration() {
    const d = this.el.duration;
    return Number.isFinite(d) && d > 0 ? d : 0;
  }
  get paused() { return this.el.paused; }

  /** 提前把音频输出打开并把图跑一遍（拿 0.05 秒静音走一次）。 */
  warm() {
    if (this._warmed) return;
    this._warmed = true;
    try {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      const n = Math.max(1, Math.round(this.ctx.sampleRate * 0.05));
      const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.ctx.destination);
      src.start();
    } catch (err) {
      /* 热身失败不影响正常播放 */
    }
  }

  setUrl(url) {
    this.url = url;
    this.el.src = url;
    this.el.load();
  }

  async play() {
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* ignore */ }
    }
    try {
      await this.el.play();
    } catch (err) {
      this.onError && this.onError('无法播放：' + (err && err.message ? err.message : err));
    }
  }

  pause() { this.el.pause(); }

  get clipActive() { return this.clipStart != null && this.clipEnd != null && this.clipEnd > this.clipStart; }

  /** 设定"只播这一段"的区间；传 null 恢复整段播放。 */
  setClip(start, end) {
    if (start == null || end == null || !(end > start)) {
      this.clipStart = null;
      this.clipEnd = null;
    } else {
      this.clipStart = start;
      this.clipEnd = end;
    }
    // 区间播放自己管循环，交给 <audio loop> 会循环整段
    this.el.loop = this.clipActive ? false : state.loop;
  }

  stop() {
    this.el.pause();
    try { this.el.currentTime = this.clipActive ? this.clipStart : 0; } catch { /* ignore */ }
  }

  seek(t) {
    try {
      const d = this.duration;
      let lo = 0;
      let hi = d ? d - 0.001 : t;
      if (this.clipActive) {
        lo = this.clipStart;
        hi = Math.min(hi, this.clipEnd - 0.001);
      }
      this.el.currentTime = Math.max(lo, Math.min(t, hi));
    } catch { /* ignore */ }
  }

  setGainDb(db) {
    const g = state.muted ? 0 : dbToGain(db);
    const now = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setTargetAtTime(g, now, 0.012);
  }

  setLoop(on) {
    // 有播放入口区间时，循环由 tickPlayhead() 在区间内自己滚，不用 <audio.loop>
    this.el.loop = this.clipActive ? false : on;
  }

  setMono(on) {
    try { this.src.disconnect(); } catch { /* ignore */ }
    try { this.monoSum.disconnect(); } catch { /* ignore */ }
    const dest = this.fxOn ? this.fx.input : this.gain;
    if (on) {
      this.src.connect(this.splitter);
      this.monoSum.connect(dest);
    } else {
      this.src.connect(dest);
    }
  }

  /** 打开/旁通效果器。params 给了就顺手更新参数。 */
  setFx(on, params) {
    if (params) this.fx.update(params);
    on = !!on;
    if (on === this.fxOn) return;
    this.fxOn = on;
    this.setMono(state.mono);
  }
}

const player = new Player();

// ---------------------------------------------------------------------------
// Waveform view (two canvases: static body + per-frame playhead)
// ---------------------------------------------------------------------------
class WaveView {
  constructor(wrap, canvas, headCanvas) {
    this.wrap = wrap;
    this.canvas = canvas;
    this.headCanvas = headCanvas;
    this.ctx = canvas.getContext('2d');
    this.headCtx = headCanvas.getContext('2d');
    this.peaks = null;
    this.duration = 0;
    this.time = 0;
    this.hoverX = -1;
    this.hovering = false;
    this.dpr = 1;
    this.w = 0;
    this.h = 0;
    this.rulerH = 15;           // 顶部时间码标尺的高度，波形画在它下面
    this.dirty = true;
    this.zoom = 1;
    this.viewStart = 0;
    this.follow = true;         // 缩放后播放头是否自动跟随
    this.selection = null;      // { start, end } 秒，修剪选区
    this.selDragging = null;    // 拖动选区时的临时 { start, end }
    this.srcPath = null;        // 原始 PCM 路径，缩放时用来取真实采样
    this.detail = null;         // { key, channels, cols, data } 当前视窗的真实采样包络
    this.detailReq = null;      // 已发出的请求键
    this.detailFail = new Set();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);

    // 窗口宽度没变、但上面那排按钮换行（缩放倍数变长、贴边面板变窄）时，
    // canvas 的高度会跟实际可用高度对不上，波形就被挤出去裁掉一半。
    // 用 ResizeObserver 盯住容器自己的尺寸，比只听 window.resize 可靠。
    if (typeof ResizeObserver === 'function') {
      let lastW = 0;
      let lastH = 0;
      this._ro = new ResizeObserver((entries) => {
        const box = entries[0] && entries[0].contentRect;
        if (!box) return;
        const w = Math.round(box.width);
        const h = Math.round(box.height);
        if (w === lastW && h === lastH) return;
        lastW = w;
        lastH = h;
        this.resize();
      });
      this._ro.observe(this.wrap);
    }

    this._raf = () => {
      this.tick();
      requestAnimationFrame(this._raf);
    };
    requestAnimationFrame(this._raf);
  }

  resize() {
    const rect = this.wrap.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = Math.max(1, Math.floor(rect.width));
    this.h = Math.max(1, Math.floor(rect.height));
    // 面板很矮时把标尺压薄一点，别把波形挤没
    this.rulerH = this.h < 90 ? 13 : 15;
    for (const c of [this.canvas, this.headCanvas]) {
      c.width = Math.floor(this.w * this.dpr);
      c.height = Math.floor(this.h * this.dpr);
      c.style.width = this.w + 'px';
      c.style.height = this.h + 'px';
    }
    this.dirty = true;
    this.drawBody();
    this.drawHead();
    this.maybeRequestDetail();
  }

  setData(peaks, duration, srcPath) {
    this.peaks = peaks;
    this.duration = duration || 0;
    this.autoGain = computeWaveGain(peaks);
    this.zoom = 1;
    this.viewStart = 0;
    this.selection = null;
    this.selDragging = null;
    this.srcPath = srcPath || null;
    this.detail = null;
    this.detailReq = null;
    this.detailFail.clear();
    this.dirty = true;
    this.drawBody();
    this.drawHead();
    if (typeof syncZoomChip === 'function') syncZoomChip();
  }

  setTime(t) {
    if (Math.abs(t - this.time) < 0.0005) return;
    this.time = t;
    if (this.zoom > 1 && this.follow) this.followTime(t);
    this.drawHead();
  }

  tick() {
    if (this.dirty) {
      this.dirty = false;
      this.drawBody();
      this.drawHead();
    }
  }

  // ---- view window -------------------------------------------------------
  get viewSpan() {
    return this.duration > 0 ? this.duration / this.zoom : 0;
  }

  get viewEnd() {
    return Math.min(this.duration, this.viewStart + this.viewSpan);
  }

  maxZoom() {
    const bps = (this.peaks && this.peaks.binsPerSecond) || 320;
    const bins = this.duration * bps;
    // 视窗里至少留 ~96 个包络柱；再细就靠真实采样补齐
    return Math.max(1, Math.min(4096, bins / 96));
  }

  clampView() {
    const maxStart = Math.max(0, this.duration - this.viewSpan);
    this.viewStart = Math.max(0, Math.min(maxStart, this.viewStart));
  }

  tToX(t) {
    const span = this.viewSpan;
    if (!span) return 0;
    return ((t - this.viewStart) / span) * this.w;
  }

  xToTime(x) {
    if (!this.w) return this.viewStart;
    const span = this.viewSpan;
    const t = this.viewStart + (x / this.w) * span;
    return Math.max(0, Math.min(this.duration, t));
  }

  /** 以 anchorT 为锚缩放，锚点在屏幕上的相对位置保持不变。 */
  setZoom(z, anchorT) {
    if (!this.duration) return false;
    const next = Math.max(1, Math.min(this.maxZoom(), z));
    if (Math.abs(next - this.zoom) < 1e-6) return false;
    const span = this.viewSpan;
    const anchor = anchorT == null ? this.viewStart + span / 2 : anchorT;
    const frac = span > 0 ? (anchor - this.viewStart) / span : 0.5;
    this.zoom = next;
    this.viewStart = anchor - frac * this.viewSpan;
    this.clampView();
    this.markDirty();
    if (typeof syncZoomChip === 'function') syncZoomChip();
    return true;
  }

  zoomBy(factor, anchorT) {
    return this.setZoom(this.zoom * factor, anchorT);
  }

  resetZoom() {
    if (this.zoom === 1 && this.viewStart === 0) return false;
    this.zoom = 1;
    this.viewStart = 0;
    this.markDirty();
    if (typeof syncZoomChip === 'function') syncZoomChip();
    return true;
  }

  setViewStart(t) {
    const next = Math.max(0, Math.min(Math.max(0, this.duration - this.viewSpan), t));
    if (Math.abs(next - this.viewStart) < 1e-9) return false;
    this.viewStart = next;
    this.markDirty();
    return true;
  }

  panBy(seconds) {
    return this.setViewStart(this.viewStart + seconds);
  }

  followTime(t) {
    const span = this.viewSpan;
    if (!span) return;
    if (t < this.viewStart || t > this.viewStart + span * 0.92) {
      this.setViewStart(t - span * 0.12);
    }
  }

  markDirty() {
    this.dirty = true;
    this.drawBody();
    this.drawHead();
    this.maybeRequestDetail();
  }

  detailKey() {
    return `${this.viewStart.toFixed(4)}|${this.viewEnd.toFixed(4)}|${this.w}`;
  }

  /**
   * 缩放到 320 bins/s 包络分辨率以下时，向主进程要这段视窗的真实采样 min/max，
   * 这样放大后看到的是真实波形细节而不是插值出来的平滑线。
   * 只对 PCM 文件有效；mp3 等继续用包络插值。
   */
  maybeRequestDetail() {
    if (!this.srcPath || !this.peaks || !this.duration || this.w <= 0) { this.detail = null; return; }
    const bps = this.peaks.binsPerSecond || 320;
    const binsPerPx = (this.viewSpan * bps) / this.w;
    if (binsPerPx >= 1.6) { this.detail = null; return; }
    const key = this.detailKey();
    if (this.detail && this.detail.key === key) return;
    if (this.detailReq === key || this.detailFail.has(key)) return;
    this.detailReq = key;
    const cols = this.w;
    Promise.resolve(sb.invoke('audio:window', {
      path: this.srcPath, start: this.viewStart, end: this.viewEnd, cols
    })).then((res) => {
      if (this.detailReq !== key) return;
      if (!res || !res.data) { this.detailFail.add(key); return; }
      this.detail = { key, channels: res.channels, cols: res.cols, data: res.data };
      this.markDirty();
    }).catch(() => { this.detailFail.add(key); });
  }

  // ---- drawing -----------------------------------------------------------
  drawBody() {
    const c = this.ctx;
    const W = this.w, H = this.h;
    if (!W || !H) return;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, W, H);

    c.fillStyle = '#080a0e';
    c.fillRect(0, 0, W, H);

    // 顶部留一条标尺带：时间码画在这里，波形被裁在这条线以下，
    // 再大的振幅也压不到时间码上。
    const rh = this.rulerH || 0;
    if (rh > 0) {
      c.fillStyle = '#0a0e14';
      c.fillRect(0, 0, W, rh);
      c.fillStyle = 'rgba(255,255,255,0.07)';
      c.fillRect(0, rh - 1, W, 1);
    }

    const peaks = this.peaks;
    const duration = this.duration;
    const span = this.viewSpan;

    if (!peaks || !peaks.bins || !duration) {
      c.fillStyle = '#242c37';
      c.fillRect(0, rh + (H - rh) / 2, W, 1);
      this.drawGrid(c, W, H, span, rh);
      this.drawSelection(c, W, H, rh);
      return;
    }

    // 已播放区域底色（画在波形下面）
    if (this.time > this.viewStart) {
      const px = Math.max(0, Math.min(W, ((this.time - this.viewStart) / span) * W));
      c.fillStyle = 'rgba(61, 220, 151, 0.07)';
      c.fillRect(0, rh, px, H - rh);
    }

    this.drawGrid(c, W, H, span, rh);

    const detail = (this.detail && this.detail.key === this.detailKey() && this.detail.cols === W)
      ? this.detail : null;
    const dch = detail ? Math.min(2, detail.channels || 1) : 0;
    const ch = Math.min(2, (detail ? detail.channels : peaks.channels) || 1);
    const bins = peaks.bins;
    const bps = peaks.binsPerSecond || 320;
    const data = peaks.data;
    const vg = state.waveAutoGain ? (this.autoGain || 1) : 1;
    const norm = (v) => Math.max(-1, Math.min(1, (v * vg) / 32767));

    const padY = 6;
    const laneH = (H - rh - padY * 2) / ch;
    const b0f = this.viewStart * bps;
    const perPx = (span / W) * bps;

    const tops = new Float32Array(W);
    const bots = new Float32Array(W);

    // 波形只在标尺带下面画，别盖住时间码
    c.save();
    if (rh > 0) {
      c.beginPath();
      c.rect(0, rh, W, H - rh);
      c.clip();
    }

    for (let lane = 0; lane < ch; lane++) {
      const top = rh + padY + lane * laneH;
      const mid = top + laneH / 2;
      const half = Math.max(1, laneH / 2 - 2);

      c.fillStyle = 'rgba(255,255,255,0.045)';
      c.fillRect(0, Math.round(mid), W, 1);

      for (let x = 0; x < W; x++) {
        let lo = 0, hi = 0;
        if (detail) {
          if (lane < dch) {
            const o = (Math.min(detail.cols - 1, x) * dch + lane) * 2;
            lo = detail.data[o];
            hi = detail.data[o + 1];
          }
          tops[x] = mid - norm(hi) * half;
          bots[x] = mid - norm(lo) * half;
          continue;
        }
        const cb0 = b0f + (x / W) * (span * bps);
        const cb1 = b0f + ((x + 1) / W) * (span * bps);
        if (perPx <= 1.0001) {
          // 一个像素比一个包络柱还窄：在相邻柱之间线性插值
          const i0 = Math.max(0, Math.min(bins - 1, Math.floor(cb0)));
          const i1 = Math.min(bins - 1, i0 + 1);
          const f = Math.max(0, Math.min(1, cb0 - i0));
          const o0 = (i0 * ch + lane) * 2;
          const o1 = (i1 * ch + lane) * 2;
          lo = data[o0] + (data[o1] - data[o0]) * f;
          hi = data[o0 + 1] + (data[o1 + 1] - data[o0 + 1]) * f;
        } else {
          let b0 = Math.floor(cb0);
          let b1 = Math.ceil(cb1);
          if (b1 <= b0) b1 = b0 + 1;
          if (b0 < 0) b0 = 0;
          if (b1 > bins) b1 = bins;
          for (let b = b0; b < b1; b++) {
            const o = (b * ch + lane) * 2;
            if (data[o] < lo) lo = data[o];
            if (data[o + 1] > hi) hi = data[o + 1];
          }
        }
        tops[x] = mid - norm(hi) * half;
        bots[x] = mid - norm(lo) * half;
      }

      // 填充
      c.beginPath();
      c.moveTo(0, tops[0]);
      for (let x = 1; x < W; x++) c.lineTo(x, tops[x]);
      for (let x = W - 1; x >= 0; x--) c.lineTo(x, bots[x]);
      c.closePath();
      const grad = c.createLinearGradient(0, mid - half, 0, mid + half);
      const tint = lane === 0 ? '78,163,255' : '66,146,226';
      grad.addColorStop(0, `rgba(${tint},0.34)`);
      grad.addColorStop(0.5, `rgba(${tint},0.62)`);
      grad.addColorStop(1, `rgba(${tint},0.34)`);
      c.fillStyle = grad;
      c.fill();

      // 上下包络线
      c.strokeStyle = lane === 0 ? 'rgba(150,198,246,0.62)' : 'rgba(132,180,230,0.5)';
      c.lineWidth = 1;
      c.lineJoin = 'round';
      c.beginPath();
      c.moveTo(0, tops[0]);
      for (let x = 1; x < W; x++) c.lineTo(x, tops[x]);
      c.stroke();
      c.beginPath();
      c.moveTo(0, bots[0]);
      for (let x = 1; x < W; x++) c.lineTo(x, bots[x]);
      c.stroke();
    }

    c.restore();
    this.drawSelection(c, W, H, rh);
  }

  drawGrid(c, W, H, span, rh = 0) {
    if (!span) return;
    const targetPx = 110;
    const steps = [0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5,
                   1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    let step = steps[steps.length - 1];
    for (const s of steps) {
      if ((s / span) * W >= targetPx) { step = s; break; }
    }
    c.strokeStyle = 'rgba(255,255,255,0.055)';
    c.lineWidth = 1;
    c.font = '10px "Cascadia Mono", Consolas, monospace';
    c.textBaseline = 'top';

    const t0 = Math.floor(this.viewStart / step) * step;
    for (let i = 0; ; i++) {
      const t = t0 + i * step;
      if (t > this.viewStart + span + 1e-9) break;
      const x = Math.round(((t - this.viewStart) / span) * W) + 0.5;
      if (x < -1) continue;
      if (x > W + 1) break;
      c.beginPath();
      c.moveTo(x, rh);
      c.lineTo(x, H);
      c.stroke();
      if (t >= 0) {
        const label = fmtTC(t);
        const tw = c.measureText(label).width;
        // 贴着右边缘的那一格会只剩半个数字，干脆不画
        if (x + 4 + tw > W - 2) continue;
        c.fillStyle = 'rgba(255,255,255,0.34)';
        // 标尺带里竖向居中，没有标尺带时退回原来的贴顶位置
        const ty = rh > 0 ? Math.max(2, Math.round((rh - 10) / 2)) : 4;
        c.fillText(label, x + 4, ty);
      }
    }
  }

  /** 修剪选区：区域外压暗 + 两侧 IN/OUT 竖线 */
  drawSelection(c, W, H, rh = 0) {
    const sel = this.selDragging || this.selection;
    if (!sel || !this.duration) return;
    const a = Math.min(sel.start, sel.end);
    const b = Math.max(sel.start, sel.end);
    if (b - a <= 0.0005) return;
    const x0 = this.tToX(a);
    const x1 = this.tToX(b);

    c.fillStyle = 'rgba(0,0,0,0.45)';
    if (x0 > 0) c.fillRect(0, rh, Math.min(W, x0), H - rh);
    if (x1 < W) c.fillRect(Math.max(0, x1), rh, W - Math.max(0, x1), H - rh);

    c.strokeStyle = '#ffb454';
    c.lineWidth = 1;
    for (const x of [x0, x1]) {
      if (x < -1 || x > W + 1) continue;
      const px = Math.round(x) + 0.5;
      c.beginPath();
      c.moveTo(px, rh);
      c.lineTo(px, H);
      c.stroke();
    }

    c.font = '600 10px "Cascadia Mono", Consolas, monospace';
    c.textBaseline = 'top';
    const label = `选区 ${fmtTC(a)} – ${fmtTC(b)}`;
    const tw = c.measureText(label).width;
    if (tw + 12 < Math.max(40, x1 - x0)) {
      c.fillStyle = 'rgba(255,180,84,0.16)';
      c.fillRect(x0, rh, x1 - x0, 15);
      c.fillStyle = '#ffb454';
      c.fillText(label, x0 + 5, rh + 2);
    }
  }

  drawHead() {
    const c = this.headCtx;
    const W = this.w, H = this.h;
    if (!W || !H) return;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, W, H);

    if (this.hovering && this.hoverX >= 0) {
      c.strokeStyle = 'rgba(255,255,255,0.18)';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(Math.round(this.hoverX) + 0.5, this.rulerH || 0);
      c.lineTo(Math.round(this.hoverX) + 0.5, H);
      c.stroke();
    }

    if (!this.duration) return;
    const span = this.viewSpan;
    const x = ((this.time - this.viewStart) / span) * W;
    if (x < -2 || x > W + 2) return;

    const rh = this.rulerH || 0;
    c.strokeStyle = '#ff6b5b';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(x, rh);
    c.lineTo(x, H);
    c.stroke();

    // Head cap
    c.fillStyle = '#ff6b5b';
    c.beginPath();
    c.moveTo(x - 4, rh);
    c.lineTo(x + 4, rh);
    c.lineTo(x, rh + 6);
    c.closePath();
    c.fill();

    // Time bubble
    const label = fmtTC(this.time);
    c.font = '600 10.5px "Cascadia Mono", Consolas, monospace';
    const tw = c.measureText(label).width;
    let bx = x + 6;
    if (bx + tw + 10 > W) bx = x - tw - 16;
    if (bx < 0) bx = 0;
    c.fillStyle = 'rgba(255,107,91,0.92)';
    c.beginPath();
    c.roundRect(bx, H - 21, tw + 10, 15, 3);
    c.fill();
    c.fillStyle = '#1a0d0b';
    c.textBaseline = 'middle';
    c.fillText(label, bx + 5, H - 13);
  }
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const dom = {
  search: $('search'),
  searchClear: $('searchClear'),
  btnAddFiles: $('btnAddFiles'),
  btnAddFolder: $('btnAddFolder'),
  btnSettings: $('btnSettings'),
  btnAiSearch: $('btnAiSearch'),
  btnFx: $('btnFx'),
  fxMini: $('fxMini'),
  fxMiniToggle: $('fxMiniToggle'),
  fxMiniHp: $('fxMiniHp'),
  fxMiniLp: $('fxMiniLp'),
  fxMiniRev: $('fxMiniRev'),

  categoryList: $('categoryList'),
  catTitle: $('catTitle'),
  btnNewCategory: $('btnNewCategory'),
  formatList: $('formatList'),
  collectionList: $('collectionList'),
  libTitle: $('libTitle'),
  btnNewCollection: $('btnNewCollection'),
  countAll: $('countAll'),
  countMissing: $('countMissing'),
  countAi: $('countAi'),
  libStats: $('libStats'),

  listHeader: $('listHeader'),
  listBody: $('listBody'),
  listSpacer: $('listSpacer'),
  listRows: $('listRows'),
  emptyState: $('emptyState'),

  wavePanel: $('wavePanel'),
  waveResize: $('waveResize'),
  waveName: $('waveName'),
  waveMeta: $('waveMeta'),
  waveTime: $('waveTime'),
  waveWrap: $('waveWrap'),
  waveCanvas: $('waveCanvas'),
  waveHint: $('waveHint'),
  chipLoop: $('chipLoop'),
  chipMono: $('chipMono'),
  chipWaveGain: $('chipWaveGain'),
  chipZoom: $('chipZoom'),

  btnPrev: $('btnPrev'),
  btnPlay: $('btnPlay'),
  btnNext: $('btnNext'),
  btnStop: $('btnStop'),
  iconPlay: $('iconPlay'),
  iconPause: $('iconPause'),
  btnMute: $('btnMute'),
  iconVol: $('iconVol'),
  iconMuted: $('iconMuted'),
  volume: $('volume'),
  volReadout: $('volReadout'),
  // 贴边面板里时间码右边的增益旋钮（同一份音量状态）
  gainKnob: $('gainKnob'),
  gainKnobDial: $('gainKnobDial'),
  gainKnobValue: $('gainKnobValue'),
  tcCurrent: $('tcCurrent'),
  tcTotal: $('tcTotal'),

  dropOverlay: $('dropOverlay'),
  dropHint: $('dropHint'),
  settings: $('settings'),
  settingsScrim: $('settingsScrim'),
  infoPanel: $('infoPanel'),
  infoBody: $('infoBody'),
  infoTitle: $('infoTitle'),
  infoClose: $('infoClose'),
  chipInfo: $('chipInfo'),
  chipSimilar: $('chipSimilar'),
  chipTrim: $('chipTrim'),
  chipAi: $('chipAi'),
  chipFx: $('chipFx'),
  similarPanel: $('similarPanel'),
  similarScrim: $('similarScrim'),
  similarBody: $('similarBody'),
  similarTitle: $('similarTitle'),
  similarClose: $('similarClose'),
  settingsClose: $('settingsClose'),
  cacheSize: $('cacheSize'),
  userDataPath: $('userDataPath'),
  btnClearCache: $('btnClearCache'),
  btnOpenUserData: $('btnOpenUserData'),
  btnCleanCategories: $('btnCleanCategories'),
  cleanupStats: $('cleanupStats'),
  btnCleanupNow: $('btnCleanupNow'),
  btnPurgeMissing: $('btnPurgeMissing'),
  btnPurgeEmptyCats: $('btnPurgeEmptyCats'),
  btnClearCategories: $('btnClearCategories'),
  // 找回：重新检查 / 按新位置找回
  relinkStats: $('relinkStats'),
  btnRelinkCheck: $('btnRelinkCheck'),
  btnRelinkFolder: $('btnRelinkFolder'),
  // 存储位置 / 备份 / 悬停试听
  storagePath: $('storagePath'),
  storageHint: $('storageHint'),
  btnStorageOpen: $('btnStorageOpen'),
  btnStorageMove: $('btnStorageMove'),
  btnStorageReset: $('btnStorageReset'),
  backupList: $('backupList'),
  btnBackupNow: $('btnBackupNow'),
  btnBackupOpen: $('btnBackupOpen'),
  chkHoverAudition: $('chkHoverAudition'),
  hoverAuditionHint: $('hoverAuditionHint'),
  hoverDelay: $('hoverDelay'),
  hoverDelayVal: $('hoverDelayVal'),
  hoverAuditionDesc: $('hoverAuditionDesc'),
  toast: $('toast')
};

const wave = new WaveView(
  dom.waveWrap,
  dom.waveCanvas,
  (() => {
    const c = document.createElement('canvas');
    c.id = 'waveHead';
    c.style.position = 'absolute';
    c.style.inset = '0';
    c.style.pointerEvents = 'none';
    dom.waveWrap.appendChild(c);
    return c;
  })()
);

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
let toastTimer = null;
function toast(msg, opts = {}) {
  const ms = typeof opts === 'number' ? opts : (opts.ms || 2200);
  const action = typeof opts === 'object' ? opts.action : null;

  dom.toast.textContent = msg;
  dom.toast.classList.toggle('has-action', !!action);
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.type = 'button';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      dom.toast.classList.remove('show');
      if (toastTimer) clearTimeout(toastTimer);
      action.run();
    });
    dom.toast.appendChild(btn);
  }

  dom.toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.remove('show'), ms);
}

// ---------------------------------------------------------------------------
// View computation
// ---------------------------------------------------------------------------
function plural(n, unit) { return `${n} ${unit}`; }

/** Bucket for clips that belong to no category. */
const UNCATEGORIZED = '未分类';

function computeView() {
  const q = state.search.trim().toLowerCase();
  const terms = q ? q.split(/\s+/).filter(Boolean) : [];
  let list = state.items;

  const f = state.filter;
  if (f.type === 'ai') {
    const ids = new Set([AI_ROOT_ID, ...categoryDescendantIds(AI_ROOT_ID)]);
    list = list.filter((i) => i.categoryId && ids.has(i.categoryId));
  } else if (f.type === 'missing') {
    list = list.filter((i) => i.missing);
  } else if (f.type === 'collection') {
    const ids = f.ids && f.ids.length ? f.ids : [f.value];
    list = list.filter((i) => ids.some((id) => i.collections.includes(id)));
  } else if (f.type === 'category') {
    const ids = f.ids && f.ids.length ? f.ids : [f.value];
    // 点文件夹 = 看整棵子树：子分类里的音频也要算进来。
    // 索引只建一次，别在子树展开里反复 O(分类数) 地扫。
    const ix = categoryTreeIndex();
    const keepCats = new Set();
    let wantUncat = false;
    for (const id of ids) {
      if (id === UNCAT_SENTINEL) { wantUncat = true; continue; }
      for (const x of categorySubtreeIds(id, ix)) keepCats.add(x);
    }
    list = list.filter((i) => (wantUncat && !i.categoryId) ||
      (i.categoryId && keepCats.has(i.categoryId)));
  } else if (f.type === 'format') {
    list = list.filter((i) => extOf(i.name) === f.value);
  }

  if (terms.length) {
    list = list.filter((i) => terms.every((t) => i.haystack.includes(t)));
  }

  // Agent 检索的「只看这些结果」：按相关度顺序展示，忽略当前排序键
  const aiRank = aiRankMap();
  if (aiRank) {
    list = list.filter((i) => aiRank.has(i.path));
    list = list.slice().sort((a, b) => aiRank.get(a.path).rank - aiRank.get(b.path).rank);
    state.view = list;
    return;
  }

  const key = state.sort.key;
  const dir = state.sort.dir;
  const metaVal = (i, k) => (i.meta ? (i.meta[k] || 0) : -1);

  const sorters = {
    addedAt: (a, b) => a.addedAt - b.addedAt,
    name: (a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }),
    duration: (a, b) => metaVal(a, 'duration') - metaVal(b, 'duration'),
    sampleRate: (a, b) => metaVal(a, 'sampleRate') - metaVal(b, 'sampleRate'),
    bitDepth: (a, b) => metaVal(a, 'bitDepth') - metaVal(b, 'bitDepth'),
    channels: (a, b) => metaVal(a, 'channels') - metaVal(b, 'channels'),
    size: (a, b) => a.size - b.size,
    format: (a, b) => extOf(a.name).localeCompare(extOf(b.name))
  };

  const sorter = sorters[key] || sorters.addedAt;
  list = list.slice().sort((a, b) => {
    const r = sorter(a, b);
    return r !== 0 ? r * dir : a.addedAt - b.addedAt;
  });

  state.view = list;
}

// ---------------------------------------------------------------------------
// Rendering: sidebar
// ---------------------------------------------------------------------------
function renderSidebar() {
  const total = state.items.length;
  const missing = state.items.filter((i) => i.missing).length;
  dom.countAll.textContent = String(total);
  dom.countMissing.textContent = String(missing);
  if (dom.countAi) dom.countAi.textContent = String(aiLibraryCount());

  // Categories
  renderCategories();

  // Formats
  const fmtCounts = new Map();
  for (const it of state.items) {
    const e = extOf(it.name);
    if (!e) continue;
    fmtCounts.set(e, (fmtCounts.get(e) || 0) + 1);
  }
  const fmts = [...fmtCounts.entries()].sort((a, b) => b[1] - a[1]);
  const fFrag = document.createDocumentFragment();
  for (const [e, n] of fmts) {
    const chip = document.createElement('button');
    chip.className = 'fmt-chip';
    chip.dataset.filter = 'format';
    chip.dataset.value = e;
    if (state.filter.type === 'format' && state.filter.value === e) chip.classList.add('active');
    chip.textContent = `${e} ${n}`;
    fFrag.appendChild(chip);
  }
  dom.formatList.replaceChildren(fFrag);

  renderCollections();
  renderStats();
}

// ---------------------------------------------------------------------------
// Categories (one per clip; seeded from the UCS name, fully editable)
// ---------------------------------------------------------------------------
const UNCAT_SENTINEL = '__uncat__';

// 内置分类："经过处理"。导出修剪片段时新条目自动落到这里，
// 并且它固定排在分类列表最上面（pinned），不能删。
const AI_ROOT_ID = 'cat_ai_lib';
const AI_ROOT_NAME = 'AI 音效库';
const PROCESSED_ID = 'cat_processed';
const PROCESSED_NAME = '经过处理';

/**
 * 「AI 音效库」根分类：侧栏资料库里固定出现的一行。
 * 每次云端生成都在这下面建一个子分类（「2026-11-16 20:44 · 点状动效」），
 * 生成的音频都落在对应子分类里，便于按批次找回。
 */
function ensureAiLibraryRoot() {
  let cat = state.categories.find((c) => c.id === AI_ROOT_ID);
  if (!cat) {
    cat = { id: AI_ROOT_ID, name: AI_ROOT_NAME, parentId: null, auto: null, pinned: true };
    state.categories.unshift(cat);
  } else {
    cat.name = AI_ROOT_NAME;
    cat.parentId = null;
    cat.pinned = true;
  }
  return cat;
}

/** 侧栏「AI 音效库」这一行的计数：根分类 + 所有子分类里的音频。 */
function aiLibraryCount() {
  const root = state.categories.find((c) => c.id === AI_ROOT_ID);
  if (!root) return 0;
  const ids = new Set([AI_ROOT_ID, ...categoryDescendantIds(AI_ROOT_ID)]);
  let n = 0;
  for (const it of state.items) if (it.categoryId && ids.has(it.categoryId)) n++;
  return n;
}

/** 给这一批生成建一个子分类，名字带时间与类型。 */
function createAiBatchCategory(label) {
  ensureAiLibraryRoot();
  const d = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  let name = stamp + (label ? ' · ' + label : '');
  // 同一分钟连生成两次时加序号，避免同层重名建不出来
  let n = 2;
  const base = name;
  while (state.categories.some((c) => c.name === name && catParentId(c) === AI_ROOT_ID)) {
    name = base + ' (' + n + ')';
    n += 1;
  }
  const cat = { id: newCategoryId(), name: name, parentId: AI_ROOT_ID, auto: null };
  state.categories.push(cat);
  setCatCollapsed(AI_ROOT_ID, false);
  return cat;
}

function ensureProcessedCategory() {
  let cat = state.categories.find((c) => c.id === PROCESSED_ID);
  if (!cat) {
    cat = { id: PROCESSED_ID, name: PROCESSED_NAME, auto: null, pinned: true };
    state.categories.unshift(cat);
  } else {
    cat.pinned = true;
  }
  return cat;
}

/** Category record an item belongs to, or null for the uncategorized bucket. */
function categoryRecordOf(it) {
  if (!it || !it.categoryId) return null;
  return state.categories.find((c) => c.id === it.categoryId) || null;
}

/**
 * Display name of the category an item belongs to. Used by both the sidebar
 * counts and the filter, because when those two disagree the count advertises
 * files that the filter then refuses to show.
 */
function categoryOf(it) {
  const c = categoryRecordOf(it);
  return c ? c.name : UNCATEGORIZED;
}

function newCategoryId() {
  return 'cat_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function categoryById(id) {
  return state.categories.find((c) => c.id === id) || null;
}

function categoryName(id) {
  const c = categoryById(id);
  return c ? c.name : '';
}

function countInCategory(id) {
  let n = 0;
  for (const it of state.items) if ((it.categoryId || null) === id) n++;
  return n;
}

// ---------------------------------------------------------------------------
// 分类树（文件夹 / 子文件夹）
//
// 每条分类记录多一个 parentId；侧栏按层级画，文件夹左侧有倒三角。
// 点文件夹等于看它自己和所有子文件夹里的音频，计数也是整棵子树的和。
// ---------------------------------------------------------------------------
function catParentId(cat) {
  return cat && cat.parentId && categoryById(cat.parentId) && cat.parentId !== cat.id
    ? cat.parentId
    : null;
}

/** 直接子分类（按 state.categories 里的顺序，也就是用户的排列顺序）。 */
function categoryChildren(id) {
  return state.categories.filter((c) => catParentId(c) === (id || null));
}

function categoryHasKids(id) {
  return state.categories.some((c) => catParentId(c) === id);
}

function categoryDescendantIds(id, out = []) {
  for (const c of categoryChildren(id)) {
    if (out.includes(c.id)) continue;
    out.push(c.id);
    categoryDescendantIds(c.id, out);
  }
  return out;
}

/**
 * 自己 + 所有子孙分类的 id。
 *
 * 早期版本走 categoryDescendantIds → categoryChildren，每次都对 1553 条分类做一遍
 * filter，子树一大就是几十万次比较；用户那份清单里点「106 Fields」（4428 条素材）
 * 会同步卡 8 秒。这里改成用 kidsOf 索引一趟走完（线性）。
 */
function categorySubtreeIds(id, ix = null) {
  const { kidsOf } = ix || categoryTreeIndex();
  const out = [];
  const seen = new Set([id]);
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const k of kidsOf.get(cur) || []) {
      if (seen.has(k.id)) continue;
      seen.add(k.id);
      out.push(k.id);
      stack.push(k.id);
    }
  }
  return [id, ...out];
}

function categoryDepth(id) {
  let d = 0;
  let cur = categoryById(id);
  const seen = new Set();
  while (cur && catParentId(cur) && !seen.has(cur.id)) {
    seen.add(cur.id);
    d++;
    cur = categoryById(catParentId(cur));
  }
  return d;
}

/** 整棵子树的音频数。 */
function countInCategoryTree(id) {
  const ids = new Set(categorySubtreeIds(id));
  let n = 0;
  for (const it of state.items) if (it.categoryId && ids.has(it.categoryId)) n++;
  return n;
}

/**
 * 一次遍历算好侧栏要用的所有东西：子分类表、每棵子树的音频数、未分类数。
 *
 * 之前 renderCategories 对每一行都调 categoryChildren()（内部又是 O(分类数) 的
 * find）和 countInCategoryTree()（O(素材数)），分类一多就是平方级——用户那份
 * 1553 个分类的清单一渲染要 2.6 秒，点一下卡住 5 秒。这里改成线性。
 */
function categoryTreeIndex() {
  const byId = new Map(state.categories.map((c) => [c.id, c]));
  const parentOf = (c) => (c && c.parentId && byId.has(c.parentId) && c.parentId !== c.id ? c.parentId : null);

  const kidsOf = new Map();
  for (const c of state.categories) {
    const p = parentOf(c);
    if (!p) continue;
    if (!kidsOf.has(p)) kidsOf.set(p, []);
    kidsOf.get(p).push(c);
  }

  const total = new Map();
  let uncat = 0;
  for (const it of state.items) {
    if (!it.categoryId) { uncat++; continue; }
    total.set(it.categoryId, (total.get(it.categoryId) || 0) + 1);
  }

  // 先排出一个父在子前的顺序，再从后往前把子树的数加到父级，每个分类只碰一次。
  const order = [];
  const seen = new Set();
  const push = (c) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    order.push(c);
    for (const k of kidsOf.get(c.id) || []) push(k);
  };
  for (const c of state.categories) if (!parentOf(c)) push(c);
  for (const c of state.categories) if (!seen.has(c.id)) push(c); // 兜底：孤儿或环
  for (let i = order.length - 1; i >= 0; i--) {
    const c = order[i];
    const p = parentOf(c);
    if (p) total.set(p, (total.get(p) || 0) + (total.get(c.id) || 0));
  }

  return { kidsOf, total, uncat, roots: state.categories.filter((c) => !parentOf(c)) };
}

/** 老清单没有 parentId；把悬空父级和成环的父级退回顶层，别让侧栏画崩。 */
function repairCategoryTree() {
  const byId = new Map(state.categories.map((c) => [c.id, c]));
  for (const c of state.categories) {
    if (!c.parentId) { c.parentId = null; continue; }
    if (!byId.has(c.parentId) || c.parentId === c.id) { c.parentId = null; continue; }
    const seen = new Set([c.id]);
    let p = byId.get(c.parentId);
    let bad = false;
    while (p) {
      if (seen.has(p.id)) { bad = true; break; }
      seen.add(p.id);
      p = p.parentId ? byId.get(p.parentId) : null;
    }
    if (bad) c.parentId = null;
  }
}

function isCatCollapsed(id) {
  return state.collapsedCats.includes(id);
}

function setCatCollapsed(id, on) {
  const i = state.collapsedCats.indexOf(id);
  if (on && i < 0) state.collapsedCats.push(id);
  if (!on && i >= 0) state.collapsedCats.splice(i, 1);
}

/** 让某个分类可见：把它的祖先都展开。 */
function revealCategory(id) {
  let cur = categoryById(id);
  const seen = new Set();
  while (cur && catParentId(cur) && !seen.has(cur.id)) {
    seen.add(cur.id);
    setCatCollapsed(catParentId(cur), false);
    cur = categoryById(catParentId(cur));
  }
}

/**
 * Give an item its category, creating the UCS-seeded category on first use.
 * Items the user already placed keep their choice: a re-import must not steal
 * a clip out of the category someone filed it into.
 */
function ensureCategory(it) {
  if (!it) return;
  if (it.categoryId && categoryById(it.categoryId)) return;
  it.categoryId = null;
  const auto = it.ucs && it.ucs.category ? it.ucs.category : null;
  if (!auto) return;
  if (state.hiddenCategoryAutos.includes(auto)) return;
  let cat = state.categories.find((c) => c.auto === auto);
  if (!cat) {
    cat = { id: newCategoryId(), name: auto, auto };
    state.categories.push(cat);
  }
  it.categoryId = cat.id;
}

function ensureAllCategories() {
  for (const it of state.items) ensureCategory(it);
}

function createCategory(name, seedItems, parentId) {
  const clean = (name || '').trim();
  if (!clean) return null;
  const parent = parentId ? categoryById(parentId) : null;
  // 只在同一层里查重：A/金属 和 B/金属 是允许的
  if (state.categories.some((c) => c.name === clean && catParentId(c) === (parent ? parent.id : null))) {
    toast('这一层已经有同名分类');
    return null;
  }
  const cat = { id: newCategoryId(), name: clean, parentId: parent ? parent.id : null, auto: null };
  state.categories.push(cat);
  if (parent) {
    setCatCollapsed(parent.id, false);
    revealCategory(parent.id);
  }
  if (seedItems && seedItems.length) addItemsToCategory(seedItems, cat.id, true);
  scheduleSave();
  renderSidebar();
  toast(parent ? `已在「${parent.name}」里新建「${clean}」` : `已新建分类「${clean}」`);
  return cat;
}

function renameCategory(id, name) {
  const clean = (name || '').trim();
  const cat = categoryById(id);
  if (!cat || !clean || clean === cat.name) return;
  if (state.categories.some((c) => c.name === clean && c.id !== id)) {
    toast('已存在同名分类');
    return;
  }
  cat.name = clean;
  scheduleSave();
  renderSidebar();
}

function addItemsToCategory(items, id, silent) {
  const cat = categoryById(id);
  if (!cat) return 0;
  let n = 0;
  for (const it of items) {
    if (!it || it.categoryId === id) continue;
    it.categoryId = id;
    n++;
  }
  if (n) {
    scheduleSave();
    if (!silent) {
      toast(`已移动到「${cat.name}」${n > 1 ? `（${n} 个）` : ''}`);
      if (state.filter.type === 'category') { computeView(); scheduleRender(); }
      renderSidebar();
    }
  } else if (!silent) {
    toast(`已在「${cat.name}」中`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Detaching items from the library
//
// Deleting a category or a library takes its contents with it: those clips
// leave the list (the files on disk are never touched) instead of piling up
// in 未分类. Both directions are reversible through the undo toast, which is
// why the undo window for these is longer than the usual 6.5s.
// ---------------------------------------------------------------------------

/** Take items out of the library. Returns snapshots for reattachItems(). */
function detachItems(items) {
  const snap = [];
  const paths = new Set();
  for (const it of items) {
    if (!it) continue;
    const i = state.items.indexOf(it);
    if (i < 0) continue;
    snap.push({ it, index: i });
    state.byPath.delete(it.path);
    state.items.splice(i, 1);
    paths.add(it.path);
  }
  if (!snap.length) return snap;
  // 用户把最后一条也删掉了：这才允许写空清单
  if (!state.items.length) emptyByUser = true;
  for (const p of paths) state.selection.delete(p);
  if (state.currentPath && paths.has(state.currentPath)) {
    player.stop();
    state.currentPath = null;
    state.playing = false;
    updateWavePanel();
    updateTransport();
  }
  return snap;
}

/** Put detached items back at (roughly) the index they came from. */
function reattachItems(snap) {
  let n = 0;
  for (const { it, index } of snap.slice().sort((a, b) => a.index - b.index)) {
    if (state.byPath.has(it.path)) continue;
    const at = Math.max(0, Math.min(index, state.items.length));
    state.items.splice(at, 0, it);
    state.byPath.set(it.path, it);
    n++;
  }
  if (!n) return 0;
  emptyByUser = false;
  computeView();
  renderSidebar();
  scheduleRender();
  scheduleSave();
  return n;
}

/** Delete a category together with its clips (they do not fall back to 未分类). */
function deleteCategory(id) {
  const cat = categoryById(id);
  if (!cat) return;
  if (cat.pinned) { toast(`「${cat.name}」是内置分类，不能删除`); return; }

  // 文件夹连同里面的子分类一起删：只删外壳会把子分类变成孤儿，看着像丢了
  const cats = categorySubtreeIds(id)
    .map((x) => categoryById(x))
    .filter((c) => c && !c.pinned);
  if (!cats.length) return;
  const idSet = new Set(cats.map((c) => c.id));
  const snaps = cats.map((c) => ({ cat: c, index: state.categories.indexOf(c) }));
  const snap = detachItems(state.items.filter((it) => it.categoryId && idSet.has(it.categoryId)));

  for (const c of cats) {
    state.categories = state.categories.filter((x) => x.id !== c.id);
    // 记住 UCS 前缀，免得下次导入又把它建回来
    if (c.auto && !state.hiddenCategoryAutos.includes(c.auto)) state.hiddenCategoryAutos.push(c.auto);
    setCatCollapsed(c.id, false);
  }
  if (state.filter.type === 'category' && idSet.has(state.filter.value)) {
    state.filter = { type: 'all', value: null };
  }
  computeView();
  // 数据删了，侧栏那张 DOM 还在：不重画的话分类行和计数会留在屏幕上，
  // 看着像"删了但分类还在"（用户报过）。批量删 deleteCategories 本来就有这行。
  renderSidebar();
  scheduleRender();
  scheduleSave();

  const extraKids = cats.length > 1 ? `及其 ${cats.length - 1} 个子分类` : '';
  toast(`已删除分类「${cat.name}」${extraKids}${snap.length ? `，${snap.length} 个音频一并移除` : ''}`, {
    ms: 12000,
    action: {
      label: '撤销',
      run: () => {
        reattachItems(snap);
        for (const s of snaps.slice().sort((a, b) => a.index - b.index)) {
          if (categoryById(s.cat.id)) continue;
          const at = Math.max(0, Math.min(s.index, state.categories.length));
          state.categories.splice(at, 0, s.cat);
          const hi = state.hiddenCategoryAutos.indexOf(s.cat.auto);
          if (hi >= 0) state.hiddenCategoryAutos.splice(hi, 1);
        }
        scheduleSave();
        renderSidebar();
        computeView();
        scheduleRender();
        toast('已撤销');
      }
    }
  });
}

function undoDeleteCategory(cat, memberPaths, index) {
  if (categoryById(cat.id)) return;
  const at = Math.max(0, Math.min(index, state.categories.length));
  state.categories.splice(at, 0, cat);
  const hi = state.hiddenCategoryAutos.indexOf(cat.auto);
  if (hi >= 0) state.hiddenCategoryAutos.splice(hi, 1);
  let n = 0;
  for (const p of memberPaths) {
    const it = state.byPath.get(p);
    if (it && !it.categoryId) { it.categoryId = cat.id; n++; }
  }
  scheduleSave();
  renderSidebar();
  if (state.filter.type === 'category') { computeView(); scheduleRender(); }
  toast(`已恢复分类「${cat.name}」${n ? `，${n} 个音频` : ''}`);
}

function doDeleteCategory(id, opts = {}) {
  const cat = categoryById(id);
  if (!cat) return;
  state.categories = state.categories.filter((c) => c.id !== id);
  // Remember the UCS prefix so a later import does not resurrect it.
  if (cat.auto && !state.hiddenCategoryAutos.includes(cat.auto)) {
    state.hiddenCategoryAutos.push(cat.auto);
  }
  for (const it of state.items) {
    if (it.categoryId === id) it.categoryId = null;
  }
  if (state.filter.type === 'category' && state.filter.value === id) {
    state.filter = { type: 'all', value: null };
    computeView();
    scheduleRender();
  }
  scheduleSave();
  renderSidebar();
  if (!opts.quiet) toast(`已删除分类「${cat.name}」`);
}

// ---------------------------------------------------------------------------
// 清理维护：已丢失的音频 / 空分类 / 清空所有分类
// ---------------------------------------------------------------------------
// 三种清理都走"先留快照 → 改 → toast 里给撤销"，和删分类/删资料库一个套路。
// 空分类的判定看子树计数：父分类自己没音频、子分类也全空，就一起算空。

function missingItemCount() {
  let n = 0;
  for (const it of state.items) if (it.missing) n++;
  return n;
}

/** 子树里一条音频都没有的分类（内置「经过处理」永远留着）。 */
function emptyCategoryIds() {
  const ix = categoryTreeIndex();
  const out = [];
  for (const c of state.categories) {
    if (c.pinned) continue;
    if ((ix.total.get(c.id) || 0) > 0) continue;
    out.push(c.id);
  }
  return out;
}

function cleanupStatsText() {
  const miss = missingItemCount();
  const empty = emptyCategoryIds().length;
  const cats = state.categories.filter((c) => !c.pinned).length;
  return `丢失音频 ${miss} 条 · 空分类 ${empty} 个 · 可清空分类 ${cats} 个`;
}

function renderCleanupStats() {
  if (!dom.cleanupStats) return;
  dom.cleanupStats.textContent = cleanupStatsText();
}

/** 设置页「找回丢失素材」那一行统计。 */
function renderRelinkStats() {
  if (!dom.relinkStats) return;
  const miss = missingItemCount();
  const total = state.items.length;
  if (!miss) {
    dom.relinkStats.textContent = `${total} 条素材，全部能找到文件`;
    return;
  }
  // 缺失的都在哪个盘上：给一句更有用的提示
  const roots = new Map();
  for (const it of state.items) {
    if (!it.missing) continue;
    const m = /^([A-Za-z]:\\|\\\\[^\\]+)/.exec(it.path);
    const k = m ? m[1] : '其他';
    roots.set(k, (roots.get(k) || 0) + 1);
  }
  const where = [...roots.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, n]) => `${k}（${n}）`)
    .join('、');
  dom.relinkStats.textContent = `${miss} / ${total} 条找不到文件，主要在：${where || '—'}`;
}

// ---------------------------------------------------------------------------
// 存储位置与备份
//
// 「存储更换」实际搬文件的是主进程；这里只负责问路径、确认、搬完重启。
// 备份是每天启动自动留一份清单，设置页里能手动备份、也能挑一个日期恢复。
// ---------------------------------------------------------------------------
function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 ** 3) return (v / 1024 ** 3).toFixed(2) + ' GB';
  if (v >= 1024 ** 2) return (v / 1024 ** 2).toFixed(1) + ' MB';
  if (v >= 1024) return Math.round(v / 1024) + ' KB';
  return v + ' B';
}

async function renderStorageInfo() {
  if (!dom.storagePath) return;
  try {
    const info = await sb.invoke('storage:info');
    if (!info || !info.ok) { dom.storagePath.textContent = '读取失败'; return; }
    dom.storagePath.textContent = info.current;
    dom.storagePath.title = info.current;
    if (dom.storageHint) {
      dom.storageHint.textContent = info.custom
        ? `当前用的是自己指定的位置（清单 ${fmtBytes(info.libraryBytes)}，整个目录 ${fmtBytes(info.size)}）。换回去点「恢复默认位置」。`
        : `清单 ${fmtBytes(info.libraryBytes)}，整个目录 ${fmtBytes(info.size)}。C 盘紧张时点「迁移到…」把它搬到别的盘。`;
    }
  } catch {
    dom.storagePath.textContent = '读取失败';
  }
}

async function migrateStorage() {
  const pick = await sb.invoke('dialog:pick-folder', { title: '选择新的数据目录（会新建一个 SoundBin-data 子目录）' });
  const dirs = Array.isArray(pick) ? pick : (pick && pick.dirs) || [];
  if (!dirs.length) return;
  const base = dirs[0];
  const target = base.replace(/[\\/]+$/, '') + '\\SoundBin-data';
  showBatchDialog({
    title: '迁移数据目录',
    hint: `把清单和缓存整个搬到：\n${target}\n\n搬完程序会自动重启；原来的 data\ 不会自动删除，确认新位置能用之后可以自己删掉。`,
    lines: ['数据位置迁移需要几秒到几十秒（取决于缓存大小）', '迁移过程中请不要关闭程序'],
    okText: '开始迁移',
    onOk: async () => {
      closeBatchDialog();
      toast('正在迁移数据…', { ms: 4000 });
      const r = await sb.invoke('storage:migrate', target);
      if (!r || !r.ok) {
        toast('迁移失败：' + ((r && r.reason) || '未知原因'), { ms: 8000 });
        return;
      }
      toast('迁移完成，正在重启…', { ms: 2000 });
      sb.invoke('app:relaunch');
    }
  });
}

async function resetStorage() {
  const info = await sb.invoke('storage:info').catch(() => null);
  if (!info || !info.custom) { toast('现在就是默认位置'); return; }
  showBatchDialog({
    title: '恢复默认数据位置',
    hint: '迁移记录会被清除，下次启动回到程序旁边（便携版是 exe 旁的 data\\)。\n原来搬走的目录不会自动删除，里面的清单还在，可以自己拷回来。',
    lines: [`当前：${info.current}`],
    okText: '恢复并重启',
    onOk: async () => {
      closeBatchDialog();
      const r = await sb.invoke('storage:reset');
      if (!r || !r.ok) { toast('恢复失败'); return; }
      sb.invoke('app:relaunch');
    }
  });
}

async function renderBackupList() {
  if (!dom.backupList) return;
  try {
    const r = await sb.invoke('backup:list');
    const list = (r && r.list) || [];
    if (!list.length) { dom.backupList.textContent = '还没有备份'; return; }
    dom.backupList.replaceChildren();
    dom.backupList.appendChild(document.createTextNode('点日期可恢复：'));
    list.slice(0, 7).forEach((b, i) => {
      // library-2026-11-14.json → 11-14；library-2026-11-14-171907.json → 11-14 17:19
      const m = /^library-(\d{4})-(\d{2})-(\d{2})(?:-(\d{2})(\d{2})\d{2})?\.json$/.exec(b.name);
      const name = m
        ? (m[4] ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : `${m[2]}-${m[3]}`)
        : b.name.replace(/^library-|\.json$/g, '');
      const a = document.createElement('a');
      a.href = '#';
      a.className = 'backup-link';
      a.textContent = name;
      a.title = `${fmtBytes(b.bytes)} · 点一下恢复这份`;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        restoreBackup(b.name, name);
      });
      if (i) dom.backupList.appendChild(document.createTextNode(' · '));
      dom.backupList.appendChild(a);
    });
  } catch {
    dom.backupList.textContent = '读取失败';
  }
}

function restoreBackup(file, label) {
  showBatchDialog({
    title: '从备份恢复清单',
    hint: `用 ${label} 的备份覆盖当前清单。\n\n恢复前会先把「现在的清单」再存一份到备份目录，所以做错了还能退回来。恢复后程序自动重启。`,
    lines: ['会丢的是：这份备份之后新增的条目与分类', '不会动的是：磁盘上的音频文件本身'],
    okText: '恢复并重启',
    onOk: async () => {
      closeBatchDialog();
      const r = await sb.invoke('backup:restore', file);
      if (!r || !r.ok) { toast('恢复失败：' + ((r && r.reason) || ''), { ms: 7000 }); return; }
      toast('已恢复，正在重启…', { ms: 1500 });
      sb.invoke('app:relaunch');
    }
  });
}

async function createBackupNow() {
  const r = await sb.invoke('backup:create');
  if (r && r.ok) {
    toast('已备份：' + r.name);
    renderBackupList();
  } else {
    toast('备份失败：' + ((r && r.reason) || '未知原因'));
  }
}

// ---------------------------------------------------------------------------
// 悬停即试听
//
// 停 0.7 秒才开始播，避免鼠标扫过列表时一路响；播 8 秒自动停，移开立刻停。
// 有东西正在播（用户自己点的）就不抢——否则找素材的时候会被打断。
// ---------------------------------------------------------------------------
let hoverTimer = 0;
let hoverStopTimer = 0;
let hoverPath = null;
// 当前这声音是不是"悬停放出来的"：是的话，移到别的行可以直接切走；
// 用户自己点/空格放的那条不许被悬停打断。
let hoverPlayingPath = null;
// 悬停发起 playItem 时置真，用来区分"这条是悬停放的吗"
let hoverPlayIntent = false;

function hoverDelayMs() {
  const sec = Number(state.hoverDelay);
  return Math.round((Number.isFinite(sec) ? Math.min(3, Math.max(0.1, sec)) : 0.3) * 1000);
}

function cancelHoverPreview(stopAudio) {
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0; }
  if (hoverStopTimer) { clearTimeout(hoverStopTimer); hoverStopTimer = 0; }
  const p = hoverPath;
  hoverPath = null;
  const stopPath = hoverPlayingPath;
  hoverPlayingPath = null;
  if (stopAudio && stopPath && state.currentPath === stopPath) {
    player.pause();
    state.playing = false;
    updateTransport();
    scheduleRender();
  }
  void p;
}

/** 用户自己点了某一行 / 按了播放键：这条不再算"悬停播放"，以后移开也不停它。 */
function releaseHoverPlayback() {
  hoverPlayingPath = null;
  if (hoverStopTimer) { clearTimeout(hoverStopTimer); hoverStopTimer = 0; }
}

function queueHoverPreview(it) {
  if (!state.hoverAudition) return;
  if (!it || it.missing || state.loading) return;
  // 同一行已经在等着/已经在放：不用重来
  if (hoverPath === it.path && (hoverTimer || (state.currentPath === it.path && state.playing))) return;
  // 谁在占着喇叭？
  if (state.playing) {
    const byHover = hoverPlayingPath && state.currentPath === hoverPlayingPath;
    if (state.currentPath === it.path) return;
    // 用户自己放的那条：不抢；悬停放的那条：直接换过去
    if (!byHover) return;
  }
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0; }
  if (hoverStopTimer) { clearTimeout(hoverStopTimer); hoverStopTimer = 0; }
  hoverPath = it.path;
  hoverTimer = setTimeout(() => {
    hoverTimer = 0;
    if (!state.hoverAudition || hoverPath !== it.path) return;
    if (state.playing) {
      const byHover = hoverPlayingPath && state.currentPath === hoverPlayingPath;
      if (!byHover && state.currentPath !== it.path) return;
    }
    hoverPlayIntent = true;
    playItem(it).then(() => {
      if (hoverPath !== it.path) return;
      hoverPlayingPath = it.path;
      hoverStopTimer = setTimeout(() => {
        hoverStopTimer = 0;
        if (hoverPath === it.path) cancelHoverPreview(true);
      }, 8000);
    }).catch(() => {}).finally(() => { hoverPlayIntent = false; });
  }, hoverDelayMs());
}

function applyHoverAudition() {
  if (dom.chkHoverAudition) dom.chkHoverAudition.checked = !!state.hoverAudition;
  if (dom.hoverAuditionHint) dom.hoverAuditionHint.textContent = state.hoverAudition ? '悬停即试听' : '悬停不试听';
  const sec = Number(state.hoverDelay) || 0.3;
  if (dom.hoverDelay) {
    dom.hoverDelay.value = String(Math.round(sec * 10));
    dom.hoverDelay.disabled = !state.hoverAudition;
  }
  if (dom.hoverDelayVal) dom.hoverDelayVal.textContent = `${sec.toFixed(1)} s`;
  if (dom.hoverAuditionDesc) {
    dom.hoverAuditionDesc.textContent = state.hoverAudition
      ? `鼠标在列表某一行停 ${sec.toFixed(1)} 秒开始播（播 8 秒自动停）；移到同一目录下别的行会直接换过去，不用点。正在手动播放的那条不会被抢。`
      : '悬停即试听已关闭：只有点击才会播放。';
  }
  if (!state.hoverAudition) cancelHoverPreview(true);
}


/** 把 missing 的条目从清单里摘掉（不删磁盘文件，可撤销）。 */
function purgeMissingItems(opts = {}) {
  const targets = state.items.filter((it) => it.missing);
  if (!targets.length) {
    if (!opts.quiet) toast('没有已丢失的音频');
    return { count: 0, undo: null };
  }
  const snap = detachItems(targets);
  computeView();
  renderSidebar();
  scheduleRender();
  scheduleSave();
  renderCleanupStats();
  const undo = () => {
    reattachItems(snap);
    renderCleanupStats();
    toast('已撤销');
  };
  if (!opts.quiet) {
    toast(`已清除 ${snap.length} 条已丢失的音频`, { ms: 12000, action: { label: '撤销', run: undo } });
  }
  return { count: snap.length, undo };
}

function purgeEmptyCategories(opts = {}) {
  const ids = emptyCategoryIds();
  if (!ids.length) {
    if (!opts.quiet) toast('没有空分类');
    return { count: 0, undo: null };
  }
  const idSet = new Set(ids);
  const snaps = [];
  for (const c of state.categories) {
    if (idSet.has(c.id)) snaps.push({ cat: c, index: state.categories.indexOf(c) });
  }
  const hiddenPushed = [];
  for (const c of state.categories) {
    if (!idSet.has(c.id)) continue;
    if (c.auto && !state.hiddenCategoryAutos.includes(c.auto)) {
      state.hiddenCategoryAutos.push(c.auto);
      hiddenPushed.push(c.auto);
    }
    setCatCollapsed(c.id, false);
  }
  state.categories = state.categories.filter((c) => !idSet.has(c.id));
  if (state.filter.type === 'category' && idSet.has(state.filter.value)) {
    state.filter = { type: 'all', value: null };
  }
  if (state.sideSelection && state.sideSelection.type === 'category') {
    for (const id of [...state.sideSelection.ids]) if (idSet.has(id)) state.sideSelection.ids.delete(id);
  }
  renderSidebar();
  computeView();
  scheduleRender();
  scheduleSave();
  renderCleanupStats();

  const undo = () => {
    for (const s of snaps.slice().sort((a, b) => a.index - b.index)) {
      if (categoryById(s.cat.id)) continue;
      const at = Math.max(0, Math.min(s.index, state.categories.length));
      state.categories.splice(at, 0, s.cat);
    }
    for (const a of hiddenPushed) {
      const i = state.hiddenCategoryAutos.indexOf(a);
      if (i >= 0) state.hiddenCategoryAutos.splice(i, 1);
    }
    renderSidebar();
    computeView();
    scheduleRender();
    scheduleSave();
    renderCleanupStats();
    toast('已撤销');
  };
  if (!opts.quiet) {
    toast(`已清除 ${snaps.length} 个空分类`, { ms: 12000, action: { label: '撤销', run: undo } });
  }
  return { count: snaps.length, undo };
}

/**
 * 清空所有分类：分类连同里面的音频一起删掉（和右键删分类一个语义，只是范围是全部分类）。
 * 内置「经过处理」永远保留；没归到任何分类的音频不受影响。整批可撤销。
 */
function clearAllCategories(opts = {}) {
  const targets = state.categories.filter((c) => !c.pinned);
  if (!targets.length) {
    if (!opts.quiet) toast('没有可清空的分类');
    return { count: 0, items: 0, undo: null };
  }
  const snaps = targets.map((c) => ({ cat: c, index: state.categories.indexOf(c) }));
  const hiddenPushed = [];
  for (const c of targets) {
    if (c.auto && !state.hiddenCategoryAutos.includes(c.auto)) {
      state.hiddenCategoryAutos.push(c.auto);
      hiddenPushed.push(c.auto);
    }
  }
  const idSet = new Set(targets.map((c) => c.id));
  const snap = detachItems(state.items.filter((it) => it.categoryId && idSet.has(it.categoryId)));
  state.categories = state.categories.filter((c) => c.pinned);
  state.collapsedCats = [];
  state.filter = { type: 'all', value: null };
  if (state.sideSelection && state.sideSelection.type === 'category') state.sideSelection.ids.clear();
  renderSidebar();
  computeView();
  scheduleRender();
  scheduleSave();
  renderCleanupStats();

  const undo = () => {
    reattachItems(snap);
    for (const s of snaps.slice().sort((a, b) => a.index - b.index)) {
      if (categoryById(s.cat.id)) continue;
      const at = Math.max(0, Math.min(s.index, state.categories.length));
      state.categories.splice(at, 0, s.cat);
    }
    for (const a of hiddenPushed) {
      const i = state.hiddenCategoryAutos.indexOf(a);
      if (i >= 0) state.hiddenCategoryAutos.splice(i, 1);
    }
    renderSidebar();
    computeView();
    scheduleRender();
    scheduleSave();
    renderCleanupStats();
    toast('已撤销');
  };
  if (!opts.quiet) {
    toast(`已清空 ${snaps.length} 个分类，连带删除 ${snap.length} 条音频`, {
      ms: 15000,
      action: { label: '撤销', run: undo }
    });
  }
  return { count: snaps.length, items: snap.length, undo };
}

/** 一键：先摘掉丢失的音频，再清因为摘掉而变空的分类，一次撤销全回来。 */
function cleanupMissingAndEmpty() {
  const missItems = state.items.filter((it) => it.missing);
  if (!missItems.length && !emptyCategoryIds().length) {
    toast('没有需要清理的内容');
    return { missing: 0, empty: 0 };
  }
  const missRes = missItems.length ? purgeMissingItems({ quiet: true }) : { count: 0, undo: null };
  // 摘完丢失条目会有分类变空，所以空分类要在这之后再算
  const emptyRes = purgeEmptyCategories({ quiet: true });
  renderSidebar();
  computeView();
  scheduleRender();
  scheduleSave();
  renderCleanupStats();

  const parts = [];
  if (missRes.count) parts.push(`${missRes.count} 条已丢失音频`);
  if (emptyRes.count) parts.push(`${emptyRes.count} 个空分类`);
  toast(`一键清理：${parts.length ? parts.join('、') : '没有变化'}`, {
    ms: 15000,
    action: {
      label: '撤销',
      run: () => {
        if (emptyRes.undo) emptyRes.undo();
        if (missRes.undo) missRes.undo();
        renderCleanupStats();
      }
    }
  });
  return { missing: missRes.count, empty: emptyRes.count };
}

/** 分类标题右边那个 🧹：点开就是清理菜单，数字直接写在菜单项里。 */
function openCleanupMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  const miss = missingItemCount();
  const empty = emptyCategoryIds().length;
  const cats = state.categories.filter((c) => !c.pinned).length;
  const acts = [
    {
      label: miss ? `重新检查丢失素材（${miss} 条，只查文件在不在）` : '重新检查丢失素材',
      muted: !miss,
      run: () => relinkMissing()
    },
    { label: `按新位置找回…（盘符/目录变了时用）`, muted: !miss, run: relinkFromFolder },
    { sep: true },
    {
      label: miss || empty ? `一键清理（${miss} 条丢失 + ${empty} 个空分类）` : '一键清理（当前很干净）',
      muted: !miss && !empty,
      run: cleanupMissingAndEmpty
    },
    { sep: true },
    { label: `清除已丢失音频（${miss}）`, muted: !miss, run: () => purgeMissingItems() },
    { label: `清除空分类（${empty}）`, muted: !empty, run: () => purgeEmptyCategories() },
    {
      label: `清空所有分类（${cats} 个，连同音频）`,
      muted: !cats,
      danger: true,
      run: () => clearAllCategories()
    }
  ];
  showContextMenu(r.left, r.bottom + 4, null, acts);
}

// ---------------------------------------------------------------------------
// 找回丢失素材（移动硬盘没插 / 盘符变了 / 整个目录被改名）
// ---------------------------------------------------------------------------
// 场景：上次导入的素材在移动盘 E: 上，这次没插盘打开，全部标成「文件缺失」；
// 插上盘以后以前必须重启才能重新探测。这里做三件事：
//   1) 一键重新检查（只 stat，不读音频），插上盘后点一下就好；
//   2) 整库换位置（盘符变了：E:\声音 → F:\声音），按"同名 + 同大小"重新对上；
//   3) 后台每 30 秒悄悄检查一批，找回的自动恢复，不用重启也不用点。

let relinkBusy = false;

function missingItems() {
  return state.items.filter((it) => it.missing);
}

/** 改一条素材的路径，并把所有以路径为键的地方一起搬过去。 */
function relinkItemPath(it, newPath) {
  const old = it.path;
  if (!newPath || old === newPath) return false;
  if (state.byPath.has(newPath) && state.byPath.get(newPath) !== it) return false;
  state.byPath.delete(old);
  it.path = newPath;
  it.name = baseName(newPath);
  it.playPath = newPath;
  it.missing = false;
  // 峰值/指纹是按旧路径缓存的，换了位置就作废，下次看波形时重算
  it.peaks = null;
  it.peaksState = 'idle';
  it.fp = null;
  it.analysis = 'known';
  rebuildHaystack(it);
  state.byPath.set(newPath, it);
  if (state.selection.delete(old)) state.selection.add(newPath);
  if (state.focusPath === old) state.focusPath = newPath;
  if (state.currentPath === old) state.currentPath = newPath;
  deepCache.delete(old);
  clipCacheKeysDrop(old);
  return true;
}

// 修剪/效果器渲染出来的临时文件是按源路径命名的，旧路径的记录直接丢掉
function clipCacheKeysDrop(oldPath) {
  const prefix = oldPath + '|';
  for (const k of Array.from(fxDragCache.keys())) {
    if (k.startsWith(prefix)) fxDragCache.delete(k);
  }
}

/** 重新 stat 一遍丢失的素材；还存在的就地恢复（可选 limit 分批）。 */
async function relinkMissing({ silent = false, limit = 0 } = {}) {
  if (relinkBusy) return 0;
  const miss = missingItems();
  if (!miss.length) {
    if (!silent) toast('没有丢失的素材');
    return 0;
  }
  relinkBusy = true;
  try {
    const batch = limit > 0 ? miss.slice(0, limit) : miss;
    const flags = await sb.invoke('fs:exists', batch.map((it) => it.path));
    let found = 0;
    for (let i = 0; i < batch.length; i++) {
      if (flags && flags[i]) {
        batch[i].missing = false;
        found++;
      }
    }
    if (found) {
      computeView();
      renderSidebar();
      scheduleRender();
      scheduleSave();
      if (!silent) {
        const left = missingItems().length;
        toast(`找回了 ${found} 条${left ? `，还剩 ${left} 条没找到` : '，全部齐了'}`, {
          action: left ? undefined : undefined
        });
      }
    } else if (!silent) {
      toast(`这 ${batch.length} 条还是找不到文件（盘没插上？）`);
    }
    return found;
  } finally {
    relinkBusy = false;
  }
}

/**
 * 整库换位置：用户挑一个新根目录（比如 F:\ 代替 E:\），
 * 按"文件名相同 + 大小相同"把丢失的条目重新对上。
 */
async function relinkFromFolder() {
  const miss = missingItems();
  if (!miss.length) {
    toast('没有丢失的素材');
    return;
  }
  const dirs = await sb.invoke('dialog:pick-folder');
  if (!dirs || !dirs.length) return;
  await relinkFromRoot(dirs[0]);
}

/** 真正的"换位置找回"：给定新根目录，按同名 + 同大小重新对上（对话流程之外的入口，便于自动化测试）。 */
async function relinkFromRoot(root) {
  const miss = missingItems();
  if (!miss.length) {
    toast('没有丢失的素材');
    return { matched: 0, total: 0 };
  }
  const tree = await sb.invoke('library:scan-tree', [root]);
  const index = new Map(); // 小写文件名 → [{path, size}]
  const walk = (node) => {
    if (!node) return;
    for (const f of node.files || []) {
      const k = String(f.name).toLowerCase();
      if (!index.has(k)) index.set(k, []);
      index.get(k).push({ path: f.path, size: f.size });
    }
    for (const c of node.children || []) walk(c);
  };
  for (const t of tree || []) walk(t);
  if (!index.size) {
    toast('这个文件夹里没找到音频文件');
    return { matched: 0, total: miss.length };
  }

  const pairs = [];
  let nameOnly = 0;
  for (const it of miss) {
    const cands = index.get(String(it.name).toLowerCase());
    if (!cands || !cands.length) continue;
    let pick = cands.length === 1 ? cands[0] : cands.find((c) => c.size === it.size);
    if (!pick) {
      // 同名但大小都对不上：多半是另一条同名素材，先不认
      continue;
    }
    if (pick.size !== it.size) nameOnly++;
    pairs.push({ it, to: pick.path });
  }

  if (!pairs.length) {
    toast(`在「${baseName(root)}」里没对上任何一条（${miss.length} 条缺失）`);
    return { matched: 0, total: miss.length };
  }

  const lines = pairs.slice(0, 12).map((p) => `${p.it.name}\n  → ${p.to}`);
  if (pairs.length > 12) lines.push(`…… 还有 ${pairs.length - 12} 条`);

  showBatchDialog({
    title: `按新位置找回（${pairs.length} 条）`,
    hint: `把「${baseName(root)}」里同名（并且大小相同）的文件对回清单。原文件不会被移动或改名。`,
    lines,
    okText: '开始找回',
    onOk: () => applyRelinkPairs(pairs, nameOnly)
  });
  return { matched: pairs.length, total: miss.length, pending: true };
}

/** 把"找回"的配对真正落到清单上（对话框确认后，或自动化直接调）。 */
function applyRelinkPairs(pairs, nameOnly = 0) {
  let n = 0;
  for (const p of pairs) {
    if (relinkItemPath(p.it, p.to)) n++;
  }
  computeView();
  renderSidebar();
  scheduleRender();
  scheduleSave();
  renderRelinkStats();
  toast(`已找回 ${n} 条${nameOnly ? `（其中 ${nameOnly} 条大小不同，请随手抽查）` : ''}`);
  return n;
}

/** 单条素材：重新 stat 一次，在就恢复。 */
async function relinkOne(it) {
  if (!it) return;
  const flags = await sb.invoke('fs:exists', [it.path]);
  if (flags && flags[0]) {
    it.missing = false;
    computeView();
    renderSidebar();
    scheduleRender();
    scheduleSave();
    toast(`找到了：${it.name}`);
  } else {
    toast(`还是找不到：${it.path}`);
  }
}

// 后台自动找回：插上盘以后不用点，30 秒内自己恢复。
let relinkTimer = 0;
function startMissingWatch() {
  const tick = () => {
    if (document.hidden) return;
    if (relinkBusy) return;
    if (!missingItems().length) return;
    // 一次最多 400 条，慢慢扫，不抢磁盘
    relinkMissing({ silent: true, limit: 400 });
  };
  if (relinkTimer) clearInterval(relinkTimer);
  relinkTimer = setInterval(tick, 30000);
  window.addEventListener('focus', tick);
  // 启动 5 秒后先扫一遍（用户插了盘再打开软件的情况）
  setTimeout(tick, 5000);
}

// ---------------------------------------------------------------------------
// 批量工作流：UCS 改名 / 写回元数据 / 复制到工程目录 / 导出选片单
// ---------------------------------------------------------------------------
// UCS（Universal Category System）文件名约定：
//   分类_子类_描述_作者ID_来源ID[_补充].wav
// 这里只解析前 5 段，多余的并进描述。
function ucsPartsOf(it) {
  const base = String(it.name || '').replace(/\.[^.]+$/, '');
  const bits = base.split('_').map((s) => s.trim()).filter(Boolean);
  const parsed = parseUcs(it.name);
  if (parsed) {
    return {
      category: parsed.category,
      sub: parsed.sub,
      name: parsed.desc.replace(/_/g, ' '),
      creator: '',
      source: '',
      extra: '',
      conforming: true
    };
  }
  // 不是标准 UCS：把现有名字当描述，其余留空
  return {
    category: (it.meta && it.meta.container) === 'WAV' ? 'SFX' : 'SFX',
    sub: 'Misc',
    name: bits.join(' ') || base,
    creator: '',
    source: '',
    extra: '',
    conforming: false
  };
}

function ucsSafe(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');
}

function makeUcsName(it) {
  const p = ucsPartsOf(it);
  const bits = [
    ucsSafe(p.category) || 'SFX',
    ucsSafe(p.sub) || 'Misc',
    ucsSafe(p.name) || 'Untitled'
  ];
  if (it.ucsCreator) bits.push(ucsSafe(it.ucsCreator));
  if (it.ucsSource) bits.push(ucsSafe(it.ucsSource));
  const ext = (it.name.match(/\.[^.]+$/) || ['.wav'])[0].toLowerCase();
  return bits.join('_') + ext;
}

function batchTargets(item) {
  const t = menuTargets(item).filter((it) => it && !it.missing);
  return t.length ? t : [];
}

function showBatchMenu(x, y, item) {
  const targets = batchTargets(item);
  const n = targets.length;
  if (!n) {
    toast('这些素材的文件不在（先找回或清除）');
    return;
  }
  showContextMenu(x, y, null, [
    { label: `复制到工程文件夹…（${n} 条）`, run: () => batchCopyToProject(targets) },
    { label: `按 UCS 规则改名…（${n} 条）`, run: () => batchRenameUcs(targets) },
    { label: `把 UCS / 标签写回 WAV…（${n} 条）`, run: () => batchWriteInfo(targets) },
    { sep: true },
    { label: `导出选片单…（${n} 条）`, run: () => exportPickList(targets) }
  ]);
}

async function batchCopyToProject(targets) {
  const dirs = await sb.invoke('dialog:pick-folder');
  if (!dirs || !dirs.length) return;
  const dest = dirs[0];
  const lines = targets.slice(0, 8).map((it) => `${it.name}  →  ${baseName(dest)}\\`);
  if (targets.length > 8) lines.push(`…… 还有 ${targets.length - 8} 条`);
  showBatchDialog({
    title: `复制到「${baseName(dest)}」`,
    hint: '原文件不移动、不改名；目标里已有同名文件会自动加 (2)(3)。',
    lines,
    okText: '开始复制',
    onOk: () => doCopyTo(targets, dest)
  });
}

/** 复制本身（不弹目录选择，便于自动化）。 */
async function doCopyTo(targets, dest) {
  const r = await sb.invoke('files:copy', { paths: targets.map((it) => it.path), dest });
  if (!r || !r.ok) {
    toast(`复制失败：${(r && r.reason) || '未知原因'}`);
    return { ok: false, copied: 0 };
  }
  toast(`已复制 ${r.copied} 条到「${baseName(dest)}」${r.failed ? `，${r.failed} 条失败` : ''}`);
  return r;
}

/** 只算改名计划，不动文件。 */
function planUcsRenames(targets) {
  const plan = [];
  for (const it of targets) {
    const to = makeUcsName(it);
    if (to === it.name) continue;
    const dir = dirName(it.path);
    plan.push({ it, from: it.path, to: dir.replace(/[\\/]+$/, '') + '\\' + to, name: to });
  }
  return plan;
}

async function batchRenameUcs(targets) {
  const plan = planUcsRenames(targets);
  if (!plan.length) {
    toast('这些素材已经是 UCS 命名了');
    return;
  }
  const lines = plan.slice(0, 15).map((p) => `${p.it.name}\n  → ${p.name}`);
  if (plan.length > 15) lines.push(`…… 还有 ${plan.length - 15} 条`);
  showBatchDialog({
    title: `按 UCS 改名（${plan.length} 条）`,
    hint: '规则：分类_子类_描述[_作者_来源].wav。目标文件已存在时会整批取消，不会覆盖。',
    lines,
    okText: '改名',
    onOk: () => applyUcsRenames(plan)
  });
}

/** 真正改名 + 更新清单路径（对话框确认后，或自动化直接调）。 */
async function applyUcsRenames(plan) {
  const r = await sb.invoke('files:rename', {
    items: plan.map((p) => ({ from: p.from, to: p.to }))
  });
  if (!r || !r.ok) {
    toast(r && r.reason === 'exists' ? '有同名文件，已取消（没有改动任何文件）' : `改名失败：${(r && r.reason) || ''}`);
    return { ok: false, renamed: 0 };
  }
  let n = 0;
  for (const p of plan) if (relinkItemPath(p.it, p.to)) n++;
  computeView();
  renderSidebar();
  scheduleRender();
  scheduleSave();
  toast(`已改名 ${n} 条`);
  return { ok: true, renamed: n };
}

// WAV 的 LIST-INFO 只安全放 Latin-1；中文会被跳过并统计，不硬塞乱码。
function latin1Ok(s) {
  return /^[\x00-\xFF]*$/.test(s);
}

async function batchWriteInfo(targets) {
  const wavs = targets.filter((it) => /\.wav$/i.test(it.path));
  if (!wavs.length) {
    toast('写回元数据目前只支持 WAV');
    return;
  }
  const skipped = targets.length - wavs.length;
  const lines = wavs.slice(0, 10).map((it) => {
    const p = ucsPartsOf(it);
    return `${it.name}\n  分类=${p.category}/${p.sub} 描述=${p.name}`;
  });
  if (wavs.length > 10) lines.push(`…… 还有 ${wavs.length - 10} 条`);
  showBatchDialog({
    title: `写回元数据（${wavs.length} 个 WAV）`,
    hint: '把分类、描述、标签写进 WAV 的 RIFF LIST-INFO 块（其他软件如 Soundminer / Basehead 能读到）。含中文的字段会跳过。原始音频数据不动。',
    lines,
    okText: '写入',
    onOk: async () => {
      let ok = 0;
      let skippedField = 0;
      let fail = 0;
      for (const it of wavs) {
        const p = ucsPartsOf(it);
        const tags = (it.meta && it.meta.tags) || {};
        const fields = {};
        const put = (key, val) => {
          const s = String(val == null ? '' : val).trim();
          if (!s) return;
          if (!latin1Ok(s)) {
            skippedField++;
            return;
          }
          fields[key] = s;
        };
        put('title', baseName(it.name));
        put('genre', `${p.category}/${p.sub}`);
        put('comment', p.name);
        put('keywords', [p.category, p.sub, ...(it.meta && it.meta.tags ? Object.values(it.meta.tags).slice(0, 3) : [])].join(',').slice(0, 200));
        put('software', 'SoundBin');
        put('artist', tags.artist || tags.IART || '');
        const r = await sb.invoke('audio:write-info', { path: it.path, fields });
        if (r && r.ok) ok++;
        else fail++;
      }
      toast(`已写入 ${ok} 个文件${fail ? `，${fail} 个失败` : ''}${skippedField ? `，跳过 ${skippedField} 个含中文的字段` : ''}${skipped ? `；${skipped} 个非 WAV 未处理` : ''}`);
      // 重新读一次标签，让信息面板显示新值
      const cur = state.byPath.get(state.currentPath);
      if (cur) ensureTags(cur).then(() => {
        if (state.currentPath === cur.path) renderInfoPanel(cur);
      });
    }
  });
}

function buildPickListCsv(targets) {
  const rows = [
    ['序号', '文件名', '时长', '时长(s)', '格式', '采样率', '位深', '声道', 'LUFS-I', '峰值(dBFS)', '分类', '资料库', '路径']
  ];
  for (let i = 0; i < targets.length; i++) {
    const it = targets[i];
    const m = it.meta || {};
    const d = deepCache.get(it.path);
    rows.push([
      String(i + 1),
      it.name,
      fmtTC(m.duration || 0),
      (m.duration || 0).toFixed(3),
      m.container || '',
      m.sampleRate || '',
      m.bitDepth || '',
      m.channels || '',
      d && d.loudness && isFinite(d.loudness.integrated) ? d.loudness.integrated.toFixed(1) : '',
      d && d.loudness && isFinite(d.loudness.peakDb) ? d.loudness.peakDb.toFixed(1) : '',
      it.categoryId ? categoryName(it.categoryId) : '',
      (it.collections || []).map((id) => collectionName(id)).filter(Boolean).join('/'),
      it.path
    ]);
  }
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  return rows.map((r) => r.map(esc).join(',')).join('\r\n');
}

async function exportPickList(targets) {
  const csv = buildPickListCsv(targets);
  const r = await sb.invoke('dialog:save-text', {
    content: csv,
    defaultName: `选片单_${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
  if (r && r.ok) toast(`已导出 ${targets.length} 条到 ${baseName(r.path)}`);
}

// ---------------------------------------------------------------------------
// 响度 / 峰值 / 频谱图（本地计算，结果按路径缓存）
// ---------------------------------------------------------------------------
const deepCache = new Map();
const deepInflight = new Map();

function ensureDeep(it) {
  if (!it || it.missing) return Promise.resolve(null);
  const key = it.path;
  if (deepCache.has(key)) return Promise.resolve(deepCache.get(key));
  if (deepInflight.has(key)) return deepInflight.get(key);
  const job = sb.invoke('audio:deep', it.path)
    .then((r) => {
      if (r && r.ok) deepCache.set(key, r);
      return r && r.ok ? r : null;
    })
    .catch(() => null)
    .finally(() => deepInflight.delete(key));
  deepInflight.set(key, job);
  return job;
}

function drawSpectrum(canvas, spec) {
  if (!canvas || !spec || !spec.data) return;
  const { cols, rows } = spec;
  const data = spec.data;
  const cssW = canvas.clientWidth || 320;
  const cssH = canvas.clientHeight || 96;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(cols, rows);
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      const v = data[x * rows + y] || 0;          // row 0 = 低频
      const o = ((rows - 1 - y) * cols + x) * 4;   // 画的时候翻过来
      const t = v / 255;
      img.data[o] = Math.round(20 + 235 * Math.min(1, t * 1.6));
      img.data[o + 1] = Math.round(40 + 200 * Math.max(0, t - 0.15) * 1.4);
      img.data[o + 2] = Math.round(90 + 165 * Math.max(0, t - 0.55) * 2.2);
      img.data[o + 3] = 255;
    }
  }
  const off = document.createElement('canvas');
  off.width = cols;
  off.height = rows;
  off.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
}

// Clips waiting to land in a category whose name is still being typed.
let pendingCategorySeed = null;

// ---------------------------------------------------------------------------
// 批量确认对话框（改名/复制/写回/找回都先给一份清单再执行）
// ---------------------------------------------------------------------------
let batchDialogEl = null;
let batchOkRun = null;

function ensureBatchDialog() {
  if (batchDialogEl) return batchDialogEl;
  const mask = document.createElement('div');
  mask.className = 'batch-mask hidden';
  mask.id = 'batchMask';
  mask.innerHTML = [
    '<div class="batch-dialog" role="dialog" aria-modal="true">',
    '  <div class="batch-head">',
    '    <h3 id="batchTitle">批量操作</h3>',
    '    <button class="icon-btn" id="batchClose" title="关闭">✕</button>',
    '  </div>',
    '  <div class="batch-body">',
    '    <p class="batch-hint" id="batchHint"></p>',
    '    <pre class="batch-list" id="batchList"></pre>',
    '  </div>',
    '  <div class="batch-foot">',
    '    <button class="btn ghost" id="batchCancel">取消</button>',
    '    <button class="btn" id="batchOk">执行</button>',
    '  </div>',
    '</div>'
  ].join('\n');
  document.body.appendChild(mask);
  mask.addEventListener('mousedown', (e) => {
    if (e.target === mask) closeBatchDialog();
  });
  mask.querySelector('#batchClose').addEventListener('click', closeBatchDialog);
  mask.querySelector('#batchCancel').addEventListener('click', closeBatchDialog);
  mask.querySelector('#batchOk').addEventListener('click', async () => {
    const run = batchOkRun;
    closeBatchDialog();
    if (run) await run();
  });
  batchDialogEl = mask;
  return mask;
}

function showBatchDialog({ title, hint, lines = [], okText = '执行', onOk }) {
  const mask = ensureBatchDialog();
  mask.querySelector('#batchTitle').textContent = title || '批量操作';
  mask.querySelector('#batchHint').textContent = hint || '';
  mask.querySelector('#batchList').textContent = (lines || []).join('\n');
  mask.querySelector('#batchOk').textContent = okText;
  batchOkRun = onOk || null;
  mask.classList.remove('hidden');
}

function closeBatchDialog() {
  batchOkRun = null;
  if (batchDialogEl) batchDialogEl.classList.add('hidden');
}
// 新建子分类时的父级（输入框重绘会丢参数，所以记在模块级）
let pendingCategoryParent = null;

function categoryRow(id, name, n, color, opts = {}) {
  const depth = opts.depth || 0;
  const hasKids = !!opts.hasKids;
  const btn = document.createElement('button');
  btn.className = 'side-item category';
  btn.dataset.filter = 'category';
  btn.dataset.value = id;
  btn.dataset.depth = String(depth);
  if (depth) btn.style.paddingLeft = (8 + depth * 13) + 'px';
  const sel = state.sideSelection;
  if (id !== UNCAT_SENTINEL && sel.type === 'category' && sel.ids.has(id)) btn.classList.add('multi');
  else if (state.filter.type === 'category' && state.filter.value === id) btn.classList.add('active');

  // 倒三角：有子分类才画，点它展开 / 收起，不触发筛选
  const caret = document.createElement('span');
  caret.className = 'side-caret' + (hasKids ? '' : ' leaf');
  caret.dataset.caret = '1';
  caret.textContent = hasKids ? (opts.collapsed ? '▸' : '▾') : '';
  if (hasKids) caret.title = opts.collapsed ? '展开子分类' : '收起子分类';

  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = color;
  const label = document.createElement('span');
  label.className = 'side-label';
  label.textContent = name;
  label.title = name;
  const cnt = document.createElement('span');
  cnt.className = 'side-count';
  cnt.textContent = String(n);
  btn.append(caret, dot, label, cnt);
  return btn;
}

function renderCategories() {
  const host = dom.categoryList;
  if (!host) return;
  const editing = host.querySelector('.side-input');

  const frag = document.createDocumentFragment();
  const ix = categoryTreeIndex();

  // 只从顶层往下画；内置分类（经过处理）永远在最上面
  const roots = ix.roots.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

  const walk = (cat, depth) => {
    const kids = ix.kidsOf.get(cat.id) || [];
    const collapsed = kids.length > 0 && isCatCollapsed(cat.id);
    frag.appendChild(categoryRow(cat.id, cat.name, ix.total.get(cat.id) || 0, colorForCategory(cat.name), {
      depth,
      hasKids: kids.length > 0,
      collapsed
    }));
    if (collapsed) return;
    for (const k of kids) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);

  const uncatN = ix.uncat;
  if (uncatN) frag.appendChild(categoryRow(UNCAT_SENTINEL, UNCATEGORIZED, uncatN, '#4a5566', {}));

  if (!state.categories.some((c) => !c.pinned) && !uncatN && !state.items.length && !editing) {
    const hint = document.createElement('div');
    hint.className = 'side-empty';
    hint.textContent = '右键此处或点 ＋ 新建分类';
    frag.appendChild(hint);
  }

  host.replaceChildren(frag);
  if (editing) beginCategoryInput(editing.dataset.mode, editing.dataset.colId, editing.value, editing.dataset.parentId);
}

// ---------------------------------------------------------------------------
// Sidebar multi-selection: merge or delete several libraries/categories at once
// ---------------------------------------------------------------------------
function sidePool(type) {
  return type === 'collection' ? state.collections : state.categories;
}

function clearSideSelection() {
  state.sideSelection.type = null;
  state.sideSelection.ids.clear();
  state.sideSelection.anchor = null;
}

/** Drop the multi-selection and show everything again. */
function resetSideSelection() {
  clearSideSelection();
  state.filter = { type: 'all', value: null };
  computeView();
  dom.listBody.scrollTop = 0;
  refreshSideHighlight();
  scheduleRender();
}

/**
 * 只刷新侧栏选中 / 多选高亮，不重建 DOM 行。
 *
 * 之前每次点分类都调 renderSidebar() 重建整个侧栏：分类多的时候（用户那份
 * 1553 个）一次 10~20 毫秒，加上两轮 querySelectorAll 扫 3000 多个节点，
 * 连续快速点就会积压成卡顿。筛选只改变「哪一行高亮」，改 class 就够。
 */
function refreshSideHighlight() {
  const sel = state.sideSelection;
  const f = state.filter;
  for (const host of [dom.collectionList, dom.categoryList]) {
    if (!host) continue;
    for (const el of host.querySelectorAll('.side-item[data-filter]')) {
      const type = el.dataset.filter;
      const id = el.dataset.value || null;
      const multi = !!sel.type && sel.type === type && !!id && id !== UNCAT_SENTINEL && sel.ids.has(id);
      const active = !multi && f.type === type && (f.value || null) === id;
      el.classList.toggle('multi', multi);
      el.classList.toggle('active', active);
    }
  }
}

/** Ctrl toggles one entry, Shift extends from the anchor, plain click resets. */
function selectSide(type, id, { additive = false, range = false } = {}) {
  const sel = state.sideSelection;
  if (id === UNCAT_SENTINEL) return; // "未分类" is a bucket, not a record
  if (sel.type !== type) { sel.type = type; sel.ids.clear(); sel.anchor = null; }

  if (range && sel.anchor) {
    const ids = sidePool(type).map((c) => c.id);
    const a = ids.indexOf(sel.anchor);
    const b = ids.indexOf(id);
    if (a >= 0 && b >= 0) {
      sel.ids.clear();
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) sel.ids.add(ids[i]);
    }
  } else if (additive) {
    if (sel.ids.has(id)) sel.ids.delete(id); else sel.ids.add(id);
    sel.anchor = id;
  } else {
    sel.ids.clear();
    sel.ids.add(id);
    sel.anchor = id;
  }

  if (!sel.ids.size) { sel.type = null; sel.anchor = null; }

  if (sel.type) {
    // The list shows the union so a bulk selection is visible before acting.
    state.filter = { type: sel.type, value: sel.anchor, ids: [...sel.ids] };
    computeView();
    dom.listBody.scrollTop = 0;
    scheduleRender();
  }
  refreshSideHighlight();
}

/** "合并资料库", "合并资料库1", "合并资料库2", ... */
function uniqueName(base, pool) {
  if (!pool.some((c) => c.name === base)) return base;
  let n = 1;
  while (pool.some((c) => c.name === base + n)) n++;
  return base + n;
}

function mergeCollections(ids) {
  const cols = ids.map(collectionById).filter(Boolean);
  if (cols.length < 2) return;
  const name = uniqueName('合并资料库', state.collections);

  // Collect members before deleting the sources: that strips their tags.
  const members = state.items.filter((it) => ids.some((id) => it.collections.includes(id)));

  const merged = createCollection(name);
  if (!merged) return;
  for (const it of members) if (!it.collections.includes(merged.id)) it.collections.push(merged.id);

  state.collections = state.collections.filter((c) => !ids.includes(c.id));
  for (const it of state.items) it.collections = it.collections.filter((id) => !ids.includes(id));

  // Put the result at the top, where the eye lands.
  const at = state.collections.indexOf(merged);
  if (at > 0) { state.collections.splice(at, 1); state.collections.unshift(merged); }

  clearSideSelection();
  state.filter = { type: 'collection', value: merged.id };
  computeView();
  dom.listBody.scrollTop = 0;
  renderSidebar();
  scheduleRender();
  scheduleSave();
  toast(`合并 ${cols.length} 个资料库为「${name}」，共 ${members.length} 个音频`);
}

function deleteCollections(ids) {
  const snaps = ids.map((id) => {
    const col = collectionById(id);
    if (!col) return null;
    return {
      col,
      members: state.items.filter((it) => it.collections.includes(id)).map((it) => it.path),
      index: state.collections.indexOf(col)
    };
  }).filter(Boolean);
  if (!snaps.length) return;

  const removedIds = new Set(snaps.map((s) => s.col.id));
  const losing = state.items.filter((it) => it.collections.some((id) => removedIds.has(id)));
  const onlyHere = losing.filter((it) => it.collections.every((id) => removedIds.has(id)));
  const snap = detachItems(onlyHere);
  const kept = losing.length - snap.length;
  for (const s of snaps) doDeleteCollection(s.col.id, { quiet: true });

  clearSideSelection();
  state.filter = { type: 'all', value: null };
  computeView();
  renderSidebar();
  scheduleRender();
  scheduleSave();

  const parts = [];
  if (snap.length) parts.push(`${snap.length} 个音频一并移除`);
  if (kept > 0) parts.push(`${kept} 个仍在其他资料库`);
  toast(`已删除 ${snaps.length} 个资料库${parts.length ? `，${parts.join('，')}` : ''}`, {
    ms: 12000,
    action: {
      label: '撤销',
      run: () => {
        reattachItems(snap);
        for (const s of snaps.slice().sort((a, b) => a.index - b.index)) {
          undoDeleteCollection(s.col, [], s.index);
        }
      }
    }
  });
}

function mergeCategories(ids) {
  // 内置分类（经过处理）不参与合并，否则它会被并掉然后又被 init 重建
  const allowed = ids.filter((id) => {
    const c = categoryById(id);
    return c && !c.pinned;
  });
  const cats = allowed.map(categoryById).filter(Boolean);
  if (cats.length < 2) return;
  const name = uniqueName('合并分类', state.categories);
  const members = state.items.filter((it) => allowed.includes(it.categoryId));

  const merged = createCategory(name);
  if (!merged) return;
  for (const it of members) it.categoryId = merged.id;

  // Deliberately NOT doDeleteCategory(): merging is not "the user removed this
  // UCS prefix", so it must not leak into hiddenCategoryAutos.
  state.categories = state.categories.filter((c) => !allowed.includes(c.id));
  // 被并掉的如果是文件夹，它的子分类跟着搬到合并后的分类下面
  for (const c of state.categories) {
    if (c.parentId && allowed.includes(c.parentId)) c.parentId = merged.id;
  }
  const at = state.categories.indexOf(merged);
  if (at > 0) { state.categories.splice(at, 1); state.categories.unshift(merged); }

  clearSideSelection();
  state.filter = { type: 'category', value: merged.id };
  computeView();
  dom.listBody.scrollTop = 0;
  renderSidebar();
  scheduleRender();
  scheduleSave();
  toast(`合并 ${cats.length} 个分类为「${name}」，共 ${members.length} 个音频`);
}

function deleteCategories(ids) {
  // 勾了文件夹就等于勾了它里面所有子分类
  const allIds = new Set();
  for (const id of ids) for (const x of categorySubtreeIds(id)) allIds.add(x);
  const snaps = [...allIds].map((id) => {
    const cat = categoryById(id);
    if (!cat || cat.pinned) return null;
    return {
      cat,
      members: state.items.filter((it) => it.categoryId === id).map((it) => it.path),
      index: state.categories.indexOf(cat)
    };
  }).filter(Boolean);
  if (!snaps.length) return;

  const removedIds = new Set(snaps.map((s) => s.cat.id));
  const snap = detachItems(state.items.filter((it) => removedIds.has(it.categoryId)));
  for (const s of snaps) doDeleteCategory(s.cat.id, { quiet: true });

  clearSideSelection();
  state.filter = { type: 'all', value: null };
  computeView();
  renderSidebar();
  scheduleRender();
  scheduleSave();

  toast(`已删除 ${snaps.length} 个分类${snap.length ? `，${snap.length} 个音频一并移除` : ''}`, {
    ms: 12000,
    action: {
      label: '撤销',
      run: () => {
        reattachItems(snap);
        for (const s of snaps.slice().sort((a, b) => a.index - b.index)) {
          undoDeleteCategory(s.cat, [], s.index);
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Collections (user-made libraries)
// ---------------------------------------------------------------------------
const COL_COLORS = ['#5a9fd4', '#5fb98a', '#d9a441', '#c07ad4', '#d4715c', '#4fb8b0', '#8f9fd4'];

// Items waiting to be dropped into a library whose name is still being typed.
let pendingCollectionSeed = null;

function colorForCollection(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff;
  return COL_COLORS[h % COL_COLORS.length];
}

function newCollectionId() {
  return 'col_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function collectionById(id) {
  return state.collections.find((c) => c.id === id) || null;
}

function collectionName(id) {
  const c = collectionById(id);
  return c ? c.name : '';
}

function countInCollection(id) {
  let n = 0;
  for (const it of state.items) if (it.collections.includes(id)) n++;
  return n;
}

function createCollection(name, seedItems) {
  const clean = (name || '').trim();
  if (!clean) return null;
  if (state.collections.some((c) => c.name === clean)) {
    toast('已存在同名资料库');
    return null;
  }
  const col = { id: newCollectionId(), name: clean, createdAt: Date.now() };
  state.collections.push(col);
  if (seedItems && seedItems.length) addItemsToCollection(seedItems, col.id, true);
  scheduleSave();
  renderSidebar();
  toast(`已新建资料库「${clean}」`);
  return col;
}

function renameCollection(id, name) {
  const clean = (name || '').trim();
  const col = collectionById(id);
  if (!col || !clean || clean === col.name) return;
  if (state.collections.some((c) => c.name === clean && c.id !== id)) {
    toast('已存在同名资料库');
    return;
  }
  col.name = clean;
  scheduleSave();
  renderSidebar();
}

/**
 * Deleting a library takes its clips with it — clips that also sit in another
 * library only lose this tag, so they are not lost from that other one.
 * One click plus an undo, not a two-step confirm: the confirm menu used to open
 * at exactly the spot and width of the menu it replaced, so clicking "delete"
 * looked like it had done nothing at all.
 */
function deleteCollection(id) {
  const col = collectionById(id);
  if (!col) return;
  const index = state.collections.indexOf(col);
  const members = state.items.filter((it) => it.collections.includes(id));
  const onlyHere = members.filter((it) => it.collections.every((c) => c === id));
  const snap = detachItems(onlyHere);
  doDeleteCollection(id, { quiet: true });
  computeView();
  scheduleRender();
  scheduleSave();
  const kept = members.length - snap.length;
  const parts = [];
  if (snap.length) parts.push(`${snap.length} 个音频一并移除`);
  if (kept > 0) parts.push(`${kept} 个仍在其他资料库`);
  toast(`已删除资料库「${col.name}」${parts.length ? `，${parts.join('，')}` : ''}`, {
    ms: 12000,
    action: {
      label: '撤销',
      run: () => {
        reattachItems(snap);
        undoDeleteCollection(col, [], index);
      }
    }
  });
}

function undoDeleteCollection(col, memberPaths, index) {
  if (collectionById(col.id)) return;
  const at = Math.max(0, Math.min(index, state.collections.length));
  state.collections.splice(at, 0, col);
  let n = 0;
  for (const p of memberPaths) {
    const it = state.byPath.get(p);
    if (it && !it.collections.includes(col.id)) { it.collections.push(col.id); n++; }
  }
  scheduleSave();
  renderSidebar();
  if (state.filter.type === 'collection' && state.filter.value === col.id) {
    computeView();
    scheduleRender();
  }
  toast(`已恢复资料库「${col.name}」${n ? `，${n} 个音频` : ''}`);
}

function doDeleteCollection(id, opts = {}) {
  const col = collectionById(id);
  if (!col) return;
  state.collections = state.collections.filter((c) => c.id !== id);
  for (const it of state.items) {
    const i = it.collections.indexOf(id);
    if (i >= 0) it.collections.splice(i, 1);
  }
  if (state.filter.type === 'collection' && state.filter.value === id) {
    state.filter = { type: 'all', value: null };
    computeView();
    scheduleRender();
  }
  scheduleSave();
  renderSidebar();
  if (!opts.quiet) toast(`已删除资料库「${col.name}」`);
}

function addItemsToCollection(items, id, silent) {
  const col = collectionById(id);
  if (!col) return 0;
  let n = 0;
  for (const it of items) {
    if (!it || it.collections.includes(id)) continue;
    it.collections.push(id);
    n++;
  }
  if (n) {
    scheduleSave();
    if (!silent) {
      toast(col ? `已加入「${col.name}」${n > 1 ? ` （${n} 个）` : ''}` : '');
      if (state.filter.type === 'collection' && state.filter.value === id) {
        computeView();
        scheduleRender();
      }
      renderSidebar();
    }
  } else if (!silent) {
    toast(`已在「${col.name}」中`);
  }
  return n;
}

function removeItemsFromCollection(items, id) {
  const col = collectionById(id);
  if (!col) return;
  let n = 0;
  for (const it of items) {
    const i = it.collections.indexOf(id);
    if (i >= 0) { it.collections.splice(i, 1); n++; }
  }
  if (!n) return;
  scheduleSave();
  renderSidebar();
  computeView();
  scheduleRender();
  toast(`已从「${col.name}」移出 ${n} 个`);
}

function renderCollections() {
  const host = dom.collectionList;
  if (!host) return;

  // Don't blow away an in-progress name field.
  const editing = host.querySelector('.side-input');

  const frag = document.createDocumentFragment();
  const sel = state.sideSelection;
  for (const col of state.collections) {
    const btn = document.createElement('button');
    btn.className = 'side-item collection';
    btn.dataset.filter = 'collection';
    btn.dataset.value = col.id;
    if (sel.type === 'collection' && sel.ids.has(col.id)) btn.classList.add('multi');
    else if (state.filter.type === 'collection' && state.filter.value === col.id) {
      btn.classList.add('active');
    }
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = colorForCollection(col.id);
    const label = document.createElement('span');
    label.className = 'side-label';
    label.textContent = col.name;
    label.title = col.name;
    const cnt = document.createElement('span');
    cnt.className = 'side-count';
    cnt.textContent = String(countInCollection(col.id));
    btn.append(dot, label, cnt);
    frag.appendChild(btn);
  }

  if (!state.collections.length && !editing) {
    const hint = document.createElement('div');
    hint.className = 'side-empty';
    hint.textContent = '右键此处或点 ＋ 新建资料库';
    frag.appendChild(hint);
  }

  host.replaceChildren(frag);
  if (editing) beginCollectionInput(editing.dataset.mode, editing.dataset.colId, editing.value);
}

/**
 * Inline name field, shared by libraries and categories. Electron disables
 * window.prompt, and a full modal for one text field would be heavier than the
 * feature it serves.
 */
function beginNameInput({ host, mode, id, initial, placeholder, rerender, commit, parentId }) {
  if (!host) return;
  if (host.querySelector('.side-input-row')) return;

  const row = document.createElement('div');
  row.className = 'side-input-row';
  const input = document.createElement('input');
  input.className = 'side-input';
  input.type = 'text';
  input.maxLength = 60;
  input.dataset.mode = mode;
  input.dataset.colId = id || '';
  input.dataset.parentId = parentId || '';
  input.value = initial || '';
  input.placeholder = placeholder;
  input.spellcheck = false;

  let settled = false;
  const finish = (ok) => {
    if (settled) return;
    settled = true;
    const value = input.value.trim();
    row.remove();
    if (!ok || !value) { rerender(); return; }
    commit(value, mode, id);
  };

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));

  row.appendChild(input);
  host.appendChild(row);
  input.focus();
  input.select();
}

function beginCollectionInput(mode, colId, initial) {
  beginNameInput({
    host: dom.collectionList,
    mode,
    id: colId,
    initial,
    placeholder: mode === 'create' ? '新资料库名称' : '重命名',
    rerender: renderCollections,
    commit: (value) => {
      if (mode === 'create') {
        const seed = pendingCollectionSeed;
        pendingCollectionSeed = null;
        if (!createCollection(value, seed)) renderCollections();
      } else {
        renameCollection(colId, value);
        renderCollections();
      }
    }
  });
}

function beginCategoryInput(mode, catId, initial, parentId) {
  // 新建子分类时把父级记下来：输入框被重绘时也还能还原
  pendingCategoryParent = mode === 'create' ? (parentId || null) : pendingCategoryParent;
  beginNameInput({
    host: dom.categoryList,
    mode,
    id: catId,
    initial,
    parentId: mode === 'create' ? (parentId || null) : null,
    placeholder: mode === 'create' ? (parentId ? '新子分类名称' : '新分类名称') : '重命名分类',
    rerender: renderCategories,
    commit: (value) => {
      if (mode === 'create') {
        const seed = pendingCategorySeed;
        const parent = pendingCategoryParent;
        pendingCategorySeed = null;
        pendingCategoryParent = null;
        if (!createCategory(value, seed, parent)) renderCategories();
      } else {
        renameCategory(catId, value);
        renderCategories();
      }
    }
  });
}

function renderStats() {
  const total = state.items.length;
  let dur = 0;
  let bytes = 0;
  let known = 0;
  for (const it of state.items) {
    bytes += it.size || 0;
    if (it.meta && it.meta.duration) { dur += it.meta.duration; known++; }
  }
  if (!total) {
    dom.libStats.textContent = '资料库为空';
    return;
  }
  const durStr = dur >= 3600
    ? `${(dur / 3600).toFixed(2)} 小时`
    : `${Math.floor(dur / 60)} 分 ${Math.round(dur % 60)} 秒`;
  const prog = probeProgress();
  dom.libStats.innerHTML =
    `${plural(total, '个文件')} · ${fmtSize(bytes)}<br />` +
    `总时长 ${durStr}` +
    (prog
      ? ` <span style="opacity:.55">· 读取信息 ${prog.known}/${prog.total}</span>`
      : (known < total ? ` <span style="opacity:.55">(${total - known} 待分析)</span>` : ''));
}

let statsTimer = null;
function scheduleStats() {
  if (statsTimer) return;
  statsTimer = setTimeout(() => { statsTimer = null; renderStats(); }, 300);
}

// ---------------------------------------------------------------------------
// Rendering: list (virtualised)
// ---------------------------------------------------------------------------
const rowPool = [];

function makeRow() {
  const el = document.createElement('div');
  el.className = 'row';
  el.draggable = true;
  el.innerHTML =
    '<div class="col col-idx"></div>' +
    '<div class="col col-art"><img class="row-art empty" alt="" /></div>' +
    '<div class="col col-name"><span class="cat-dot"></span><span class="name-text"></span></div>' +
    '<div class="col col-desc"></div>' +
    '<div class="col col-dur"></div>' +
    '<div class="col col-fmt"></div>' +
    '<div class="col col-sr"></div>' +
    '<div class="col col-bd"></div>' +
    '<div class="col col-ch"></div>' +
    '<div class="col col-size"></div>' +
    '<div class="col col-path"></div>';
  el._r = {
    idx: el.children[0],
    art: el.children[1].children[0],
    dot: el.children[2].children[0],
    name: el.children[2].children[1],
    desc: el.children[3],
    dur: el.children[4],
    fmt: el.children[5],
    sr: el.children[6],
    bd: el.children[7],
    ch: el.children[8],
    size: el.children[9],
    path: el.children[10]
  };
  return el;
}

// ---------------------------------------------------------------------------
// Cover art (row thumbnails)
// ---------------------------------------------------------------------------
// path -> { url, source, from, mime, bytes } | null (no cover).
// Fetched lazily for visible rows only.
const artCache = new Map();
const artQueue = [];
const artQueued = new Set();
let artActive = 0;
const ART_CONCURRENCY = 4;

// 没有图片文件时的占位封面：按「音频所在目录」生成稳定的色块 + 两字母缩写。
// 音效库常常整包共用一张封面，或者根本没带图；前者由主进程找到真实图片，
// 后者（如 BOOM 这类只有 wav 的包）就靠这个占位图让人一眼看出属于哪个包。
const placeholderCache = new Map();

function artLabelFor(it) {
  const dir = it.dir || dirName(it.path);
  return baseName(dir) || 'SoundBin';
}

function artInitials(label) {
  const clean = String(label).replace(/[_\.]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return 'SB';
  const words = clean.split(' ').filter((w) => /[A-Za-z0-9\u4e00-\u9fa5]/.test(w));
  if (!words.length) return 'SB';
  if (words.length === 1) {
    const w = words[0].replace(/[^A-Za-z0-9\u4e00-\u9fa5]/g, '');
    return (w.slice(0, 2) || 'SB').toUpperCase();
  }
  const a = words[0][0] || '';
  const b = words[1][0] || '';
  return (a + b).toUpperCase();
}

function artHue(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360;
  return h;
}

function placeholderArt(it) {
  const dir = it.dir || dirName(it.path);
  const hit = placeholderCache.get(dir);
  if (hit) return hit;
  const label = artLabelFor(it);
  const initials = artInitials(label);
  const hue = artHue(dir);
  const size = initials.length > 1 ? 34 : 44;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue}, 40%, 27%)"/>` +
    `<stop offset="1" stop-color="hsl(${hue}, 46%, 13%)"/></linearGradient></defs>` +
    `<rect width="96" height="96" fill="url(#g)"/>` +
    `<rect x="0.5" y="0.5" width="95" height="95" fill="none" stroke="hsl(${hue}, 45%, 38%)" stroke-opacity="0.65"/>` +
    `<text x="48" y="49" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="${size}" font-weight="600" ` +
    `fill="hsl(${hue}, 62%, 84%)" letter-spacing="0.5">${escapeHtml(initials)}</text>` +
    `</svg>`;
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  placeholderCache.set(dir, url);
  return url;
}

function queueArt(it) {
  if (!it || artCache.has(it.path)) return;
  if (artQueued.has(it.path)) return;
  artQueued.add(it.path);
  artQueue.push(it);
  pumpArt();
}

function pumpArt() {
  while (artActive < ART_CONCURRENCY && artQueue.length) {
    const it = artQueue.shift();
    artActive++;
    sb.invoke('art:cover', { path: it.path })
      .then((res) => {
        artCache.set(it.path, res && res.ok
          ? { url: res.url, source: res.source, from: res.from, rel: res.rel, mime: res.mime, bytes: res.bytes }
          : null);
        if (res && res.ok) dispatchArtLoaded(it.path, res.url);
      })
      .catch(() => { artCache.set(it.path, null); })
      .finally(() => {
        artActive--;
        artQueued.delete(it.path);
        if (it.path === state.currentPath && state.infoOpen) {
          const cur = state.byPath.get(it.path);
          if (cur) renderInfoPanel(cur);
        }
        pumpArt();
      });
  }
}

function dispatchArtLoaded(path, url) {
  for (const el of rowPool) {
    if (el._item && el._item.path === path) applyRowArt(el, el._item);
  }
}

function applyRowArt(el, it) {
  const img = el._r && el._r.art;
  if (!img) return;
  const cached = it ? artCache.get(it.path) : null;
  const url = cached && cached.url ? cached.url : (it ? placeholderArt(it) : '');
  if (!url) {
    img.removeAttribute('src');
    img.classList.add('empty');
    return;
  }
  if (img.getAttribute('src') !== url) img.src = url;
  img.classList.remove('empty');
}

function setRowArt(el, it) {
  applyRowArt(el, it);
  if (!artCache.has(it.path)) queueArt(it);
}


let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderList();
  });
}

function highlightName(name) {
  const q = state.search.trim();
  if (!q) return escapeHtml(name);
  const terms = q.split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (!terms.length) return escapeHtml(name);
  const re = new RegExp(`(${terms.join('|')})`, 'gi');
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(name)) !== null) {
    if (m.index > last) out += escapeHtml(name.slice(last, m.index));
    out += '<mark>' + escapeHtml(m[0]) + '</mark>';
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  out += escapeHtml(name.slice(last));
  return out;
}

function renderList() {
  const rows = state.view;
  const n = rows.length;

  dom.listSpacer.style.height = (n * ROW_H) + 'px';

  // Two distinct empty states: an empty library vs. filters that hid everything.
  const emptyEl = dom.emptyState;
  if (n > 0) {
    emptyEl.classList.add('hidden');
  } else {
    emptyEl.classList.remove('hidden');
    const isEmptyLib = state.items.length === 0;
    const title = emptyEl.querySelector('h2');
    const sub = emptyEl.querySelector('p');
    if (title) title.textContent = isEmptyLib ? '把音频拖进这里' : '没有匹配的音频';
    if (sub) {
      sub.innerHTML = isEmptyLib
        ? '或点击 <b>添加文件</b> / <b>添加文件夹</b><br />文件不会被复制，始终留在原位置'
        : '试试清空搜索，或在左侧选择“全部音频”';
    }
  }

  if (n === 0) {
    dom.listRows.replaceChildren();
    rowPool.length = 0;
    updateHeaderCounts();
    return;
  }

  const scrollTop = dom.listBody.scrollTop;
  const viewH = dom.listBody.clientHeight;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 6);
  const visible = Math.ceil(viewH / ROW_H) + 12;
  const last = Math.min(n, first + visible);

  const needed = last - first;
  while (rowPool.length < needed) {
    const el = makeRow();
    rowPool.push(el);
    dom.listRows.appendChild(el);
  }
  for (let i = needed; i < rowPool.length; i++) {
    rowPool[i].style.display = 'none';
  }

  dom.listRows.style.transform = `translateY(${first * ROW_H}px)`;

  for (let k = 0; k < needed; k++) {
    const idx = first + k;
    const it = rows[idx];
    const el = rowPool[k];
    el.style.display = '';
    el._item = it;
    updateRow(el, it, idx);
  }

  updateHeaderCounts();
  kickVisibleAnalysis(rows, first, last);
}

function updateRow(el, it, idx) {
  const r = el._r;
  r.idx.textContent = String(idx + 1);
  r.name.innerHTML = highlightName(it.name);
  setRowArt(el, it);

  const cat = it.ucs ? it.ucs.category : '';
  r.dot.style.background = cat ? colorForCategory(cat) : '#39424f';
  r.dot.title = cat || '未分类';

  const m = it.meta;
  const tags = (m && m.tags) || {};
  const desc = tags.comment || tags.description || '';
  r.desc.textContent = desc;
  r.desc.title = desc;
  const clip = trimmableClip(it);
  if (clip) {
    // 时长列显示"拖出去会得到多长"，title 里保留原长
    r.dur.textContent = fmtDur(clip.end - clip.start);
    r.dur.title = `修剪后 ${fmtTC(clip.end - clip.start)}（原长 ${fmtTC(m && m.duration ? m.duration : 0)}）`;
  } else {
    r.dur.textContent = m && m.duration ? fmtDur(m.duration) : (it.analysis === 'loading' ? '…' : '—');
    r.dur.title = '';
  }
  r.fmt.textContent = m && m.container ? m.container : extOf(it.name);
  r.sr.textContent = m && m.sampleRate ? fmtRate(m.sampleRate) : '—';
  r.bd.textContent = m && m.bitDepth ? String(m.bitDepth) : '—';
  r.ch.textContent = m && m.channels ? fmtChannels(m.channels) : '—';
  r.size.textContent = fmtSize(it.size);
  r.path.textContent = it.dir;
  r.path.title = it.path;

  el.classList.toggle('selected', state.selection.has(it.path));
  el.classList.toggle('playing', state.currentPath === it.path && state.playing);
  el.classList.toggle('missing', it.missing);

  // badges
  let badge = null;
  if (it.missing) badge = 'missing';
  else if (state.currentPath === it.path && state.playing) badge = 'playing';

  const existing = r.name.parentElement.querySelector('.badge-missing, .badge-playing');
  if (badge === 'missing') {
    if (!existing || !existing.classList.contains('badge-missing')) {
      if (existing) existing.remove();
      const b = document.createElement('span');
      b.className = 'badge-missing';
      b.textContent = '缺失';
      r.name.parentElement.appendChild(b);
    }
  } else if (badge === 'playing') {
    if (existing) existing.remove();
    const b = document.createElement('span');
    b.className = 'badge-playing';
    b.textContent = state.mono ? 'MONO' : 'PLAY';
    r.name.parentElement.appendChild(b);
  } else if (existing) {
    existing.remove();
  }

  // 「已修剪」标记：这一行拖出去给的是裁剪后的文件
  let trimBadge = r.name.parentElement.querySelector('.badge-trim');
  if (clip) {
    if (!trimBadge) {
      trimBadge = document.createElement('span');
      trimBadge.className = 'badge-trim';
      r.name.parentElement.appendChild(trimBadge);
    }
    trimBadge.textContent = '已修剪';
    trimBadge.title = `拖出去的是 ${fmtTC(clip.start)}–${fmtTC(clip.end)} 的裁剪文件`;
  } else if (trimBadge) {
    trimBadge.remove();
  }
}

function updateHeaderCounts() {
  for (const el of dom.listHeader.querySelectorAll('.sortable')) {
    // 表头文字包在 .col-text 里（拖拽把手是它的兄弟节点），所以不能直接写 textContent
    const textEl = el.querySelector('.col-text') || el;
    el.classList.toggle('sorted', el.dataset.sort === state.sort.key);
    textEl.textContent = textEl.textContent.replace(/\s*[▲▼]$/, '');
    if (el.dataset.sort === state.sort.key) {
      textEl.textContent += state.sort.dir > 0 ? ' ▲' : ' ▼';
    }
  }
}

// ---------------------------------------------------------------------------
// Column widths — drag the grip on a header cell to resize that column
// ---------------------------------------------------------------------------
// 最后一列（路径）永远吃掉剩余宽度，其余 10 列是固定像素，所以任何一次拖动
// 都要先把当前渲染出来的宽度量下来"冻结"，否则列宽会在拖动瞬间跳一下。
const COL_MIN = [28, 26, 64, 52, 52, 40, 48, 36, 28, 52, 60];
// 侧栏宽度（需求 1：侧栏可以拖宽）。宽窗口 150~360，贴边面板里 100~240
const SIDE_MIN = 100;
const SIDE_MAX = 360;
const COL_GAP = 12; // 与 style.css 里 .row / .list-header 的 column-gap 保持一致
let colDrag = null;
let suppressHeaderClick = false;

/**
 * 某一列当前最多能拖到多宽：总宽不能超过容器，最后一列（路径）可以一路缩到
 * COL_MIN[10]，所以可用的多余空间都要先让给它。
 */
function colMaxWidth(i, widths) {
  const cs = getComputedStyle(dom.listHeader);
  const inner = (dom.listHeader.clientWidth || 800) - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  const gaps = COL_GAP * (widths.length - 1);
  const others = widths.reduce((a, w, j) => {
    if (j === i || j === 10) return a;
    return a + Math.max(COL_MIN[j], Math.round(w));
  }, 0);
  // 最后一列是 1fr，永远是"剩下多少"，不提供拖拽把手
  const tailMin = COL_MIN[10];
  return Math.max(COL_MIN[i], Math.floor(inner - gaps - others - tailMin));
}

function captureColWidths() {
  const cells = [...dom.listHeader.querySelectorAll('.col')];
  return cells.map((el, i) => {
    // 最后一列（路径）是 1fr，实时宽度只是"剩下多少"；固定记成它的最小宽度，
    // 这样别的列加宽时它会自动让位。
    if (i === 10) return COL_MIN[10];
    const w = Math.round(el.getBoundingClientRect().width);
    return Math.max(COL_MIN[i] || 28, w);
  });
}

function applyColWidths() {
  const root = document.documentElement;
  // 窄面板（贴边 320~820）里只留 4 列，用户拖过的 11 列宽在这里没有意义：
  // 内联 --cols 会压过媒体查询，导致表头比窗口还宽、右边一列被裁掉。
  if (window.innerWidth <= 820) {
    root.style.removeProperty('--cols');
    return;
  }
  if (!state.colWidths || state.colWidths.length !== 11) {
    root.style.removeProperty('--cols');
    return;
  }
  // 旧版在贴边面板里压过的列宽会带到普通窗口，
  // 名称列只剩几十像素（只能看到 “M…”）：这种情况就当没存过
  if (Math.round(state.colWidths[2]) < 120) {
    root.style.removeProperty('--cols');
    return;
  }
  const fixed = state.colWidths.slice(0, 10).map((w, i) => `${Math.max(COL_MIN[i], Math.round(w))}px`);
  const tail = Math.max(COL_MIN[10], Math.round(state.colWidths[10]));
  root.style.setProperty('--cols', `${fixed.join(' ')} minmax(${tail}px, 1fr)`);
}

function resetColWidths() {
  state.colWidths = null;
  applyColWidths();
  scheduleSave();
  toast('列宽已恢复默认');
}

/**
 * 窗口变窄（或早先存下的列宽比窗口还宽）时，把多出来的宽度从最宽的列一路削回去，
 * 保证表头永远不会撑出容器。
 */
function fitColWidths() {
  if (!state.colWidths || state.colWidths.length !== 11) return false;
  const cs = getComputedStyle(dom.listHeader);
  const inner =
    (dom.listHeader.clientWidth || 0) - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  if (!inner) return false;
  const gaps = COL_GAP * (state.colWidths.length - 1);
  let over = state.colWidths.reduce((a, w, i) => a + Math.max(COL_MIN[i], Math.round(w)), 0) + gaps - inner;
  if (over <= 0) return false;
  const order = state.colWidths.map((w, i) => i).sort((a, b) => state.colWidths[b] - state.colWidths[a]);
  for (const i of order) {
    if (over <= 0) break;
    const room = Math.max(0, Math.round(state.colWidths[i]) - COL_MIN[i]);
    const take = Math.min(room, over);
    if (take > 0) {
      state.colWidths[i] = Math.round(state.colWidths[i]) - take;
      over -= take;
    }
  }
  return true;
}

/** 布局出来之后（以及窗口第一次真正绘制时）再校正一次列宽 */
function scheduleFitColWidths() {
  const run = () => {
    if (!state.colWidths) return;
    if (fitColWidths()) {
      applyColWidths();
      scheduleSave();
    }
  };
  requestAnimationFrame(run);
  setTimeout(run, 700);
  window.addEventListener('load', run, { once: true });
}

function setupColumnResize() {
  const cells = [...dom.listHeader.querySelectorAll('.col')];
  cells.forEach((cell, i) => {
    // 文字单独一个 span，updateHeaderCounts() 只改它，不会把把手一起清掉
    const label = document.createElement('span');
    label.className = 'col-text';
    label.textContent = cell.textContent;
    cell.replaceChildren(label);

    const isTail = i === cells.length - 1;
    const grip = document.createElement('span');
    grip.className = isTail ? 'col-resizer tail' : 'col-resizer';
    grip.title = '拖动调整列宽 · 双击恢复默认宽度';
    cell.appendChild(grip);

    grip.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (!state.colWidths) state.colWidths = captureColWidths();
      colDrag = { i, x: e.clientX, w0: state.colWidths[i] };
      document.body.classList.add('col-resizing');
    });
    grip.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      resetColWidths();
    });
  });

  window.addEventListener('mousemove', (e) => {
    if (!colDrag) return;
    const dx = e.clientX - colDrag.x;
    const i = colDrag.i;
    // 不允许把表头撑出容器：宽出来的部分只会把"路径"挤到它的最小宽度为止
    const max = colMaxWidth(i, state.colWidths);
    state.colWidths[i] = Math.max(COL_MIN[i], Math.min(max, Math.round(colDrag.w0 + dx)));
    applyColWidths();
  });

  window.addEventListener('mouseup', () => {
    if (!colDrag) return;
    const moved = Math.abs(state.colWidths[colDrag.i] - colDrag.w0) > 1;
    colDrag = null;
    document.body.classList.remove('col-resizing');
    // 松手后浏览器还会补一个 click：刚拖过列宽就不该顺手把列表排序切了
    if (moved) {
      suppressHeaderClick = true;
      setTimeout(() => { suppressHeaderClick = false; }, 0);
      scheduleSave();
    }
  });

  // 窗口变窄时把列宽收回容器内，否则"路径"列会被裁掉
  window.addEventListener('resize', () => {
    if (!state.colWidths) return;
    const shrank = fitColWidths();
    applyColWidths();
    if (shrank) scheduleSave();
  });
}

// ---------------------------------------------------------------------------
// Analysis
//
// 两段式：
//   probe —— 只读文件头（时长/采样率/声道/位深/标签），单个 2~7 ms，导入后
//            整库跑一遍也不疼，列表立刻有信息；
//   peaks —— 波形包络，得把整段音频读一遍（250 MB ≈ 0.7 s），只在真正要看
//            波形 / 算指纹时才做，而且主进程放到工作线程里算。
// 早先一步到位：9000 条素材 = 读 100 GB + 每条留最多 1.6 MB 峰值在内存里，
// 于是「导入卡半天，导入完还卡」。
// ---------------------------------------------------------------------------
const analysisQueue = [];
const analysisSet = new Set();
let analysisActive = 0;
const ANALYSIS_CONCURRENCY = 6;

// 峰值只给最近看过的几条留着，别的算完就丢（.bin 缓存还在，回来时秒开）
const PEAKS_KEEP = 8;
const peaksOrder = [];
const peaksInflight = new Map();

function requestAnalysis(it, priority = false) {
  if (!it || it.analysis === 'loading' || it.analysis === 'ready' || it.analysis === 'failed') return;
  if (analysisSet.has(it.path)) return;
  analysisSet.add(it.path);
  it.analysis = 'loading';
  if (priority) analysisQueue.unshift(it);
  else analysisQueue.push(it);
  pumpAnalysis();
}

function pumpAnalysis() {
  while (analysisActive < ANALYSIS_CONCURRENCY && analysisQueue.length) {
    const it = analysisQueue.shift();
    analysisActive++;
    runAnalysis(it).finally(() => {
      analysisActive--;
      pumpAnalysis();
    });
  }
}

function probeProgress() {
  const total = state.items.length;
  if (!total) return null;
  const waiting = analysisQueue.length + analysisActive;
  if (!waiting) return null;
  let known = 0;
  for (const it of state.items) if (it.meta && it.meta.duration) known++;
  return { known, total, waiting };
}

async function runAnalysis(it) {
  let res;
  try {
    res = await sb.invoke('audio:probe', it.path);
  } catch (err) {
    res = { ok: false, reason: String(err) };
  }

  analysisSet.delete(it.path);

  if (!res || res.ok === false) {
    it.analysis = 'failed';
    if (res && res.reason === 'missing') it.missing = true;
    if (res && res.meta) it.meta = { ...(it.meta || {}), ...res.meta };
    if (res && res.reason && res.reason !== 'missing') {
      it.playable = false;
    }
    scheduleRender();
    scheduleStats();
    return;
  }

  it.meta = { ...(it.meta || {}), ...(res.meta || {}) };
  if (res.playPath) it.playPath = res.playPath;
  it.needsTranscode = !!res.needsTranscode;
  it.analysis = 'ready';
  rebuildHaystack(it);

  scheduleRender();
  scheduleStats();
  // 正在看的这条：顺手把波形也取过来（进视口时已经排过队，这里不重复）
  if (state.currentPath === it.path) ensurePeaks(it);
}

/**
 * 取波形峰值。命中内存/磁盘缓存都很快；第一次要读整段音频，所以只对
 * 「当前选中 / 要播 / 要算相似度」的素材调用。
 */
function ensurePeaks(it) {
  if (!it || it.missing) return Promise.resolve(null);
  if (it.peaks && it.peaks.data) {
    touchPeaks(it);
    return Promise.resolve(it.peaks);
  }
  const inflight = peaksInflight.get(it.path);
  if (inflight) return inflight;

  // 注意顺序：先把状态和 inflight 登记好，再去刷新面板。
  // 反过来的话 refreshWaveIfCurrent → updateWavePanel → ensurePeaks 会查不到 inflight，
  // 于是无限递归（RangeError: Maximum call stack size exceeded），整个界面卡死。
  it.peaksState = 'loading';

  const job = (async () => {
    let res;
    try {
      res = await sb.invoke('audio:peaks', it.path);
    } catch (err) {
      res = { ok: false, reason: String(err) };
    }
    if (!res || res.ok === false) {
      it.peaksState = 'failed';
      refreshWaveIfCurrent(it);
      return null;
    }
    if (res.playPath && res.playPath !== it.path) it.playPath = res.playPath;
    if (res.kind === 'browser') {
      // Chromium 能解码的格式：解码也在渲染层按需做，别在导入时做
      it.peaksState = 'pending';
      refreshWaveIfCurrent(it);
      try {
        await computeBrowserPeaks(it);
      } catch {
        it.peaksState = 'failed';
      }
      refreshWaveIfCurrent(it);
      return it.peaks || null;
    }
    if (res.peaks && res.peaks.data) {
      it.peaks = res.peaks;
      it.peaksState = 'ready';
      ensureFingerprint(it);
      touchPeaks(it);
      scheduleRender();
      scheduleStats();
      refreshWaveIfCurrent(it);
      return it.peaks;
    }
    it.peaksState = 'failed';
    refreshWaveIfCurrent(it);
    return null;
  })().finally(() => {
    peaksInflight.delete(it.path);
  });

  peaksInflight.set(it.path, job);
  refreshWaveIfCurrent(it);
  return job;
}

function touchPeaks(it) {
  const i = peaksOrder.indexOf(it.path);
  if (i >= 0) peaksOrder.splice(i, 1);
  peaksOrder.push(it.path);
  trimPeaksMemory();
}

function trimPeaksMemory() {
  if (peaksOrder.length <= PEAKS_KEEP) return;
  const keep = new Set([state.currentPath].filter(Boolean));
  for (let i = 0; i < peaksOrder.length && peaksOrder.length > PEAKS_KEEP;) {
    const p = peaksOrder[i];
    if (keep.has(p)) { i++; continue; }
    peaksOrder.splice(i, 1);
    const it = state.byPath.get(p);
    if (it && it.path !== state.currentPath) {
      it.peaks = null;
      if (it.peaksState === 'ready') it.peaksState = 'idle';
    }
  }
}


async function computeBrowserPeaks(it) {
  const url = audioUrl(it.playPath || it.path);
  const res = await fetch(url);
  if (!res.ok) throw new Error('fetch failed');
  const buf = await res.arrayBuffer();
  const audioBuf = await player.ctx.decodeAudioData(buf);
  if (!it.meta || !it.meta.duration) {
    it.meta = { ...(it.meta || {}), duration: audioBuf.duration, sampleRate: audioBuf.sampleRate, channels: audioBuf.numberOfChannels };
  } else {
    it.meta = {
      ...it.meta,
      duration: it.meta.duration || audioBuf.duration,
      sampleRate: it.meta.sampleRate || audioBuf.sampleRate,
      channels: it.meta.channels || audioBuf.numberOfChannels
    };
  }
  const peaks = peaksFromAudioBuffer(audioBuf);
  it.peaks = peaks;
  it.peaksState = 'ready';
  ensureFingerprint(it);
  scheduleRender();
  scheduleStats();
  refreshWaveIfCurrent(it);
}

function peaksFromAudioBuffer(audioBuf) {
  const chCount = Math.min(2, audioBuf.numberOfChannels);
  const sr = audioBuf.sampleRate;
  const duration = audioBuf.duration;
  const binsPerSecond = 320;
  const bins = Math.max(1, Math.min(400000, Math.ceil(duration * binsPerSecond)));
  const framesPerBin = audioBuf.length / bins;
  const data = new Int16Array(bins * chCount * 2);

  // 过零率轮廓：64 段，配合包络做相似度判断（见 computeFingerprint）。
  const zcrBins = Math.min(64, Math.max(1, bins));
  const zcrCross = new Float64Array(zcrBins);
  const zcrFrames = new Float64Array(zcrBins);
  const segFrames = Math.max(1, audioBuf.length / zcrBins);
  const lastSign = new Int8Array(chCount);

  for (let c = 0; c < chCount; c++) {
    const chData = audioBuf.getChannelData(c);
    for (let b = 0; b < bins; b++) {
      const s = Math.floor(b * framesPerBin);
      let e = Math.floor((b + 1) * framesPerBin);
      if (e <= s) e = s + 1;
      if (e > chData.length) e = chData.length;
      let lo = 1, hi = -1;
      for (let i = s; i < e; i++) {
        const v = chData[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;

        let zi = (i / segFrames) | 0;
        if (zi >= zcrBins) zi = zcrBins - 1;
        if (c === 0) zcrFrames[zi] += 1;
        const sign = v > 0 ? 1 : v < 0 ? -1 : 0;
        if (sign !== 0) {
          if (lastSign[c] !== 0 && sign !== lastSign[c]) zcrCross[zi] += 1;
          lastSign[c] = sign;
        }
      }
      if (lo > hi) { lo = 0; hi = 0; }
      const o = (b * chCount + c) * 2;
      data[o] = Math.max(-32768, Math.min(32767, Math.round(lo * 32767)));
      data[o + 1] = Math.max(-32768, Math.min(32767, Math.round(hi * 32767)));
    }
  }

  const zcr = new Array(zcrBins);
  for (let i = 0; i < zcrBins; i++) {
    const denom = zcrFrames[i] * chCount;
    zcr[i] = denom > 0 ? Math.min(1, zcrCross[i] / denom) : 0;
  }

  return { binsPerSecond, channels: chCount, bins, data, zcr };
}

// ---------------------------------------------------------------------------
// Waveform fingerprint (similarity search)
// ---------------------------------------------------------------------------
// 64 列归一化包络 + 峰值哈希。包络只描述"响度随时间的走向"，所以同一素材的
// 不同采样率/位深版本、同一段的单声道/立体声版本都会落在同一个指纹附近；
// 峰值哈希逐 bin 比对，用来认出内容完全相同的文件。
const FP_BINS = 64;

function computeFingerprint(peaks) {
  if (!peaks || !peaks.data || !peaks.bins) return null;
  const bins = peaks.bins;
  const chCount = Math.max(1, Math.min(2, peaks.channels || 1));
  const per = Math.max(1, bins / FP_BINS);
  const out = new Array(FP_BINS).fill(0);
  for (let c = 0; c < chCount; c++) {
    for (let i = 0; i < FP_BINS; i++) {
      const b0 = Math.floor(i * per);
      let b1 = Math.floor((i + 1) * per);
      if (b1 <= b0) b1 = b0 + 1;
      if (b1 > bins) b1 = bins;
      let peak = 0;
      for (let b = b0; b < b1; b++) {
        const o = (b * chCount + c) * 2;
        const mn = Math.abs(peaks.data[o]);
        const mx = Math.abs(peaks.data[o + 1]);
        if (mn > peak) peak = mn;
        if (mx > peak) peak = mx;
      }
      out[i] += peak / 32767;
    }
  }
  let norm = 0;
  for (let i = 0; i < FP_BINS; i++) {
    out[i] /= chCount;
    norm += out[i] * out[i];
  }
  norm = Math.sqrt(norm);
  if (!norm) return null;
  return out.map((v) => Math.round((v / norm) * 10000) / 10000);
}

function fingerprintHash(peaks) {
  if (!peaks || !peaks.data) return null;
  const d = peaks.data;
  let h = 0x811c9dc5;
  for (let i = 0; i < d.length; i++) {
    h ^= d[i] & 0xffff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${d.length.toString(16)}-${h.toString(16)}`;
}

function ensureFingerprint(it) {
  if (!it || !it.peaks || !it.peaks.data) return;
  if (Array.isArray(it.peaks.zcr) && it.peaks.zcr.length) it.zcr = it.peaks.zcr;
  if (!it.fp) {
    const fp = computeFingerprint(it.peaks);
    if (fp) {
      it.fp = fp;
      it.fpHash = fingerprintHash(it.peaks);
      scheduleSave();
      // 「相似波形」面板开着的时候，算出一条就刷新一次，让结果逐步补全
      if (similarTargetPath) scheduleSimilarRender();
    }
  } else if (!it.fpHash) {
    it.fpHash = fingerprintHash(it.peaks);
  }
}

let similarRerenderTimer = 0;
function scheduleSimilarRender() {
  if (!similarTargetPath || similarRerenderTimer) return;
  similarRerenderTimer = setTimeout(() => {
    similarRerenderTimer = 0;
    if (!similarTargetPath) return;
    if (dom.similarPanel.classList.contains('hidden')) return;
    renderSimilarPanel();
  }, 160);
}

function itemDuration(it) {
  return (it.meta && it.meta.duration) || (it.peaks ? it.peaks.bins / (it.peaks.binsPerSecond || 320) : 0);
}

/** 0..1，1 = 波形完全一致（包络 + 过零率 + 时长都吻合）。 */
function similarityScore(a, b) {
  if (!a || !b || !a.fp || !b.fp) return 0;
  let dot = 0;
  const n = Math.min(a.fp.length, b.fp.length);
  for (let i = 0; i < n; i++) dot += a.fp[i] * b.fp[i];
  const env = Math.max(0, Math.min(1, dot));

  // 过零率轮廓差异：同一包络但音高/亮度不同的素材会在这里掉分。
  // 用相对差（差值 / 两侧平均水平）而不是绝对差，否则安静段的微小差别
  // 会被当成噪声吃掉，两段完全不同的音色也会显示成 99%。
  let tone = 1;
  if (Array.isArray(a.zcr) && Array.isArray(b.zcr) && a.zcr.length && a.zcr.length === b.zcr.length) {
    let diff = 0;
    let sum = 0;
    for (let i = 0; i < a.zcr.length; i++) {
      const x = a.zcr[i] || 0;
      const y = b.zcr[i] || 0;
      diff += Math.abs(x - y);
      sum += Math.abs(x) + Math.abs(y);
    }
    tone = sum > 1e-6 ? Math.max(0, 1 - diff / sum) : 1;
  }

  let score = env * 0.62 + tone * 0.38;

  const da = itemDuration(a);
  const db = itemDuration(b);
  if (da > 0 && db > 0) {
    const ratio = Math.min(da, db) / Math.max(da, db);
    // 时长差一倍左右仍然该算相似（剪辑版本），差太多才压分。
    score *= 0.45 + 0.55 * Math.pow(ratio, 0.5);
  }
  return Math.max(0, Math.min(1, score));
}

function similarCandidates(target) {
  const out = [];
  let pending = 0;
  for (const it of state.items) {
    if (it.path === target.path || it.missing) continue;
    if (!it.fp && it.peaks) ensureFingerprint(it);
    if (!it.fp) {
      pending++;
      continue;
    }
    const score = similarityScore(target, it);
    out.push({ it, score, same: !!(target.fpHash && it.fpHash && target.fpHash === it.fpHash) });
  }
  out.sort((x, y) => (y.same - x.same) || (y.score - x.score));
  return { list: out, pending };
}

let similarTargetPath = null;

function openSimilarPanel(it) {
  if (!it) return;
  similarTargetPath = it.path;
  if (!it.fp) {
    if (it.peaks) ensureFingerprint(it);
    else ensurePeaks(it);
  }
  if (state.ai.open) closeAiPanel();
  if (fxOpen) closeFxPanel();
  if (state.settingsOpen) closeSettings();
  dom.similarPanel.classList.remove('hidden');
  dom.similarScrim.classList.remove('hidden');
  renderSimilarPanel();
}

function closeSimilarPanel() {
  similarTargetPath = null;
  dom.similarPanel.classList.add('hidden');
  dom.similarScrim.classList.add('hidden');
}

function toggleSimilarPanel() {
  if (similarTargetPath) { closeSimilarPanel(); return; }
  const it = state.byPath.get(state.currentPath) ||
             (state.selection.size === 1 ? state.byPath.get([...state.selection][0]) : null);
  if (!it) { toast('先选中一个音频'); return; }
  openSimilarPanel(it);
}

function renderSimilarPanel() {
  const target = similarTargetPath ? state.byPath.get(similarTargetPath) : null;
  if (!target) { closeSimilarPanel(); return; }
  const body = dom.similarBody;
  body.replaceChildren();
  dom.similarTitle.textContent = '相似波形';

  const head = document.createElement('div');
  head.className = 'sim-head';
  const name = document.createElement('div');
  name.className = 'sim-target';
  name.textContent = target.name;
  name.title = target.path;
  head.appendChild(name);
  const dur = document.createElement('div');
  dur.className = 'setting-desc';
  dur.textContent = `比对对象：${fmtTC(itemDuration(target))}`;
  head.appendChild(dur);
  body.appendChild(head);

  const { list, pending } = similarCandidates(target);
  const top = list.slice(0, 40);

  if (!top.length) {
    const p = document.createElement('p');
    p.className = 'setting-desc';
    p.textContent = pending
      ? '资料库里还没有别的波形指纹，正在分析…'
      : '资料库里没有别的音频可以比对。';
    body.appendChild(p);
  } else {
    const wrap = document.createElement('div');
    wrap.className = 'sim-list';
    top.forEach((m, i) => {
      const row = document.createElement('div');
      row.className = 'sim-row' + (m.same ? ' same' : '') + (m.score > 0.9 ? ' close' : '');
      row.dataset.path = m.it.path;
      row.title = m.it.path;

      const rank = document.createElement('span');
      rank.className = 'sim-rank';
      rank.textContent = String(i + 1);

      const nm = document.createElement('span');
      nm.className = 'sim-name';
      nm.textContent = m.it.name;

      const dm = document.createElement('span');
      dm.className = 'sim-dur';
      dm.textContent = fmtDur(itemDuration(m.it));

      const bar = document.createElement('span');
      bar.className = 'sim-bar';
      const fill = document.createElement('i');
      fill.style.width = Math.round(m.score * 100) + '%';
      bar.appendChild(fill);

      const sc = document.createElement('span');
      sc.className = 'sim-score';
      sc.textContent = String(Math.round(m.score * 100));

      row.append(rank, nm, dm, bar, sc);
      if (m.same) {
        const tag = document.createElement('span');
        tag.className = 'sim-tag';
        tag.textContent = '相同';
        row.appendChild(tag);
      }
      row.addEventListener('click', () => {
        const it = state.byPath.get(m.it.path);
        if (!it) return;
        state.selection.clear();
        state.selection.add(it.path);
        state.focusPath = it.path;
        selectItem(it, { play: true });
        scheduleRender();
      });
      wrap.appendChild(row);
    });
    body.appendChild(wrap);

    const legend = document.createElement('p');
    legend.className = 'setting-desc';
    legend.textContent = '按 64 段响度包络的相似度排序（含时长权重）。数值 100 = 波形走向完全一致。'
      + (pending ? ` 还有 ${pending} 条音频尚未分析出波形，分析完会自动出现。` : '');
    body.appendChild(legend);
  }

  if (pending) {
    // 给没算过波形的项目排上队，面板下次打开就能看到它们。
    let n = 0;
    for (const it of state.items) {
      if (n >= 24) break;
      if (it.path !== target.path && !it.fp && !it.missing && it.analysis !== 'failed') {
        ensurePeaks(it);
        n++;
      }
    }
  }
}

function kickVisibleAnalysis(rows, first, last) {
  const limit = Math.min(last, first + 40);
  for (let i = first; i < limit; i++) {
    const it = rows[i];
    if (it && it.analysis === 'idle') requestAnalysis(it);
  }
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------
function audioUrl(p) {
  return `snd://app/audio?p=${encodeURIComponent(p)}`;
}

function refreshWaveIfCurrent(it) {
  if (state.currentPath !== it.path) return;
  updateWavePanel();
}

async function selectItem(it, { play = true } = {}) {
  if (!it) return;
  state.focusPath = it.path;
  if (!state.selection.has(it.path)) {
    state.selection.clear();
    state.selection.add(it.path);
  }
  scheduleRender();

  if (play) await playItem(it);
  else updateWavePanel();
}

/**
 * 修剪区间 → 可用的播放入口。没有标记、区间退化、起点已经越过文件尾都返回 null。
 */
function trimmableClip(it) {
  const t = it && it.trim;
  if (!t) return null;
  const dur = (it.meta && it.meta.duration) || 0;
  const start = Math.max(0, Math.min(t.start, t.end));
  let end = Math.max(t.start, t.end);
  if (!(end > start + 0.005)) return null;
  if (dur > 0) {
    if (start >= dur - 0.005) return null;
    end = Math.min(end, dur);
  }
  return { start, end };
}

function playheadOutsideClip() {
  if (!player.clipActive) return false;
  const t = player.currentTime || 0;
  return t < player.clipStart - 0.005 || t >= player.clipEnd - 0.005;
}

async function playItem(it) {
  if (!it) return;
  // 不是悬停发起的播放 → 这条归用户管，之后鼠标移开也不许停它
  if (!hoverPlayIntent) releaseHoverPlayback();
  if (it.missing) {
    toast('文件已不在原位置: ' + it.name);
    return;
  }
  if (it.analysis !== 'ready') {
    // Ensure metadata before we touch the player.
    requestAnalysis(it, true);
  }
  // AIFF 这类 Chromium 放不了的格式，要先等一份缓存 WAV 才能拿到 playPath。
  // 其余格式直接播，波形可以晚一步到。
  if (it.needsTranscode || !it.peaks) ensurePeaks(it);

  const path = it.playPath || it.path;
  const url = audioUrl(path);

  // 被修剪过的素材：只播保留的那一段（见 Player.setClip）
  const clip = trimmableClip(it);
  player.setClip(clip ? clip.start : null, clip ? clip.end : null);

  // Already loaded? just resume.
  if (state.currentPath === it.path && player.url === url) {
    if (!player.paused) return;
    if (player.clipActive && playheadOutsideClip()) player.seek(player.clipStart);
    state.playing = true;
    updateTransport();
    await player.play();
    return;
  }

  state.currentPath = it.path;
  state.loading = true;
  // 换了文件就把视图带回 100% 并恢复播放头跟随
  wave.follow = true;
  // A new file always starts at unity gain: the dB you dialed in for the
  // previous clip almost never belongs to this one (and a hot clip inheriting
  // -30 dB just sounds broken).
  setGainDb(0);
  updateWavePanel();
  updateTransport();

  player.setUrl(url);
  try {
    await player.play();
    state.playing = true;
  } catch {
    state.playing = false;
  }
  if (player.clipActive && playheadOutsideClip()) player.seek(player.clipStart);
  state.loading = false;
  updateTransport();
  scheduleRender();
}

function togglePlay() {
  if (!state.currentPath) {
    const first = state.view[0] || state.items[0];
    if (first) selectItem(first);
    return;
  }
  if (state.playing) {
    player.pause();
    state.playing = false;
  } else {
    // 已播到修剪区间的尾巴时，空格应该是"从头再听一遍"，而不是原地卡住
    if (player.clipActive && playheadOutsideClip()) player.seek(player.clipStart);
    state.playing = true;
    player.play();
  }
  updateTransport();
  scheduleRender();
}

function stopPlayback() {
  player.stop();
  state.playing = false;
  updateTransport();
  updateWavePanel();
  scheduleRender();
}

function stepSelection(delta) {
  const rows = state.view;
  if (!rows.length) return;
  let idx = state.focusPath ? rows.findIndex((i) => i.path === state.focusPath) : -1;
  if (idx < 0) idx = delta > 0 ? -1 : rows.length;
  let next = idx + delta;
  if (next < 0) next = 0;
  if (next >= rows.length) next = rows.length - 1;
  const it = rows[next];
  state.selection.clear();
  state.selection.add(it.path);
  state.focusPath = it.path;
  scrollToRow(next);
  playItem(it);
  scheduleRender();
}

function scrollToRow(idx) {
  const top = idx * ROW_H;
  const viewTop = dom.listBody.scrollTop;
  const viewBottom = viewTop + dom.listBody.clientHeight;
  if (top < viewTop) dom.listBody.scrollTop = top;
  else if (top + ROW_H > viewBottom) dom.listBody.scrollTop = top + ROW_H - dom.listBody.clientHeight + 4;
}

function updateTransport() {
  const it = state.items.find((i) => i.path === state.currentPath) || null;
  dom.iconPlay.classList.toggle('hidden', state.playing);
  dom.iconPause.classList.toggle('hidden', !state.playing);
  dom.btnPlay.title = state.playing ? '暂停 (空格)' : '播放 (空格)';

  const dur = player.duration || (it && it.meta ? it.meta.duration : 0) || 0;
  dom.tcTotal.textContent = fmtTC(dur);
  dom.tcCurrent.textContent = fmtTC(player.currentTime || 0);

  dom.iconVol.classList.toggle('hidden', state.muted);
  dom.iconMuted.classList.toggle('hidden', !state.muted);
  dom.chipLoop.classList.toggle('on', state.loop);
  dom.chipMono.classList.toggle('on', state.mono);
  syncWaveGainChip();

  const label = state.muted ? '静音' : (state.gainDb <= -60 ? '-∞ dB' : `${state.gainDb > 0 ? '+' : ''}${state.gainDb.toFixed(1)} dB`);
  dom.volReadout.textContent = label;
  dom.volume.value = String(state.gainDb);
  const pct = Math.max(0, Math.min(100, ((state.gainDb + 60) / 72) * 100));
  dom.volume.style.setProperty('--p', `${state.muted ? 0 : pct}%`);

  // 贴边面板里的增益旋钮（和主音量是同一份状态）
  if (dom.gainKnobValue) {
    dom.gainKnobValue.textContent = state.muted ? 'MUTE' : label;
    dom.gainKnob.classList.toggle('muted', state.muted);
    const rot = -135 + Math.max(0, Math.min(1, (state.gainDb + 60) / 72)) * 270;
    dom.gainKnobDial.style.setProperty('--rot', `${rot.toFixed(1)}deg`);
  }

  dom.btnPrev.classList.toggle('disabled', state.items.length === 0);
  dom.btnNext.classList.toggle('disabled', state.items.length === 0);
}

// ---------------------------------------------------------------------------
// Waveform panel
// ---------------------------------------------------------------------------
let wavePanelBusy = false;
function updateWavePanel() {
  // 防重入：ensurePeaks 的进度回调会再进这里，不挡会递归（栈溢出 → 界面卡死/黑屏）
  if (wavePanelBusy) return;
  wavePanelBusy = true;
  try {
    updateWavePanelInner();
  } finally {
    wavePanelBusy = false;
  }
}

function updateWavePanelInner() {
  const it = state.items.find((i) => i.path === state.currentPath) || null;
  if (!it) {
    dom.waveName.textContent = '未选择音频';
    dom.waveMeta.textContent = '';
    dom.waveHint.classList.remove('hidden');
    dom.waveHint.textContent = '点击列表中的音频开始试听';
    wave.setData(null, 0);
    dom.waveTime.textContent = '00:00.000';
    return;
  }

  dom.waveName.textContent = it.name;
  const m = it.meta || {};
  const bits = [];
  if (m.container) bits.push(m.container);
  if (m.codec) bits.push(m.codec + (m.bitDepth ? ` ${m.bitDepth}bit` : ''));
  if (m.sampleRate) bits.push(`${m.sampleRate} Hz`);
  if (m.channels) bits.push(fmtChannels(m.channels) === '1' ? '单声道' : `${m.channels} ch`);
  if (m.isBWF) bits.push('BWF');
  if (it.trim) bits.push(`修剪 ${fmtTC(it.trim.start)}–${fmtTC(it.trim.end)}`);
  if (it.missing) bits.push('文件缺失');
  dom.waveMeta.textContent = bits.join('  ·  ');
  dom.waveMeta.title = it.path;

  if (it.peaks) {
    dom.waveHint.classList.add('hidden');
    const srcKey = it.playPath || it.path;
    // 同一个文件的波形已经在画布上了：不要重建，否则缩放和选区都会被抹掉。
    const sameData = wave.peaks === it.peaks && wave.srcPath === srcKey;
    if (!sameData) {
      wave.setData(it.peaks, m.duration || player.duration || 0, srcKey);
      if (it.trim) wave.selection = { start: it.trim.start, end: it.trim.end };
      wave.markDirty();
    }
  } else {
    dom.waveHint.classList.remove('hidden');
    dom.waveHint.textContent = it.missing ? '文件缺失' :
      (it.analysis === 'failed' ? '无法解析该格式' :
        (it.peaksState === 'pending' ? '正在解析波形…' : '正在解析波形…'));
    wave.setData(null, m.duration || 0);
    // 波形是按需算的：选中一条就顺手取（缓存命中时是毫秒级的）
    if (!it.missing && it.analysis !== 'failed' && it.peaksState !== 'loading' && !peaksInflight.has(it.path)) {
      ensurePeaks(it);
    }
  }
  syncWaveGainChip();
  syncZoomChip();
  syncTrimChip();
  if (state.infoOpen) renderInfoPanel(it);
  // 需求：点一条音频，右侧空白处自动出现信息
  else if (state.autoInfo && it && window.innerWidth > 820) openInfoPanel(it);
  dom.waveTime.textContent = fmtTC(player.currentTime || 0);
}

// ---------------------------------------------------------------------------
// Per-frame playhead
// ---------------------------------------------------------------------------
let lastTc = -1;
function tickPlayhead() {
  const t = player.currentTime || 0;
  const dur = player.duration || 0;
  wave.setTime(t);

  const shown = Math.round(t * 1000);
  if (shown !== lastTc) {
    lastTc = shown;
    dom.tcCurrent.textContent = fmtTC(t);
    dom.waveTime.textContent = fmtTC(t);
  }

  // 修剪过的素材：播到区间尾巴就停（或循环回起点），不要一路播到文件结尾
  if (state.playing && player.clipActive && t >= player.clipEnd - 0.006) {
    if (state.loop) {
      player.seek(player.clipStart);
      wave.setTime(player.clipStart);
      dom.tcCurrent.textContent = fmtTC(player.clipStart);
      dom.waveTime.textContent = fmtTC(player.clipStart);
      lastTc = Math.round(player.clipStart * 1000);
    } else {
      player.pause();
      player.seek(player.clipEnd);
      wave.setTime(player.clipEnd);
      dom.tcCurrent.textContent = fmtTC(player.clipEnd);
      dom.waveTime.textContent = fmtTC(player.clipEnd);
      lastTc = Math.round(player.clipEnd * 1000);
      state.playing = false;
      updateTransport();
      scheduleRender();
    }
  }

  if (state.playing && dur > 0 && t > dur - 0.01 && player.paused) {
    state.playing = false;
    updateTransport();
    scheduleRender();
  }
  requestAnimationFrame(tickPlayhead);
}

// ---------------------------------------------------------------------------
// Library import
// ---------------------------------------------------------------------------
function addFiles(fileInfos, { silent = false, analyzeFirst = false, collectionId = null, categoryId = null, deferRender = false } = {}) {
  const existing = state.byPath;
  let added = 0;
  let skipped = 0;
  const fresh = [];

  for (const f of fileInfos) {
    const p = f.path;
    if (!p) continue;
    if (existing.has(p)) { skipped++; continue; }
    const it = makeItem(f);
    if (categoryId && categoryById(categoryId)) it.categoryId = categoryId;
    ensureCategory(it);
    state.items.push(it);
    existing.set(p, it);
    added++;
    fresh.push(it);
  }

  // Dropping onto a library tags everything that was dropped, including files
  // that were already in the list — otherwise the second drop onto the same
  // library silently looks like it did nothing.
  let tagged = 0;
  if (collectionId && collectionById(collectionId)) {
    for (const f of fileInfos) {
      const it = existing.get(f.path);
      if (it && !it.collections.includes(collectionId)) { it.collections.push(collectionId); tagged++; }
    }
  } else if (categoryId && categoryById(categoryId)) {
    for (const f of fileInfos) {
      const it = existing.get(f.path);
      if (it && it.categoryId !== categoryId) { it.categoryId = categoryId; tagged++; }
    }
  }

  if (added || tagged) {
    // Bulk callers (one folder per new library) redraw once at the end.
    if (!deferRender) {
      computeView();
      renderSidebar();
      scheduleRender();
    }
    scheduleSave();
  }

  if (!silent) {
    const parts = [];
    if (added) parts.push(`导入 ${added} 个音频`);
    if (skipped) parts.push(`跳过 ${skipped} 个重复`);
    if (tagged) {
      parts.push(collectionId
        ? `加入「${collectionName(collectionId)}」`
        : `归入「${categoryName(categoryId)}」`);
    }
    toast(parts.length ? parts.join('，') : '没有可导入的音频');
  }

  if (analyzeFirst && fresh.length) {
    // 首屏那几条先插队（马上能看到时长/格式），剩下的排队 probe。
    // probe 只读文件头，9000 条也就是十几秒，而不是把 100 GB 全读一遍。
    fresh.slice(0, 8).forEach((it) => requestAnalysis(it, true));
    for (let i = 8; i < fresh.length; i++) requestAnalysis(fresh[i]);
  }
  return { added, skipped, tagged };
}

async function importViaDialog(kind) {
  const paths = await sb.invoke(kind === 'folder' ? 'dialog:pick-folder' : 'dialog:pick-files');
  if (!paths || !paths.length) return;
  const files = await sb.invoke('library:scan', paths);
  if (!files || !files.length) {
    toast('没有找到音频文件');
    return;
  }
  addFiles(files, { analyzeFirst: true });
}

// ---------------------------------------------------------------------------
// Drag out to DAW
// ---------------------------------------------------------------------------

/**
 * Set while a drag we started ourselves is in flight. The OS feeds that drag
 * straight back into this window, so without this the app sees its own drag as
 * an external file drop and offers to import the clips it is carrying.
 */
let dragOutGuardUntil = 0;
const dragOutInFlight = () => Date.now() < dragOutGuardUntil;

function dragPathsFor(item) {
  if (state.selection.size > 1 && state.selection.has(item.path)) {
    return [...state.selection].filter((p) => {
      const it = state.byPath.get(p);
      return it && !it.missing;
    });
  }
  return item.missing ? [] : [item.path];
}

// 拖出去的文件路径：带修剪区间的条目要换成"裁剪成品"的缓存文件，
// 这样从列表里拖的时候拿到的一定是改过的那一段，不必再去「经过处理」里找。
const clipPathCache = new Map();  // "路径|起点|终点" → 缓存文件路径
const clipPending = new Map();    // 同一区间只发一次 IPC

function clipCacheKey(src, clip) {
  return `${src}|${clip.start.toFixed(3)}|${clip.end.toFixed(3)}`;
}

// 开着效果器时，拖出去的必须是"处理过的那一版"：离线跑一遍效果器链、
// 编成 24-bit WAV 落到 cache\fx\<参数签名>\ 里，再把那个文件的路径交给系统。
// 参数没动过（或者效果器等于直通）就不折腾，直接拖原文件。
const fxDragCache = new Map();   // "源路径|参数签名" → 缓存文件路径
const fxDragPending = new Map();

/** 效果器参数是不是真的会改变声音（默认值 = 直通）。 */
function fxAudible(f) {
  if (!f) return false;
  return f.hp > 20.5 || f.lp < 17999 || Math.abs(f.bellGain) > 0.05 || !!f.compOn || !!f.revOn;
}

function fxSignature() {
  const f = state.fx;
  return [f.hp, f.lp, f.bellFreq, f.bellGain, f.compOn, f.compThreshold, f.compRatio,
    f.revOn, f.revMix, f.revTime, f.revDamp].join('|');
}

function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * 给一条素材渲染"效果器版本"，返回缓存文件路径；用不上或失败返回 null
 * （调用方退回原始文件，拖拽本身不会因此失败）。
 */
async function ensureFxDragFile(it) {
  if (!state.fx.enabled || !fxAudible(state.fx)) return null;
  const src = it.playPath || it.path;
  const sig = fxSignature();
  const key = `${src}|${sig}`;
  const hit = fxDragCache.get(key);
  if (hit) return hit;

  // 先用清单里已知的时长/大小挡一道：解码本身就要几百 MB，
  // 等解出来再拦已经晚了（渲染进程会直接崩，看起来就是"软件闪退"）。
  const metaDur = Number(it.meta && it.meta.duration) || 0;
  const metaSize = Number(it.size) || 0;
  if (metaDur > 480 || metaSize > 120 * 1024 * 1024) {
    toast('这条太长（' + fmtTC(metaDur) + '），效果器版本请先用「导出处理后的 WAV」，或划一段修剪区间再拖', 5200);
    return null;
  }

  let pending = fxDragPending.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        const res = await fetch(audioUrl(src));
        if (!res.ok) return null;
        const buf = await res.arrayBuffer();
        const rate = peekWavRate(buf);
        const decodeCtx = rate ? new OfflineAudioContext(2, 1, rate) : player.ctx;
        let decoded;
        try {
          decoded = await decodeCtx.decodeAudioData(buf.slice(0));
        } catch {
          return null;  // 浏览器解不开的格式（APE/WMA…）就退回原文件
        }
        // 内存闸门：整条解码成 float32 再离线渲染，长素材会吃掉几百 MB。
        // 两个进程各存一份（渲染进程 float + 主进程 24-bit WAV），十万级采样
        // 以上就该劝退，否则表现就是拖到一半整个应用消失。
        const chans = Math.min(2, decoded.numberOfChannels || 1);
        const samples = decoded.length * chans;
        const tooLong = decoded.duration > 480 || samples > 6e7;
        if (tooLong) {
          toast('这条太长（' + fmtTC(decoded.duration) + '），效果器版本请先用「导出处理后的 WAV」，或在波形上划一段修剪区间再拖', 5200);
          return null;  // 退回原文件，不硬渲染
        }
        const out = await renderOffline(decoded, state.fx);
        const wav = encodeWav24(out);
        const base = String(it.name || 'audio').replace(/\.[^.]+$/, '');
        const saved = await sb.invoke('audio:fx-wav', { buffer: wav, sig: hash32(sig), base });
        if (saved && saved.ok && saved.path) {
          fxDragCache.set(key, saved.path);
          return saved.path;
        }
        return null;
      } catch (err) {
        console.warn('fx drag render failed', err);
        return null;
      } finally {
        fxDragPending.delete(key);
      }
    })();
    fxDragPending.set(key, pending);
  }
  return pending;
}

/**
 * 给一条素材准备"拖出用"的文件路径。
 * 返回 { path, clipped, fxed }：没有修剪区间／格式不支持时 clipped=false；
 * 开着效果器时 fxed=true，path 是离线渲染过的版本。
 */
async function ensureDragFile(it) {
  let fxPath = null;
  try { fxPath = await ensureFxDragFile(it); } catch { fxPath = null; }
  const basePath = fxPath || it.playPath || it.path;
  const clip = trimmableClip(it);
  if (!clip) return { path: basePath, clipped: false, fxed: !!fxPath };
  const key = clipCacheKey(basePath, clip);
  const hit = clipPathCache.get(key);
  if (hit) return { path: hit, clipped: true, fxed: !!fxPath };

  let pending = clipPending.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        const res = await sb.invoke('audio:clip', { path: basePath, start: clip.start, end: clip.end });
        if (res && res.ok && res.path) {
          clipPathCache.set(key, res.path);
          return res.path;
        }
        return null;
      } catch {
        return null;
      } finally {
        clipPending.delete(key);
      }
    })();
    clipPending.set(key, pending);
  }
  const done = await pending;
  return done ? { path: done, clipped: true, fxed: !!fxPath } : { path: basePath, clipped: false, fxed: !!fxPath };
}

/** 把本次拖拽要交给系统的文件收集齐（多选时逐个处理）。 */
async function collectDragFiles(item) {
  const items = dragPathsFor(item)
    .map((p) => state.byPath.get(p))
    .filter(Boolean);
  const out = [];
  let fallback = false;
  let fxed = false;
  for (const it of items) {
    const got = await ensureDragFile(it);
    if (!got.clipped && trimmableClip(it)) fallback = true;
    if (got.fxed) fxed = true;
    if (got.path && !out.includes(got.path)) out.push(got.path);
  }
  return { files: out, fallback, fxed };
}

/** 把一个条目真正拖出去（列表行和 Agent 检索结果共用）。 */
// 拖出去那一行会调暗（.dragging），用来和别的行区分开。
// 但 native 拖拽（webContents.startDrag）接管之后 HTML5 的 dragend 不一定还会发，
// 松手后这行就会一直灰着——所以除了 dragend，还有下面几处兜底。
function clearDragMarks() {
  for (const el of document.querySelectorAll('.row.dragging, .ai-row.dragging, .sim-row.dragging')) {
    el.classList.remove('dragging');
  }
}

async function startDragOut(item, e) {
  if (!item) return;
  if (e) e.preventDefault();
  const srcRow =
    e && e.target && e.target.closest
      ? e.target.closest('.row') || e.target.closest('.ai-row') || e.target.closest('.sim-row')
      : null;
  if (srcRow) srcRow.classList.add('dragging');
  // 万一 drag:start 永远不返回（系统拖拽被别的程序吃掉），也别把灰一直留着
  const watchdog = setTimeout(clearDragMarks, 15000);
  // 渲染效果版 / 裁切要读整段音频，大文件会要几秒：先说一声，免得像卡死
  toast('正在准备拖出的文件…', 1200);
  const picked = await collectDragFiles(item);
  const files = picked.files;
  if (!files.length) {
    clearTimeout(watchdog);
    clearDragMarks();
    toast('文件缺失，无法拖出');
    return;
  }
  if (picked.fxed) {
    toast('拖出去的是效果器处理后的版本（24-bit WAV）', 3000);
  } else if (picked.fallback) {
    toast('这条素材的格式不支持裁剪，拖出去的是原始文件', 4000);
  }
  // 开始拖出去（拖到 DAW / 资源管理器）就把试听停掉：否则整段素材会在
  // 拖拽途中继续响，落下之后还在响，很容易盖住 DAW 里正在听的东西。
  if (state.playing) {
    player.pause();
    state.playing = false;
    updateTransport();
    scheduleRender();
  }
  // Our own drag re-enters this window as an ordinary file drag, so the
  // import overlay would pop up over the row the user just grabbed and a
  // release inside the window would re-import it. Hold the guard for the
  // whole drag, plus a short tail for the drop event that follows the
  // promise resolving.
  dragOutGuardUntil = Infinity;
  dom.dropOverlay.classList.remove('active');
  try {
    // 原生拖拽在 Windows 上是个模态循环，落点是某些 DAW 时偶尔不会回来；
    // 超时就当它结束，至少把「正在拖」的状态和图标清掉
    await Promise.race([
      sb.invoke('drag:start', { files }),
      new Promise((resolve) => setTimeout(resolve, 90000))
    ]);
  } catch {
    /* the guard is released below regardless */
  } finally {
    clearTimeout(watchdog);
    dragOutGuardUntil = Date.now() + 800;
    clearDragMarks();
    dom.dropOverlay.classList.remove('active');
    requestAnimationFrame(() => scheduleRender());
  }
}

function setupDragOut() {
  // 悬停即试听：停在某一行 0.7 秒才播（见 queueHoverPreview），移开/点击/拖拽都停
  dom.listBody.addEventListener('mouseover', (e) => {
    const rowEl = e.target.closest ? e.target.closest('.row') : null;
    if (!rowEl || !rowEl._item) return;
    if (rowEl._item.path === hoverPath) return;
    queueHoverPreview(rowEl._item);
  });
  dom.listBody.addEventListener('mouseleave', () => cancelHoverPreview(true));
  dom.listBody.addEventListener('mousedown', () => cancelHoverPreview(false));
  dom.listBody.addEventListener('dragstart', () => cancelHoverPreview(false));
  dom.listBody.addEventListener('scroll', () => cancelHoverPreview(false), { passive: true });

  // AI 结果行也要能悬停试听：删掉那条的空行占位后重新绑
  function bindAiRowHover() {
    const box = document.getElementById('aiResults');
    if (!box || box._hoverBound) return;
    box._hoverBound = true;
    box.addEventListener('mouseover', (e) => {
      const row = e.target.closest ? e.target.closest('.ai-row') : null;
      if (!row || !row.dataset.path) return;
      if (row.dataset.path === hoverPath) return;
      const it = state.byPath.get(row.dataset.path);
      if (it) queueHoverPreview(it);
    });
    box.addEventListener('mouseleave', () => cancelHoverPreview(true));
    box.addEventListener('mousedown', () => cancelHoverPreview(false));
    box.addEventListener('dragstart', () => cancelHoverPreview(false));
    box.addEventListener('scroll', () => cancelHoverPreview(false), { passive: true });
  }
  bindAiRowHover();

  dom.listRows.addEventListener('dragstart', (e) => {
    const rowEl = e.target.closest ? e.target.closest('.row') : null;
    const item = rowEl && rowEl._item;
    if (!item) return;
    startDragOut(item, e);
  });

  dom.listRows.addEventListener('dragend', () => {
    clearDragMarks();
  });

  // dragend 靠不住：拖到别的窗口、或者系统拖拽抢走事件时都要靠这两条
  window.addEventListener('blur', clearDragMarks);
  document.addEventListener('pointerup', clearDragMarks, true);
  document.addEventListener('drop', () => setTimeout(clearDragMarks, 0), true);
}

// ---------------------------------------------------------------------------
// Selection handling
// ---------------------------------------------------------------------------
function setupListInteraction() {
  dom.listBody.addEventListener('mousedown', (e) => {
    const rowEl = e.target.closest ? e.target.closest('.row') : null;
    if (!rowEl || !rowEl._item) return;
    const it = rowEl._item;
    const idx = state.view.indexOf(it);

    if (e.button === 2) return; // context menu handled separately

    if (e.shiftKey && state.focusPath) {
      const anchor = state.view.findIndex((i) => i.path === state.focusPath);
      if (anchor >= 0) {
        const [a, b] = anchor < idx ? [anchor, idx] : [idx, anchor];
        state.selection.clear();
        for (let i = a; i <= b; i++) state.selection.add(state.view[i].path);
        state.focusPath = it.path;
        scheduleRender();
        updateWavePanelForSelection();
        return;
      }
    }

    if (e.ctrlKey || e.metaKey) {
      if (state.selection.has(it.path)) state.selection.delete(it.path);
      else state.selection.add(it.path);
      state.focusPath = it.path;
      scheduleRender();
      return;
    }

    const wasOnly = state.selection.size === 1 && state.selection.has(it.path);
    state.selection.clear();
    state.selection.add(it.path);
    state.focusPath = it.path;
    scheduleRender();

    if (wasOnly && state.currentPath === it.path) {
      togglePlay();
    } else {
      playItem(it);
    }
  });

  dom.listBody.addEventListener('dblclick', (e) => {
    const rowEl = e.target.closest ? e.target.closest('.row') : null;
    if (!rowEl || !rowEl._item) return;
    openInFinder(rowEl._item);
  });

  dom.listBody.addEventListener('contextmenu', (e) => {
    const rowEl = e.target.closest ? e.target.closest('.row') : null;
    if (!rowEl || !rowEl._item) return;
    e.preventDefault();
    const it = rowEl._item;
    if (!state.selection.has(it.path)) {
      state.selection.clear();
      state.selection.add(it.path);
      state.focusPath = it.path;
      scheduleRender();
    }
    showContextMenu(e.clientX, e.clientY, it);
  });

  dom.listBody.addEventListener('scroll', () => scheduleRender(), { passive: true });
}

function updateWavePanelForSelection() {
  const p = state.focusPath;
  if (!p) return;
  const it = state.byPath.get(p);
  if (it) {
    state.currentPath = it.path;
    updateWavePanel();
  }
}

// ---------------------------------------------------------------------------
// Context menu (custom, no Electron menu needed)
// ---------------------------------------------------------------------------
let ctxEl = null;
function showContextMenu(x, y, item, customActions) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  const actions = customActions || [
    { label: '试听 / 暂停', run: () => playItem(item) },
    { label: '音频信息 (Ctrl+I)', run: () => openInfoPanel(item) },
    { label: '查找相似波形 (Ctrl+F)', run: () => openSimilarPanel(item) },
    { label: '在资源管理器中显示', run: () => openInFinder(item) },
    { label: '复制文件路径', run: () => copyText(item.path) },
    { label: '复制文件名', run: () => copyText(item.name) },
    { sep: true },
    { label: '加入资料库…', run: () => showCollectionPicker(x, y, item) },
    { label: '移动到分类…', run: () => showCategoryPicker(x, y, item) },
    { label: '批量工作流…', run: () => showBatchMenu(x, y, item) },
    ...(item.missing
      ? [{ label: '重新检查这个文件', run: () => relinkOne(item) }]
      : []),
    ...(state.filter.type === 'collection'
      ? [{ label: `从「${collectionName(state.filter.value)}」移出`, run: () => removeItemsFromCollection(menuTargets(item), state.filter.value) }]
      : []),
    { sep: true },
    { label: state.selection.size > 1 ? `从列表移除所选 (${state.selection.size})` : '从列表移除', run: () => removeSelection() },
    { label: '用系统播放器打开', run: () => sb.invoke('shell:open', item.path) }
  ];

  for (const a of actions) {
    if (a.sep) {
      const s = document.createElement('div');
      s.className = 'ctx-sep';
      menu.appendChild(s);
      continue;
    }
    const b = document.createElement('button');
    b.className = 'ctx-item';
    if (a.danger) b.classList.add('danger');
    if (a.muted) b.classList.add('muted');
    b.textContent = a.label;
    b.addEventListener('click', () => {
      closeContextMenu();
      a.run();
    });
    menu.appendChild(b);
  }

  document.body.appendChild(menu);
  ctxEl = menu;

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth - 6) menu.style.left = Math.max(6, window.innerWidth - rect.width - 6) + 'px';
  if (rect.bottom > window.innerHeight - 6) menu.style.top = Math.max(6, window.innerHeight - rect.height - 6) + 'px';
}

/** The row that was right-clicked plus the rest of the selection when it is part of it. */
function menuTargets(item) {
  if (!item) return [];
  if (state.selection.size > 1 && state.selection.has(item.path)) {
    return [...state.selection].map((p) => state.byPath.get(p)).filter(Boolean);
  }
  return [item];
}

/** Second-level menu: pick (or create) a library to drop the current rows into. */
function showCollectionPicker(x, y, item) {
  const items = menuTargets(item || state.byPath.get(state.focusPath));
  const acts = state.collections.map((col) => ({
    label: col.name,
    run: () => addItemsToCollection(items, col.id)
  }));
  if (state.collections.length) acts.push({ sep: true });
  acts.push({
    label: '＋ 新建资料库…',
    run: () => createCollectionFromPrompt(items)
  });
  showContextMenu(x, y, null, acts);
}

function createCollectionFromPrompt(seedItems) {
  pendingCollectionSeed = seedItems && seedItems.length ? seedItems : null;
  beginCollectionInput('create', null);
}

/** Second-level menu: move the current rows into one category. */
function showCategoryPicker(x, y, item) {
  const items = menuTargets(item || state.byPath.get(state.focusPath));
  const acts = state.categories.map((cat) => ({
    label: cat.name,
    run: () => addItemsToCategory(items, cat.id)
  }));
  if (state.categories.length) acts.push({ sep: true });
  acts.push({
    label: '＋ 新建分类…',
    run: () => {
      pendingCategorySeed = items;
      beginCategoryInput('create', null);
    }
  });
  showContextMenu(x, y, null, acts);
}

function closeContextMenu() {
  if (ctxEl) { ctxEl.remove(); ctxEl = null; }
}

document.addEventListener('mousedown', (e) => {
  if (ctxEl && !ctxEl.contains(e.target)) closeContextMenu();
}, true);

async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
    toast('已复制');
  } catch {
    toast('复制失败');
  }
}

function openInFinder(item) {
  if (item.missing) {
    toast('文件已不在原位置');
    return;
  }
  sb.invoke('shell:reveal', item.path);
}

function removeSelection() {
  const paths = [...state.selection];
  if (!paths.length) return;
  const removed = paths.map((p) => state.byPath.get(p)).filter(Boolean);
  state.lastRemoved = removed.map((it) => it.path);
  for (const p of paths) {
    const it = state.byPath.get(p);
    if (!it) continue;
    state.byPath.delete(p);
    const i = state.items.indexOf(it);
    if (i >= 0) state.items.splice(i, 1);
  }
  state.selection.clear();
  // 用户主动把清单删空：这是唯一允许写空清单的情形
  if (!state.items.length) emptyByUser = true;
  if (paths.includes(state.currentPath)) {
    player.stop();
    state.currentPath = null;
    state.playing = false;
    updateWavePanel();
    updateTransport();
  }
  computeView();
  renderSidebar();
  scheduleRender();
  scheduleSave();
  toast(`已从列表移除 ${removed.length} 个（文件未被删除）`);
}

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------
function applyGain() {
  player.setGainDb(state.gainDb);
  updateTransport();
  scheduleSave();
}

function setGainDb(db) {
  state.gainDb = Math.max(-60, Math.min(12, Math.round(db * 10) / 10));
  applyGain();
}

function adjustGain(delta) {
  setGainDb(state.gainDb + delta);
}

// ---------------------------------------------------------------------------
// Settings drawer
// ---------------------------------------------------------------------------
// 设置项越来越多，分成三块：常规 / 数据与位置 / AI 与插件。
// 只做「显示哪一组」，隐藏逻辑全在 style.css 的 `#settings[data-tab=…]` 规则里，
// 所以这里只负责给 data-tab 赋值 + 高亮按钮 + 记住上次看的是哪块。
const SETTINGS_TABS = ['general', 'data', 'ai'];

function setSettingsTab(tab, save = true) {
  const want = SETTINGS_TABS.includes(tab) ? tab : 'general';
  if (dom.settings) dom.settings.dataset.tab = want;
  const bar = $('settingsTabs');
  if (bar) {
    for (const btn of bar.querySelectorAll('.settings-tab')) {
      btn.classList.toggle('active', btn.dataset.tab === want);
    }
  }
  if (state.ai.settingsTab !== want) {
    state.ai.settingsTab = want;
    if (save) scheduleSave();
  }
}

function setupSettingsTabs() {
  const bar = $('settingsTabs');
  if (!bar || bar._tabsBound) return;
  bar._tabsBound = true;
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.settings-tab');
    if (!btn) return;
    setSettingsTab(btn.dataset.tab);
  });
}

async function openSettings() {
  state.settingsOpen = true;
  dom.settings.classList.remove('hidden');
  dom.settingsScrim.classList.remove('hidden');
  setSettingsTab(state.ai.settingsTab, false);
  syncDockTabs();
  // 每次打开都顺手问一下主进程：快捷键到底注册上没有（可能被别的程序占用）
  sb.invoke('dock:state')
    .then((st) => {
      if (st && typeof st.shortcut === 'boolean') {
        state.dock.shortcut = st.shortcut;
        syncDockUI();
      }
    })
    .catch(() => {});
  const info = await sb.invoke('app:info');
  dom.userDataPath.textContent = info.userData;
  const bytes = await sb.invoke('cache:size');
  dom.cacheSize.textContent = fmtSize(bytes);
  renderCleanupStats();
  renderRelinkStats();
  renderStorageInfo();
  renderBackupList();
  applyHoverAudition();
}

function closeSettings() {
  state.settingsOpen = false;
  dom.settings.classList.add('hidden');
  dom.settingsScrim.classList.add('hidden');
  syncDockTabs();
}

// ---------------------------------------------------------------------------
// Metadata drawer
// ---------------------------------------------------------------------------
/** 老 library.json 里的条目没有标签层：选中时按需补一次（很便宜）。 */
async function ensureTags(it) {
  if (!it || !it.meta || it.meta.tags !== undefined || it.tagLoading) return;
  if (it.analysis === 'idle') return; // 完整分析会带上标签
  it.tagLoading = true;
  try {
    const res = await sb.invoke('audio:tags', it.path);
    if (res && res.ok) {
      it.meta.tags = res.tags || null;
      it.meta.tagGroups = res.tagGroups && res.tagGroups.length ? res.tagGroups : null;
      it.meta.cover = res.cover || null;
      rebuildHaystack(it);
      if (state.infoOpen && state.currentPath === it.path) renderInfoPanel(it);
      scheduleSave();
    }
  } catch {
    /* 文件没了就算了 */
  } finally {
    it.tagLoading = false;
  }
}
function fmtDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 从包络数据里取真实峰值电平（dBFS）——不用再扫一遍文件。 */
function peakDbOf(peaks) {
  if (!peaks || !peaks.data) return null;
  let max = 0;
  for (let i = 1; i < peaks.data.length; i += 2) {
    const v = Math.abs(peaks.data[i]);
    if (v > max) max = v;
  }
  if (!max) return -Infinity;
  return 20 * Math.log10(max / 32767);
}

function infoRow(label, value, opts = {}) {
  const row = document.createElement('div');
  row.className = 'info-row';
  const k = document.createElement('span');
  k.className = 'info-key';
  k.textContent = label;
  const v = document.createElement('span');
  v.className = 'info-val' + (opts.mono ? ' mono' : '');
  v.textContent = value;
  if (opts.title) v.title = opts.title;
  v.addEventListener('click', () => copyText(String(value)));
  row.append(k, v);
  return row;
}

function infoSection(title) {
  const sec = document.createElement('section');
  sec.className = 'info-sec';
  const h = document.createElement('h4');
  h.textContent = title;
  sec.appendChild(h);
  return sec;
}

function renderInfoPanel(it) {
  const body = dom.infoBody;
  body.textContent = '';
  if (!it) {
    dom.infoTitle.textContent = '音频信息';
    const p = document.createElement('p');
    p.className = 'setting-desc';
    p.textContent = '先在列表里选中一个音频。';
    body.appendChild(p);
    return;
  }

  dom.infoTitle.textContent = it.name;
  const m = it.meta || {};
  const t = m.tags || {};

  const basic = infoSection('文件');
  basic.appendChild(infoRow('文件名', it.name));
  basic.appendChild(infoRow('路径', it.path, { mono: true, title: it.path }));
  basic.appendChild(infoRow('大小', fmtSize(it.size)));
  basic.appendChild(infoRow('修改时间', fmtDate(it.mtimeMs)));
  if (it.trim) {
    basic.appendChild(infoRow('修剪选区',
      `${fmtTC(it.trim.start)} – ${fmtTC(it.trim.end)}（${(it.trim.end - it.trim.start).toFixed(3)} s）`));
  }
  body.appendChild(basic);

  const tech = infoSection('技术参数');
  if (m.container) tech.appendChild(infoRow('容器', m.container));
  if (m.codec) tech.appendChild(infoRow('编码', m.codec));
  if (m.sampleRate) tech.appendChild(infoRow('采样率', `${m.sampleRate} Hz`));
  if (m.bitDepth) tech.appendChild(infoRow('位深', `${m.bitDepth} bit${m.isFloat ? ' float' : ''}`));
  if (m.channels) tech.appendChild(infoRow('声道', `${m.channels}（${fmtChannels(m.channels)}）`));
  if (m.duration) tech.appendChild(infoRow('时长', fmtTC(m.duration)));
  if (m.frames) tech.appendChild(infoRow('采样帧数', String(m.frames)));
  const db = peakDbOf(it.peaks);
  if (db != null) {
    tech.appendChild(infoRow('峰值电平', db === -Infinity ? '-∞ dBFS' : `${db.toFixed(2)} dBFS`));
  }
  if (m.isBWF) tech.appendChild(infoRow('BWF', '是'));
  if (it.categoryId) tech.appendChild(infoRow('分类', categoryName(it.categoryId)));
  const cols = (it.collections || []).map((id) => collectionName(id)).filter(Boolean);
  if (cols.length) tech.appendChild(infoRow('资料库', cols.join('、')));
  body.appendChild(tech);

  // 电平与响度 + 频谱图：本地算，异步填进来（几百 MB 的文件要一两秒）
  {
    const lv = infoSection('电平与响度');
    const lufs = infoRow('响度（LUFS-I）', '计算中…');
    lufs.id = 'infoLufs';
    const pk = infoRow('数字峰值', '计算中…');
    pk.id = 'infoPeakRow';
    const lra = infoRow('动态范围（LRA）', '计算中…');
    lra.id = 'infoLra';
    lv.appendChild(lufs);
    lv.appendChild(pk);
    lv.appendChild(lra);
    body.appendChild(lv);

    const sp = infoSection('频谱图');
    const canvas = document.createElement('canvas');
    canvas.className = 'info-spec';
    canvas.id = 'infoSpecCanvas';
    const note = document.createElement('p');
    note.className = 'setting-desc';
    note.id = 'infoSpecNote';
    note.textContent = '计算中…';
    sp.appendChild(canvas);
    sp.appendChild(note);
    body.appendChild(sp);

    const want = it.path;
    ensureDeep(it).then((d) => {
      if (state.currentPath !== want) return;
      const setVal = (id, text) => {
        const row = document.getElementById(id);
        const v = row && row.querySelector('.info-val');
        if (v) v.textContent = text;
      };
      if (!d) {
        setVal('infoLufs', '—');
        setVal('infoPeakRow', '—');
        setVal('infoLra', '—');
        const n2 = document.getElementById('infoSpecNote');
        if (n2) n2.textContent = '这个文件算不了（可能不是 PCM，或者读不到）';
        return;
      }
      const L = d.loudness || {};
      setVal('infoLufs', isFinite(L.integrated) ? `${L.integrated.toFixed(1)} LUFS` : '-∞');
      setVal('infoPeakRow', isFinite(L.peakDb) ? `${L.peakDb.toFixed(2)} dBFS` : '-∞');
      setVal('infoLra', isFinite(L.lra) ? `${L.lra.toFixed(1)} LU` : '—');
      const c2 = document.getElementById('infoSpecCanvas');
      if (c2 && d.spectrum) drawSpectrum(c2, d.spectrum);
      const n3 = document.getElementById('infoSpecNote');
      if (n3) {
        n3.textContent = d.spectrum
          ? `30 Hz – 20 kHz，横轴时间，越亮越响（K 加权前的原始频谱）`
          : '文件太短或读不到，没有频谱';
      }
    });
  }

  // 封面：内嵌图片优先，其次同目录的 cover/folder 图片（Soundminer 的做法）
  {
    const cover = infoSection('封面');
    const holder = document.createElement('div');
    holder.className = 'info-cover';
    holder.id = 'infoCover';
    cover.appendChild(holder);
    body.appendChild(cover);
    loadCoverInto(holder, it, cover);
  }

  for (const g of (m.tagGroups || [])) {
    const sec = infoSection(g.title);
    for (const [label, value] of g.rows) sec.appendChild(infoRow(label, value));
    body.appendChild(sec);
  }

  if (!m.tagGroups || !m.tagGroups.length) {
    const none = infoSection('元数据');
    const p = document.createElement('p');
    p.className = 'setting-desc';
    p.textContent = m.tags && Object.keys(m.tags).length
      ? '只找到通用字段，没有 BWF / iXML / ID3 标签块。'
      : '这个文件没有内嵌标签（bext / iXML / LIST-INFO / ID3 都没找到）。';
    none.appendChild(p);
    body.appendChild(none);
  }

  const foot = document.createElement('div');
  foot.className = 'info-foot';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn small';
  copyBtn.textContent = '复制全部信息';
  copyBtn.addEventListener('click', () => copyText(infoAsText(it)));
  foot.appendChild(copyBtn);
  body.appendChild(foot);
}

function infoAsText(it) {
  const lines = [it.name, it.path];
  const rows = dom.infoBody.querySelectorAll('.info-sec');
  for (const sec of rows) {
    const title = sec.querySelector('h4');
    if (title) lines.push('', `[${title.textContent}]`);
    for (const row of sec.querySelectorAll('.info-row')) {
      const k = row.querySelector('.info-key');
      const v = row.querySelector('.info-val');
      if (k && v) lines.push(`${k.textContent}: ${v.textContent}`);
    }
  }
  return lines.join('\n');
}

function openInfoPanel(it) {
  state.infoOpen = true;
  state.autoInfo = true;
  document.body.classList.add('info-open');
  dom.infoPanel.classList.remove('hidden');
  renderInfoPanel(it);
  if (it) ensureTags(it);
}

function closeInfoPanel(keepAuto = false) {
  state.infoOpen = false;
  // 用户手动关掉之后就别再自动弹了，直到他自己用 Ctrl+I 或再点开
  // 进贴边模式时是程序自己收起的，不能当成用户主动关掉
  if (!keepAuto) state.autoInfo = false;
  document.body.classList.remove('info-open');
  dom.infoPanel.classList.add('hidden');
}

function toggleInfoPanel() {
  if (state.infoOpen) { closeInfoPanel(); return; }
  const it = state.byPath.get(state.currentPath) ||
             (state.selection.size === 1 ? state.byPath.get([...state.selection][0]) : null);
  if (!it) { toast('先选中一个音频'); return; }
  openInfoPanel(it);
}

/** 封面预览：内嵌图片优先，其次同目录的 cover/folder 图片。 */
async function loadCoverInto(holder, it, section) {
  holder.textContent = '正在读取封面…';
  const addNote = (text) => {
    if (!section) return;
    const p = document.createElement('p');
    p.className = 'setting-desc';
    p.textContent = text;
    section.appendChild(p);
  };
  try {
    let res = artCache.get(it.path);
    if (res === undefined) {
      const raw = await sb.invoke('art:cover', { path: it.path });
      res = raw && raw.ok
        ? { url: raw.url, source: raw.source, from: raw.from, rel: raw.rel, mime: raw.mime, bytes: raw.bytes }
        : null;
      artCache.set(it.path, res);
    }
    if (!res || !res.url) {
      const img = new Image();
      img.className = 'cover-placeholder';
      img.onload = () => {
        holder.textContent = '';
        holder.appendChild(img);
        addNote(`这个目录里没有图片，占位图按目录名「${artLabelFor(it)}」生成。`);
        addNote('想让整个包共用一张图：把 cover / folder / artwork 命名的图片放进包根或 Artwork 子目录；单条素材可用与音频同名的图片。');
      };
      img.src = placeholderArt(it);
      img.alt = it.name;
      return;
    }
    const img = new Image();
    img.onload = () => {
      holder.textContent = '';
      holder.appendChild(img);
      const rel = res.rel || (res.from ? baseName(res.from) : '');
      if (res.source === 'folder') {
        addNote(`来自同目录图片：${rel}`);
      } else if (res.source === 'artwork') {
        addNote(`来自封面目录：${rel}`);
      } else if (res.source === 'ancestor') {
        addNote(`来自上级目录：${rel}`);
      } else if (res.source === 'embedded') {
        addNote(`内嵌图片 · ${res.mime || 'image'} · ${fmtSize(res.bytes || 0)}`);
      }
    };
    img.onerror = () => { holder.textContent = '图片无法解码'; };
    img.src = res.url;
    img.alt = it.name;
  } catch {
    holder.textContent = '封面数据无法读取';
  }
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------
function setupKeyboard() {
  window.addEventListener('keydown', (e) => {
    const tag = document.activeElement && document.activeElement.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA';

    // 面板开关和旁通是全局的：光标停在搜索框/检索框里也要能用
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'k' && !e.shiftKey) { e.preventDefault(); toggleAiPanel(); return; }
      if (k === 'e' && e.shiftKey) { e.preventDefault(); toggleFxPanel(); return; }
      if (k === 'b' && e.shiftKey) { e.preventDefault(); fxBypass(); return; }
      }

    if (typing) {
      if (e.key === 'Escape') {
        // 焦点在抽屉里的输入框时，Escape 先关抽屉，再谈清空搜索
        const el = document.activeElement;
        if (el && el.closest && el.closest('#aiPanel') && state.ai.open) { closeAiPanel(); return; }
        if (el && el.closest && el.closest('#fxPanel') && fxOpen) { closeFxPanel(); return; }
            if (el && el.closest && el.closest('#aiSynthSection') && synth.open) { closeSynthPanel(); return; }
        document.activeElement.blur();
        if (dom.search.value) { dom.search.value = ''; applySearch(''); }
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && state.lastRemoved) {
      e.preventDefault();
      toast('移除操作不可撤销，请重新拖入文件');
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      toggleInfoPanel();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      toggleSimilarPanel();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      exportTrimSelection();
      return;
    }

    switch (e.key) {
      case ' ':
      case 'k':
      case 'K':
        e.preventDefault();
        togglePlay();
        break;
      case 'Escape':
        e.preventDefault();
        if (ctxEl) { closeContextMenu(); break; }
        if (state.ai.open) { closeAiPanel(); break; }
        if (fxOpen) { closeFxPanel(); break; }
        if (synth.open) { closeSynthPanel(); break; }
        if (state.settingsOpen) { closeSettings(); break; }
        if (state.infoOpen) { closeInfoPanel(); break; }
        if (similarTargetPath) { closeSimilarPanel(); break; }
        if (state.sideSelection.ids.size) { resetSideSelection(); break; }
        if (wave.selection) { clearTrimSelection(); break; }
        stopPlayback();
        break;
      case 't':
      case 'T':
        e.preventDefault();
        wave.zoomBy(2, wave.hovering ? wave.xToTime(wave.hoverX) : wave.time);
        break;
      case 'r':
      case 'R':
        e.preventDefault();
        wave.zoomBy(0.5, wave.hovering ? wave.xToTime(wave.hoverX) : wave.time);
        break;
      case 'i':
      case 'I':
        e.preventDefault();
        setTrimPoint('in');
        break;
      case 'o':
      case 'O':
        e.preventDefault();
        setTrimPoint('out');
        break;
      case 'ArrowUp':
        e.preventDefault();
        stepSelection(-1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        stepSelection(1);
        break;
      case 'Enter':
        e.preventDefault();
        if (state.focusPath) {
          const it = state.byPath.get(state.focusPath);
          if (it) playItem(it);
        }
        break;
      case 'l':
      case 'L':
        toggleLoop();
        break;
      case 'm':
      case 'M':
        toggleMute();
        break;
      case 's':
      case 'S':
        toggleMono();
        break;
      case 'Delete':
        e.preventDefault();
        removeSelection();
        break;
      case '/':
        e.preventDefault();
        dom.search.focus();
        dom.search.select();
        break;
      case 'f':
      case 'F':
        if (state.focusPath) {
          const it = state.byPath.get(state.focusPath);
          if (it) openInFinder(it);
        }
        break;
      default:
        break;
    }
  });
}

function toggleLoop() {
  state.loop = !state.loop;
  player.setLoop(state.loop);
  updateTransport();
  scheduleSave();
}

function toggleMute() {
  state.muted = !state.muted;
  applyGain();
}

function toggleMono() {
  state.mono = !state.mono;
  player.setMono(state.mono);
  updateTransport();
  scheduleRender();
  scheduleSave();
}

function syncWaveGainChip() {
  if (!dom.chipWaveGain) return;
  const g = wave.autoGain || 1;
  dom.chipWaveGain.classList.toggle('on', state.waveAutoGain);
  dom.chipWaveGain.textContent = state.waveAutoGain
    ? `波形 适应${g > 1.2 ? ` ×${g}` : ''}`
    : '波形 实际';
}

function toggleWaveGain() {
  state.waveAutoGain = !state.waveAutoGain;
  wave.dirty = true;
  wave.drawBody();
  syncWaveGainChip();
  scheduleSave();
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
function applySearch(value) {
  state.search = value;
  dom.searchClear.classList.toggle('hidden', !value);
  computeView();
  dom.listBody.scrollTop = 0;
  scheduleRender();
  renderSidebar();
}

// ---------------------------------------------------------------------------
// Waveform interaction
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 波形缩放 / 修剪选区
// ---------------------------------------------------------------------------
function syncZoomChip() {
  if (!dom.chipZoom) return;
  const z = wave.zoom;
  let label;
  if (z >= 1.995) label = String(Math.round(z));
  else if (z > 1.001) label = String(Math.round(z * 10) / 10);
  else label = '1';
  const parts = [`×${label}`];
  if (z > 1.001) parts.push(`${fmtTC(wave.viewStart)}–${fmtTC(wave.viewEnd)}`);
  dom.chipZoom.textContent = parts.join('  ');
  dom.chipZoom.classList.toggle('on', z > 1.001);
}

/** 把修剪选区写回当前条目（内存 + 持久化） */
function commitTrimSelection() {
  const it = state.byPath.get(state.currentPath);
  if (!it) return;
  const sel = wave.selection;
  if (sel && Math.abs(sel.end - sel.start) > 0.0005) {
    it.trim = { start: Math.min(sel.start, sel.end), end: Math.max(sel.start, sel.end) };
  } else {
    delete it.trim;
  }
  scheduleSave();
  // 正在听的这条改了修剪区间，立刻按新区间播（不用等下一次点击）
  applyClipToPlayer();
  // 顺手把"拖出用"的裁剪文件准备好：真正拖的时候就不用等生成，
  // 手感上跟直接拖原文件一样。
  if (it.trim) ensureDragFile(it).catch(() => {});
  scheduleRender();
}

/** 把当前条目的修剪区间同步给播放器。 */
function applyClipToPlayer() {
  const it = state.byPath.get(state.currentPath);
  if (!it) return;
  const clip = trimmableClip(it);
  player.setClip(clip ? clip.start : null, clip ? clip.end : null);
  if (clip && state.playing && playheadOutsideClip()) player.seek(clip.start);
}

function clearTrimSelection(silent) {
  if (!wave.selection) return;
  wave.selection = null;
  wave.markDirty();
  commitTrimSelection();
  if (!silent) updateWavePanel();
}

/** 播放头处打点：kind='in' 设置选区起点，'out' 设置终点 */
function setTrimPoint(kind) {
  const it = state.byPath.get(state.currentPath);
  if (!it || !wave.peaks) return;
  const t = wave.time;
  const cur = wave.selection;
  if (kind === 'in') {
    wave.selection = { start: t, end: cur ? Math.max(cur.end, t + 0.001) : wave.duration };
  } else {
    wave.selection = { start: cur ? Math.min(cur.start, t) : 0, end: t };
  }
  wave.markDirty();
  commitTrimSelection();
  updateWavePanel();
}

function setTrimAll() {
  const it = state.byPath.get(state.currentPath);
  if (!it || !wave.duration) return;
  wave.selection = { start: 0, end: wave.duration };
  wave.markDirty();
  commitTrimSelection();
  updateWavePanel();
}

/** "00m03.250s" —— 与主进程 defaultTrimPath 同格式，Windows 文件名安全。 */
function trimStamp(sec) {
  const t = Math.max(0, Number(sec) || 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}m${s.toFixed(3).padStart(6, '0')}s`;
}

function trimSpan() {
  const sel = wave.selection;
  return sel ? Math.abs(sel.end - sel.start) : 0;
}

function syncTrimChip() {
  if (!dom.chipTrim) return;
  const span = trimSpan();
  const on = span > 0.005;
  dom.chipTrim.classList.toggle('hidden', !on);
  if (!on) return;
  dom.chipTrim.textContent = `导出选区 ${span.toFixed(2)}s`;
  const sel = wave.selection;
  dom.chipTrim.title = `把 ${fmtTC(Math.min(sel.start, sel.end))} – ${fmtTC(Math.max(sel.start, sel.end))} ` +
    `导出成 WAV 并加入列表 (Ctrl+E)`;
}

/**
 * 便携修改：把当前选区复制成一个新的 WAV 文件（默认落在源文件旁边），
 * 并加进列表。原文件一个字节都不动，所以"去掉前一段、只把后半段拖进 DAW"
 * 这个流程永远可逆。
 */
async function exportTrimSelection() {
  const it = state.byPath.get(state.currentPath);
  if (!it) { toast('先选一条音频'); return; }
  const sel = wave.selection || it.trim;
  if (!sel || Math.abs(sel.end - sel.start) < 0.005) {
    toast('先在波形上 Shift+拖拽（或按 I / O 打点）选出要保留的一段');
    return;
  }
  const start = Math.max(0, Math.min(sel.start, sel.end));
  const end = Math.max(sel.start, sel.end);
  // AIFF 走的是缓存里的 wav，但输出位置必须按用户原始文件算。
  const src = it.playPath || it.path;
  const base = baseName(it.path).replace(/\.[^.]+$/, '');
  const outPath = `${dirName(it.path)}\\${base}_trim_${trimStamp(start)}-${trimStamp(end)}.wav`;

  dom.chipTrim.disabled = true;
  let res;
  try {
    res = await sb.invoke('audio:trim', { path: src, start, end, outPath });
  } finally {
    dom.chipTrim.disabled = false;
  }
  if (!res || !res.ok) {
    const why = !res ? '无响应'
      : res.reason === 'not-pcm' ? '该格式不支持裁剪导出（支持 WAV / BWF / RF64 / W64 / AIFF）'
      : res.reason === 'bad-range' ? '选区无效'
      : res.reason === 'same-file' ? '输出路径和源文件相同'
      : `${res.reason}`;
    toast(`导出失败：${why}`);
    return;
  }

  ensureProcessedCategory();
  addFiles([{ path: res.path, name: res.name, size: res.bytes + 44, mtimeMs: Date.now() }],
           { analyzeFirst: true, silent: true, categoryId: PROCESSED_ID });
  const created = state.byPath.get(res.path);
  if (created) {
    selectItem(created, { play: false });
    const idx = state.view.indexOf(created);
    if (idx >= 0) scrollToRow(idx);
  }
  toast(`已导出 ${fmtTC(start)}–${fmtTC(end)} → ${res.name}（已加入列表）`, {
    ms: 9000,
    action: {
      label: '撤销',
      run: () => {
        if (!created) return;
        const cur = state.byPath.get(res.path);
        if (!cur) return;
        state.selection = new Set([cur.path]);
        removeSelection();
        toast('已从列表移除（导出的 WAV 文件保留在磁盘上）');
      }
    }
  });
}

function setupWaveInteraction() {
  let mode = null; // 'scrub' | 'pan' | 'select'
  let selAnchor = 0;
  let panLastX = 0;

  const posOf = (e) => {
    const rect = dom.waveWrap.getBoundingClientRect();
    return { x: Math.max(0, Math.min(rect.width, e.clientX - rect.left)), rect };
  };

  const seekFromEvent = (e, silent) => {
    const { x } = posOf(e);
    const t = wave.xToTime(x);
    player.seek(t);
    wave.setTime(t);
    dom.tcCurrent.textContent = fmtTC(t);
    dom.waveTime.textContent = fmtTC(t);
    if (!silent) return t;
  };

  dom.waveWrap.addEventListener('mousedown', (e) => {
    if (!wave.peaks) return;
    const { x } = posOf(e);

    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      mode = 'pan';
      panLastX = e.clientX;
      wave.follow = false;
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;

    if (e.shiftKey) {
      mode = 'select';
      selAnchor = wave.xToTime(x);
      wave.selDragging = { start: selAnchor, end: selAnchor };
      wave.markDirty();
      e.preventDefault();
      return;
    }

    mode = 'scrub';
    seekFromEvent(e);
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    const { x, rect } = posOf(e);
    const inside = e.clientX >= rect.left && e.clientX <= rect.right &&
                   e.clientY >= rect.top && e.clientY <= rect.bottom;

    if (mode === 'scrub') {
      seekFromEvent(e);
      return;
    }
    if (mode === 'pan') {
      const dx = e.clientX - panLastX;
      panLastX = e.clientX;
      if (dx) wave.panBy(-(dx / Math.max(1, rect.width)) * wave.viewSpan);
      return;
    }
    if (mode === 'select') {
      const t = wave.xToTime(x);
      wave.selDragging = { start: selAnchor, end: t };
      wave.markDirty();
      return;
    }

    wave.hovering = inside;
    if (inside) {
      wave.hoverX = x;
      wave.drawHead();
    } else if (wave.hovering) {
      wave.hovering = false;
      wave.drawHead();
    }
  });

  window.addEventListener('mouseup', () => {
    if (mode === 'select' && wave.selDragging) {
      const a = Math.min(wave.selDragging.start, wave.selDragging.end);
      const b = Math.max(wave.selDragging.start, wave.selDragging.end);
      wave.selDragging = null;
      if (b - a > 0.002) {
        wave.selection = { start: a, end: b };
        commitTrimSelection();
        updateWavePanel();
      }
      wave.markDirty();
    }
    mode = null;
  });

  dom.waveWrap.addEventListener('wheel', (e) => {
    if (!wave.peaks) return;
    e.preventDefault();
    const { x, rect } = posOf(e);
    if (e.shiftKey) {
      // Shift+滚轮：横向平移
      const delta = (e.deltaY || e.deltaX) / Math.max(1, rect.width);
      wave.follow = false;
      wave.panBy(delta * wave.viewSpan);
    } else {
      const factor = Math.pow(1.002, -e.deltaY);
      wave.zoomBy(factor, wave.xToTime(x));
    }
  }, { passive: false });

  dom.waveWrap.addEventListener('dblclick', (e) => {
    if (!wave.peaks) return;
    if (wave.zoom > 1.001) {
      wave.resetZoom();
    } else if (wave.selection) {
      clearTrimSelection();
    }
  });

  dom.waveWrap.addEventListener('mouseleave', () => {
    wave.hovering = false;
    wave.drawHead();
  });

  dom.waveWrap.addEventListener('contextmenu', (e) => {
    if (!wave.peaks) return;
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, null, [
      {
        label: wave.selection ? '清除修剪选区' : '选区：在波形上 Shift+拖拽',
        muted: !wave.selection,
        run: () => { if (wave.selection) clearTrimSelection(); }
      },
      { label: '选取整段 (I 起点 / O 终点)', run: () => setTrimAll() },
      {
        label: '导出选区为 WAV (Ctrl+E)',
        muted: !wave.selection,
        run: () => { if (wave.selection) exportTrimSelection(); }
      },
      { sep: true },
      { label: '缩放还原 (双击)', run: () => wave.resetZoom() },
      { label: '缩放 ×2 (T)', run: () => wave.zoomBy(2, wave.time) },
      { label: '缩放 ÷2 (R)', run: () => wave.zoomBy(0.5, wave.time) }
    ]);
  });
}

// ---------------------------------------------------------------------------
// Window resize of the wave panel
// ---------------------------------------------------------------------------
function setupWaveResize() {
  let dragging = false;
  let startY = 0;
  let startH = 0;

  dom.waveResize.addEventListener('mousedown', (e) => {
    dragging = true;
    startY = e.clientY;
    startH = dom.wavePanel.getBoundingClientRect().height;
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const h = Math.max(108, Math.min(window.innerHeight - 260, startH - (e.clientY - startY)));
    dom.wavePanel.style.height = h + 'px';
    state.waveHeight = h;
    wave.resize();
    syncAiPanelBounds();
  });

  window.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      scheduleSave();
    }
  });
}

// ---------------------------------------------------------------------------
// Drop target for import
// ---------------------------------------------------------------------------
function setupDropImport() {
  let depth = 0;
  let hoveredRow = null;
  let hoveredZone = null;

  const isFileDrag = (e) => {
    if (dragOutInFlight()) return false; // our own drag-out, never an import
    const dt = e.dataTransfer;
    if (!dt) return false;
    const types = dt.types ? [...dt.types] : [];
    return types.includes('Files');
  };

  /**
   * Where a drop would land:
   *   { kind: 'collection', id }   a library row
   *   { kind: 'category', id }     a category row
   *   { kind: 'new-collection' }   the libraries section, away from any row
   *   { kind: 'new-category' }     the categories section, away from any row
   * Dropping a folder on a section builds a new library/category named after it.
   */
  const dropHitAt = (e) => {
    if (!e.target || !e.target.closest) return null;
    const col = e.target.closest('.side-item.collection');
    if (col && col.dataset.value) return { kind: 'collection', id: col.dataset.value, row: col };
    const cat = e.target.closest('.side-item.category');
    if (cat && cat.dataset.value && cat.dataset.value !== UNCAT_SENTINEL) {
      return { kind: 'category', id: cat.dataset.value, row: cat };
    }
    const zone = e.target.closest('[data-dropzone]');
    if (zone) {
      const k = zone.dataset.dropzone === 'category' ? 'new-category' : 'new-collection';
      return { kind: k, id: null, row: null, zone };
    }
    return null;
  };

  const paintHover = (hit) => {
    const row = hit && hit.row ? hit.row : null;
    const zone = hit && !hit.row ? hit.zone : null;
    if (hoveredRow === row && hoveredZone === zone) return;
    if (hoveredRow) hoveredRow.classList.remove('drop-target');
    if (hoveredZone) hoveredZone.classList.remove('drop-zone');
    hoveredRow = row;
    hoveredZone = zone;
    if (hoveredRow) hoveredRow.classList.add('drop-target');
    if (hoveredZone) hoveredZone.classList.add('drop-zone');
    // The full-screen hint would hide the row the user is aiming at.
    dom.dropOverlay.classList.toggle('active', !hit);
  };

  /** Tell the user what releasing here will do, before they release. */
  const paintHint = (hit) => {
    if (!dom.dropHint) return;
    if (hit && hit.kind === 'collection') {
      dom.dropHint.textContent = `松手导入并加入「${collectionName(hit.id)}」`;
    } else if (hit && hit.kind === 'category') {
      dom.dropHint.textContent = `松手导入并归入「${categoryName(hit.id)}」`;
    } else if (hit && hit.kind === 'new-collection') {
      dom.dropHint.textContent = '拖入文件夹，每个文件夹各建一个资料库；单独的文件只导入';
    } else if (hit && hit.kind === 'new-category') {
      dom.dropHint.textContent = '拖入文件夹，按文件夹结构建分类（主文件夹 + 里面的子文件夹）；单独的文件只导入';
    } else if (state.filter.type === 'collection') {
      dom.dropHint.textContent = `松手导入并加入「${collectionName(state.filter.value)}」`;
    } else if (state.filter.type === 'category' && state.filter.value !== UNCAT_SENTINEL) {
      dom.dropHint.textContent = `松手导入并归入「${categoryName(state.filter.value)}」`;
    } else {
      dom.dropHint.textContent = '想让它们进某个资料库？把文件夹拖到左侧那个库上';
    }
  };

  window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    depth++;
    const hit = dropHitAt(e);
    paintHint(hit);
    if (!hit) dom.dropOverlay.classList.add('active');
  });

  window.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const hit = dropHitAt(e);
    paintHover(hit);
    paintHint(hit);
  });

  window.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) { paintHover(null); dom.dropOverlay.classList.remove('active'); }
  });

  window.addEventListener('drop', async (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    depth = 0;
    const hit = dropHitAt(e);
    paintHover(null);
    dom.dropOverlay.classList.remove('active');

    const files = e.dataTransfer.files;
    if (!files || !files.length) return;
    const paths = [];
    for (const f of files) {
      const p = sb.getPathForFile(f);
      if (p) paths.push(p);
    }
    if (!paths.length) { toast('无法读取拖入的文件路径'); return; }
    await dropPaths(paths, hit);
  });
}

/**
 * Import whatever was dropped, honouring the drop target:
 * - a library/category row files the clips into it;
 * - a section header/blank area builds a new one named after the dropped
 *   folder (only for a single folder — a pile of loose files has no name);
 * - anywhere else falls back to the library/category currently being viewed.
 */
async function dropPaths(paths, hit) {
  let collectionId = null;
  let categoryId = null;
  let buildFor = null;

  if (hit && (hit.kind === 'new-collection' || hit.kind === 'new-category')) {
    const info = await sb.invoke('drag:inspect', paths);
    const dirs = info.filter((x) => x.isDir && x.name);
    const loose = info.filter((x) => !x.isDir && x.path);
    if (dirs.length) buildFor = { kind: hit.kind, dirs, loose };
  } else if (hit && hit.kind === 'collection') {
    collectionId = hit.id;
  } else if (hit && hit.kind === 'category') {
    categoryId = hit.id;
  } else if (state.filter.type === 'collection') {
    collectionId = state.filter.value;
  } else if (state.filter.type === 'category' && state.filter.value !== UNCAT_SENTINEL) {
    categoryId = state.filter.value;
  }

  if (buildFor) {
    await buildFromFolders(buildFor);
    return;
  }

  const files = await sb.invoke('library:scan', paths);
  if (!files || !files.length) {
    toast('没有找到音频文件');
    return;
  }

  const res = addFiles(files, { analyzeFirst: true, collectionId, categoryId });
  return res;
}

// Dropping folders on a sidebar section builds one library/category per folder,
// so a whole pack can be filed in a single gesture. Folders whose name already
// exists are merged into that one instead of piling up duplicates.
//
// 拖到「分类」上时还会照着目录结构建子树：主文件夹 → 子文件夹 → 子子文件夹，
// 音频跟着自己所在的目录走；只有真的含音频的分支才会建分类。
async function importCategoryTree(dir) {
  const nodes = await sb.invoke('library:scan-tree', [dir.path]);
  const root = nodes && nodes[0];
  if (!root) return { made: [], added: 0, skipped: 0, images: 0, empty: true };
  if (!root.files.length && !root.children.length) {
    return { made: [], added: 0, skipped: 0, images: root.images, empty: true };
  }

  const made = [];
  let added = 0;
  let skipped = 0;
  let images = 0;

  const walk = (node, parentId, displayName) => {
    const pid = parentId || null;
    let cat = state.categories.find((c) => c.name === displayName && catParentId(c) === pid);
    if (!cat) {
      cat = { id: newCategoryId(), name: displayName, parentId: pid, auto: null };
      state.categories.push(cat);
      made.push(displayName);
    }
    if (pid) setCatCollapsed(pid, false);
    if (node.files.length) {
      const res = addFiles(node.files, {
        analyzeFirst: true,
        categoryId: cat.id,
        silent: true,
        deferRender: true
      });
      added += res.added;
      skipped += res.skipped;
    }
    images += node.images;
    for (const kid of node.children) walk(kid, cat.id, kid.name);
  };

  walk(root, null, dir.name);
  return { made, added, skipped, images, empty: false };
}

async function buildFromFolders({ kind, dirs, loose }) {
  const isCollection = kind === 'new-collection';
  const what = isCollection ? '资料库' : '分类';
  const pool = isCollection ? state.collections : state.categories;
  const made = [];
  let added = 0;
  let skipped = 0;
  let empty = 0;
  let images = 0;

  for (const dir of dirs) {
    if (!isCollection) {
      const tree = await importCategoryTree(dir);
      if (tree.empty) { empty++; continue; }
      made.push(...tree.made);
      added += tree.added;
      skipped += tree.skipped;
      images += tree.images;
      continue;
    }

    const files = await sb.invoke('library:scan', [dir.path]);
    if (!files || !files.length) { empty++; continue; }

    let target = pool.find((c) => c.name === dir.name);
    let created = false;
    if (!target) {
      target = isCollection ? createCollection(dir.name) : createCategory(dir.name);
      if (!target) continue;
      created = true;
    }
    const res = addFiles(files, {
      analyzeFirst: true,
      collectionId: isCollection ? target.id : null,
      categoryId: isCollection ? null : target.id,
      silent: true,
      deferRender: true
    });
    added += res.added;
    skipped += res.skipped;
    if (created) made.push(target.name);
  }

  // Files that came along with the folders still get imported normally.
  if (loose.length) {
    const files = await sb.invoke('library:scan', loose.map((x) => x.path));
    if (files && files.length) {
      const res = addFiles(files, { analyzeFirst: true, silent: true, deferRender: true });
      added += res.added;
      skipped += res.skipped;
    }
  }

  computeView();
  renderSidebar();
  scheduleRender();
  scheduleSave();

  if (!made.length && !added) {
    toast(empty ? '这些文件夹里没有音频文件' : '这些音频已经在列表里了');
    return;
  }
  const parts = [];
  if (made.length === 1) parts.push(`新建${what}「${made[0]}」`);
  else if (made.length > 1) {
    const head = made.length > 3 ? `${made.slice(0, 3).join('、')} 等 ${made.length} 个` : made.join('、');
    parts.push(`新建 ${made.length} 个${what}：${head}`);
  } else parts.push(`加入已有的${what}`);
  if (added) parts.push(`共 ${added} 个音频`);
  if (skipped) parts.push(`跳过 ${skipped} 个重复`);
  if (images) parts.push(`其中 ${images} 张图片会当封面用`);
  toast(parts.join('，'));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function verifyMissing() {
  if (!state.items.length) return;
  const paths = state.items.map((i) => i.path);
  const res = await sb.invoke('file:exists', paths);
  let changed = false;
  for (const it of state.items) {
    const r = res[it.path];
    const missing = !r || !r.ok;
    if (missing !== it.missing) { it.missing = missing; changed = true; }
    if (!missing && r) {
      if (r.size !== it.size || Math.round(r.mtimeMs) !== Math.round(it.mtimeMs)) {
        it.size = r.size;
        it.mtimeMs = r.mtimeMs;
        changed = true;
      }
    }
  }
  if (changed) scheduleSave();
}

// 后台分块核对（启动时用）。浏览器一帧都不要等它。
let missingSweepToken = 0;
async function verifyMissingInBackground({ chunk = 1200 } = {}) {
  if (!state.items.length) return { checked: 0, changed: false };
  const token = ++missingSweepToken;
  const paths = state.items.map((i) => i.path);
  let changed = false;
  for (let i = 0; i < paths.length; i += chunk) {
    if (token !== missingSweepToken) return { cancelled: true, checked: i };
    const slice = paths.slice(i, i + chunk);
    let res = null;
    try { res = await sb.invoke('file:exists', slice); } catch { return { failed: true, checked: i }; }
    if (!res) return { failed: true, checked: i };
    for (const p of slice) {
      const it = state.byPath.get(p);
      if (!it) continue;
      const r = res[p];
      const missing = !r || !r.ok;
      if (missing !== it.missing) { it.missing = missing; changed = true; }
      if (!missing && r && (r.size !== it.size || Math.round(r.mtimeMs) !== Math.round(it.mtimeMs))) {
        it.size = r.size;
        it.mtimeMs = r.mtimeMs;
        changed = true;
      }
    }
    // 让出主线程：用户可以马上滚动、点分类
    await new Promise((r) => setTimeout(r, 0));
  }
  if (token !== missingSweepToken) return { cancelled: true, checked: paths.length };
  if (changed) {
    scheduleSave();
    computeView();
    renderSidebar();
    scheduleRender();
    scheduleStats();
  }
  markStartup('verify-done');
  return { checked: paths.length, changed };
}

// ===========================================================================
// 贴边隐藏（QQ 那种「贴屏幕边自动缩起来、鼠标一碰又滑出来」）
//
// 窗口几何全在主进程算——只有它知道显示器工作区和真实鼠标坐标。
// 渲染进程这边只做三件事：记住用户偏好、把模式画成紧凑布局、在收起时露出那条把手。
// ===========================================================================
/** 贴边模式下顶部的「音频 / 设置」标签跟着状态走。 */
function syncDockTabs() {
  const a = $('dockTabAudio');
  const s = $('dockTabSettings');
  if (a) a.classList.toggle('active', !state.settingsOpen);
  if (s) s.classList.toggle('active', !!state.settingsOpen);
  const hint = $('dockTabsHint');
  if (hint) {
    // 右上角还有系统画的窗口按钮，这里只放最短的一行字，避免挤在一起
    hint.textContent = state.dock.enabled ? `${Math.round(state.dock.width)} px` : '';
  }
}

/** 面板叠在一起时，切页前把其它抽屉先关掉。 */
function closeOverlays() {
  try { closeAiPanel(); } catch { /* ignore */ }
  try { closeFxPanel(); } catch { /* ignore */ }
  try { closeInfoPanel(); } catch { /* ignore */ }
  try { closeSimilarPanel(); } catch { /* ignore */ }
  try { if (synth.open) closeSynthPanel(); } catch { /* ignore */ }
}

function syncDockUI() {
  const d = state.dock;
  const en = $('dockEnabled');
  if (en) en.checked = !!d.enabled;
  for (const b of document.querySelectorAll('#dockEdge .seg-btn')) {
    b.classList.toggle('active', b.dataset.edge === d.edge);
  }
  const w = $('dockWidth');
  if (w) {
    w.value = String(d.width);
    w.disabled = !d.enabled;
  }
  const wv = $('dockWidthVal');
  if (wv) wv.textContent = Math.round(d.width) + 'px';
  const hint = $('dockHint');
  if (hint) {
    hint.textContent = !d.enabled
      ? '未开启'
      : d.hidden
        ? '已收起'
        : '已展开';
  }
  const sh = $('dockScreenHint');
  if (sh) {
    sh.innerHTML = state.dock.shortcut === false
      ? '<strong>Ctrl+Alt+S 被别的程序占用了</strong>，这个组合键在 SoundBin 里不生效，只能用鼠标贴边。'
      : '';
  }
  syncDockTabs();
}

function applyDockMode(m) {
  const d = state.dock;
  const wasEnabled = !!d.enabled;
  if (m) {
    if (typeof m.enabled === 'boolean') d.enabled = m.enabled;
    if (m.edge) d.edge = m.edge === 'left' ? 'left' : 'right';
    if (typeof m.width === 'number' && m.width > 0) d.width = Math.round(m.width);
    if (typeof m.hidden === 'boolean') d.hidden = m.hidden;
  }
  d.docked = !!d.enabled && !d.hidden;
  document.body.classList.toggle('dock-docked', !!d.enabled);
  // 只有窗口真的收成一条（≤80px）才把界面藏起来。
  // 主进程的 hidden 是异步发过来的：拖宽到一半时可能先收到「已收起」，
  // 而窗口还停在半屏宽，这时照 hidden 去藏界面就会得到一整块黑屏。
  const reallyCollapsed = !!d.enabled && !!d.hidden && window.innerWidth <= 80;
  document.body.classList.toggle('dock-collapsed', reallyCollapsed);
  document.body.dataset.dockEdge = d.edge;
  if (d.enabled && state.infoOpen) closeInfoPanel(true);
  if (!!d.enabled !== wasEnabled) {
    // 需求 2：切换时窗口会重新建表面，未重绘的那一帧是空的（看着就像黑屏），
    // 先盖一层和面板同色的底，等尺寸定下来再淡出
    document.body.classList.add('dock-switching');
    clearTimeout(applyDockMode.switchTimer);
    applyDockMode.switchTimer = setTimeout(() => {
      document.body.classList.remove('dock-switching');
    }, 260);
    // 进/出贴边面板时列数不一样（ 4 列 / 11 列），留着旧宽度只会把名字挤没
    state.colWidths = null;
    applyColWidths();
  }
  const strip = $('edgeStrip');
  if (strip) strip.dataset.edge = d.edge;
  syncDockUI();
  syncAiPanelBounds();
  // 被拖走了（或被外部关掉）：把偏好也存下来，下次启动别再贴回去
  if (wasEnabled && !d.enabled) scheduleSave();
}

// 兜底自愈：窗口宽度和「收起」状态一旦对不上，立刻按实际宽度纠正。
// （主进程的 hidden 是异步消息，动画被打断时可能和真实尺寸短暂错位）
window.addEventListener('resize', () => {
  if (!state.dock.enabled) return;
  const cls = document.body.classList;
  const narrow = window.innerWidth <= 80;
  if (narrow && state.dock.hidden && !cls.contains('dock-collapsed')) cls.add('dock-collapsed');
  if (!narrow && cls.contains('dock-collapsed')) cls.remove('dock-collapsed');
});

async function dockSet(patch = {}) {
  const d = state.dock;
  if (patch.enabled != null) d.enabled = !!patch.enabled;
  if (patch.edge) d.edge = patch.edge === 'left' ? 'left' : 'right';
  if (patch.width != null) d.width = Math.max(320, Math.round(patch.width));
  syncDockUI();

  let res = null;
  try {
    res = await sb.invoke('dock:set', { enabled: d.enabled, edge: d.edge, width: d.width });
  } catch (err) {
    toast('贴边隐藏设置失败：' + (err && err.message ? err.message : err));
    return null;
  }
  if (!res || !res.ok) {
    toast('贴边隐藏设置失败：' + (res && res.error ? res.error : '未知错误'));
    return res;
  }
  applyDockMode({ enabled: d.enabled, edge: d.edge, width: d.width, hidden: false });
  // 从设置里把开关打开后，直接回到音频页；想继续调就点顶上「设置」标签
  if (patch.enabled === true && state.settingsOpen) closeSettings();
  scheduleSave();
  return res;
}

/** 启动时把上次的偏好交给主进程；主进程不存偏好（它只执行），所以这里以清单为准。 */
async function dockRestore() {
  const want = !!state.dock.enabled;
  const wantEdge = state.dock.edge;
  const wantWidth = state.dock.width;
  let st = null;
  try { st = await sb.invoke('dock:state'); } catch { /* ignore */ }
  if (st && typeof st.shortcut === 'boolean') state.dock.shortcut = st.shortcut;
  if (want) {
    // 上次是贴着边的：让主进程按存下来的边和宽度重新贴回去
    await dockSet({ enabled: true, edge: wantEdge, width: wantWidth });
  } else if (st && st.enabled) {
    // 上次已经关掉了，但主进程还贴着边：恢复普通窗口
    await dockSet({ enabled: false });
  } else {
    applyDockMode({ enabled: false, hidden: false });
  }
}

// ===========================================================================
// Agent 语义检索
//
// 两级：先用本地的概念表把整库过一遍（快、离线、可解释），
// 配了接口的话再把前 24 条候选交给模型复核，模型只能从候选里挑。
// ===========================================================================
const AI_LIMIT = 80;

function aiStatus(text, kind = '') {
  const el = $('aiStatus');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'ai-status' + (kind ? ' ' + kind : '');
}

function aiRankMap() {
  if (!state.ai.only || !state.ai.results.length) return null;
  const m = new Map();
  state.ai.results.forEach((r, idx) => m.set(r.item.path, { rank: idx, pct: r.pct }));
  return m;
}

/**
 * 贴边（侧栏）模式下，Agent 检索面板只占列表那一块：
 * 下面的波形条、效果器小块要能继续看见、继续操作（试听 / 修剪 / 拖出）。
 * 宽屏模式下不动它，抽屉照旧从右边盖上来。
 */
function syncAiPanelBounds() {
  const root = document.documentElement;
  if (!root) return;
  const docked = document.body.classList.contains('dock-docked');
  const wave = $('wavePanel');
  let bottom = 0;
  if (docked && state.ai.open && wave) {
    const r = wave.getBoundingClientRect();
    bottom = Math.max(0, Math.round(window.innerHeight - r.top));
  }
  root.style.setProperty('--ai-bottom', bottom + 'px');
}

function openAiPanel() {
  // 两个抽屉别叠在一起：开一个就收起另一个
  if (fxOpen) closeFxPanel();
  if (synth.open) closeSynthPanel();
  if (state.ai.open) closeAiPanel();
  if (fxOpen) closeFxPanel();
  if (similarTargetPath) closeSimilarPanel();
  if (state.settingsOpen) closeSettings();
  state.ai.open = true;
  $('aiScrim').classList.remove('hidden');
  $('aiPanel').classList.remove('hidden');
  setAiTab(state.ai.tab || 'search');
  renderAiPresets();
  renderAiChips();
  renderAiResults();
  renderAiModelBar();
  syncAiPanelBounds();
  const deepBox = $('aiDeep');
  if (deepBox) deepBox.checked = !!state.ai.deep;
  const keepBox = $('aiKeepLocal');
  if (keepBox) keepBox.checked = !!state.ai.keepLocal;
  const offBox = $('aiOffline');
  if (offBox) offBox.checked = !!state.ai.offline;
  // 每次打开都按 state 重画一遍：图片、画面描述、声音标签都跟着回来
  renderAiImage();
  const q = $('aiQuery');
  if (q && !q.value && state.ai.query) q.value = state.ai.query;
  if (q) q.focus();
}

function closeAiPanel() {
  state.ai.open = false;
  synth.open = false;
  try { synthStop(); } catch { /* 合成没开过就算了 */ }
  $('aiScrim').classList.add('hidden');
  $('aiPanel').classList.add('hidden');
  syncAiPanelBounds();
  const el = document.activeElement;
  if (el && el.closest && el.closest('#aiPanel')) el.blur();
}

function toggleAiPanel() {
  if (state.ai.open) closeAiPanel();
  else openAiPanel();
}

function renderAiPresets() {
  const box = $('aiPresets');
  if (!box || box.childElementCount) return;
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = p.label;
    b.title = p.text;
    b.addEventListener('click', () => {
      const q = $('aiQuery');
      if (q) q.value = p.text;
      state.ai.query = p.text;
      runAiSearch();
    });
    box.appendChild(b);
  }
}

function renderAiChips() {
  const box = $('aiTags');
  if (!box) return;
  box.textContent = '';
  const parsed = state.ai.parsed;
  if (!parsed) return;
  const add = (text, neg) => {
    const s = document.createElement('span');
    s.className = 'ai-tag' + (neg ? ' neg' : '');
    s.textContent = text;
    box.appendChild(s);
  };
  for (const p of parsed.positive) add(p.concept.label, false);
  for (const n of parsed.negative) add('避开 ' + n.concept.label, true);
  for (const lit of parsed.literals) add(lit, false);
}

// ---------------------------------------------------------------------------
// 参考图：把图缩到 1024 以内再发给模型（原图动辄几 MB，白烧 token）
// ---------------------------------------------------------------------------
const AI_IMAGE_MAX = 1024;

function renderAiImage() {
  const img = state.ai.image;
  const box = $('aiImageBox');
  const thumb = $('aiImageThumb');
  const nameEl = $('aiImageName');
  const btn = $('aiImageBtn');
  if (box) box.classList.toggle('hidden', !img);
  if (thumb) {
    if (img) thumb.src = img.dataUrl;
    else thumb.removeAttribute('src');
  }
  if (nameEl) nameEl.textContent = img ? `${img.name} · ${img.w}×${img.h}` : '';
  if (btn) btn.textContent = img ? '换一张图' : '＋ 导入图片';
  const retry = $('aiImageRetry');
  if (retry) retry.classList.toggle('hidden', !img);
  const info = $('aiImageInfo');
  if (info) {
    const err = state.ai.imageError;
    const scene = state.ai.imageScene;
    info.classList.toggle('err', !!err);
    info.textContent = err ? '这次看图没成功：' + err + '（已退回文字检索）' : scene ? '画面：' + scene : '';
    info.classList.toggle('hidden', !err && !scene);
  }
  renderAiSounds();
}

function renderAiSounds() {
  const box = $('aiSounds');
  if (!box) return;
  box.textContent = '';
  const list = state.ai.sounds || [];
  box.classList.toggle('hidden', !list.length);
  for (const s of list) {
    const span = document.createElement('span');
    span.className = 'ai-sound';
    span.textContent = s;
    box.appendChild(span);
  }
}

function clearAiImage() {
  state.ai.image = null;
  state.ai.imageScene = '';
  state.ai.imageError = '';
  state.ai.sounds = [];
  state.ai.look = null;
  state.ai.forceLook = false;
  renderAiImage();
}

async function shrinkImageFile(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, AI_IMAGE_MAX / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  return { dataUrl: cv.toDataURL('image/jpeg', 0.82), w, h };
}

async function loadAiImage(file) {
  try {
    const shot = await shrinkImageFile(file);
    state.ai.image = { dataUrl: shot.dataUrl, name: file.name, w: shot.w, h: shot.h };
    state.ai.imageScene = '';
    state.ai.imageError = '';
    state.ai.sounds = [];
    state.ai.look = null;
    state.ai.forceLook = false;
    renderAiImage();
    aiStatus('图片已就绪：点「检索」让 Agent 看画面（需求那一栏可以留空）', 'ok');
  } catch (err) {
    toast('这张图读不进来：' + (err && err.message ? err.message : err));
  }
}

function pickAiImage() {
  if (!state.ai.agentOk) {
    aiStatus('图片分析要用到视觉模型：先在设置里填好接口、模型和密钥。', 'err');
    return;
  }
  const input = $('aiImageInput');
  if (input) input.click();
}

/** 让模型看图，产出 {scene, sounds, terms, avoid, note}。 */
async function aiAnalyzeImage(query) {
  const img = state.ai.image;
  if (!img) return { ok: false, error: '还没有图片', scene: '', sounds: [], terms: [], avoid: [], note: '' };
  const ask = async (budget) =>
    sb.invoke('agent:chat', {
      messages: buildImageMessages(query, img.dataUrl),
      temperature: 0.2,
      maxTokens: budget,
      timeoutMs: 120000
    });

  let r = await ask(2600);
  // 带推理的模型偶尔会把预算花在 reasoning 上、content 变空，或者偶发 5xx；
  // 鉴权类错误重试没有意义，别浪费时间
  const authFail = r && !r.ok && (r.status === 401 || r.status === 403);
  if (r && !r.ok && !authFail) {
    aiStatus('看图没成功，再试一次…', 'busy');
    r = await ask(4600);
  }
  if (!r || !r.ok) {
    return { ok: false, error: (r && r.error) || '接口没有返回内容', scene: '', sounds: [], terms: [], avoid: [], note: '' };
  }
  const parsed = parseImageReply(r.text);
  if (parsed.error) return { ok: false, error: parsed.error, scene: '', sounds: [], terms: [], avoid: [], note: '' };
  return { ok: true, ...parsed, ms: r.ms };
}

function renderAiResults() {
  const box = $('aiResults');
  if (!box) return;
  // 历史 / 已保存列表正开着时别被「重新渲染结果」顶掉（切回来时 renderAiList 会自己调这里）
  if (state.ai.histView !== 'none') return;
  box.textContent = '';
  const list = state.ai.results;

  const count = $('aiCount');
  if (count) count.textContent = list.length ? String(list.length) : '';

  // 「补齐缺失的」按钮：只在结果里有「库里缺失」的条目时出现
  const missBtn = $('aiGenMissing');
  if (missBtn) {
    const miss = list.filter((r) => r.item && r.item.missing).length;
    missBtn.classList.toggle('hidden', !miss);
    if (miss) missBtn.textContent = '补齐缺失的（' + Math.min(4, miss) + '）';
  }

  if (!list.length) {
    const p = document.createElement('div');
    p.className = 'ai-empty';
    p.textContent = state.ai.parsed
      ? '没有匹配的素材。'
      : '写一句话，回车检索。';
    box.appendChild(p);
    return;
  }

  list.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'ai-row';
    row.dataset.path = r.item.path;
    row.draggable = true;
    if (r.item.path === state.currentPath) row.classList.add('active');
    row.title = r.item.path + '\n点一下试听 / 修剪，直接拖到 DAW 就是这条素材';

    const rank = document.createElement('div');
    rank.className = 'ai-rank';
    rank.textContent = String(i + 1);

    const main = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'ai-name';
    name.textContent = r.item.name;
    const why = document.createElement('div');
    why.className = 'ai-why';
    const bits = [];
    if (r.reason) bits.push(r.reason);
    else if (Array.isArray(r.reasons) && r.reasons.length) bits.push(r.reasons.join(' · '));
    if (r.local) bits.push('本地命中');
    const meta = r.item.meta || {};
    if (Number.isFinite(meta.duration) && meta.duration > 0) bits.push(fmtDur(meta.duration));
    if (meta.sampleRate) bits.push((meta.sampleRate / 1000).toFixed(1) + 'k');
    if (meta.channels) bits.push(meta.channels === 1 ? '单声道' : meta.channels + ' ch');
    why.textContent = bits.join(' · ');
    main.appendChild(name);
    if (bits.length) main.appendChild(why);

    const score = document.createElement('div');
    score.className = 'ai-score';
    score.textContent = r.pct + '%';

    row.appendChild(rank);
    row.appendChild(main);
    row.appendChild(score);
    row.addEventListener('click', () => {
      for (const el of box.querySelectorAll('.ai-row.active')) el.classList.remove('active');
      row.classList.add('active');
      selectItem(r.item, { play: true });
    });
    box.appendChild(row);
  });
}

function currentAiTarget() {
  const it = state.byPath.get(state.currentPath);
  return it ? it.name : '';
}

// ---------------------------------------------------------------------------
// 检索记录：两种东西，分开存
//   history —— 每次检索完自动记一条（不用点按钮），解决「刚才那句我要什么来着」
//   saved   —— 手动点「保存」才记，解决「这几句是我常用的」
// 都只存需求 + 路径 + 分数 + 理由，恢复时按 path 从 state.byPath 取。
// ---------------------------------------------------------------------------
const AI_HISTORY_MAX = 60;
const AI_SAVED_MAX = 40;

function fmtHistoryWhen(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function aiHistorySnapshot() {
  const input = $('aiQuery');
  const q = String((input && input.value) || state.ai.query || '').trim();
  return {
    id: 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    q,
    at: Date.now(),
    mode: state.ai.agentOk && !state.ai.offline ? 'agent' : 'local',
    count: state.ai.results.length,
    scene: state.ai.imageScene || '',
    // 存 120 条：列表最多也就看这么多，再多的恢复时也用不上
    results: state.ai.results.slice(0, 120).map((r) => ({
      path: r.item.path,
      pct: Number(r.pct) || 0,
      reason: r.reason || ''
    }))
  };
}

/** 同一句需求的旧记录先摘掉，再插到最前面（两种列表都这么去重）。 */
function pushAiEntry(list, snap, max) {
  const at = list.findIndex((h) => h.q === snap.q);
  if (at >= 0) list.splice(at, 1);
  list.unshift(snap);
  if (list.length > max) list.length = max;
  return snap;
}

/** 自动记录：每次检索结束时调用，不需要用户做任何事。 */
function recordAiHistory() {
  const snap = aiHistorySnapshot();
  if (!snap.q || !snap.results.length) return null;   // 没结果不记账，免得历史里全是空壳
  pushAiEntry(state.ai.history, snap, AI_HISTORY_MAX);
  if (state.ai.histView === 'history') renderAiList();
  scheduleSave();
  return snap;
}

/** 手动保存：只有点「保存」才会进这个列表。 */
function saveAiCurrent(silent) {
  if (!state.ai.results.length) {
    if (!silent) toast('这次还没有结果，先检索再保存');
    return null;
  }
  const snap = aiHistorySnapshot();
  if (!snap.q) snap.q = '（未命名的检索）';
  pushAiEntry(state.ai.saved, snap, AI_SAVED_MAX);
  if (state.ai.histView === 'saved') renderAiList();
  scheduleSave();
  if (!silent) toast(`已保存这次检索（共 ${state.ai.saved.length} 条）`);
  return snap;
}

function aiListOf(kind) {
  return kind === 'saved' ? state.ai.saved : state.ai.history;
}

function deleteAiEntry(kind, id) {
  const list = aiListOf(kind);
  const at = list.findIndex((h) => h.id === id);
  if (at < 0) return;
  list.splice(at, 1);
  renderAiList();
  scheduleSave();
}

function clearAiList(kind) {
  const list = aiListOf(kind);
  if (!list.length) return;
  list.length = 0;
  renderAiList();
  scheduleSave();
  toast(kind === 'saved' ? '已清空「已保存」' : '检索历史已清空');
}

function restoreAiEntry(h) {
  if (!h) return;
  const rows = [];
  let lost = 0;
  for (const r of h.results) {
    const it = state.byPath.get(r.path);
    if (!it) {
      lost++;
      continue;
    }
    rows.push({ item: it, score: (Number(r.pct) || 0) / 100, pct: Number(r.pct) || 0, reason: r.reason || '' });
  }
  const input = $('aiQuery');
  if (input) input.value = h.q;
  state.ai.query = h.q;
  state.ai.results = rows;
  state.ai.histView = 'none';
  renderAiChips();
  renderAiResults();
  const tail = lost ? `，${lost} 条已不在库里` : '';
  if (rows.length) {
    aiStatus(`回到 ${fmtHistoryWhen(h.at)} 的检索：${h.q} · ${rows.length} 条${tail}`, 'ok');
  } else {
    aiStatus(`这条记录里的素材现在都找不到了${tail}`, 'err');
  }
}

/** 画「历史 / 已保存」列表；两个列表长得一样，只是标题与提示不同。 */
function renderAiList() {
  const box = $('aiResults');
  if (!box) return;
  const kind = state.ai.histView;
  if (kind !== 'history' && kind !== 'saved') {
    renderAiResults();
    return;
  }
  box.textContent = '';
  const list = aiListOf(kind);
  const head = document.createElement('div');
  head.className = 'ai-hist-head';
  const n = list.length;
  head.textContent = kind === 'saved'
    ? (n ? `已保存（${n} 条，点一条就回到那次的搜索结果）` : '还没有保存过检索。检索完点「保存」就会存到这里。')
    : (n ? `检索历史（${n} 条，每次检索自动记，点一条回到那次的结果）` : '还没有检索过。检索一次就会自动记在这里。');
  box.appendChild(head);
  if (n) {
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn ghost mini ai-hist-clear';
    clearBtn.textContent = '清空';
    clearBtn.addEventListener('click', () => clearAiList(kind));
    head.appendChild(clearBtn);
  }
  const tabBar = $('aiTags');
  if (tabBar) tabBar.textContent = '';
  if (!n) return;
  for (const h of list) {
    const row = document.createElement('div');
    row.className = 'ai-hist-row';
    row.dataset.id = h.id;

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'ai-hist-main';
    const q = document.createElement('span');
    q.className = 'ai-hist-q';
    q.textContent = h.q;
    const meta = document.createElement('span');
    meta.className = 'ai-hist-meta';
    meta.textContent =
      `${fmtHistoryWhen(h.at)} · ${h.mode === 'agent' ? 'Agent' : '本地'} · ${h.count} 条` + (h.scene ? ' · 看图' : '');
    main.appendChild(q);
    main.appendChild(meta);
    main.addEventListener('click', () => restoreAiEntry(h));
    row.appendChild(main);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ai-hist-del';
    del.title = kind === 'saved' ? '从「已保存」里删掉这条' : '从历史里删掉这条';
    del.textContent = '\u00d7';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteAiEntry(kind, h.id);
    });
    row.appendChild(del);
    box.appendChild(row);
  }
}

function toggleAiList(view) {
  state.ai.histView = state.ai.histView === view ? 'none' : view;
  renderAiList();
}

// 交给模型终排的候选上限（再多 token 就不划算了）
const AI_TERM_LIMIT = 160;
// 全库扫描：每段条数 / 最多看多少条 / 并发几段
const AI_SCAN_CHUNK = 900;
const AI_SCAN_MAX = 12000;
const AI_SCAN_PARALLEL = 3;

/**
 * 素材库的「库」是哪一层：把所有素材目录的公共前缀去掉以后的第一段。
 * 真实资料库里这正好是 `E:\声音\071 Cyber Weapons` 这种音效包名，
 * 拿它来按库统计「这一库是不是全是爆炸/尖叫」最省事。
 */
let libPrefixCache = { n: -1, prefix: '' };

function libraryPrefix() {
  if (libPrefixCache.n === state.items.length) return libPrefixCache.prefix;
  let prefix = '';
  const dirs = [];
  for (const it of state.items) if (it.dir) dirs.push(it.dir);
  if (dirs.length) {
    const first = dirs[0].split('\\');
    let depth = first.length;
    for (const d of dirs) {
      const p = d.split('\\');
      let k = 0;
      const lim = Math.min(depth, p.length);
      while (k < lim && p[k].toLowerCase() === first[k].toLowerCase()) k++;
      depth = Math.min(depth, k);
      if (!depth) break;
    }
    prefix = first.slice(0, depth).join('\\');
  }
  libPrefixCache = { n: state.items.length, prefix };
  return prefix;
}

function libraryKeyOf(it) {
  const dir = (it && it.dir) || '';
  if (!dir) return '';
  const prefix = libraryPrefix();
  const rest = prefix && dir.toLowerCase().startsWith(prefix.toLowerCase())
    ? dir.slice(prefix.length).replace(/^\\+/, '')
    : dir.replace(/^[a-z]:\\/i, '');
  const first = rest.split('\\')[0];
  return first || rest || dir;
}

/** 把「这次跳过了多少条、因为哪几类」写进面板里的一行小字。 */
function renderAiPrune(note) {
  const el = $('aiPrune');
  if (!el) return;
  const text = note || '';
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}

/** 把候选行交给模型终排；失败返回 null（调用方保留本地顺序）。 */
async function aiRankRows(rows, headText) {
  if (!state.ai.agentOk || !rows.length) return null;
  // 选中项只在它自己也在候选里时告诉模型，否则它会拿不相关的选中项做参考，
  // 理由里就会冒出一句「当前选中的电动车素材不符」这种废话
  const sel = currentAiTarget();
  const target = sel && rows.some((r) => String(r[1] || '') === sel) ? sel : '';
  const messages = buildAgentMessages(state.ai.query, rows, { target });
  aiStatus(headText || '正在让 Agent 排序…', 'busy');
  let r;
  try {
    // 有些模型（DeepSeek 新出的带推理步的）会先写一大段 reasoning，
    // 预算给小了 content 就是空的，所以留宽一点
    r = await sb.invoke('agent:chat', { messages, temperature: 0.2, maxTokens: 3000 });
    if (r && !r.ok && /空内容/.test(String(r.error))) {
      aiStatus('模型把预算花在推理上了，加大预算再试一次…', 'busy');
      r = await sb.invoke('agent:chat', { messages, temperature: 0.2, maxTokens: 4800 });
    }
  } catch (err) {
    aiStatus('Agent 请求失败，已用本地结果：' + (err && err.message ? err.message : err), 'err');
    return null;
  }
  if (!r || !r.ok) {
    aiStatus('Agent 不可用，已用本地结果：' + (r && r.error ? String(r.error).slice(0, 160) : '未知错误'), 'err');
    return null;
  }
  const parsed = parseAgentReply(r.text);
  if (parsed.error) {
    aiStatus('Agent 回包看不懂，已用本地结果：' + parsed.error, 'err');
    return null;
  }
  const picked = resolvePicks(parsed.picks, state.items);
  if (!picked.length) {
    aiStatus(
      `Agent 回了 ${parsed.picks.length} 条，但对不上库里的素材（名字可能被截断），下面是本地初筛`,
      'err'
    );
    return null;
  }
  return { picked, note: parsed.note };
}

/**
 * 第一步：让模型把需求拆成检索词（中文需求 → 英文/中文同义词）。
 * 没有接口时返回 null，后面的流程就完全退回原来的纯本地检索。
 */
async function aiExpandQuery() {
  if (!state.ai.agentOk) return null;
  aiStatus('正在让 Agent 拆解需求…', 'busy');
  let r;
  try {
    r = await sb.invoke('agent:chat', { messages: buildExpandMessages(state.ai.query), temperature: 0.2, maxTokens: 1200 });
  } catch {
    return null;
  }
  if (!r || !r.ok) return null;
  const parsed = parseExpandReply(r.text);
  if (parsed.error) return null;
  if (!parsed.terms.length && !parsed.avoid.length && !parsed.where.length && !parsed.keywords.length) {
    return null;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Agent 主导的「全库语义召回」
// 以前必须先被本地词表命中，才有机会送到模型面前；像「狗叫」这种需求，
// 库里叫 DOG_Bark 还能撞上，叫 ANML_Pet_Vocal_03 就永远进不了候选。
// 现在让模型直接给 where（这东西一般出现在哪类素材里）+ keywords（具体对象名、拟声词），
// 拿这两个去整库扫一遍，本地命中只是其中一路证据，不再是门槛。
// ---------------------------------------------------------------------------
function aiHayOf(it) {
  if (it._aiHay) return it._aiHay;
  const ucs = it.ucs ? [it.ucs.category, it.ucs.sub, it.ucs.desc].filter(Boolean).join(' ') : '';
  const hay = [it.name || '', it.dir || '', ucs, it.path || ''].join(' ').toLowerCase();
  it._aiHay = hay;
  return hay;
}

function aiRecallByHints(pool, expand) {
  const norm = (arr) => (Array.isArray(arr) ? arr : [])
    .map((w) => String(w || '').trim().toLowerCase())
    .filter((w) => w.length >= 2);
  const kws = norm(expand && expand.keywords);
  const wheres = norm(expand && expand.where);
  const avoid = norm(expand && expand.avoid);
  if (!kws.length && !wheres.length) return [];
  const out = [];
  for (const it of pool) {
    if (!it || it.missing) continue;
    const hay = aiHayOf(it);
    if (avoid.length && avoid.some((w) => hay.includes(w))) continue;
    const kwHit = kws.filter((w) => hay.includes(w));
    const whHit = wheres.filter((w) => hay.includes(w));
    if (!kwHit.length && !whHit.length) continue;
    let score = 0;
    const why = [];
    if (kwHit.length) {
      score = Math.min(1, 0.55 + 0.15 * Math.min(3, kwHit.length));
      why.push('关键词 ' + kwHit.slice(0, 3).join('/'));
    }
    if (whHit.length) {
      score = Math.max(score, Math.min(0.9, 0.35 + 0.12 * Math.min(3, whHit.length)));
      why.push('范围 ' + whHit.slice(0, 2).join('/'));
    }
    out.push({ item: it, score, why: why.join(' · ') });
  }
  out.sort((a, b) => b.score - a.score || String(a.item.name).localeCompare(String(b.item.name)));
  return out.slice(0, 120).map((h) => ({
    item: h.item,
    score: h.score,
    pct: Math.max(1, Math.min(99, Math.round(h.score * 100))),
    reason: 'Agent 语义召回：' + h.why
  }));
}

/**
 * 第三步（可选）：全库扫描。把整库的「名字 + 分类」分段发给模型逐段点名，
 * 这样即使本地一个词都没命中，也能靠模型自己把素材找出来。
 */
async function aiDeepScan(query, onProgress, chunkSize = AI_SCAN_CHUNK, pool = state.items) {
  const total = Math.min(pool.length, AI_SCAN_MAX);
  const step = Math.max(20, Math.floor(chunkSize));
  const jobs = [];
  for (let s = 0; s < total; s += step) {
    jobs.push({ start: s, count: Math.min(step, total - s) });
  }
  const found = new Map();
  let scanned = 0;
  let failed = 0;
  let next = 0;

  const worker = async () => {
    for (;;) {
      const slot = next++;
      if (slot >= jobs.length) return;
      const job = jobs[slot];
      const payload = buildScanMessages(query, pool, job);
      let r = null;
      try {
        r = await sb.invoke('agent:chat', { messages: payload.messages, temperature: 0.2, maxTokens: 1800 });
      } catch {
        r = null;
      }
      scanned += payload.count;
      if (!r || !r.ok) {
        failed++;
      } else {
        const parsed = parseScanReply(r.text);
        for (const p of parsed.picks) {
          const it = pool[payload.start + p.i];
          if (!it) continue;
          const prev = found.get(it.path);
          if (!prev || prev.score < p.score) {
            found.set(it.path, { item: it, score: p.score / 100, pct: Math.round(p.score), reason: p.reason, reasons: p.reason ? [p.reason] : [], agent: true });
          }
        }
      }
      if (onProgress) onProgress(scanned, total, failed);
    }
  };

  await Promise.all(Array.from({ length: Math.min(AI_SCAN_PARALLEL, jobs.length) }, worker));
  return { found: [...found.values()].sort((a, b) => b.score - a.score), scanned, failed, total };
}

async function runAiSearch() {
  if (state.ai.busy) return;
  const input = $('aiQuery');
  let q = input ? input.value.trim() : '';
  const hasImage = !!state.ai.image;
  // 离线开关（需求 4）：勾上就完全不走网络，和没配密钥时行为一致
  // 注意：必须在下面的图片检查之前声明，否则会踩 TDZ（Cannot access 'useAgent' before initialization）
  const useAgent = !!(state.ai.agentOk && !state.ai.offline);
  if (!q && !hasImage) {
    aiStatus('先写一句需求，或者导入一张参考图。', 'err');
    return;
  }
  if (hasImage && !useAgent) {
    aiStatus('图片分析要用视觉模型：先在设置里填好 Agent 接口、模型和密钥。', 'err');
    return;
  }

  const deepEl = $('aiDeep');
  const deep = !!(deepEl && deepEl.checked);
  state.ai.busy = true;
  const btn = $('aiRun');
  if (btn) btn.disabled = true;

  try {
    // 0) 有参考图就先让模型看图：这一步同时产出「画面里会出现什么声音」和检索词，
    //    所以它替代了后面的「拆词」，不再额外花一次请求。
    //    已经看过同一张图就直接复用上次的结果：改完文字再检索时，不会因为第二次看图
    //    偶发失败而把画面描述清空（以前那种情况看起来就像「图片丢了、AI 也看不到图」）。
    let look = null;
    if (hasImage && useAgent) {
      const cached = state.ai.look && state.ai.image && state.ai.look.name === state.ai.image.name ? state.ai.look : null;
      if (cached && !state.ai.forceLook) {
        look = { ...cached, ok: true, cached: true };
        state.ai.imageError = '';
        state.ai.imageScene = cached.scene || '';
        state.ai.sounds = cached.sounds || [];
        renderAiImage();
      } else {
        aiStatus('正在看图片…', 'busy');
        await new Promise((r) => setTimeout(r, 0));
        look = await aiAnalyzeImage(q);
        if (!look.ok) {
          // 还有上一次的结果就继续用它，只在状态栏说明这次没重新看图
          if (cached) {
            look = { ...cached, ok: true, cached: true };
            state.ai.imageError = '';
            state.ai.imageScene = cached.scene || '';
            state.ai.sounds = cached.sounds || [];
            renderAiImage();
            aiStatus('这次重新看图没成功（' + (look.error || '接口没返回') + '），继续用上一次看图的描述。', '');
          } else {
            state.ai.imageScene = '';
            state.ai.sounds = [];
            state.ai.imageError = look.error || '未知错误';
            renderAiImage();
            aiStatus('看图没成功：' + look.error + '。已经退回纯文字检索。', 'err');
            look = null;
          }
        } else {
          state.ai.imageError = '';
          state.ai.imageScene = look.scene;
          state.ai.sounds = look.sounds;
          state.ai.look = { ...look, name: state.ai.image ? state.ai.image.name : '' };
          state.ai.forceLook = false;
          renderAiImage();
        }
        if (!q && look) q = [look.scene, ...look.sounds].join(' ');
      }
      if (!q && look) q = [look.scene, ...look.sounds].join(' ');
    }
    if (!q) {
      aiStatus('图片没看出可用内容，写一句需求再检索。', 'err');
      return;
    }
    state.ai.query = q;

    // 1) 有接口就先让模型拆需求；没有接口时这一步跳过，行为和以前完全一样
    const expand = look
      ? { terms: look.terms, avoid: look.avoid, note: look.note }
      : (useAgent ? await aiExpandQuery() : null);
    state.ai.expand = expand;
    const extraTerms = expand ? expand.terms : [];
    const extraAvoid = expand ? expand.avoid : [];

    // 2) 先按需求取向筛一遍：要「安静/自然」时，整库都是爆炸/尖叫/转场的库直接跳过，
    //    免得模型在候选里被这些强冲突素材带偏。取向判定只看中文关键词，不花 token。
    const intent = classifyQuery(q);
    const prune = planPrune(state.items, intent, { libraryOf: libraryKeyOf });
    const pool = prune.keep;
    state.ai.intent = { mood: intent.mood, nature: intent.nature };
    state.ai.prune = { dropped: prune.dropped, libs: prune.libs, labels: prune.labels };
    if (intent.mood === 'calm') {
      renderAiPrune(
        prune.dropped
          ? `安静取向：已跳过 ${prune.dropped} 条强烈无关素材${prune.labels.length ? '（' + prune.labels.join('、') + '）' : ''}，剩下 ${pool.length} 条参与检索`
          : ''
      );
    } else {
      renderAiPrune('');
    }

    // 3) 本地对整个库打分。扩出来的词只当辅证，阈值也压低，宁愿多召回
    aiStatus(expand ? `用 Agent 给的 ${extraTerms.length} 个词筛全库…` : '正在本地检索…', 'busy');
    await new Promise((r) => setTimeout(r, 0));

    const res = searchLibrary(pool, q, {
      limit: AI_TERM_LIMIT,
      extraTerms,
      extraAvoid,
      minScore: extraTerms.length ? 0.01 : 0.02
    });

    state.ai.parsed = res.parsed;
    state.ai.results = res.results;
    renderAiChips();
    renderAiResults();

    if (look) {
      aiStatus(
        `看图得到 ${look.sounds.length} 条可能的声音、${extraTerms.length} 个检索词，初筛 ${res.results.length} 条（共 ${res.total} 条素材）`,
        'ok'
      );
    } else if (expand) {
      aiStatus(`Agent 拆出 ${extraTerms.length} 个检索词，全库初筛 ${res.results.length} 条（共 ${res.total} 条素材）`, 'ok');
    } else if (res.results.length) {
      aiStatus(
        state.ai.offline
          ? `离线模式（不发送给 AI）：本地命中 ${res.results.length} 条（共 ${res.total} 条素材）`
          : `本地命中 ${res.results.length} 条（共 ${res.total} 条素材）`,
        'ok'
      );
    } else {
      aiStatus(`没有本地命中（共 ${res.total} 条素材）`, '');
    }

    // 3.5) 连上 Agent 时，让模型给的 where / keywords 直接去全库捞一遍。
    //      默认不再把「本地命中」当门槛（keepLocal=false），本地那几条只在勾选时附在后面，
    //      否则像「狗叫」这种需求会被英文命名 + 本地词表卡死在几条上。
    if (useAgent && expand && (expand.where.length || expand.keywords.length)) {
      const recalled = aiRecallByHints(pool, expand);
      if (recalled.length) {
        const seen = new Set(recalled.map((r) => r.item.path));
        const keep = state.ai.keepLocal ? res.results.filter((r) => !seen.has(r.item.path)) : [];
        state.ai.results = recalled.concat(keep).slice(0, 120);
        renderAiResults();
        const wk = (expand.where || []).slice(0, 2).join('/');
        const kk = (expand.keywords || []).slice(0, 3).join('/');
        aiStatus(
          `Agent 按「${[wk, kk].filter(Boolean).join(' · ')}」全库召回 ${recalled.length} 条` +
            (keep.length ? `，另附本地命中 ${keep.length} 条` : '') +
            `（共 ${res.total} 条素材）`,
          'ok'
        );
      } else if (!res.results.length) {
        aiStatus(`Agent 召回和本地命中都没有结果（共 ${res.total} 条素材），可以勾「全库扫描」再试。`, '');
      }
    }

    // 4) 勾了「全库扫描」才做：把整库名字分段发给模型，代价是 token
    if (deep && useAgent) {
      const scan = await aiDeepScan(q, (done, total, bad) => {
        aiStatus(`全库扫描 ${done}/${total} 条…${bad ? '（' + bad + ' 段失败）' : ''}`, 'busy');
      }, AI_SCAN_CHUNK, pool);
      if (scan.found.length) {
        const seen = new Set(scan.found.map((r) => r.item.path));
        const merged = scan.found.slice(0, 60);
        for (const r of res.results) {
          if (merged.length >= 60) break;
          if (!seen.has(r.item.path)) merged.push(r);
        }
        state.ai.results = merged;
        renderAiResults();
        aiStatus(
          `全库扫描点到 ${scan.found.length} 条（扫了 ${scan.scanned}/${scan.total} 条${scan.failed ? '，' + scan.failed + ' 段失败' : ''}）`,
          'ok'
        );
      } else if (!res.results.length) {
        aiStatus(`全库扫描也没点到（扫了 ${scan.scanned} 条${scan.failed ? '，' + scan.failed + ' 段失败' : ''}）`, '');
      }
    }

    // 4) 有接口就让模型在候选里终排（最多 40 行，别把上下文烧光）
    if (useAgent && state.ai.results.length) {
      const localRows = state.ai.results;
      const rows = candidateRows(localRows, 40);
      const better = await aiRankRows(rows, '候选已就绪，正在让 Agent 排序…');
      if (better) {
        // 默认「保留本地命中」：模型挑出来的排前面，本地初筛里没被挑中的附在后面，
        // 免得模型漏掉某条好素材时本地那几条也跟着消失
        let merged = better.picked;
        let extra = 0;
        if (state.ai.keepLocal) {
          const seen = new Set(better.picked.map((r) => r.item.path));
          const rest = localRows.filter((r) => !seen.has(r.item.path)).slice(0, Math.max(0, 40 - better.picked.length));
          extra = rest.length;
          merged = better.picked.concat(rest.map((r) => ({ ...r, local: true })));
        }
        state.ai.results = merged;
        renderAiResults();
        const note = better.note ? '：' + better.note : '';
        const tail = extra ? `，另附本地命中 ${extra} 条` : '';
        aiStatus(`Agent 复核后留下 ${better.picked.length} 条${tail}${note}`, 'ok');
      }
    } else if (!res.results.length && state.ai.agentOk && !deep) {
      aiStatus('本地和扩词都没命中，可以勾上「全库扫描」让 Agent 直接翻全库。', '');
    }
  } finally {
    state.ai.busy = false;
    if (btn) btn.disabled = false;
    // 每次检索完自动记一条历史（不用点保存）；空结果不记，免得列表里全是空壳
    try {
      recordAiHistory();
    } catch {
      /* 记历史失败不影响检索结果 */
    }
    if (state.ai.only) {
      computeView();
      renderList();
    }
  }
}

function setAiOnly(on) {
  state.ai.only = !!on;
  const b = $('aiOnly');
  if (b) b.classList.toggle('active', state.ai.only);
  computeView();
  renderList();
  dom.listBody.scrollTop = 0;
  if (state.ai.only) toast(`列表只显示这 ${state.ai.results.length} 条`);
}

// ===========================================================================
// 效果器（播放链上实时 + 离线渲染导出）
// ===========================================================================
let fxOpen = false;

const FX_SLIDERS = [
  ['fxHp', 'hp', 'fxHpVal', (v) => Math.round(v) + ' Hz'],
  ['fxLp', 'lp', 'fxLpVal', (v) => Math.round(v) + ' Hz'],
  ['fxBellFreq', 'bellFreq', 'fxBellFreqVal', (v) => Math.round(v) + ' Hz'],
  ['fxBellGain', 'bellGain', 'fxBellGainVal', (v) => (v > 0 ? '+' : '') + Number(v).toFixed(1) + ' dB'],
  ['fxCompThresh', 'compThreshold', 'fxCompThreshVal', (v) => Math.round(v) + ' dB'],
  ['fxCompRatio', 'compRatio', 'fxCompRatioVal', (v) => Number(v).toFixed(1) + ':1'],
  ['fxRevMix', 'revMix', 'fxRevMixVal', (v) => Math.round(v * 100) + '%'],
  ['fxRevTime', 'revTime', 'fxRevTimeVal', (v) => Number(v).toFixed(2) + ' s']
];

function syncFxUI() {
  const p = state.fx;
  const en = $('fxEnabled');
  if (en) en.checked = !!p.enabled;
  for (const [inputId, key, labelId, fmt] of FX_SLIDERS) {
    const el = $(inputId);
    if (el) el.value = String(p[key]);
    const lab = $(labelId);
    if (lab) lab.textContent = fmt(p[key]);
  }
  const comp = $('fxCompOn');
  if (comp) comp.checked = !!p.compOn;
  const rev = $('fxRevOn');
  if (rev) rev.checked = !!p.revOn;
  for (const [inputId] of FX_SLIDERS) {
    const el = $(inputId);
    if (el) el.disabled = false;
  }
  syncFxMini();
}

// 波形条左侧那一小块：开关 + 三个基础旋钮 + 「更多」
function syncFxMini() {
  const p = state.fx;
  if (dom.fxMini) dom.fxMini.classList.toggle('on', !!p.enabled);
  if (dom.fxMiniToggle) dom.fxMiniToggle.title = p.enabled
    ? '效果器已开：点开选择效果器 / 调参数（Ctrl+Shift+B 旁通）'
    : '效果器已旁通：点开选择效果器（Ctrl+Shift+B 启用）';
  const set = (input, label, value, fmt) => {
    if (input) input.value = String(value);
    if (label) label.textContent = fmt(value);
  };
  set(dom.fxMiniHp, $('fxMiniHpVal'), p.hp, (v) => Math.round(v) + '');
  set(dom.fxMiniLp, $('fxMiniLpVal'), p.lp, (v) => (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(Math.round(v))));
  set(dom.fxMiniRev, $('fxMiniRevVal'), Math.round(p.revMix * 100), (v) => Math.round(v) + '%');
}

function fxApply(patch = {}, save = true) {
  state.fx = clampFx({ ...state.fx, ...patch });
  player.setFx(!!state.fx.enabled, state.fx);
  syncFxUI();
  if (save) scheduleSave();
}

/** 效果器选择菜单：点「效果 ▾」先选要用哪套效果器，选中后直接打开它自己的参数窗。 */
function openImportMenu(anchor) {
  const el = anchor && anchor.getBoundingClientRect ? anchor : $('btnImport');
  const r = el ? el.getBoundingClientRect() : { left: 24, bottom: 24 };
  showContextMenu(r.left, r.bottom + 4, null, [
    { label: '导入文件…', run: () => importViaDialog('files') },
    { label: '导入文件夹…', run: () => importViaDialog('folder') }
  ]);
}

function openInspectorMenu(anchor) {
  const el = anchor && anchor.getBoundingClientRect ? anchor : $('btnInspector');
  const r = el ? el.getBoundingClientRect() : { left: 24, bottom: 24 };
  const cur = state.currentPath ? state.byPath.get(state.currentPath) : null;
  showContextMenu(r.left, r.bottom + 4, cur ? cur.name : null, [
    { label: '信息（Ctrl+I）', run: () => toggleInfoPanel() },
    { label: '相似波形（Ctrl+F）', run: () => toggleSimilarPanel() },
    { sep: true },
    { label: '处理：效果器 / 采样器 / VST3…', run: () => openFxMenu(el) }
  ]);
}

function openFxMenu(anchor) {
  const el = anchor && anchor.getBoundingClientRect ? anchor : dom.fxMiniToggle;
  const r = el ? el.getBoundingClientRect() : { left: 24, bottom: 24 };
  const on = !!state.fx.enabled;
  const vstInfo = (typeof vst !== 'undefined' && vst) ? vst : null;
  const vstLabel = vstInfo && vstInfo.plugin
    ? (vstInfo.name || String(vstInfo.plugin).split(/[\\/]/).pop().replace(/\.vst3$/i, ''))
    : '';
  const acts = [
    {
      label: (on ? '✓ ' : '○ ') + '启用效果器（Ctrl+Shift+B）',
      run: () => {
        fxApply({ enabled: !on });
        toast(on ? '效果器已旁通' : '效果器已开启');
      }
    },
    { sep: true },
    { label: '内置效果链：EQ / 压缩 / 混响…', run: () => openFxPanel() },
    { label: '采样器：变调 / 循环 / 包络…', run: () => openSamplerPanel() },
    { label: vstLabel ? `VST3 插件：${vstLabel}…` : 'VST3 插件…', run: () => openVstPanel() }
  ];
  const cur = state.byPath.get(state.currentPath);
  const hasVstRender = !!(cur && cur.playPath && /[\\/]cache[\\/]vst[\\/]/i.test(cur.playPath));
  if (vstLabel && hasVstRender) acts.push({ label: '撤掉 VST 渲染，还原原始素材', run: () => vstRestore() });
  acts.push({ sep: true }, {
    label: '收起效果器窗口',
    run: () => {
      if (fxOpen) closeFxPanel();
      if (vstInfo && vstInfo.open) closeVstPanel();
      if (synth.open) closeSynthPanel();
    }
  });
  showContextMenu(r.left, r.bottom + 4, null, acts);
}

function openFxPanel() {
  if (synth.open) closeSynthPanel();
  if (state.ai.open) closeAiPanel();
  if (fxOpen) closeFxPanel();
  if (similarTargetPath) closeSimilarPanel();
  if (state.settingsOpen) closeSettings();
  fxOpen = true;
  $('fxScrim').classList.remove('hidden');
  $('fxPanel').classList.remove('hidden');
  syncFxUI();
}

function closeFxPanel() {
  fxOpen = false;
  $('fxScrim').classList.add('hidden');
  $('fxPanel').classList.add('hidden');
  const el = document.activeElement;
  if (el && el.closest && el.closest('#fxPanel')) el.blur();
}

function toggleFxPanel() {
  if (fxOpen) closeFxPanel();
  else openFxPanel();
}

/** 快速旁通：保留参数，只把效果器从试听链里摘掉（导出仍按参数走）。 */
function fxBypass() {
  const on = !state.fx.enabled;
  fxApply({ enabled: on });
  toast(on ? '效果器已开启' : '效果器已旁通');
}

/** 从 WAV 头读采样率，导出时按原采样率解码，避免被声卡采样率重采样一遍。 */
function peekWavRate(buf) {
  try {
    const v = new DataView(buf);
    const tag = (off) => String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
    if (tag(0) === 'RIFF' && tag(8) === 'WAVE') {
      const rate = v.getUint32(24, true);
      if (rate >= 8000 && rate <= 384000) return rate;
    }
  } catch { /* ignore */ }
  return 0;
}

async function fxExport() {
  const it = state.byPath.get(state.currentPath) ||
    (state.selection.size === 1 ? state.byPath.get([...state.selection][0]) : null);
  const note = $('fxNote');
  if (!it) {
    if (note) note.textContent = '先在列表里选一个音频。';
    toast('先选中一个音频');
    return;
  }
  const btn = $('fxExport');
  if (btn) btn.disabled = true;
  try {
    if (note) note.textContent = '正在读取原始音频…';
    const src = it.playPath || it.path;
    const res = await fetch(audioUrl(src));
    if (!res.ok) throw new Error('读取音频失败（' + res.status + '）');
    const buf = await res.arrayBuffer();

    if (note) note.textContent = '正在解码…';
    const rate = peekWavRate(buf);
    const decodeCtx = rate ? new OfflineAudioContext(2, 1, rate) : player.ctx;
    let audio;
    try {
      audio = await decodeCtx.decodeAudioData(buf.slice(0));
    } catch {
      // 有些格式（APE/WMA 等）浏览器解不了，说明清楚而不是报个看不懂的错
      throw new Error('这个格式解不开（' + extOf(it.name).toUpperCase() + '），先转成 WAV 再处理');
    }

    if (note) note.textContent = '正在离线渲染效果…';
    const out = await renderOffline(audio, state.fx);

    if (note) note.textContent = '正在编码 24-bit WAV…';
    const wav = encodeWav24(out);
    const peak = bufferPeakDb(out);
    const base = it.name.replace(/\.[^.]+$/, '');
    const r = await sb.invoke('audio:save-wav', {
      buffer: wav,
      name: base + ' (fx).wav',
      dir: it.dir || undefined
    });
    if (r && r.ok) {
      if (note) {
        note.textContent = `已导出 ${r.path}（${fmtSize(r.size)}，${out.sampleRate} Hz，峰值 ${peak.toFixed(1)} dBFS）`;
      }
      toast('已导出处理后的音频');
    } else if (r && r.canceled) {
      if (note) note.textContent = '已取消。';
    } else {
      if (note) note.textContent = '导出失败：' + (r && r.error ? r.error : '未知错误');
    }
  } catch (err) {
    if (note) note.textContent = '导出失败：' + (err && err.message ? err.message : err);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ===========================================================================
// 生成底噪（把库里的几条素材缝成一条可循环的环境声）
//
// 流程分两段：先用模型把需求拆成检索词、再从库里召回候选，然后让模型按频率/质感
// 把候选分成若干层；真正的声音合成全在 synth.js（纯数组运算），这里只负责
// 读参数、喂 URL、把结果编码成 WAV 并给用户试听。生成的条目默认不写盘，
// 只有点「保存并入库」才走 synth:save 落到 <数据目录>\generated。
// ===========================================================================
const synth = {
  open: false,
  busy: false,
  plan: [],
  // 纹理参数（模式为 texture / hybrid 时才有）：面板上要显示这一条
  texture: null,
  result: null,
  // 一次可以生成好几条候选：各自带自己的 plan / stats / 预览文件路径
  candidates: [],
  active: -1,
  detailIdx: -1,
  liveBusy: false,
  liveAgain: false,
  detailOpen: false,
  opts: { ...SYNTH_DEFAULTS, mode: 'stitch', color: 'brown' }
};

// 试听用的是 blob URL，重生成时要把它收回，否则一条条攒着不放
let synthObjectUrl = '';

function synthStatus(text, kind = '') {
  const el = $('synthStatus');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'ai-status' + (kind ? ' ' + kind : '');
}

/** 数字格式化：stats 里缺字段时别显示 NaN，直接给个破折号。 */
function synthNum(v, digits = 1) {
  return Number.isFinite(Number(v)) ? Number(v).toFixed(digits) : '—';
}

/** 面板上几个控件 → 夹紧后的参数。以界面为准，别信内存里的旧值。 */
function synthReadOpts() {
  const num = (id, dflt) => {
    const el = $(id);
    const v = el ? Number(el.value) : NaN;
    return Number.isFinite(v) ? v : dflt;
  };
  const modeEl = $('synthMode');
  const mode = modeEl ? String(modeEl.value || 'stitch') : 'stitch';
  const colorEl = $('synthColor');
  const color = colorEl ? String(colorEl.value || 'brown') : 'brown';
  // clampSynth 只认识它自己那几个字段，mode / color 会被丢掉，所以夹完再挂回去
  const layersEl = $('synthLayers');
  const layersRaw = layersEl ? String(layersEl.value) : '';
  const layersAuto = layersRaw === 'auto';
  const base = clampSynth({
    ...synth.opts,
    seconds: num('synthSecondsN', SYNTH_DEFAULTS.seconds),
    layers: layersAuto ? SYNTH_DEFAULTS.layers : num('synthLayers', SYNTH_DEFAULTS.layers),
    targetLufs: num('synthLufs', SYNTH_DEFAULTS.targetLufs)
  });
  return {
    ...base,
    layersAuto,
    mode: ['stitch', 'texture', 'hybrid'].includes(mode) ? mode : 'stitch',
    color: ['brown', 'pink', 'white'].includes(color) ? color : 'brown'
  };
}

/** 一条候选压成一行给模型看：名字 + 所在目录 + 时段标签（时间错了是最容易被听出来的错）。 */
// 一条素材听着像不像是「合成音色 / 设计音效」而不是现场录音。
// 造「夜晚马路」出来像星球大战，多半是挑到了 Drone / Synth / Laser 这类音色库。
const SYNTHY_RE = /(drone|synth|tonal|laser|sci[-_ ]?fi|scifi|pad|atmos(?:phere)?\s*design|designed|sound\s*design|texture|resonance|pulse|bleep|glitch|riser|impulse\s*design|合成|电子音|科幻)/i;
function synthIsSynthetic(it) {
  const hay = `${(it && it.name) || ''} ${(it && it.path) || ''}`;
  return SYNTHY_RE.test(hay);
}
const WANT_SYNTH_RE = /(合成|电子|科幻|sci-?fi|laser|drone|pad|星际|太空|未来|机器|机械|信号|蜂鸣)/i;

function synthCandidateLine(it) {
  const dir = String(it.dir || '');
  const where = dir ? dir.split(/[\\/]/).filter(Boolean).slice(-1)[0] : '';
  const desc = where || (it.meta && it.meta.container ? String(it.meta.container) : '');
  const tag = synthTimeTag(it);
  const tagText = tag === 'day' ? '[白天]' : (tag === 'night' ? '[夜]' : (tag === 'dawn' ? '[晨昏]' : ''));
  // 合成音色也标出来：提示词里让模型「除非明说要电子/科幻，否则别选」，没有这个标注那句话就是空的
  const synthText = synthIsSynthetic(it) ? '[合成音色]' : '';
  return String(it.name || '') + (desc ? ' — ' + desc : '') + tagText + synthText;
}

/* --------------------------------------------------------------------------
   时段判定：白天的鸟叫 / 夜晚的蟋蟀，是两条完全不同的底噪。
   素材库的命名习惯很统一（day / night / morning / 夜 / 晨），所以用关键词就够，
   真拿不准就返回 'any'，交给模型自己判断。
   -------------------------------------------------------------------------- */

const TIME_DAY_RE = /(^|[^a-z])(day|midday|noon|afternoon|morning|sunrise|dawn|am\b)/i;
const TIME_NIGHT_RE = /(^|[^a-z])(night|nite|midnight|evening|dusk|sunset|owl|bat|cricket|frog)/i;
const TIME_DAY_CN = /(白天|白昼|正午|中午|午后|清晨|早晨|早上|晨间|日出)/;
const TIME_NIGHT_CN = /(夜晚|夜里|夜间|深夜|午夜|凌晨|傍晚|黄昏|日落|夜)/;

function synthTimeTag(it) {
  const s = String((it && (it.name || '')) + ' ' + (it && it.dir ? it.dir : '')).toLowerCase();
  const dayEn = TIME_DAY_RE.test(s);
  const nightEn = TIME_NIGHT_RE.test(s);
  if (dayEn && !nightEn) return 'day';
  if (nightEn && !dayEn) return 'night';
  if (TIME_DAY_CN.test(s) && !TIME_NIGHT_CN.test(s)) return 'day';
  if (TIME_NIGHT_CN.test(s) && !TIME_DAY_CN.test(s)) return 'night';
  return 'any';
}

/** 需求里的时段；判断不出来就 any。 */
function synthQueryTime(q) {
  const s = String(q || '').toLowerCase();
  if (TIME_NIGHT_CN.test(s) || /(night|midnight|evening|dusk)/.test(s)) return 'night';
  if (TIME_DAY_CN.test(s) || /(daytime|morning|noon|afternoon|sunrise)/.test(s)) return 'day';
  return 'any';
}

/** 面板里那串「每层用了哪几条素材」，生成完用来核对缝合来源。 */
function renderSynthLayers() {
  // 层列表已经搬进「参数」面板（内嵌在候选行下面），这里只保留兼容入口
  const box = $('synthLayerList');
  if (!box) return;
  if (!box) return;
  const tex = synth.texture;
  if (!synth.plan.length && !tex) { box.innerHTML = ''; return; }
  const head = tex
    ? `<div class="synth-layer"><b>纹理：${escapeHtml(tex.colorLabel || tex.color || '')}</b><span>`
      + `低切 ${Math.round(tex.lowCut)} Hz · 高切 ${Math.round(tex.highCut)} Hz · 呼吸 ${Number(tex.lfoRate).toFixed(2)} Hz`
      + ` · 起伏 ${Math.round(tex.gust * 100)}%`
      + (tex.rumble > 0 ? ` · 低频轰鸣 ${Math.round(tex.rumble * 100)}%` : '')
      + (tex.why ? `；${escapeHtml(tex.why)}` : '')
      + (tex.degraded ? '（本地规则）' : '')
      + '</span></div>'
    : '';
  const layers = synth.plan.map((layer, i) => {
    const label = layer && layer.label ? String(layer.label) : ('第 ' + (i + 1) + ' 层');
    const gain = Number(layer && layer.gainDb);
    const gainText = Number.isFinite(gain) ? ` <i>${gain > 0 ? '+' : ''}${gain} dB</i>` : '';
    const names = (layer && Array.isArray(layer.items) ? layer.items : [])
      .map((it) => escapeHtml(it.name || ''))
      .join('、');
    const why = layer && layer.why ? `<em>${escapeHtml(layer.why)}</em>` : '';
    return `<div class="synth-layer"><b>${escapeHtml(label)}${gainText}</b><span>${names || '（这一层没取到素材）'}</span>${why}</div>`;
  }).join('');
  box.innerHTML = head + layers;
}

function syncSynthModeUi() {
  // 只有纹理/混合才用到噪声底色；缝合模式下这栏灰掉，免得误以为它在起作用。
  // 注意要读下拉框的当前值（synth.opts 是上一次「生成」时才写的，读它会慢一拍）
  const sel = $('synthMode');
  const mode = sel ? String(sel.value || 'stitch') : ((synth && synth.opts && synth.opts.mode) || 'stitch');
  const color = $('synthColor');
  if (color) color.disabled = mode === 'stitch';
}

function openSynthPanel() {
  // 合成现在是 AI 工作台的第二个板块，不再是独立抽屉
  if (!state.ai.open) openAiPanel();
  setAiTab('synth');
  renderSynthLayers();
  renderSynthCandidates();
  synthStatus(synth.candidates.length
    ? '已经有生成好的候选，可以试听 / 参数 / 入库，也可以改需求再生成一批'
    : '写一句需求，点「生成」');
}

function closeSynthPanel() {
  synthStop();
  setAiTab('search');
}

/** 两个板块顶部的模型条：显示当前用的是哪套配置，点一下就能换 */
function renderAiModelBar() {
  const list = (state.agentProfiles && state.agentProfiles.profiles) || [];
  const active = (state.agentProfiles && state.agentProfiles.active) || '';
  for (const id of ['aiModelSelect', 'synthModelSelect']) {
    const sel = $(id);
    if (!sel) continue;
    const keep = sel.value;
    sel.textContent = '';
    if (!list.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = '未配置（点「管理…」填接口和密钥）';
      sel.appendChild(o);
      sel.disabled = true;
      continue;
    }
    sel.disabled = false;
    for (const p of list) {
      const o = document.createElement('option');
      o.value = p.id;
      const tail = p.keyTail ? ` · 尾号 ${p.keyTail}` : ' · 无密钥';
      // 名字里常常已经带了模型名（比如「deepseek-flash（767a）」），别重复写两遍
      const base = p.name || p.model || '未命名';
      const modelPart = p.model && !base.includes(p.model) ? ` · ${p.model}` : '';
      o.textContent = `${base}${modelPart}${tail}`;
      sel.appendChild(o);
    }
    const want = active || (list[0] && list[0].id) || '';
    // 始终跟着「当前生效的那套」走：在别处切换后这里要立刻反映出来
    sel.value = want;
  }
}

/** 模型条换一套即生效（写回 agent.json，并把界面状态刷新一遍） */
async function switchAiProfile(id) {
  if (!id || id === state.agentProfiles.active) return;
  try {
    const r = await sb.invoke('agent:profile-activate', { id });
    if (!r || !r.ok) throw new Error((r && r.error) || '切换失败');
    await loadAgentConfig();
    await loadAgentProfiles();
    renderAiModelBar();
    toast('已切换：' + (state.agentProfiles.profiles.find((p) => p.id === id) || {}).name);
  } catch (err) {
    toast('切换失败：' + (err && err.message ? err.message : err));
    await loadAgentProfiles();
    renderAiModelBar();
  }
}

/** AI 工具面板：检索 / 生成 两个板块。 */
function setAiTab(tab) {
  const want = tab === 'gen' ? 'gen' : 'search';
  state.ai.tab = want;
  const search = $('aiSearchSection');
  if (search) search.classList.toggle('hidden', want !== 'search');
  const gen = $('aiGenSection');
  if (gen) gen.classList.toggle('hidden', want !== 'gen');
  for (const b of document.querySelectorAll('#aiTabs .settings-tab')) {
    b.classList.toggle('active', b.dataset.aiTab === want);
  }
  if (want === 'gen') {
    loadGenConfig();
    genKindSetup(true);
    refreshGenBalance();
  }
  renderAiModelBar();
}

/** 停掉试听并收回 blob URL（关面板、重新生成、保存前都调一次）。 */
function synthStop() {
  // 预览用的是主播放器：切走板块/关闭面板时把它停掉，否则空格会接着放那条底噪
  if (state.currentPath) {
    const cur = state.byPath.get(state.currentPath);
    if (cur && cur.preview) {
      try { player.pause(); } catch { /* ignore */ }
      state.playing = false;
      updateTransport();
    }
  }
  const a = $('synthAudio');
  if (a) {
    try { a.pause(); } catch { /* ignore */ }
    a.removeAttribute('src');
    try { a.load(); } catch { /* ignore */ }
  }
  if (synthObjectUrl) {
    try { URL.revokeObjectURL(synthObjectUrl); } catch { /* ignore */ }
    synthObjectUrl = '';
  }
}

function synthPlay() {
  const idx = synth.active >= 0 ? synth.active : (synth.candidates.length ? 0 : -1);
  if (idx < 0) return;
  playSynthCandidate(idx).catch((err) => toast('试听失败：' + String(err && err.message ? err.message : err)));
}

/** 候选行上的「试听」：先切到那条，再走统一的 synthPlay。 */
function synthPlayCandidate(idx) {
  selectSynthCandidate(idx);
  synthPlay();
}

/** 候选行拖到 DAW / 资源管理器：拖预览文件本身，不依赖入库。 */
async function synthDragCandidate(idx, ev) {
  const c = synth.candidates[idx];
  if (!c) return;
  ev.preventDefault();
  if (!c.path) { toast('这条还没写到磁盘，先等一下或点「参数」重做一次'); return; }
  try {
    await sb.invoke('drag:start', { files: [c.path] });
  } catch (err) {
    toast('拖出失败：' + String(err && err.message ? err.message : err));
  }
}

/** 看起来像环境声却选了点状动效时，提一句。 */
function genKindHint() {
  const note = $('genKindNote');
  if (!note) return;
  const kindSel = $('genKind');
  const kind = (kindSel && kindSel.value) || 'ambience';
  const promptEl = $('genPrompt');
  const text = (promptEl && promptEl.value.trim()) || '';
  const sceneLike = /夜晚|夜里|街|马路|环境|氛围|场景|公园|室内|室外|城市|海边|森林|雨声|风声/.test(text);
  const shortish = kind === 'event' || kind === 'foley' || kind === 'ui';
  if (sceneLike && shortish) {
    note.textContent = '看起来你要的是一段环境声，建议把类型改成「环境底噪」：'
      + '点状动效会往提示词里加 single one-shot / dry / close，'
      + '生成出来就是一下子很响的声音，与“安静的街道”相反。';
    note.classList.remove('hidden');
  } else {
    note.textContent = '';
    note.classList.add('hidden');
  }
}

/** 把模型回的 JSON 解析成分层结果；任何不合规的序号/空层都丢掉。 */
function parseSynthLayers(text, wantLayers, shown) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj = null;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  if (!obj || !Array.isArray(obj.layers) || !obj.layers.length) return null;
  const out = [];
  for (const raw of obj.layers) {
    if (!raw || out.length >= wantLayers) continue;
    const items = [];
    for (const p of (Array.isArray(raw.picks) ? raw.picks : [])) {
      const n = Number(p);
      // 序号从 1 开始，且只能落在真正发给模型的那批候选里
      if (!Number.isInteger(n) || n < 1 || n > shown.length) continue;
      const it = shown[n - 1];
      if (it && !items.includes(it)) items.push(it);
    }
    if (!items.length) continue;
    // gainDb 是模型建议的层电平（低频层可以给 0，细节层通常 −6…−14）；夹在 −18…+3
    const g = Number(raw.gainDb);
    const gainDb = Number.isFinite(g) ? Math.max(-18, Math.min(3, g)) : null;
    const label = String(raw.label || '').trim().slice(0, 24) || ('第 ' + (out.length + 1) + ' 层');
    const why = String(raw.why || raw.role || '').trim().slice(0, 60);
    out.push({ label, items: items.slice(0, 3), gainDb, why });
  }
  // 同一条素材不许占满所有层：超过两层就把后出现的层里它剔掉
  const seen = new Map();
  for (const layer of out) {
    layer.items = layer.items.filter((it) => {
      const used = seen.get(it) || 0;
      if (used >= 2) return false;
      seen.set(it, used + 1);
      return true;
    });
  }
  return out.filter((l) => l.items.length).length ? out.filter((l) => l.items.length) : null;
}

/**
 * 降级方案：模型不可用（没网 / 没配密钥 / 回的 JSON 不合法）时自己分组。
 * 候选按 3 段平均切（低 / 中 / 高），第 N 层取对应那段的头两条；
 * 层数超过 3 时多出来的层复用最后一段——总比一条都出不来强。
 */
function degradeSynthLayers(pool, layers, query) {
  const n = Math.max(1, layers);
  // 降级也得守时段：模型不可用时最容易翻车的正是「夜里配白天鸟」
  const wantTime = synthQueryTime(String(query || ''));
  let use = pool;
  if (wantTime !== 'any') {
    const bad = wantTime === 'night' ? 'day' : 'night';
    const kept = pool.filter((it) => synthTimeTag(it) !== bad);
    if (kept.length >= 6) use = kept;
  }
  pool = use;
  const segs = 3;
  const chunks = [];
  const per = Math.max(1, Math.ceil(pool.length / segs));
  for (let s = 0; s < segs; s++) chunks.push(pool.slice(s * per, s * per + per));
  const out = [];
  for (let i = 0; i < n; i++) {
    const seg = chunks[Math.min(i, segs - 1)] || [];
    let items = seg.slice(0, 2);
    // 这一段不够两条就从头补：每一层都必须有东西可铺
    for (const it of pool) {
      if (items.length >= 2) break;
      if (!items.includes(it)) items.push(it);
    }
    out.push({ label: '第 ' + (i + 1) + ' 层', items });
  }
  return out;
}

/**
 * 把 plan 里的条目逐条解码成 buildBed 能吃的形状。
 * 某条坏了就跳过（记进 skips），别让一条损坏素材毁掉整次生成。
 */
async function decodePlanLayers(plan, skips) {
  const decoded = [];
  let n = 0;
  for (const layer of plan) {
    const bucket = [];
    for (const it of (layer.items || [])) {
      n++;
      synthStatus(`解码素材…（第 ${n} 条  ${it.name || ''}）`, 'busy');
      // 已知时长超上限就不解码了：几分钟的素材光解码就能把内存吃光
      const known = Number(it.meta && it.meta.duration) || 0;
      if (known > 720) {
        skips.push({ name: it.name, reason: `长 ${Math.round(known)} 秒，超过 720 秒上限` });
        continue;
      }
      try {
        const d = await decodeBuffer(audioUrl(it.playPath || it.path));
        // 把文件名带进解码结果：buildBed 的 layerUsed / skips 都靠它显示人话
        if (d && !d.name) d.name = it.name;
        bucket.push(d);
      } catch (err) {
        skips.push({ name: it.name, reason: String(err && err.message ? err.message : err) });
      }
    }
    if (bucket.length) decoded.push(bucket);
  }
  return decoded;
}

const TEXTURE_COLOR_LABEL = { brown: '棕噪（低频厚）', pink: '粉噪（均衡）', white: '白噪（亮）' };

/** 从一句中文里猜纹理参数：没网 / 没密钥时至少别给一条白噪了事。 */
function guessTextureParams(q) {
  const s = String(q || '').toLowerCase();
  const has = (...keys) => keys.some((k) => s.includes(k));
  const p = { color: 'brown', lowCut: 25, highCut: 9000, lfoRate: 0.05, lfoDepth: 0.3, gust: 0.35, rumble: 0, why: '' };
  if (has('白噪', '嘶', '静电', '磁带', '电视', '蒸汽', '喷')) {
    p.color = 'white'; p.highCut = 14000; p.lowCut = 60; p.lfoDepth = 0.1; p.gust = 0.1;
    p.why = '高频为主的嘶声';
  } else if (has('雨', '水', '风扇', '空调', '机房', '风')) {
    p.color = 'pink'; p.lowCut = 60; p.highCut = 11000; p.gust = has('风') ? 0.6 : 0.2;
    p.lfoRate = has('风') ? 0.09 : 0.03;
    p.why = has('风') ? '有起伏的风' : '宽而平的空气层';
  } else if (has('车', '路', '发动机', '低频', '轰', '地铁', '远处')) {
    p.color = 'brown'; p.lowCut = 22; p.highCut = 3500; p.rumble = 0.45; p.gust = 0.25; p.lfoRate = 0.04;
    p.why = '低频铺底 + 缓慢车流起伏';
  } else if (has('安静', '室内', '房间', '夜', '图书馆', '卧室')) {
    p.color = 'brown'; p.lowCut = 30; p.highCut = 5000; p.lfoDepth = 0.12; p.gust = 0.12;
    p.why = '低能量房间底噪';
  }
  return p;
}

function parseTextureParams(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj = null;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const n = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
  return {
    color: ['brown', 'pink', 'white'].includes(String(obj.color)) ? String(obj.color) : 'brown',
    lowCut: n(obj.lowCut, 25),
    highCut: n(obj.highCut, 9000),
    lfoRate: n(obj.lfoRate, 0.05),
    lfoDepth: n(obj.lfoDepth, 0.3),
    gust: n(obj.gust, 0.35),
    rumble: n(obj.rumble, 0),
    detailGainDb: n(obj.detailGainDb, -8),
    why: String(obj.why || obj.note || '').trim().slice(0, 60)
  };
}

/**
 * 需求 → 纹理参数。
 * 有模型就让模型判断（它知道「老式空调」和「海边风」该不一样），没有就走关键词规则。
 */
async function synthTextureParams(q) {
  const useAgent = !!(state.ai.agentOk && !state.ai.offline);
  const base = guessTextureParams(q);
  if (!useAgent) return { ...base, degraded: true };

  const messages = [
    {
      role: 'system',
      content: '你是声音设计师，负责把一句中文需求翻译成「程序化底噪」的合成参数。'
        + '可选的颜色：brown（低频厚、像车流/远雷/厚重空气）、pink（均衡、像雨/风扇/人群远底）、'
        + 'white（亮、像嘶声/蒸汽/静电）。只输出 JSON，不要解释：'
        + '{"color":"brown|pink|white","lowCut":数字Hz,"highCut":数字Hz,'
        + '"lfoRate":数字Hz(0.01–0.5),"lfoDepth":0–1,"gust":0–1,'
        + '"rumble":0–1,"detailGainDb":-18–0,"why":"一句话说这条底噪的质感"}。'
        + '参考：室内安静底噪 lowCut 30 / highCut 5000 / gust 0.1；海边风 gust 0.6、lfoRate 0.09；'
        + '雨 highCut 9000–12000；机房/车流 rumble 0.4–0.6、highCut 3000–4500。'
    },
    { role: 'user', content: `需求：${q}\n时长：${synth.opts.seconds} 秒\n目标响度：${synth.opts.targetLufs} LUFS` }
  ];
  try {
    const r = await sb.invoke('agent:chat', { messages, temperature: 0.2, maxTokens: 1500 });
    if (r && r.ok) {
      const parsed = parseTextureParams(r.text);
      if (parsed) return parsed;
    }
  } catch { /* 掉线就用关键词规则 */ }
  return { ...base, degraded: true };
}


async function synthPlan(query, layersOverride) {
  const q = String(query || '').trim();
  if (!q) return [];
  const useAgent = !!(state.ai.agentOk && !state.ai.offline);

  // 1) 拆需求：和 Agent 检索共用同一套 prompt，省得两套话术互相打架
  let expand = null;
  if (useAgent) {
    synthStatus('正在理解需求…', 'busy');
    try {
      const r = await sb.invoke('agent:chat', {
        messages: buildExpandMessages(q),
        temperature: 0.2,
        maxTokens: 3500
      });
      if (r && r.ok) expand = parseExpandReply(r.text);
      else if (r && !r.ok) synth.degradeReason = String(r.error || '拆词接口没返回内容').slice(0, 80);
    } catch { /* 没网 / 接口挂了，下面走降级 */ }
  }

  // 2) 本地召回：拿模型给的 where/keywords 去全库扫，最多留 200 条
  let pool = [];
  if (expand && !expand.error) {
    pool = aiRecallByHints(state.items, expand)
      .slice(0, 200)
      .map((hit) => hit.item)
      .filter(Boolean);
  }
  if (!pool.length) {
    // 召回一条都没有：先用本地检索按需求抓一批（比整库前 200 条靠谱得多），
    // 再不行才退回整库——整库前 200 条往往全是同一套包，听感会跑偏。
    try {
      const local = searchLibrary(state.items, q, { limit: 240 }) || [];
      pool = local.map((r) => r.item).filter(Boolean);
    } catch { /* 检索挂了才用下面的兜底 */ }
  }
  if (!pool.length) {
    pool = state.items.filter((it) => it && !it.missing).slice(0, 200);
  }
  // 生成出来的底噪自己也在库里，别拿它当原料（越叠越糊、也容易自指循环）
  pool = pool.filter((it) => it && !/[\\/]generated[\\/]/i.test(String(it.path || '')));

  // 2.2) 合成音色惩罚：需求没提电子/科幻/机械时，把 Drone/Synth/Laser 这类排到最后。
  //      这一步是「夜晚马路变成星球大战」的直接对策：候选池里现场录音优先。
  if (!WANT_SYNTH_RE.test(q)) {
    const real = [];
    const synthetic = [];
    for (const it of pool) (synthIsSynthetic(it) ? synthetic : real).push(it);
    if (real.length) pool = real.concat(synthetic);
  }

  // 2.5) 时段过滤：要「夜晚」却拿白天鸟叫来铺，是最容易被听出来的错。
  //      先按名字/目录给每条打时段标签，再按需求把不合适的排到最后（不直接删，避免库太小没得挑）。
  const wantTime = synthQueryTime(q);
  if (wantTime !== 'any') {
    const bad = wantTime === 'night' ? 'day' : (wantTime === 'day' ? 'night' : null);
    const good = [];
    const rest = [];
    for (const it of pool) {
      const tag = synthTimeTag(it);
      if (bad && tag === bad) rest.push(it);
      else good.push(it);
    }
    // 池子够大就直接剔掉错时段的（夜间配上白天鸟叫，是用户第一句就点出来的问题）；
    // 池子太小才退化成「排在后面」，免得一条都挑不出来。
    pool = good.length >= 12 ? good : good.concat(rest);
  }
  if (!pool.length) return [];

  // 混合模式只要一层细节，别让模型硬凑层数；
  // 「自主合成」时 layers = 0，让模型自己判断 2–4 层。
  const autoLayers = !!synth.opts.layersAuto && !(Number(layersOverride) > 0);
  const want = autoLayers ? 0 : (Number(layersOverride) > 0 ? Number(layersOverride) : synth.opts.layers);
  const layers = autoLayers ? 0 : Math.max(1, Math.min(5, Number(want) || 3));

  // 3) 让模型分层。候选最多发 80 条：再长模型就容易把序号数错
  const shown = pool.slice(0, 80);
  let picked = null;
  if (useAgent) {
    synthStatus('正在分层…', 'busy');
    const list = shown.map((it, i) => `${i + 1}. ${synthCandidateLine(it)}`).join('\n');
    const messages = [
      {
        role: 'system',
        content: '你是拟音师。用户要一条环境底噪，你会从候选素材里为每一层各挑 1–3 条，'
          + '叠在一起后要能互相补足、不要打架：低频层铺底、中频层给质感、高频层给细节。'
          + '同一条素材最多出现在两层里。候选只能从给出的序号里选。只输出 JSON，不要解释，格式：'
          + '{"layers":[{"label":"低频底","picks":[序号...],"gainDb":0,"why":"一句话说这层负责什么"}]}。'
          + '层名用两个到六个字的中文（比如「低频底」「风噪」「细碎高频」）。'
          + '层数：用户给了具体层数就严格照做；写「自主」时由你判断，2–4 层之间，别为了凑数硬拆。'
          + 'gainDb 是这层的电平（低频铺底通常 0，越高频越往下让：−6、−10、−14），'
          + '让叠出来不糊、不抢戏；如果某一层只是很轻的质感，可以给到 −16。'
          + '候选行尾的 [白天]/[夜]/[晨昏] 是这条素材**只适合的时段**：需求写的是夜晚就别选 [白天]，'
          + '写的是白天就别选 [夜]；标 [晨昏] 的两头都可以用。宁可少一条，也不要拿错时段的素材凑数。'
          + '行尾标了 [合成音色] 的是设计出来的音效（Drone/Synth/Laser 之类），'
          + '除非需求明确要电子、科幻、机械感，否则不要选它——要真实世界的现场录音质感。'
      },
      {
        role: 'user',
        content: `需求：${q}\n\n层数：${layers ? layers : '自主（2–4 层，你判断）'}\n\n候选素材（序号. 文件名 — 所在目录）：\n${list}`
      }
    ];
    try {
      const r = await sb.invoke('agent:chat', { messages, temperature: 0.2, maxTokens: 3500 });
      if (r && r.ok) picked = parseSynthLayers(r.text, layers || 4, shown);
      else if (r && !r.ok) synth.degradeReason = String(r.error || '接口没有返回内容').slice(0, 80);
    } catch { /* 同上去降级 */ }
  }

  // 4) 任何一步失败都用本地分组兜底，并把原因写在状态行
  if (!picked) {
    synth.degraded = true;
    synth.degradeReason = synth.degradeReason || '模型没给出可用的分层结果';
    synthStatus('模型这次没给可用结果（' + synth.degradeReason + '），已改为本地降级分组', '');
    picked = degradeSynthLayers(pool, layers || 3, q);
  } else {
    synth.degraded = false;
  }
  return picked;
}

async function synthRun() {
  if (synth.busy) return;
  const q = String(($('synthPrompt') && $('synthPrompt').value) || '').trim();
  if (!q) {
    synthStatus('先写一句需求，比如「夜晚的海边，只有海浪和一点点虫鸣」。', 'err');
    toast('先写一句需求');
    return;
  }
  const btnRun = $('synthRun');
  const btnPlay = $('synthPlay');
  const btnSave = $('synthSave');
  synth.busy = true;
  synth.candidates = [];
  synth.active = -1;
  synth.degraded = false;
  synth.degradeReason = '';
  syncSynthModeUi();
  if (btnRun) btnRun.disabled = true;
  if (btnPlay) btnPlay.disabled = true;
  if (btnSave) btnSave.disabled = true;
  renderSynthCandidates();
  closeSynthDetail();

  const skips = [];
  let aborted = false;
  try {
    const n = Math.max(1, Math.min(4, Number($('synthCount') && $('synthCount').value) || 1));
    synth.opts = synthReadOpts();
    const mode = synth.opts.mode || 'stitch';
    synth.plan = [];

    // ---- 先把「怎么搭」定下来，再按条数生成 —— 只调一次模型，省时间和 token ----
    let plan = [];
    let tex = null;
    let extrasFor = null;

    if (mode === 'texture' || mode === 'hybrid') {
      synthStatus('理解音色…', 'busy');
      tex = await synthTextureParams(q);
      tex.colorLabel = TEXTURE_COLOR_LABEL[tex.color] || tex.color;
      synth.texture = tex;
      if (mode === 'hybrid') {
        synthStatus('挑细节素材…', 'busy');
        plan = await synthPlan(q, 1);
        synth.plan = plan;
      }
    } else {
      synthStatus('挑素材…', 'busy');
      plan = await synthPlan(q);
      if (!plan.length) throw new Error('库里没找到能用的素材');
      synth.plan = plan;
    }
    renderSynthLayers();
    renderSynthCandidates();

    // 层增益（参数面板可以改）：存在候选自己的 plan 里，重做时读它
    const baseGains = plan.map((l) => l.gainDb);

    // 解码只做一次：变体之间只是层内顺序/电平不同，素材是同一批。
    // 96k / 几百 MB 的素材解一遍就要好几秒，按条数重复解码是纯粹的浪费。
    let decodedBase = null;
    if (mode === 'stitch' && plan.length) {
      synthStatus('解码素材…', 'busy');
      decodedBase = await decodePlanLayers(plan, skips);
      if (!decodedBase.length) throw new Error('素材都解码失败' + (skips.length ? '：' + skips[0].reason : ''));
    }

    for (let k = 0; k < n; k++) {
      if (aborted) break;
      const variantPlan = synthVariantPlan(plan, k, baseGains);
      const variantTex = tex ? synthVariantTexture(tex, k) : null;
      const cand = {
        idx: k,
        kind: mode,
        query: q,
        seconds: synth.opts.seconds,
        targetLufs: synth.opts.targetLufs,
        plan: variantPlan,
        texture: variantTex,
        extraGainDb: tex && Number.isFinite(Number(tex.detailGainDb)) ? Number(tex.detailGainDb) : -8,
        stats: null,
        wav: null,
        path: ''
      };

      synthStatus(n > 1 ? `生成第 ${k + 1}/${n} 条…` : '生成…', 'busy');
      await new Promise((r) => setTimeout(r, 0));

      let out = null;
      if (mode === 'texture' || mode === 'hybrid') {
        let extras = [];
        if (mode === 'hybrid' && variantPlan.length) {
          synthStatus(`解码细节层…（第 ${k + 1}/${n} 条）`, 'busy');
          const decodedDetail = await decodePlanLayers(variantPlan.slice(0, 1), skips);
          if (decodedDetail.length) {
            const detail = buildBed(decodedDetail, {
              ...synth.opts,
              seconds: cand.seconds,
              layers: 1,
              targetLufs: cand.targetLufs
            });
            extras = [{
              channels: detail.channels,
              gainDb: Math.max(-18, Math.min(0, Number(cand.extraGainDb))),
              name: variantPlan[0].label || '细节层'
            }];
          }
        }
        out = buildTexture(clampTexture({
          ...variantTex,
          seconds: cand.seconds,
          sampleRate: 48000,
          targetLufs: cand.targetLufs
        }), extras);
      } else {
        // 复用已解码的素材：只在层内换一下先后顺序，听感就是另一个版本
        const decoded = (decodedBase || []).map((bucket) => {
          if (!bucket || bucket.length < 2 || k === 0) return bucket;
          const shift = k % bucket.length;
          return bucket.slice(shift).concat(bucket.slice(0, shift));
        });
        if (!decoded.length) throw new Error('素材都解码失败');
        synthStatus(`拼接…（第 ${k + 1}/${n} 条）`, 'busy');
        await new Promise((r) => setTimeout(r, 0));
        out = buildBed(decoded, {
          ...synth.opts,
          seconds: cand.seconds,
          layers: variantPlan.length,
          targetLufs: cand.targetLufs,
          layerGains: variantPlan.map((l) => l.gainDb)
        });
      }

      if (!out || !Array.isArray(out.channels) || !out.channels.length) {
        throw new Error('合成没有返回可用的声道');
      }
      cand.stats = out.stats || {};
      // 记住生成时为了达到目标响度整体加了多少 dB：拖比例时按这个数还原，
      // 而不是每次都重新归一（重新归一会把拉低的层又抬回来，听起来就是「拉到底还在响」）
      cand.masterGainDb = Number.isFinite(Number(cand.stats.gainDb)) ? Number(cand.stats.gainDb) : 0;
      cand.wav = synthEncode(out);
      cand.baseName = synthStem(q, cand.seconds, n > 1 ? k + 1 : 0);

      // 先落到 generated\_preview：结果行立刻就能拖进 DAW，不用先入库
      synthStatus(`写入预览…（第 ${k + 1}/${n} 条）`, 'busy');
      const staged = await sb.invoke('synth:stage', { buffer: cand.wav, name: cand.baseName });
      if (staged && staged.ok) cand.path = staged.path;
      synth.candidates.push(cand);
      renderSynthCandidates();
      if (k === 0) selectSynthCandidate(0);
    }

    if (!synth.candidates.length) throw new Error('一条都没生成出来');
    synthStop();
    const st = synth.candidates[0].stats;
    const tex0 = synth.texture;
    const source = st.mode === 'texture'
      ? (tex0 && tex0.colorLabel ? `纹理（${tex0.colorLabel}）` : '纹理')
        + (st.layerUsed && st.layerUsed.length ? ` + ${st.layerUsed.length} 层库细节` : '')
      : `${Number(st.layers) || synth.plan.length} 层`;
    synthStatus(
      `已生成 ${synth.candidates.length} 条 · 每条 ${Math.round(Number(st.seconds) || synth.opts.seconds)} 秒 · ${source}`
        + ` · ${synthNum(st.lufs)} LUFS · 峰值 ${synthNum(st.peakDb)} dBFS`
        + (st.seamOk ? ' · 循环点无缝' : ' · 循环点有台阶（可先试听再决定要不要用）')
        + (synth.degraded || (tex0 && tex0.degraded) ? ' · 本地降级' : '')
        + (skips.length ? `（跳过 ${skips.length} 条解不开的素材）` : '')
        + ' —— 点「参数」看/改每一层的比例',
      'ok'
    );
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    synthStatus('失败：' + msg, 'err');
    toast(msg);
  } finally {
    synth.busy = false;
    if (btnRun) btnRun.disabled = false;
    if (btnPlay) btnPlay.disabled = !synth.result;
    if (btnSave) btnSave.disabled = !synth.result;
  }
}

/** Float32 声道 → 24-bit WAV（AudioBuffer 只是 encodeWav24 的入参形状）。 */
function synthEncode(out) {
  const ab = new AudioBuffer({
    length: out.channels[0].length,
    sampleRate: out.sampleRate,
    numberOfChannels: 2
  });
  ab.copyToChannel(out.channels[0], 0);
  ab.copyToChannel(out.channels[1] || out.channels[0], 1);
  return encodeWav24(ab);
}

/** 取需求第一句做文件名主干；多条时加 _v2/_v3。 */
function synthStem(q, seconds, variantNo) {
  const firstClause = String(q || '').split(/[，。、；：！？,.;:!?\n]/)[0] || '';
  const word = firstClause
    .replace(/[\s“”"'‘’（）()《》〈〉【】\[\]\\/:*?"<>|~`]/g, '')
    .slice(0, 12) || 'bed';
  const sec = Math.round(Number(seconds) || 60);
  return `BED_${word}_${sec}s` + (variantNo > 1 ? `_v${variantNo}` : '');
}

/** 第 k 条变体：转一层里的素材顺序（换相位）+ 层电平 ±1 dB，听感上是"另一个版本"。 */
function synthVariantPlan(plan, k, baseGains) {
  const gains = Array.isArray(baseGains) ? baseGains : [];
  return (plan || []).map((layer, li) => {
    const items = (layer.items || []).slice();
    if (k > 0 && items.length > 1) {
      const shift = k % items.length;
      items.push(...items.splice(0, shift));
    }
    let g = Number(gains[li]);
    if (!Number.isFinite(g)) g = Number(layer.gainDb);
    if (!Number.isFinite(g)) g = li === 0 ? 0 : -(6 + (li - 1) * 4);
    if (k > 0) g = Math.max(-18, Math.min(3, g + (k % 2 ? -1 : 1)));
    return { ...layer, items, gainDb: g };
  });
}

function synthVariantTexture(tex, k) {
  if (!tex || k === 0) return tex;
  const seed = (Number(tex.seed) || 1) + k * 37;
  const wobble = (v, amp) => Number((Number(v) || 0) * (k % 2 ? 1 + amp : 1 - amp));
  return {
    ...tex,
    seed,
    lfoRate: Math.max(0.01, wobble(tex.lfoRate, 0.25)),
    gust: Math.max(0, Math.min(1, (Number(tex.gust) || 0) + (k % 2 ? 0.1 : -0.1))),
    why: tex.why
  };
}

/* ---------- 候选列表 ---------- */

/* ---------- 候选列表 / 参数面板：点一行就在下方波形里试听 ---------- */

// 生成结果是 generated\_preview 下的真实文件，但不在清单里。
// 造一个「临时条目」塞进 byPath，就能直接用主播放器播它：波形、选区、裁剪、拖出全都能用。
function synthCandidateItem(c) {
  if (!c || !c.path) return null;
  if (c._item && c._item.path === c.path) return c._item;
  const secs = Number(c.stats && c.stats.seconds) || Number(c.seconds) || 60;
  const it = {
    path: c.path,
    playPath: c.path,
    name: (c.baseName || 'bed') + '.wav',
    ext: 'wav',
    dir: String(c.path).replace(/[\\/][^\\/]+$/, ''),
    size: (c.wav && c.wav.byteLength) || 0,
    mtimeMs: Date.now(),
    analysis: 'ready',
    missing: false,
    preview: true,          // 标记：不是清单里的条目，别参与保存/统计
    meta: {
      container: 'WAV',
      codec: 'PCM',
      sampleRate: 48000,
      channels: 2,
      bitsPerSample: 24,
      duration: secs,
      frames: Math.round(secs * 48000)
    },
    peaks: null,
    peaksState: 'idle',
    trim: null
  };
  c._item = it;
  state.byPath.set(it.path, it);
  return it;
}

// 重新合成之后路径会变（每次 stage 都是新文件），把临时条目指到新文件上
function retargetSynthItem(it, c) {
  if (!it || !c || !c.path) return false;
  const old = it.path;
  it.path = c.path;
  it.playPath = c.path;
  it.size = (c.wav && c.wav.byteLength) || it.size;
  it.meta.duration = Number(c.stats && c.stats.seconds) || it.meta.duration;
  it.peaks = null;
  it.peaksState = 'idle';
  if (old !== it.path) {
    state.byPath.delete(old);
    state.byPath.set(it.path, it);
    if (state.currentPath === old) state.currentPath = it.path;
    if (state.selection.has(old)) { state.selection.delete(old); state.selection.add(it.path); }
    if (state.focusPath === old) state.focusPath = it.path;
  }
  return true;
}

function synthDetailHtml(c, i) {
  const head = c.kind === 'texture'
    ? `纹理：${escapeHtml((c.texture && c.texture.colorLabel) || '')}`
      + `（低切 ${Math.round(Number(c.texture && c.texture.lowCut) || 0)} Hz / 高切 ${Math.round(Number(c.texture && c.texture.highCut) || 0)} Hz`
      + ` · 呼吸 ${Number(c.texture && c.texture.lfoRate || 0).toFixed(2)} Hz · 阵风 ${Math.round((Number(c.texture && c.texture.gust) || 0) * 100)}%`
      + ` · 低频轰鸣 ${Math.round((Number(c.texture && c.texture.rumble) || 0) * 100)}%）`
    : '这条由下面几层叠成：';
  const rows = (c.plan || []).map((layer, li) => {
    const g = Number.isFinite(Number(layer.gainDb)) ? Number(layer.gainDb) : 0;
    const names = (layer.items || []).map((it) => escapeHtml(it.name || '')).join('、');
    return `<div class="synth-detail-layer" data-layer="${li}">
        <div class="synth-detail-row"><b>${escapeHtml(layer.label || ('第 ' + (li + 1) + ' 层'))}</b>
          <input type="range" class="synth-gain" min="-60" max="6" step="0.5" value="${g}" data-layer="${li}">
          <span class="synth-gain-val" data-layer="${li}">${g <= -59.5 ? '静音' : (g > 0 ? '+' : '') + g + ' dB'}</span></div>
        <div class="synth-detail-names">${names || '（空）'}</div>
        ${layer.why ? `<div class="synth-detail-why">${escapeHtml(layer.why)}</div>` : ''}
      </div>`;
  }).join('');
  // 纹理/混合底噪没有「层」，但它的参数一样可以拖：低切/高切/呼吸/阵风/低频轰鸣
  const texRows = (c.kind === 'texture' || c.kind === 'hybrid') && c.texture ? (() => {
    const t = c.texture;
    const mk = (key, label, min, max, step, val, unit, scale) => {
      const v = Number(val) || 0;
      const shown = scale ? Math.round(v * 100) + '%' : (step < 1 ? v.toFixed(2) : Math.round(v)) + unit;
      return `<div class="synth-detail-layer" data-tex="${key}">
          <div class="synth-detail-row"><b>${label}</b>
            <input type="range" class="synth-tex" min="${min}" max="${max}" step="${step}" value="${v}" data-tex="${key}">
            <span class="synth-tex-val" data-tex="${key}">${shown}</span></div>
        </div>`;
    };
    return mk('lowCut', '低切', 20, 400, 5, t.lowCut, ' Hz', false)
      + mk('highCut', '高切', 800, 18000, 100, t.highCut, ' Hz', false)
      + mk('lfoRate', '呼吸', 0, 0.3, 0.01, t.lfoRate, '', false)
      + mk('gust', '阵风', 0, 1, 0.05, t.gust, '', true)
      + mk('rumble', '低频轰鸣', 0, 1, 0.05, t.rumble, '', true);
  })() : '';
  const texNote = (c.kind === 'hybrid' && c.plan && c.plan.length)
    ? `<p class="synth-detail-why">细节层：${escapeHtml(c.plan[0].label || '')}（当前 ${Number(c.extraGainDb) || 0} dB）</p>`
    : '';
  return `<div class="synth-detail" data-detail="${i}">
      <div class="synth-detail-head">${head}</div>${texNote}${texRows}${rows}
      <div class="synth-detail-foot">
        <button class="btn small ghost" data-act="save" data-idx="${i}">入库这条</button>
        <span class="synth-detail-why">拖比例会立刻按新比例重合成这一条，不用点按钮</span>
      </div>
    </div>`;
}

function renderSynthCandidates() {
  const box = $('synthResults');
  if (!box) return;
  if (!synth.candidates.length) { box.innerHTML = ''; return; }
  box.innerHTML = synth.candidates.map((c, i) => {
    const st = c.stats || {};
    const bits = [
      `${Math.round(Number(st.seconds) || c.seconds)} 秒`,
      st.mode === 'texture' ? '纹理' : `${Number(st.layers) || (c.plan || []).length} 层`,
      `${synthNum(st.lufs)} LUFS`,
      `峰值 ${synthNum(st.peakDb)} dBFS`,
      st.seamOk === false ? '循环点有台阶' : '循环点无缝'
    ];
    const detail = synth.detailIdx === i ? synthDetailHtml(c, i) : '';
    return `<div class="synth-cand-wrap">
      <div class="synth-cand${i === synth.active ? ' active' : ''}${synth.detailIdx === i ? ' expanded' : ''}"
           draggable="true" data-idx="${i}" title="点一下就在下方波形里试听；也可以直接拖进 DAW / 资源管理器">
        <div class="synth-cand-main">
          <b>${escapeHtml(c.baseName || ('候选 ' + (i + 1)))}</b>
          <span>${bits.join(' · ')}</span>
        </div>
        <div class="synth-cand-ops">
          <button class="btn small ghost" data-act="play" data-idx="${i}">试听</button>
          <button class="btn small ghost" data-act="detail" data-idx="${i}">${synth.detailIdx === i ? '收起' : '参数'}</button>
          <button class="btn small ghost" data-act="save" data-idx="${i}">入库</button>
        </div>
      </div>${detail}
    </div>`;
  }).join('');
  bindSynthGainSliders(box);
}

function selectSynthCandidate(idx) {
  const c = synth.candidates[idx];
  if (!c) return;
  synth.active = idx;
  // 兼容旧按钮：synthPlay / synthSave 认「当前选中」那条
  synth.result = { wav: c.wav, stats: c.stats, name: (c.baseName || 'bed') + '.wav', path: c.path };
  renderSynthCandidates();
  const btnPlay = $('synthPlay');
  const btnSave = $('synthSave');
  if (btnPlay) btnPlay.disabled = false;
  if (btnSave) btnSave.disabled = false;
}

/** 点「试听」/ 点整行：把这条挂到主播放器上（波形、选区、裁剪、拖出都能用） */
async function playSynthCandidate(idx) {
  const c = synth.candidates[idx];
  if (!c || !c.path) { toast('这条还没生成好'); return; }
  selectSynthCandidate(idx);
  const it = synthCandidateItem(c);
  if (!it) return;
  await selectItem(it, { play: true });
}

function closeSynthDetail() {
  synth.detailIdx = -1;
  renderSynthCandidates();
}

function openSynthDetail(idx) {
  if (!synth.candidates[idx]) return;
  if (synth.detailIdx === idx) {
    synth.detailIdx = -1;
    renderSynthCandidates();
    return;
  }
  synth.detailIdx = idx;
  selectSynthCandidate(idx);
  const el = document.querySelector(`.synth-detail[data-detail="${idx}"]`);
  if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
}

let synthGainTimer = 0;
function bindSynthGainSliders(root) {
  if (!root) return;
  root.querySelectorAll('.synth-gain').forEach((el) => {
    el.addEventListener('input', () => {
      const idx = synth.detailIdx;
      const c = synth.candidates[idx];
      if (!c) return;
      const li = Number(el.dataset.layer);
      const v = Number(el.value);
      const label = root.querySelector(`.synth-gain-val[data-layer="${li}"]`);
      if (label) label.textContent = v <= -59.5 ? '静音' : (v > 0 ? '+' : '') + v + ' dB';
      const layer = (c.plan || [])[li];
      if (layer) layer.gainDb = v;
      // 不用点「重做」：停手 220 ms 就按新比例重合成这一条
      clearTimeout(synthGainTimer);
      synthGainTimer = setTimeout(() => { applySynthDetailLive(idx).catch(() => {}); }, 220);
    });
  });
  root.querySelectorAll('.synth-tex').forEach((el) => {
    el.addEventListener('input', () => {
      const idx = synth.detailIdx;
      const c = synth.candidates[idx];
      if (!c || !c.texture) return;
      const key = el.dataset.tex;
      const v = Number(el.value);
      c.texture[key] = v;
      const label = root.querySelector(`.synth-tex-val[data-tex="${key}"]`);
      if (label) {
        const pct = (key === 'gust' || key === 'rumble');
        const hz = (key === 'lowCut' || key === 'highCut');
        label.textContent = pct ? Math.round(v * 100) + '%' : hz ? Math.round(v) + ' Hz' : (key === 'lfoRate' ? v.toFixed(2) : String(v));
      }
      clearTimeout(synthGainTimer);
      synthGainTimer = setTimeout(() => { applySynthDetailLive(idx).catch(() => {}); }, 260);
    });
  });
}

/** 按当前层比例重合成「这一条」（不改其它候选），并把正在播的那条无缝指到新文件 */
async function applySynthDetailLive(idx) {
  const c = synth.candidates[idx];
  if (!c) return null;
  if (synth.liveBusy) { synth.liveAgain = true; return null; }
  synth.liveBusy = true;
  const it = c._item;
  const wasLoaded = !!(it && state.currentPath === it.path);
  const pos = wasLoaded ? (player.currentTime || 0) : 0;
  const wasPlaying = wasLoaded && !player.paused;
  const skips = [];
  try {
    let out = null;
    if (c.kind === 'texture' || c.kind === 'hybrid') {
      let extras = [];
      if (c.kind === 'hybrid' && c.plan.length) {
        const decodedDetail = await decodePlanLayers(c.plan.slice(0, 1), skips);
        if (decodedDetail.length) {
          const detail = buildBed(decodedDetail, { ...synth.opts, seconds: c.seconds, layers: 1, targetLufs: null });
          extras = [{
            channels: detail.channels,
            gainDb: Math.max(-18, Math.min(0, Number(c.extraGainDb) || -8)),
            name: c.plan[0].label || '细节层'
          }];
        }
      }
      out = buildTexture(clampTexture({ ...c.texture, seconds: c.seconds, sampleRate: 48000, targetLufs: null }), extras);
    } else {
      const decoded = await decodePlanLayers(c.plan, skips);
      if (!decoded.length) throw new Error('素材解码失败');
      out = buildBed(decoded, {
        ...synth.opts,
        seconds: c.seconds,
        layers: c.plan.length,
        targetLufs: null,
        layerGains: c.plan.map((l) => l.gainDb)
      });
    }
    // 拖比例时不做响度归一：拉低哪层就真的小下去，拉到 -60 就真的没声
    if (Number.isFinite(Number(c.masterGainDb))) {
      const g = Math.pow(10, Number(c.masterGainDb) / 20);
      if (g !== 1) {
        out.channels = out.channels.map((ch) => {
          const copy = new Float32Array(ch.length);
          for (let i = 0; i < ch.length; i++) copy[i] = ch[i] * g;
          return copy;
        });
        let lv = measureLufsLite(out.channels, out.sampleRate);
        // 不归一意味着可能混音过载：超过 -0.3 dBFS 就整体压回去，宁可小一点也不削波
        if (Number.isFinite(lv.peakDb) && lv.peakDb > -0.3) {
          const fix = Math.pow(10, (-0.3 - lv.peakDb) / 20);
          out.channels = out.channels.map((ch) => {
            const copy = new Float32Array(ch.length);
            for (let i = 0; i < ch.length; i++) copy[i] = ch[i] * fix;
            return copy;
          });
          lv = measureLufsLite(out.channels, out.sampleRate);
        }
        out.stats = { ...(out.stats || {}), ...lv, gainDb: Number(c.masterGainDb) };
      }
    }
    c.stats = out.stats || {};
    c.wav = synthEncode(out);
    const staged = await sb.invoke('synth:stage', { buffer: c.wav, name: (c.baseName || 'bed') + '_' + Date.now().toString(36) });
    if (staged && staged.ok) c.path = staged.path;
    if (synth.active === idx) {
      synth.result = { wav: c.wav, stats: c.stats, name: (c.baseName || 'bed') + '.wav', path: c.path };
    }
    if (wasLoaded) {
      retargetSynthItem(it, c);
      try {
        player.setUrl(audioUrl(c.path));
        if (wasPlaying) await player.play();
        player.seek(Math.max(0, Math.min(pos, (Number(c.stats.seconds) || pos))));
      } catch { /* 播放器换不了文件就等下次点播 */ }
      updateWavePanel();
      updateTransport();
    }
    renderSynthCandidates();
    synthStatus(`已按新比例重合成：${synthNum(c.stats.lufs)} LUFS · 峰值 ${synthNum(c.stats.peakDb)} dBFS`, 'ok');
    return c;
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    synthStatus('重新合成失败：' + msg, 'err');
    return null;
  } finally {
    synth.liveBusy = false;
    if (synth.liveAgain) { synth.liveAgain = false; applySynthDetailLive(idx).catch(() => {}); }
  }
}

// 拖比例重合成后算一下响度，只用于状态行显示（不做归一）
function measureLufsLite(channels, sampleRate) {
  let sum = 0, n = 0, peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      n++;
    }
  }
  const rms = n ? Math.sqrt(sum / n) : 0;
  return {
    lufs: rms > 0 ? (-0.691 + 10 * Math.log10(rms * rms + 1e-12)) : -Infinity,
    peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity
  };
}

// 老名字保留（__sb 里还在用）
async function applySynthDetail(idx) {
  return applySynthDetailLive(idx);
}

/* ---------- 入库 ---------- */

async function synthSaveCandidate(idx) {
  const c = synth.candidates[idx];
  if (!c) { toast('先生成一条底噪'); return null; }
  synthStatus('保存中…', 'busy');
  try {
    const saved = await sb.invoke('synth:save', {
      from: c.path || '',
      buffer: c.path ? undefined : c.wav,
      name: c.baseName
    });
    if (!saved || !saved.ok) throw new Error((saved && saved.error) || '保存失败');
    c.savedPath = saved.path;
    synthStatus('入库中…', 'busy');
    const files = await sb.invoke('library:scan', [saved.path]);
    const added = await addFiles(files || [], { analyzeFirst: true });
    const name = String(saved.path).split(/[\\/]/).pop();
    toast('已入库：' + name);
    synthStatus(`已保存并入库：${saved.path}` + (added && added.added ? '' : '（清单里已有这条）'), 'ok');
    return saved;
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    synthStatus('保存失败：' + msg, 'err');
    toast(msg);
    return null;
  }
}

// ===========================================================================
// 云端音频生成（Stability / ElevenLabs / 自定义）
//
// 和 Agent 一样：密钥只存在主进程（safeStorage 加密），渲染层拿到的只有
// hasKey 和尾号。这里管三件事：多套配置的增删切换、查余额、点「云端生成」。
// ===========================================================================
const genState = { profiles: [], active: '', current: null, providers: [], busy: false, credits: null };

function genStatus(text, kind = '') {
  const el = $('genStatus');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'mono muted' + (kind ? ' ' + kind : '');
}

function fillGenFields(cur) {
  const set = (id, v) => { const el = $(id); if (el) el.value = v == null ? '' : String(v); };
  const keyEl = $('genKey');
  const pv = $('genProvider');
  if (!cur) {
    set('genName', '');
    set('genEndpoint', 'https://api.stability.ai');
    set('genModel', 'stable-audio-2');
    if (pv) pv.value = 'stability';
    if (keyEl) { keyEl.value = ''; keyEl.placeholder = '留空 = 不修改'; }
    genStatus('未配置');
    return;
  }
  set('genName', cur.name);
  set('genEndpoint', cur.endpoint);
  set('genModel', cur.model);
  if (pv) pv.value = cur.provider || 'stability';
  if (keyEl) {
    keyEl.value = '';
    keyEl.placeholder = cur.hasKey ? '已记住（尾号 ' + cur.keyTail + '），留空 = 不修改' : '填上服务商的 API Key';
  }
  genStatus(cur.hasKey ? '已记住：' + (cur.name || '') + '（尾号 ' + cur.keyTail + '）' : '还差密钥');
}

// Stable Audio 实测按秒计费：12 秒 44.1k 立体声 ≈ 18.8 credits（≈1.57/秒）
const GEN_CREDITS_PER_SEC = 1.57;

/* 生成类型：决定提示词尾部补哪些英文修饰词、默认时长与上限。
   点状动效 / 脚步这类要短、要干；长时长反而会生成一串重复。 */
const GEN_KINDS = {
  ambience: {
    label: '环境底噪',
    suffix: 'continuous ambience bed, seamless loop, steady level, no music, no speech',
    seconds: 30,
    max: 190
  },
  event: {
    label: '点状动效',
    suffix: 'single one-shot sound effect, dry, close perspective, no music, no reverb tail',
    seconds: 3,
    max: 30
  },
  foley: {
    label: '脚步 / 拟音',
    suffix: 'foley recording, natural, close-miked, small cloth movement, no music',
    seconds: 5,
    max: 30
  },
  ui: {
    label: '界面 / 提示音',
    suffix: 'short UI notification sound, clean, designed, no music, dry',
    seconds: 2,
    max: 15
  },
  custom: { label: '自定义', suffix: '', seconds: 10, max: 190 }
};

const HAS_CJK = /[\u3400-\u9fff\uff00-\uffef]/;

/** 按类型对齐时长与上限（类型决定「这种声音该多长」）。 */
function genKindSetup(keepSeconds) {
  const sel = $('genKind');
  const kind = (sel && sel.value) || 'ambience';
  const conf = GEN_KINDS[kind] || GEN_KINDS.ambience;
  const secEl = $('genSeconds');
  if (secEl) {
    secEl.max = String(conf.max);
    if (!keepSeconds) secEl.value = String(conf.seconds);
    const v = Math.max(1, Math.min(conf.max, Number(secEl.value) || conf.seconds));
    secEl.value = String(v);
  }
  const promptEl = $('genPrompt');
  if (promptEl) {
    promptEl.placeholder = kind === 'ambience'
      ? '例如：night park ambience, distant crickets, light breeze in trees, no music'
      : kind === 'event'
        ? '例如：a heavy wooden door slamming shut, close, dry'
        : kind === 'foley'
          ? '例如：leather shoes on wet concrete, slow walk'
          : kind === 'ui'
            ? '例如：soft confirmation blip for a desktop app'
            : '例如：中文也行，打开开关会自动翻成英文';
  }
}

/** 把中文需求翻成英文（用当前接入的语义检索模型）。失败就原样返回。 */
async function genTranslateToEnglish(text) {
  const raw = String(text || '').trim();
  if (!raw || !HAS_CJK.test(raw)) return raw;
  const sys =
    '把用户的中文描述改写成一条给音效生成模型用的英文提示词：' +
    '只输出英文，逗号分隔的声音要素，8-25 个词，不要解释、不要引号、不要中文。' +
    '保留材质、动作、远近、空间与情绪；不要添加用户没说的乐器或音乐。' +
    '另外避开可能触发内容审核的暴力措辞：不用 slam/smash/explode/scream/shoot 一类词，'
    '改用 shut/close/land/drop/voice 这类中性说法。';
  // deepseek-flash 会先花 token 思考，max_tokens 给小了会「思考吃光预算、正文为空」→ 重试一次
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const r = await sb.invoke('agent:chat', {
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: raw }
        ],
        temperature: 0.2,
        maxTokens: 900
      });
      if (r && r.ok) {
        let out = String(r.text || r.content || '').trim().split(/\r?\n/)[0].trim();
        out = out.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ');
        if (out && !HAS_CJK.test(out)) return out;
      }
    } catch {
      /* 再试一次 */
    }
  }
  return raw;
}

function fmtSpan(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return h + ' 小时 ' + m + ' 分';
  if (m) return m + ' 分 ' + r + ' 秒';
  return r + ' 秒';
}

/** 把「余额 / 还能生成多长 / 本次大约花多少」写进生成面板那一行。 */
function renderGenBalance() {
  const el = $('genBalance');
  if (!el) return;
  const secEl = $('genSeconds');
  const cntEl = $('genCount');
  const seconds = Math.max(1, Math.min(190, Number(secEl && secEl.value) || 30));
  const count = Math.max(1, Math.min(4, Number(cntEl && cntEl.value) || 1));
  const cost = Math.round(seconds * count * GEN_CREDITS_PER_SEC);
  const tail = '本次约 ' + cost + ' credits（' + seconds + ' 秒 × ' + count + ' 条）';
  if (genState.credits == null) {
    el.textContent = '余额 — · ' + tail;
    el.className = 'ai-status mono';
    el.title = '点右侧「查余额」可以查当前配置的剩余额度';
    return;
  }
  const creditsShown = Math.round(genState.credits * 10) / 10;
  const canSec = Math.floor(genState.credits / GEN_CREDITS_PER_SEC);
  const short = genState.credits < cost;
  el.textContent =
    '余额 ' + creditsShown + ' credits ≈ 还能生成 ' + fmtSpan(canSec) + ' · ' + tail +
    (short ? ' · 余额可能不够这次' : '');
  el.className = 'ai-status mono' + (short ? ' err' : '');
  el.title = short
    ? '余额可能不够本次生成，先去账户充值或把时长/条数调小'
    : '按 1.57 credits/秒估算（Stability Stable Audio）';
}

/** 查一次余额（失败只写「—」，不打扰）。 */
async function refreshGenBalance() {
  try {
    const r = await sb.invoke('gen:balance');
    if (r && r.ok && typeof r.credits === 'number') genState.credits = r.credits;
    else genState.credits = null;
  } catch {
    genState.credits = null;
  }
  renderGenBalance();
}

/** AI 工具面板里那排「模型」下拉：只列音频生成配置。 */
function renderGenModelBar() {
  const sel = $('genModelSelect');
  if (!sel) return;
  sel.textContent = '';
  const list = genState.profiles || [];
  if (!list.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '未配置（点「管理…」填接口和密钥）';
    sel.appendChild(o);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const p of list) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name + (p.hasKey ? '（尾号 ' + p.keyTail + '）' : '（未填密钥）');
    sel.appendChild(o);
  }
  sel.value = genState.active || (list[0] && list[0].id) || '';
}

function renderGenProfiles() {
  const sel = $('genProfile');
  if (!sel) { renderGenModelBar(); return; }
  sel.innerHTML = '';
  if (!genState.profiles.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '还没有配置（填好下面几项点「保存」）';
    sel.appendChild(o);
  } else {
    for (const p of genState.profiles) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name + (p.hasKey ? '（尾号 ' + p.keyTail + '）' : '（未填密钥）');
      sel.appendChild(o);
    }
    if (genState.active) sel.value = genState.active;
  }
  fillGenFields(genState.current);
  renderGenModelBar();
}

async function loadGenConfig() {
  let r = null;
  try { r = await sb.invoke('gen:profiles'); } catch { r = null; }
  if (r && !r.error) {
    genState.providers = r.providers || [];
    genState.profiles = r.profiles || [];
    genState.active = r.active || '';
    genState.current = r.current || null;
  }
  renderGenProfiles();
}

async function saveGenProfile(asNew = false) {
  const payload = {
    id: asNew ? '' : (genState.current && genState.current.id) || '',
    name: ($('genName') && $('genName').value.trim()) || '',
    provider: ($('genProvider') && $('genProvider').value) || 'stability',
    endpoint: ($('genEndpoint') && $('genEndpoint').value.trim()) || '',
    model: ($('genModel') && $('genModel').value.trim()) || ''
  };
  const keyEl = $('genKey');
  const key = keyEl && keyEl.value.trim();
  if (key) payload.apiKey = key;
  genStatus('保存中…', 'busy');
  try {
    const r = await sb.invoke('gen:profile-save', payload);
    if (!r || !r.ok) throw new Error((r && r.error) || '保存失败');
    genState.profiles = r.profiles || [];
    genState.active = r.active || '';
    genState.current = r.current || null;
    if (keyEl) keyEl.value = '';
    renderGenProfiles();
    toast('音频生成配置已保存');
  } catch (err) {
    genStatus('保存失败：' + String(err && err.message ? err.message : err), 'err');
  }
}

async function deleteGenProfile() {
  if (!genState.current || !genState.current.id) { toast('当前没有可删除的配置'); return; }
  if (!confirm('删除配置「' + (genState.current.name || '') + '」？密钥也会一起删掉。')) return;
  try {
    const r = await sb.invoke('gen:profile-delete', { id: genState.current.id });
    if (!r || !r.ok) throw new Error((r && r.error) || '删除失败');
    genState.profiles = r.profiles || [];
    genState.active = r.active || '';
    genState.current = r.current || null;
    renderGenProfiles();
  } catch (err) {
    genStatus('删除失败：' + String(err && err.message ? err.message : err), 'err');
  }
}

async function clearGenKey() {
  if (!genState.current) { toast('还没有配置'); return; }
  try {
    const r = await sb.invoke('gen:profile-save', { id: genState.current.id, apiKey: null });
    if (!r || !r.ok) throw new Error((r && r.error) || '删除失败');
    genState.profiles = r.profiles || [];
    genState.current = r.current || null;
    renderGenProfiles();
    toast('已删除密钥');
  } catch (err) {
    genStatus('删除密钥失败：' + String(err && err.message ? err.message : err), 'err');
  }
}

async function checkGenBalance() {
  genStatus('查询中…', 'busy');
  try {
    const r = await sb.invoke('gen:balance');
    if (!r || !r.ok) throw new Error((r && r.error) || '查询失败');
    const c = r.credits;
    // 实测 Stable Audio 2 按秒计费：12 秒 44.1k 立体声约 18.8 credits（≈1.57/秒）
    if (typeof c === 'number') {
      const secs = Math.floor(c / 1.57);
      genStatus('余额 ' + c + ' credits ≈ ' + secs + ' 秒音频（60 秒的约 ' + Math.floor(secs / 60) + ' 条）', 'ok');
    } else {
      genStatus('余额：' + (r.raw || '未知'), 'ok');
    }
  } catch (err) {
    genStatus('查询失败：' + String(err && err.message ? err.message : err), 'err');
  }
}

/** 设置 → 音频生成：按当前需求 + 时长 + 条数，调云端模型生成并入库。 */
async function genRunCloud() {
  if (genState.busy) return null;
  const promptEl = $('genPrompt');
  const prompt = (promptEl && promptEl.value.trim()) || '';
  const setRun = (text, kind) => {
    const el = $('genRunStatus');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'mono muted' + (kind ? ' ' + kind : '');
  };
  if (!prompt) { setRun('先写一句你要的声音', 'err'); toast('先写一句你要的声音'); return null; }
  const kindSel = $('genKind');
  const kind = (kindSel && kindSel.value) || 'ambience';
  const kindConf = GEN_KINDS[kind] || GEN_KINDS.ambience;
  const trEl = $('genTranslated');
  let finalPrompt = prompt;
  const cjk = HAS_CJK.test(prompt);
  const trOn = !$('genTranslate') || $('genTranslate').checked;
  if (cjk && trOn) {
    setRun('先把中文需求翻成英文…', 'busy');
    const en = await genTranslateToEnglish(prompt);
    finalPrompt = en;
    if (trEl) {
      trEl.textContent = '发送给音效模型的英文：' + en;
      trEl.classList.toggle('hidden', false);
    }
  } else if (trEl) {
    trEl.textContent = '';
    trEl.classList.add('hidden');
  }
  // 「稀疏 / 偶尔 / 远处」这类需求，要额外强调留白，否则模型会给一条不间断的厚噪声
  const SPARSE_RE = /sparse|occasional|distant|quiet|calm|light traffic|empty|\u7a00\u758f|\u5076\u5c14|\u8fdc\u5904|\u5b89\u9759|\u7a7a\u65f7/;
  let kindSuffix = kindConf.suffix || '';
  if (kind === 'ambience' && SPARSE_RE.test(finalPrompt)) {
    kindSuffix += (kindSuffix ? ', ' : '') + 'sparse, low level, distant, wide spaces of near silence between events';
  }
  if (kindSuffix) finalPrompt = finalPrompt.replace(/[,\s]+$/, '') + ', ' + kindSuffix;
  const secEl = $('genSeconds');
  const seconds = Math.max(1, Math.min(kindConf.max, Number(secEl && secEl.value) || kindConf.seconds));
  const cntEl = $('genCount');
  const count = Math.max(1, Math.min(4, Number(cntEl && cntEl.value) || 1));
  genState.busy = true;
  const btn = $('btnGenRun');
  if (btn) btn.disabled = true;
  const done = [];
  let firstItem = null;
  const batchCat = createAiBatchCategory(kindConf.label);
  const addedToBatch = [];
  try {
    for (let i = 0; i < count; i += 1) {
      setRun('第 ' + (i + 1) + '/' + count + ' 条生成中…（' + seconds + ' 秒，可能要十几秒）', 'busy');
      const r = await sb.invoke('gen:generate', { prompt: finalPrompt, seconds });
      if (!r || !r.ok) throw new Error((r && r.error) || '生成失败');
      setRun('第 ' + (i + 1) + '/' + count + ' 条已生成（' + Math.round(r.ms / 1000) + 's，'
        + Math.round(r.bytes / 1024) + ' KB），入库中…', 'busy');
      const files = await sb.invoke('library:scan', [r.path]);
      await addFiles(files || [], { analyzeFirst: true });
      for (const one of files || []) {
        const it = state.byPath.get(String(one.path)) || state.items.find((x) => x.path === one.path);
        if (it && batchCat) {
          it.categoryId = batchCat.id;
          addedToBatch.push(it);
        }
      }
      if (!firstItem) {
        const want = String(r.path);
        const base = want.split(/[\\/]/).pop();
        firstItem =
          state.byPath.get(want) ||
          state.items.find((x) => x.path === want || x.name === base) ||
          null;
      }
      done.push(String(r.path).split(/[\\/]/).pop());
    }
    await refreshGenBalance();
    scheduleSave();
    renderSidebar();
    renderGenResults(addedToBatch);
    if (firstItem) await selectItem(firstItem, { play: true });
    setRun(
      '已入库 ' + done.length + ' 条（' + kindConf.label + (finalPrompt !== prompt ? '，已翻成英文' : '')
        + (firstItem ? '；正在试听第 1 条，可直接修剪 / 加效果 / 拖出' : '') + '）：' + done.join('、'),
      'ok'
    );
    toast('云端生成并入库 ' + done.length + ' 条');
    return done;
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    setRun('生成失败：' + msg + (done.length ? '（已入库 ' + done.length + ' 条）' : ''), 'err');
    toast(msg);
    return done.length ? done : null;
  } finally {
    genState.busy = false;
    if (btn) btn.disabled = false;
  }
}

/* ---- 检索结果 → 生成：库里没有的那几条，直接让音效模型做出来 ---- */

/** 生成结果列表：每一条都可以点一下试听，也可以直接拖进 DAW。 */
function renderGenResults(items) {
  const box = $('genResults');
  if (!box) return;
  box.textContent = '';
  const list = (items || []).filter(Boolean);
  if (!list.length) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  for (const it of list) {
    const row = document.createElement('div');
    row.className = 'gen-row';
    row.dataset.path = it.path;
    row.draggable = true;
    row.title = it.path + '\n点一下试听；直接拖到 DAW 就是这条';

    const name = document.createElement('div');
    name.className = 'gen-row-name';
    name.textContent = it.name;

    const meta = document.createElement('div');
    meta.className = 'gen-row-meta';
    const m = it.meta || {};
    const bits = [];
    if (m.duration) bits.push(fmtTC(m.duration));
    if (m.sampleRate) bits.push(Math.round(m.sampleRate / 1000) + 'k');
    if (m.channels) bits.push(m.channels + ' ch');
    meta.textContent = bits.join(' \u00b7 ');

    row.appendChild(name);
    row.appendChild(meta);
    row.addEventListener('click', () => { selectItem(it, { play: true }); });
    row.addEventListener('dragstart', async (ev) => {
      ev.preventDefault();
      try {
        await sb.invoke('drag:start', { files: [it.path] });
      } catch (err) {
        toast('拖出失败：' + String(err && err.message ? err.message : err));
      }
    });
    box.appendChild(row);
  }
}

/** 从条目名 + 描述里拼一条英文提示词（去掉库编号、下划线、扩展名）。 */
function genPromptFromItem(it) {
  let base = String(it.name || '').replace(/\.[a-z0-9]+$/i, '');
  base = base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  base = base.replace(/^[A-Za-z]{1,4}\d{0,4}\s+/, '').replace(/^[A-Za-z]{1,4}\s+/, '');
  base = base.split(' ').filter((w) => !/^(loopcgzyw|tchq|com|wav)$/i.test(w)).join(' ');
  const desc = String(it.desc || '').trim();
  return (base + (desc ? ', ' + desc : '')).trim();
}

/** 这一轮检索里「库里没有」的结果（最多 4 条，按相关度）。 */
function aiMissingCandidates(limit = 4) {
  const rows = state.ai.results || [];
  const out = [];
  for (const r of rows) {
    const it = r && r.item;
    if (!it) continue;
    if (!it.missing) continue;
    if (out.some((x) => x.path === it.path)) continue;
    out.push(it);
    if (out.length >= limit) break;
  }
  return out;
}

async function genFromSearchResults() {
  const picks = aiMissingCandidates(4);
  if (!picks.length) {
    aiStatus('这一轮结果里没有「库里缺失」的条目，没什么要补的', 'warn');
    toast('这轮结果库里都有');
    return;
  }
  const seconds = 8;
  const cost = Math.round(picks.length * seconds * GEN_CREDITS_PER_SEC);
  showBatchDialog({
    title: '把检索结果里缺的生成出来',
    hint: '用云端音效模型逐条生成，生成完自动入库并归到「AI 音效库 → 本次批次」里。'
      + '约 ' + cost + ' credits（' + picks.length + ' 条 × ' + seconds + ' 秒）。',
    lines: picks.map((it, i) => (i + 1) + '. ' + it.name + (it.desc ? ' — ' + it.desc.slice(0, 40) : '')),
    okText: '生成这 ' + picks.length + ' 条',
    onOk: async () => {
      const batchCat = createAiBatchCategory('检索补录');
      const done = [];
      for (let i = 0; i < picks.length; i += 1) {
        const it = picks[i];
        aiStatus('生成第 ' + (i + 1) + '/' + picks.length + ' 条…（' + seconds + ' 秒）', 'busy');
        let prompt = genPromptFromItem(it);
        if (HAS_CJK.test(prompt)) prompt = await genTranslateToEnglish(prompt);
        const r = await sb.invoke('gen:generate', { prompt, seconds });
        if (!r || !r.ok) {
          aiStatus('第 ' + (i + 1) + ' 条失败：' + ((r && r.error) || '未知错误'), 'err');
          continue;
        }
        const files = await sb.invoke('library:scan', [r.path]);
        await addFiles(files || [], { analyzeFirst: true });
        for (const one of files || []) {
          const got = state.byPath.get(String(one.path)) || state.items.find((x) => x.path === one.path);
          if (got) got.categoryId = batchCat.id;
        }
        done.push(String(r.path).split(/[\\/]/).pop());
      }
      scheduleSave();
      renderSidebar();
      refreshGenBalance();
      aiStatus(done.length
        ? '已生成并入库 ' + done.length + ' 条，归到「AI 音效库 → ' + batchCat.name + '」'
        : '一条都没生成成功，看看上面的错误', done.length ? 'ok' : 'err');
      toast(done.length ? 'AI 音效库新增 ' + done.length + ' 条' : '生成失败');
    }
  });
}

async function synthSaveAndImport() {
  if (synth.busy) return null;
  const idx = synth.active >= 0 ? synth.active : 0;
  if (!synth.candidates[idx]) { toast('先生成一条底噪'); return null; }
  synth.busy = true;
  const btn = $('synthSave');
  if (btn) btn.disabled = true;
  try {
    return await synthSaveCandidate(idx);
  } finally {
    synth.busy = false;
    if (btn) btn.disabled = !synth.result;
  }
}

// ===========================================================================
// 设置里的 Agent 配置 / 本机插件清单
// ===========================================================================
function setAgentStatus(text) {
  const el = $('agentStatus');
  if (el) el.textContent = text || '';
}

// 接口地址 / 模型 / 密钥都是「填一次就记住」：输入完自动存进 data\agent.json，
// 下次打开设置已经填好了。密钥只回尾号，输入框永远是空的（留空 = 不改）。
let agentSaveTimer = 0;

function agentKeyHint(cfg) {
  const el = $('agentKey');
  if (!el) return;
  el.placeholder = cfg && cfg.hasKey
    ? '已记住（尾号 ' + (cfg.keyTail || '****') + '），留空 = 不修改'
    : '留空 = 不修改';
}

async function loadAgentConfig() {
  let cfg = null;
  try { cfg = await sb.invoke('agent:config-load'); } catch { return; }
  if (!cfg) return;
  const url = $('agentBaseUrl');
  if (url) url.value = cfg.baseUrl || '';
  const model = $('agentModel');
  if (model) model.value = cfg.model || '';
  const keyEl = $('agentKey');
  if (keyEl) keyEl.value = '';
  agentKeyHint(cfg);
  state.ai.agentOk = !!(cfg.hasKey && cfg.baseUrl && cfg.model);
  if (cfg.hasKey) {
    setAgentStatus('已记住：' +
      (cfg.baseUrl ? '接口 ' + cfg.baseUrl : '接口未填') +
      (cfg.model ? '，模型 ' + cfg.model : '，模型未填') +
      '，密钥尾号 ' + (cfg.keyTail || '****') + '。改完自动保存，不用再点保存。' +
      (cfg.hasPlainKey ? '（这台机器没法用系统加密，密钥在 data\\agent.json 里是明文）' : ''));
  } else if (cfg.baseUrl || cfg.model) {
    setAgentStatus('已记住接口和模型，还差密钥');
  } else {
    setAgentStatus('未配置');
  }
  loadAgentProfiles().catch(() => {});
  return cfg;
}

/* --------------------------------------------------------------------------
 * 多套 AI 配置：下拉切换 / 另存 / 删除
 * 主进程把「当前生效」那套写进 agent.json，所以切换后重新读一次表单即可。
 * ------------------------------------------------------------------------ */

async function loadAgentProfiles() {
  let r = null;
  try { r = await sb.invoke('agent:profiles'); } catch { return; }
  if (!r) return;
  state.agentProfiles = {
    active: String(r.active || ''),
    profiles: Array.isArray(r.profiles) ? r.profiles : []
  };
  renderAgentProfiles();
  renderAiModelBar();
}

function renderAgentProfiles() {
  const sel = $('agentProfile');
  if (!sel) return;
  const { active, profiles } = state.agentProfiles;
  const opts = profiles.map((p) => {
    const tail = p.hasKey && p.keyTail ? ' · 尾号 ' + p.keyTail : ' · 无密钥';
    return `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || p.model || '未命名')}${escapeHtml(tail)}</option>`;
  });
  if (!profiles.length) opts.push('<option value="">（还没有保存过配置）</option>');
  sel.innerHTML = opts.join('');
  sel.value = active || (profiles[0] ? profiles[0].id : '');
  const hint = $('agentProfileHint');
  if (hint) {
    hint.textContent = profiles.length
      ? `共 ${profiles.length} 套配置；换厂家或换号时切一下，接口、模型、密钥会一起换。`
      : '每套配置各自记住接口地址、模型和密钥；换厂家（DeepSeek / OpenAI / 本地 Ollama）时切一下就行。';
  }
}

async function activateAgentProfile(id) {
  if (!id) return null;
  let r = null;
  try { r = await sb.invoke('agent:profile-activate', { id }); } catch (err) {
    setAgentStatus('切换失败：' + (err && err.message ? err.message : err));
    return null;
  }
  if (!r || !r.ok) {
    setAgentStatus('切换失败：' + ((r && r.error) || '未知错误'));
    return null;
  }
  await loadAgentConfig();
  toast('已切换到：' + ((r.profiles && r.profiles.profiles.find((p) => p.id === id) || {}).name || '这套配置'));
  return r;
}

async function saveAgentProfileAsNew() {
  const nameEl = $('agentProfileName');
  const name = nameEl ? nameEl.value.trim() : '';
  const baseUrl = ($('agentBaseUrl') && $('agentBaseUrl').value.trim()) || '';
  const model = ($('agentModel') && $('agentModel').value.trim()) || '';
  if (!baseUrl && !model) { toast('先把接口地址或模型填上'); return null; }
  const keyEl = $('agentKey');
  const apiKey = keyEl ? keyEl.value.trim() : '';
  let r = null;
  try {
    r = await sb.invoke('agent:profile-save', {
      name: name || (model || '未命名配置'),
      baseUrl,
      model,
      temperature: 0.25,
      ...(apiKey ? { apiKey } : {})
    });
  } catch (err) {
    setAgentStatus('保存配置失败：' + (err && err.message ? err.message : err));
    return null;
  }
  if (!r || !r.ok) {
    setAgentStatus('保存配置失败：' + ((r && r.error) || '未知错误'));
    return null;
  }
  if (keyEl) keyEl.value = '';
  if (nameEl) nameEl.value = '';
  await loadAgentConfig();
  toast('已存成一套新配置，可以随时在这里切回来');
  return r;
}

async function deleteAgentProfile() {
  const id = state.agentProfiles.active || ($('agentProfile') && $('agentProfile').value);
  if (!id) { toast('没有可删的配置'); return null; }
  const p = state.agentProfiles.profiles.find((x) => x.id === id);
  const name = p ? (p.name || p.model || '这套配置') : '这套配置';
  const ok = await showBatchDialog({
    title: '删除一套 AI 配置',
    hint: `会从列表里删掉「${name}」，包括它自己保存的那份密钥。别的配置不受影响。`,
    lines: [],
    okText: '删除'
  });
  if (!ok) return null;
  let r = null;
  try { r = await sb.invoke('agent:profile-delete', { id }); } catch (err) {
    setAgentStatus('删除失败：' + (err && err.message ? err.message : err));
    return null;
  }
  if (!r || !r.ok) {
    setAgentStatus('删除失败：' + ((r && r.error) || '未知错误'));
    return null;
  }
  await loadAgentConfig();
  toast('已删掉：' + name);
  return r;
}

async function saveAgentConfig(opts = {}) {
  const silent = !!opts.silent;
  const payload = {
    baseUrl: ($('agentBaseUrl') && $('agentBaseUrl').value.trim()) || '',
    model: ($('agentModel') && $('agentModel').value.trim()) || '',
    temperature: 0.25
  };
  const keyEl = $('agentKey');
  const key = keyEl ? keyEl.value.trim() : '';
  if (key) payload.apiKey = key;

  let r = null;
  try { r = await sb.invoke('agent:config-save', payload); } catch (err) {
    setAgentStatus('保存失败：' + (err && err.message ? err.message : err));
    return null;
  }
  if (r && r.ok) {
    if (key && keyEl) keyEl.value = '';
    agentKeyHint(r);
    state.ai.agentOk = !!(r.hasKey && r.baseUrl && r.model);
    if (silent) {
      setAgentStatus(r.hasKey
        ? '已自动记住（密钥尾号 ' + (r.keyTail || '****') + '）'
        : '已自动记住接口和模型，还差密钥');
    } else {
      setAgentStatus(r.hasKey
        ? '已保存（密钥尾号 ' + (r.keyTail || '****') + '，不会显示明文）'
        : '已保存，但还没有密钥');
      toast('Agent 配置已保存');
    }
  } else {
    setAgentStatus('保存失败：' + (r && r.error ? r.error : '未知错误'));
  }
  return r;
}

// 输入停手 700ms 就存一次；密钥框等失焦 / 回车再存，免得存进半截 key
function queueAgentAutoSave(delay = 700) {
  clearTimeout(agentSaveTimer);
  agentSaveTimer = setTimeout(() => { saveAgentConfig({ silent: true }).catch(() => {}); }, delay);
}

async function clearAgentKey() {
  const r = await sb.invoke('agent:config-save', { apiKey: null });
  if (r && r.ok) {
    state.ai.agentOk = false;
    const keyEl = $('agentKey');
    if (keyEl) keyEl.value = '';
    agentKeyHint(null);
    setAgentStatus('密钥已删除。接口地址和模型还留着。');
    toast('已删除 Agent 密钥');
  } else {
    setAgentStatus('删除失败：' + (r && r.error ? r.error : '未知错误'));
  }
}

async function testAgent() {
  setAgentStatus('正在请求接口…');
  // 先把界面上刚填的存下来，这样「填完直接测试」也能用
  await saveAgentConfig({ silent: true });
  let r = null;
  try {
    r = await sb.invoke('agent:test');
  } catch (err) {
    setAgentStatus('请求失败：' + (err && err.message ? err.message : err));
    return null;
  }
  if (r && r.ok) {
    state.ai.agentOk = true;
    setAgentStatus(`接口可用（${r.ms} ms），模型回：${r.reply}`);
    toast('Agent 接口可用');
  } else {
    setAgentStatus('接口不可用：' + (r && r.error ? String(r.error).slice(0, 300) : '未知错误'));
  }
  return r;
}

async function scanPluginsNow() {
  const st = $('pluginStatus');
  const list = $('pluginList');
  const btn = $('btnScanPlugins');
  if (st) st.textContent = '正在扫描本机插件目录…';
  if (btn) btn.disabled = true;
  try {
    const r = await sb.invoke('plugins:scan');
    if (!r || !r.ok) {
      if (st) st.textContent = '扫描失败：' + (r && r.error ? r.error : '未知错误');
      return null;
    }
    if (list) {
      list.textContent = '';
      const shown = r.plugins.slice(0, 200);
      for (const p of shown) {
        const row = document.createElement('div');
        row.className = 'plugin-row';
        row.title = p.path;
        const fmt = document.createElement('span');
        fmt.className = 'plugin-fmt';
        fmt.textContent = p.format;
        const nm = document.createElement('span');
        nm.className = 'plugin-name';
        nm.textContent = p.name;
        row.appendChild(fmt);
        row.appendChild(nm);
        list.appendChild(row);
      }
      if (r.plugins.length > shown.length) {
        const more = document.createElement('div');
        more.className = 'plugin-row';
        more.textContent = `……还有 ${r.plugins.length - shown.length} 个没列出来`;
        list.appendChild(more);
      }
    }
    const byFmt = new Map();
    for (const p of r.plugins) byFmt.set(p.format, (byFmt.get(p.format) || 0) + 1);
    const parts = [...byFmt.entries()].map(([f, n]) => `${f} ${n}`);
    if (st) {
      st.textContent = r.plugins.length
        ? `找到 ${r.plugins.length} 个：${parts.join('，')}${r.truncated ? '（超过上限，只列了前 3000 个）' : ''}。SoundBin 自己不加载它们，只是让你知道这台机器上有什么。`
        : '这些标准目录里没找到插件。有些软件把插件装在自定义路径，那就扫不到。';
    }
    return r;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ===========================================================================
// 贴边隐藏 + 三个新面板的事件绑定
// ===========================================================================
// ---------------------------------------------------------------------------
// 贴边：拖内侧那条边改宽度 / 拖最上面把窗口整个挪走（挪走就解除贴边）
// ---------------------------------------------------------------------------
function setupDockResize() {
  const grip = $('dockGrip');
  if (!grip) return;
  let rs = null;
  // 每 55 ms 才真的动一次窗口。紧贴着鼠标每帧 setBounds 时，渲染进程来不及重排，
  // 新露出来那块区域会黑着——这正是「拖宽时瞬间黑屏」的来源。
  const RESIZE_INTERVAL = 55;
  let pendingTimer = 0;
  let lastApplyAt = 0;
  let applied = 0;

  const applyNow = () => {
    pendingTimer = 0;
    if (!rs) return;
    if (Math.abs(rs.w - applied) < 3) return;
    applied = rs.w;
    lastApplyAt = performance.now();
    state.dock.width = rs.w;
    syncDockTabs();
    sb.invoke('dock:resize', { width: rs.w }).catch(() => {});
  };

  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !state.dock.enabled || state.dock.hidden) return;
    e.preventDefault();
    rs = { id: e.pointerId, sx: e.screenX, w0: window.innerWidth, w: window.innerWidth };
    applied = window.innerWidth;
    lastApplyAt = 0;
    try { grip.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    grip.classList.add('dragging');
    document.body.classList.add('dock-resizing');
    sb.invoke('dock:resize-start').catch(() => {});
  });

  grip.addEventListener('pointermove', (e) => {
    if (!rs || e.pointerId !== rs.id) return;
    // 右边贴边时往左拖是加宽，左边贴边时反过来
    const dx = state.dock.edge === 'right' ? (rs.sx - e.screenX) : (e.screenX - rs.sx);
    rs.w = Math.max(320, Math.round(rs.w0 + dx));
    // 数字和提示每帧都跟上，窗口本身按节奏动
    state.dock.width = rs.w;
    syncDockTabs();
    if (pendingTimer) return;
    const wait = Math.max(0, RESIZE_INTERVAL - (performance.now() - lastApplyAt));
    pendingTimer = setTimeout(applyNow, wait);
  });

  const finish = async () => {
    if (!rs) return;
    const w = rs.w;
    const id = rs.id;
    rs = null;
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = 0; }
    try { grip.releasePointerCapture(id); } catch { /* ignore */ }
    grip.classList.remove('dragging');
    document.body.classList.remove('dock-resizing');
    let res = null;
    try { res = await sb.invoke('dock:resize-end', { width: w }); } catch { /* ignore */ }
    if (res && res.ok && res.width) state.dock.width = res.width;
    syncDockUI();
    scheduleSave();
  };
  grip.addEventListener('pointerup', finish);
  grip.addEventListener('pointercancel', finish);
}

function setupDockDrag() {
  let drag = null;

  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !state.dock.enabled || state.dock.hidden) return;
    const t = e.target;
    if (!t || !t.closest) return;
    // 只有最上面那两条（标签栏 / 标题栏的空白处）能拖，按钮和输入框照常点
    const onTabs = !!t.closest('#dockTabs');
    const onBar = !!t.closest('.titlebar');
    if (!onTabs && !onBar) return;
    if (t.closest('button, input, textarea, .search-wrap, .brand, .titlebar-actions, .dock-tabs-hint')) return;
    e.preventDefault();
    drag = {
      pid: e.pointerId,
      sx: e.screenX,
      sy: e.screenY,
      ox: e.screenX - e.clientX,   // 窗口左上角在屏幕上的位置（DIP）
      oy: e.screenY - e.clientY,
      moved: false,
      detached: false,
      busy: false
    };
    document.body.classList.add('dock-dragging');
    try { document.body.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }, true);

  document.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    const dx = e.screenX - drag.sx;
    const dy = e.screenY - drag.sy;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    drag.moved = true;
    // 解除贴边那一下要等主进程把窗口尺寸/位置都改完，期间不能插 setPosition，
    // 否则窗口一边被系统改尺寸一边被我们挪位置，DWM 偶发黑屏。
    if (drag.busy) return;
    const x = Math.round(drag.ox + dx);
    const y = Math.round(drag.oy + dy);
    if (!drag.detached) {
      drag.detached = true;
      drag.busy = true;
      const px = e.screenX;
      const py = e.screenY;
      sb.invoke('window:detach', { x, y })
        .catch(() => null)
        .then((res) => {
          if (!drag) return;
          if (!res || res.ok === false) { drag.detached = false; }
          // 窗口大小变了，抓取参考点改成「当前指针 + 当前窗口左上角」
          drag.sx = px;
          drag.sy = py;
          drag.ox = window.screenX;
          drag.oy = window.screenY;
          drag.busy = false;
        });
      return;
    }
    sb.invoke('window:move-to', { x, y }).catch(() => {});
  }, true);

  const end = () => {
    if (!drag) return;
    const didDetach = drag.moved && drag.detached;
    const pid = drag.pid;
    drag = null;
    document.body.classList.remove('dock-dragging');
    try { document.body.releasePointerCapture(pid); } catch { /* ignore */ }
    if (didDetach) toast('已解除贴边隐藏，窗口恢复成普通大小');
  };
  document.addEventListener('pointerup', end, true);
  document.addEventListener('pointercancel', end, true);
  // 窗口被系统挪动 / 失去焦点时收不到 pointerup，兜一下，别把 dragging 状态留在身上
  window.addEventListener('blur', end);
}

function isNarrowUI() {
  return window.innerWidth <= 820;
}

function sideLimits() {
  return isNarrowUI() ? { min: 96, max: 200 } : { min: 150, max: SIDE_MAX };
}

/** 窄面板里用单独一份宽度，不要拿普通窗口的 228 去挤列表 */
function currentSideW() {
  return isNarrowUI() ? (state.sideWNarrow || 132) : (state.sideW || 228);
}

function applySideWidth() {
  const lim = sideLimits();
  const w = Math.max(lim.min, Math.min(lim.max, Math.round(currentSideW())));
  document.documentElement.style.setProperty('--side-w', w + 'px');
  return w;
}

function setSideW(w) {
  if (isNarrowUI()) state.sideWNarrow = Math.round(w);
  else state.sideW = Math.round(w);
}

function setupSideSplitter() {
  const grip = $('sideSplit');
  if (!grip) return;
  let drag = null;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const lim = sideLimits();
    drag = { x: e.clientX, w0: Math.max(lim.min, Math.min(lim.max, Math.round(currentSideW()))) };
    document.body.classList.add('side-splitting');
    grip.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  grip.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const lim = sideLimits();
    setSideW(Math.max(lim.min, Math.min(lim.max, drag.w0 + (e.clientX - drag.x))));
    applySideWidth();
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    document.body.classList.remove('side-splitting');
    scheduleSave();
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  window.addEventListener('blur', end);
  // 窗口宽度变了（进/出贴边）时按当前模式重新夹一次
  window.addEventListener('resize', () => applySideWidth());
}

function setupDockAndPanels() {
  // ---- 贴边模式顶部的「音频 / 设置」标签 ----
  const tabAudio = $('dockTabAudio');
  if (tabAudio) {
    tabAudio.addEventListener('click', () => {
      closeOverlays();
      closeSettings();
      syncDockTabs();
    });
  }
  const tabSettings = $('dockTabSettings');
  if (tabSettings) {
    tabSettings.addEventListener('click', () => {
      openSettings();
      syncDockTabs();
    });
  }

  // ---- 贴边隐藏 ----
  const en = $('dockEnabled');
  if (en) {
    en.addEventListener('change', () => dockSet({ enabled: en.checked }));
  }
  for (const b of document.querySelectorAll('#dockEdge .seg-btn')) {
    b.addEventListener('click', () => dockSet({ edge: b.dataset.edge }));
  }
  const w = $('dockWidth');
  if (w) {
    w.addEventListener('input', () => {
      const v = Math.max(320, Math.round(Number(w.value) || 480));
      state.dock.width = v;
      const wv = $('dockWidthVal');
      if (wv) wv.textContent = v + 'px';
    });
    // 拖动过程中不重设窗口（会一卡一卡的），松手才应用
    w.addEventListener('change', () => dockSet({ width: state.dock.width }));
  }
  const strip = $('edgeStrip');
  if (strip) {
    strip.addEventListener('click', () => { sb.invoke('dock:peek').catch(() => {}); });
    strip.addEventListener('mouseenter', () => { sb.invoke('dock:peek').catch(() => {}); });
  }
  setupDockResize();
  setupDockDrag();
  if (sb.on) sb.on('dock:mode', (m) => applyDockMode(m));
  if (sb.on) {
    sb.on('dock:hint', () => {
      toast('贴边隐藏还没开启：这里勾上「贴边隐藏」，之后 Ctrl+Alt+S 就能展开 / 收起');
      openSettings();
      const sec = document.getElementById('dockSection');
      if (sec && sec.scrollIntoView) sec.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  // ---- Agent 检索 ----
  const openAi = () => openAiPanel();
  if (dom.btnAiSearch) dom.btnAiSearch.addEventListener('click', openAi);
  if (dom.chipAi) dom.chipAi.addEventListener('click', openAi);
  const aiClose = $('aiClose');
  if (aiClose) aiClose.addEventListener('click', closeAiPanel);
  const aiScrim = $('aiScrim');
  if (aiScrim) aiScrim.addEventListener('click', closeAiPanel);
  const aiRun = $('aiRun');
  if (aiRun) aiRun.addEventListener('click', () => runAiSearch());
  const aiQuery = $('aiQuery');
  if (aiQuery) {
    aiQuery.addEventListener('keydown', (e) => {
      // 回车直接检索（Shift+回车才换行），写需求的时候不用再去点按钮
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        runAiSearch();
      }
    });
  }
  const aiOnly = $('aiOnly');
  if (aiOnly) aiOnly.addEventListener('click', () => setAiOnly(!state.ai.only));
  const aiAll = $('aiAll');
  if (aiAll) aiAll.addEventListener('click', () => setAiOnly(false));
  const aiHistoryBtn = $('aiHistory');
  if (aiHistoryBtn) {
    aiHistoryBtn.addEventListener('click', () => toggleAiList('history'));
  }
  const aiSavedBtn = $('aiSaved');
  if (aiSavedBtn) {
    aiSavedBtn.addEventListener('click', () => toggleAiList('saved'));
  }
  const aiSaveHist = $('aiSaveHist');
  if (aiSaveHist) {
    aiSaveHist.addEventListener('click', () => {
      const snap = saveAiCurrent();
      if (snap) aiStatus(`已保存（${snap.q} · ${snap.count} 条），点「已保存」可回看`, 'ok');
    });
  }
  const aiDeep = $('aiDeep');
  if (aiDeep) {
    aiDeep.checked = !!state.ai.deep;
    aiDeep.addEventListener('change', () => {
      state.ai.deep = !!aiDeep.checked;
      if (state.ai.deep && !state.ai.agentOk) {
        aiStatus('「全库扫描」要先在设置里填好 Agent 接口和密钥，否则还是本地规则检索。', 'err');
      }
    });
  }
  // 需求 4：连上密钥也可以选择不发送给 AI
  const aiOffline = $('aiOffline');
  if (aiOffline) {
    aiOffline.checked = !!state.ai.offline;
    aiOffline.addEventListener('change', () => {
      state.ai.offline = !!aiOffline.checked;
      scheduleSave();
      toast(state.ai.offline
        ? '已切到离线模式：语义检索只用本地词表，不会发送任何内容'
        : '已恢复联网检索：会把需求和候选名字发给 Agent');
    });
  }
  const aiKeep = $('aiKeepLocal');
  if (aiKeep) {
    aiKeep.checked = !!state.ai.keepLocal;
    aiKeep.addEventListener('change', () => {
      state.ai.keepLocal = !!aiKeep.checked;
      scheduleSave();
      toast(state.ai.keepLocal
        ? '连上 Agent 时，除了模型召回的结果，也会把本地词表命中的附在后面'
        : '连上 Agent 时只按模型给的「范围 + 关键词」全库召回，不再附带本地命中');
    });
  }

  // ---- 参考图（看图取声）----
  const aiImageBtn = $('aiImageBtn');
  if (aiImageBtn) aiImageBtn.addEventListener('click', () => pickAiImage());
  const aiImageInput = $('aiImageInput');
  if (aiImageInput) {
    aiImageInput.addEventListener('change', () => {
      const f = aiImageInput.files && aiImageInput.files[0];
      if (f) loadAiImage(f);
      aiImageInput.value = '';
    });
  }
  const aiImageClear = $('aiImageClear');
  if (aiImageClear) aiImageClear.addEventListener('click', () => clearAiImage());
  const aiImageRetry = $('aiImageRetry');
  if (aiImageRetry) {
    aiImageRetry.addEventListener('click', () => {
      if (!state.ai.image) {
        aiStatus('先导入一张图片。', 'err');
        return;
      }
      state.ai.forceLook = true;
      runAiSearch();
    });
  }
  renderAiImage();

  // ---- 效果器 ----
  const openFx = () => openFxPanel();
  if (dom.btnFx) dom.btnFx.addEventListener('click', openFx);
  if (dom.chipFx) dom.chipFx.addEventListener('click', (e) => openFxMenu(e.currentTarget));
  const fxClose = $('fxClose');
  if (fxClose) fxClose.addEventListener('click', closeFxPanel);
  const fxScrim = $('fxScrim');
  if (fxScrim) fxScrim.addEventListener('click', closeFxPanel);

  // ---- AI 工作台的板块切换与模型条 ----
  const aiTabBar = $('aiTabs');
  if (aiTabBar) {
    aiTabBar.addEventListener('click', (ev) => {
      const b = ev.target && ev.target.closest ? ev.target.closest('[data-ai-tab]') : null;
      if (b) setAiTab(b.dataset.aiTab);
    });
  }
  for (const id of ['aiModelSelect', 'synthModelSelect']) {
    const sel = $(id);
    if (sel) sel.addEventListener('change', () => switchAiProfile(sel.value));
  }
  for (const id of ['aiModelManage', 'synthModelManage']) {
    const b = $(id);
    if (b) b.addEventListener('click', () => { setSettingsTab('ai'); openSettings(); });
  }

  // ---- 生成底噪 ----
  const synthClose = $('synthClose');
  if (synthClose) synthClose.addEventListener('click', closeSynthPanel);
  const synthScrim = $('synthScrim');
  if (synthScrim) synthScrim.addEventListener('click', closeSynthPanel);
  const synthRunBtn = $('synthRun');
  if (synthRunBtn) synthRunBtn.addEventListener('click', () => synthRun());
  const synthPlayBtn = $('synthPlay');
  if (synthPlayBtn) synthPlayBtn.addEventListener('click', () => synthPlay());
  const synthSaveBtn = $('synthSave');
  if (synthSaveBtn) synthSaveBtn.addEventListener('click', () => synthSaveAndImport());
  // 候选行：点按钮 / 拖出（draggable 行把文件路径直接交给主进程的 startDrag）
  const synthResults = $('synthResults');
  if (synthResults) {
    synthResults.addEventListener('click', (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (btn) {
        const idx = Number(btn.dataset.idx);
        const act = btn.dataset.act;
        if (act === 'play') playSynthCandidate(idx);
        else if (act === 'detail') openSynthDetail(idx);
        else if (act === 'save') synthSaveCandidate(idx);
        return;
      }
      // 点整行 = 试听（走主播放器，波形/裁剪/拖出都能用）
      const row = ev.target && ev.target.closest ? ev.target.closest('.synth-cand') : null;
      if (row) playSynthCandidate(Number(row.dataset.idx));
    });
    synthResults.addEventListener('dragstart', (ev) => {
      const row = ev.target && ev.target.closest ? ev.target.closest('.synth-cand') : null;
      if (!row) return;
      synthDragCandidate(Number(row.dataset.idx), ev);
    });
  }
  // 模式换成「缝合」时把「底色」灰掉（那一栏只对纹理/混合有意义）
  const synthModeSel = $('synthMode');
  if (synthModeSel) synthModeSel.addEventListener('change', syncSynthModeUi);
  syncSynthModeUi();
  // AI 面板里的「合成」入口：从检索面板直接开合成抽屉
  const btnSynthOpen = $('btnSynthOpen');
  if (btnSynthOpen) btnSynthOpen.addEventListener('click', () => openSynthPanel());

  const fxEn = $('fxEnabled');
  if (fxEn) fxEn.addEventListener('change', () => fxApply({ enabled: fxEn.checked }));

  // 波形条左侧那个小块
  if (dom.fxMiniToggle) dom.fxMiniToggle.addEventListener('click', (e) => openFxMenu(e.currentTarget));
  for (const [el, key] of [[dom.fxMiniHp, 'hp'], [dom.fxMiniLp, 'lp'], [dom.fxMiniRev, 'revMix']]) {
    if (!el) continue;
    el.addEventListener('input', () => {
      const v = Number(el.value);
      state.fx = clampFx({ ...state.fx, [key]: key === 'revMix' ? v / 100 : v });
      if (key === 'revMix') state.fx.revOn = state.fx.revMix > 0.001 ? true : state.fx.revOn;
      player.fx.update(state.fx);
      syncFxMini();
    });
    el.addEventListener('change', () => {
      const v = Number(el.value);
      fxApply(key === 'revMix' ? { revMix: v / 100, revOn: v > 0.001 ? true : state.fx.revOn } : { [key]: v });
    });
  }
  for (const [inputId, key, labelId, fmt] of FX_SLIDERS) {
    const el = $(inputId);
    if (!el) continue;
    el.addEventListener('input', () => {
      const v = Number(el.value);
      state.fx = clampFx({ ...state.fx, [key]: v });
      player.fx.update(state.fx);
      const lab = $(labelId);
      if (lab) lab.textContent = fmt(state.fx[key]);
    });
    el.addEventListener('change', () => fxApply({ [key]: Number(el.value) }));
  }
  for (const [id, key] of [['fxCompOn', 'compOn'], ['fxRevOn', 'revOn']]) {
    const el = $(id);
    if (el) el.addEventListener('change', () => fxApply({ [key]: el.checked }));
  }
  const fxReset = $('fxReset');
  if (fxReset) fxReset.addEventListener('click', () => {
    const keep = { enabled: state.fx.enabled };
    fxApply({ ...FX_DEFAULTS, ...keep });
    const note = $('fxNote');
    if (note) note.textContent = '已恢复默认参数。';
  });
  const fxExportBtn = $('fxExport');
  if (fxExportBtn) fxExportBtn.addEventListener('click', () => fxExport());

  // Agent 检索结果也能直接拖到 DAW / 资源管理器（贴边模式下尤其要能拖）
  const aiResultsEl = $('aiResults');
  if (aiResultsEl) {
    aiResultsEl.addEventListener('dragstart', (e) => {
      const row = e.target.closest ? e.target.closest('.ai-row') : null;
      const item = row && state.byPath.get(row.dataset.path);
      if (!item) return;
      row.classList.add('dragging');
      // 拖哪条，下面的波形条就显示哪条，修剪 / 效果器也就作用在它身上
      selectItem(item, { play: false }).catch(() => {});
      startDragOut(item, e);
    });
    aiResultsEl.addEventListener('dragend', () => {
      clearDragMarks();
    });
  }

  // ---- 设置里的 Agent / 插件 ----
  const btnAgentSave = $('btnAgentSave');
  if (btnAgentSave) btnAgentSave.addEventListener('click', () => saveAgentConfig());
  const btnAgentTest = $('btnAgentTest');
  if (btnAgentTest) btnAgentTest.addEventListener('click', () => testAgent());
  const btnAgentClear = $('btnAgentClearKey');
  if (btnAgentClear) btnAgentClear.addEventListener('click', () => clearAgentKey());
  const agentProfileSel = $('agentProfile');
  if (agentProfileSel) {
    agentProfileSel.addEventListener('change', () => activateAgentProfile(agentProfileSel.value));
  }
  const btnProfileSave = $('btnAgentProfileSave');
  if (btnProfileSave) btnProfileSave.addEventListener('click', () => saveAgentProfileAsNew());
  const btnProfileDel = $('btnAgentProfileDelete');
  if (btnProfileDel) btnProfileDel.addEventListener('click', () => deleteAgentProfile());

  // ---- 设置里的音频生成（云端 AI）----
  const btnGenSave = $('btnGenSave');
  if (btnGenSave) btnGenSave.addEventListener('click', () => saveGenProfile(false));
  const btnGenNew = $('btnGenProfileNew');
  if (btnGenNew) btnGenNew.addEventListener('click', () => saveGenProfile(true));
  const btnGenDel = $('btnGenProfileDelete');
  if (btnGenDel) btnGenDel.addEventListener('click', () => deleteGenProfile());
  const btnGenClear = $('btnGenClearKey');
  if (btnGenClear) btnGenClear.addEventListener('click', () => clearGenKey());
  const btnGenBal = $('btnGenBalance');
  if (btnGenBal) btnGenBal.addEventListener('click', () => checkGenBalance());
  const genSel = $('genProfile');
  if (genSel) {
    genSel.addEventListener('change', async () => {
      const id = genSel.value;
      if (!id) return;
      try {
        const r = await sb.invoke('gen:profile-activate', { id });
        if (r && r.ok) {
          genState.profiles = r.profiles || [];
          genState.active = r.active || '';
          genState.current = r.current || null;
          renderGenProfiles();
          genState.credits = null;
          refreshGenBalance();
        }
      } catch { /* 切不过去就保持原样 */ }
    });
  }
  const genProvSel = $('genProvider');
  if (genProvSel) {
    // 换服务商时把地址/模型带成该家的默认值，省得用户自己记
    genProvSel.addEventListener('change', () => {
      const p = genState.providers.find((x) => x.id === genProvSel.value);
      if (!p) return;
      const ep = $('genEndpoint');
      const md = $('genModel');
      if (ep && (!ep.value.trim() || genState.current === null)) ep.value = p.endpoint || '';
      if (md && (!md.value.trim() || genState.current === null)) md.value = p.model || '';
    });
  }
  // 云端生成的按钮绑定在 init 的「AI 工具」段
  // 填完就记：地址和模型停手 0.7 秒自动存，密钥失焦 / 回车存
  const agentUrlEl = $('agentBaseUrl');
  if (agentUrlEl) {
    agentUrlEl.addEventListener('input', () => queueAgentAutoSave());
    agentUrlEl.addEventListener('change', () => queueAgentAutoSave(0));
    agentUrlEl.addEventListener('blur', () => queueAgentAutoSave(0));
  }
  const agentModelEl = $('agentModel');
  if (agentModelEl) {
    agentModelEl.addEventListener('input', () => queueAgentAutoSave());
    agentModelEl.addEventListener('change', () => queueAgentAutoSave(0));
    agentModelEl.addEventListener('blur', () => queueAgentAutoSave(0));
  }
  const agentKeyEl = $('agentKey');
  if (agentKeyEl) {
    agentKeyEl.addEventListener('change', () => queueAgentAutoSave(0));
    agentKeyEl.addEventListener('blur', () => queueAgentAutoSave(0));
    agentKeyEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); queueAgentAutoSave(0); }
    });
  }
  const btnScan = $('btnScanPlugins');
  if (btnScan) btnScan.addEventListener('click', () => scanPluginsNow());

  syncDockUI();
  syncFxUI();
  renderAiPresets();
  renderAiResults();
}

// 启动计时：排障用。打开 DevTools 或远程调试读 window.__startup 就能看到每一段耗时。
if (!window.__startup) window.__startup = [];
function markStartup(name) {
  try { window.__startup.push({ name, t: Math.round(performance.now()) }); } catch { /* ignore */ }
}

async function init() {
  // macOS 的窗口按钮（红绿灯）会压在最左边，给标题栏让出位置
  markStartup('init');
  sb.invoke('app:info')
    .then((info) => { document.body.classList.add('platform-' + (info.platform || 'unknown')); })
    .catch(() => {});

  // Restore library
  const lib = await sb.invoke('library:load');
  const savedSettings = lib.settings || {};

  if (typeof savedSettings.gainDb === 'number') state.gainDb = savedSettings.gainDb;
  if (typeof savedSettings.muted === 'boolean') state.muted = savedSettings.muted;
  if (typeof savedSettings.loop === 'boolean') state.loop = savedSettings.loop;
  if (typeof savedSettings.mono === 'boolean') state.mono = savedSettings.mono;
  if (typeof savedSettings.waveAutoGain === 'boolean') state.waveAutoGain = savedSettings.waveAutoGain;
  if (typeof savedSettings.waveHeight === 'number') {
    state.waveHeight = Math.max(108, savedSettings.waveHeight);
    dom.wavePanel.style.height = state.waveHeight + 'px';
  }
  if (Array.isArray(savedSettings.colWidths) && savedSettings.colWidths.length === 11 &&
      savedSettings.colWidths.every((w) => typeof w === 'number' && isFinite(w))) {
    state.colWidths = savedSettings.colWidths.slice();
  }

  // 效果器参数：恢复上次的设置，并接进播放链（默认是旁通的）
  if (savedSettings.fx && typeof savedSettings.fx === 'object') {
    state.fx = clampFx({ ...FX_DEFAULTS, ...savedSettings.fx });
  }
  // 采样器参数：同样是"下次打开还是上次那组旋钮"
  if (savedSettings.sampler && typeof savedSettings.sampler === 'object') {
    state.sampler = clampSampler({ ...SAMPLER_DEFAULTS, ...savedSettings.sampler });
  }
  // 贴边隐藏的偏好（真正的窗口几何由主进程按这份偏好重算）
  if (savedSettings.dock && typeof savedSettings.dock === 'object') {
    const d = savedSettings.dock;
    if (typeof d.enabled === 'boolean') state.dock.enabled = d.enabled;
    if (d.edge === 'left' || d.edge === 'right') state.dock.edge = d.edge;
    if (typeof d.width === 'number') state.dock.width = Math.max(320, Math.round(d.width));
  }
  // Agent 检索的偏好：连上接口时是否还保留本地命中
  if (savedSettings.ai && typeof savedSettings.ai === 'object') {
    if (typeof savedSettings.ai.keepLocal === 'boolean') state.ai.keepLocal = savedSettings.ai.keepLocal;
    if (typeof savedSettings.ai.offline === 'boolean') state.ai.offline = savedSettings.ai.offline;
  }
  if (typeof lib.settingsTab === 'string' && /^(general|data|ai)$/.test(lib.settingsTab)) {
    state.ai.settingsTab = lib.settingsTab;
  }
  // 检索记录：history（自动）/ saved（手动）两条独立列表，形状一样
  const readEntries = (arr, max) => (Array.isArray(arr) ? arr : [])
    .filter((h) => h && typeof h.q === 'string' && Array.isArray(h.results))
    .slice(0, max)
    .map((h) => ({
      id: String(h.id || ('h' + Math.random().toString(36).slice(2, 8))),
      q: h.q,
      at: Number(h.at) || Date.now(),
      mode: h.mode === 'agent' ? 'agent' : 'local',
      count: Number(h.count) || h.results.length,
      scene: typeof h.scene === 'string' ? h.scene : '',
      results: h.results
        .filter((r) => r && typeof r.path === 'string')
        .slice(0, 120)
        .map((r) => ({ path: r.path, pct: Number(r.pct) || 0, reason: typeof r.reason === 'string' ? r.reason : '' }))
    }));
  state.ai.history = readEntries(lib.aiHistory, AI_HISTORY_MAX);
  state.ai.saved = readEntries(lib.aiSaved, AI_SAVED_MAX);
  // 1.4.2 之前只有一条「手动保存」的列表，搬进「已保存」再继续用
  if (!Array.isArray(lib.aiSaved) && state.ai.history.length) {
    state.ai.saved = state.ai.history.slice(0, AI_SAVED_MAX);
    state.ai.history = [];
  }
  // 界面偏好：右侧信息栏是否自动弹、侧栏宽度
  if (savedSettings.ui && typeof savedSettings.ui === 'object') {
    if (typeof savedSettings.ui.autoInfo === 'boolean') state.autoInfo = savedSettings.ui.autoInfo;
    if (typeof savedSettings.ui.sideW === 'number' && isFinite(savedSettings.ui.sideW)) {
      state.sideW = Math.max(SIDE_MIN, Math.min(SIDE_MAX, Math.round(savedSettings.ui.sideW)));
    }
    if (typeof savedSettings.ui.sideWNarrow === 'number' && isFinite(savedSettings.ui.sideWNarrow)) {
      state.sideWNarrow = Math.max(96, Math.min(200, Math.round(savedSettings.ui.sideWNarrow)));
    }
    if (typeof savedSettings.ui.hoverAudition === 'boolean') {
      state.hoverAudition = savedSettings.ui.hoverAudition;
    }
    if (Number.isFinite(Number(savedSettings.ui.hoverDelay))) {
      state.hoverDelay = Math.min(3, Math.max(0.1, Number(savedSettings.ui.hoverDelay)));
    }
  }
  applySideWidth();
  player.setFx(!!state.fx.enabled, state.fx);
  markStartup('settings');

  // 贴边几何先恢复：这一步只依赖存下来的偏好，不该等 5 万条素材建完索引。
  // 之前放在 init 末尾，用户看到的是「窗口先正常大小出现，过几秒才刷地贴边」。
  dockRestore();
  markStartup('dock');

  state.collections = (Array.isArray(lib.collections) ? lib.collections : [])
    .filter((c) => c && c.id && c.name)
    .map((c) => ({ id: String(c.id), name: String(c.name), createdAt: c.createdAt || Date.now() }));

  state.categories = (Array.isArray(lib.categories) ? lib.categories : [])
    .filter((c) => c && c.id && c.name)
    .map((c) => ({
      id: String(c.id),
      name: String(c.name),
      parentId: c.parentId ? String(c.parentId) : null,
      auto: c.auto ? String(c.auto) : null,
      pinned: c.pinned ? true : null
    }));
  // 老清单没有 parentId；顺手把悬空父级和环改回顶层，免得侧栏画不出来
  repairCategoryTree();
  ensureProcessedCategory();
  state.collapsedCats = (Array.isArray(lib.collapsedCategories) ? lib.collapsedCategories : [])
    .filter((id) => typeof id === 'string' && categoryById(id));
  state.hiddenCategoryAutos = (Array.isArray(lib.hiddenCategoryAutos) ? lib.hiddenCategoryAutos : [])
    .filter((s) => typeof s === 'string')
    .map((s) => s.toUpperCase());

  const items = Array.isArray(lib.items) ? lib.items : [];
  for (const raw of items) {
    if (!raw || !raw.path) continue;
    const it = makeItem({
      path: raw.path,
      name: raw.name || baseName(raw.path),
      size: raw.size || 0,
      mtimeMs: raw.mtimeMs || 0,
      meta: raw.meta || null,
      collections: raw.collections,
      categoryId: raw.categoryId || null,
      // 修剪区间与波形指纹都要跟着清单一起恢复，否则重开软件后
      // 「只播保留段」和「相似度」全都要重算/失效
      trim: raw.trim || null,
      fp: raw.fp || null,
      zcr: raw.zcr || null,
      fpHash: raw.fpHash || null,
      needsAnalysis: true
    });
    it.addedAt = raw.addedAt || it.addedAt;
    state.items.push(it);
    state.byPath.set(it.path, it);
  }
  // A library written by an older build has no categories at all: rebuild them
  // from the UCS names so nothing silently lands in 未分类 on first load.
  ensureAllCategories();
  markStartup('items');

  // 到这里清单才算真的恢复完，之后才允许写盘（见 scheduleSave 的 libraryReady）
  libraryReady = true;

  computeView();
  renderSidebar();
  renderList();
  markStartup('first-paint');

  // 「文件还在不在」放到后台分块核对：五万条一次性 stat 会把整机读盘队列占满，
  // 界面能点但每个操作都卡在文件系统后面。这里先出界面，再慢慢核对。
  verifyMissingInBackground();

  player.setGainDb(state.gainDb);
  player.setLoop(state.loop);
  if (state.mono) player.setMono(true);
  updateTransport();

  // Wire up events
  setupColumnResize();
  // 首帧之前表头还没有布局（clientWidth 为 0），等布局出来再校正存下来的列宽
  scheduleFitColWidths();
  applyColWidths();
  // 第一次点界面时顺手把音频设备打开，避免第一次按播放时卡一下
  window.addEventListener('pointerdown', () => player.warm(), { once: true, capture: true });
  setupKeyboard();
  setupSettingsTabs();
  setSettingsTab(state.ai.settingsTab, false);
  setupListInteraction();
  setupDropImport();
  setupDragOut();
  setupWaveInteraction();
  setupWaveResize();

  // 贴边隐藏、Agent 检索、效果器这一套的事件
  setupDockAndPanels();
  setupSideSplitter();
  loadAgentConfig();
  loadGenConfig();
  // AI 音效库的根分类一启动就要在（没生成过也要能看到这一栏），否则分类树里要等第一次生成才冒出来
  ensureAiLibraryRoot();
  // 插上移动盘后自动找回丢失素材（每 30 秒一批，不抢磁盘）
  startMissingWatch();

  const btnImport = $('btnImport');
  if (btnImport) btnImport.addEventListener('click', (e) => openImportMenu(e.currentTarget));
  const btnInspector = $('btnInspector');
  if (btnInspector) btnInspector.addEventListener('click', (e) => openInspectorMenu(e.currentTarget));

  // ---- AI 工具（检索 / 生成）----
  const btnAiTool = $('btnAiTool');
  if (btnAiTool) btnAiTool.addEventListener('click', () => { openAiPanel(); setAiTab('search'); });
  for (const b of document.querySelectorAll('#aiTabs .settings-tab')) {
    b.addEventListener('click', () => setAiTab(b.dataset.aiTab));
  }
  const genKindSel = $('genKind');
  if (genKindSel) {
    genKindSel.addEventListener('change', () => {
      genKindSetup(false);
      renderGenBalance();
    });
  }
  const genTrChk = $('genTranslate');
  if (genTrChk) {
    genTrChk.addEventListener('change', () => {
      const trEl = $('genTranslated');
      if (trEl && !genTrChk.checked) {
        trEl.textContent = '';
        trEl.classList.add('hidden');
      }
    });
  }
  const aiGenBtn = $('btnAiGen');
  if (aiGenBtn) aiGenBtn.addEventListener('click', () => { openAiPanel(); setAiTab('gen'); });
  const aiGenMissingBtn = $('aiGenMissing');
  if (aiGenMissingBtn) aiGenMissingBtn.addEventListener('click', () => { void genFromSearchResults(); });
  genKindSetup(true);
  for (const id of ['genSeconds', 'genCount', 'genModelSelect']) {
    const el = $(id);
    if (el) el.addEventListener('change', () => renderGenBalance());
  }
  const genBalBtn0 = $('btnGenBalance2');
  if (genBalBtn0) genBalBtn0.addEventListener('click', () => refreshGenBalance());
  const genRunBtn = $('btnGenRun');
  if (genRunBtn) genRunBtn.addEventListener('click', () => genRunCloud());
  // 类型 / 描述变了就刷新「是不是选错类型了」的提示
  const genKindEl = $('genKind');
  if (genKindEl) genKindEl.addEventListener('change', () => { genKindSetup(true); genKindHint(); });
  const genPromptEl = $('genPrompt');
  if (genPromptEl) genPromptEl.addEventListener('input', () => genKindHint());
  const genBalBtn = $('btnGenBalance2');
  if (genBalBtn) genBalBtn.addEventListener('click', () => checkGenBalance());
  const genManage = $('genModelManage');
  if (genManage) genManage.addEventListener('click', () => { setSettingsTab('ai'); openSettings(); });
  const genSelTop = $('genModelSelect');
  if (genSelTop) {
    genSelTop.addEventListener('change', async () => {
      const id = genSelTop.value;
      if (!id) return;
      try {
        const r = await sb.invoke('gen:profile-activate', { id });
        if (r && r.ok) {
          genState.profiles = r.profiles || [];
          genState.active = r.active || '';
          genState.current = r.current || null;
          renderGenProfiles();
        }
      } catch { /* ignore */ }
    });
  }
  if (dom.btnAddFiles) dom.btnAddFiles.addEventListener('click', () => importViaDialog('files'));
  if (dom.btnAddFolder) dom.btnAddFolder.addEventListener('click', () => importViaDialog('folder'));
  dom.btnSettings.addEventListener('click', openSettings);
  dom.settingsClose.addEventListener('click', closeSettings);
  dom.settingsScrim.addEventListener('click', closeSettings);
  dom.infoClose.addEventListener('click', closeInfoPanel);
  if (dom.chipInfo) dom.chipInfo.addEventListener('click', toggleInfoPanel);
  dom.similarScrim.addEventListener('click', closeSimilarPanel);
  dom.similarClose.addEventListener('click', closeSimilarPanel);
  if (dom.chipSimilar) dom.chipSimilar.addEventListener('click', toggleSimilarPanel);
  if (dom.chipTrim) dom.chipTrim.addEventListener('click', () => { exportTrimSelection(); });

  dom.search.addEventListener('input', (e) => applySearch(e.target.value));
  dom.searchClear.addEventListener('click', () => {
    dom.search.value = '';
    applySearch('');
    dom.search.focus();
  });

  // Sidebar filter clicks are delegated: the collection list is rebuilt on
  // every sidebar render, so per-element listeners would go stale.
  document.querySelector('.sidebar').addEventListener('click', (e) => {
    const el = e.target.closest('.side-item[data-filter]');
    if (!el) return;
    const f = el.dataset.filter;
    const id = el.dataset.value || null;

    // Ctrl/Cmd/Shift on a library or category row builds a multi-selection
    // instead of filtering, so several can be merged or deleted in one go.
    const multi = f === 'collection' || f === 'category';
    if (multi && (e.ctrlKey || e.metaKey || e.shiftKey)) {
      e.preventDefault();
      selectSide(f, id, { additive: e.ctrlKey || e.metaKey, range: e.shiftKey });
      return;
    }

    clearSideSelection();
    if (f === 'all') state.filter = { type: 'all', value: null };
    else if (f === 'missing') state.filter = { type: 'missing', value: null };
    else state.filter = { type: f, value: id };
    refreshSideHighlight();
    computeView();
    dom.listBody.scrollTop = 0;
    scheduleRender();
  });

  dom.btnNewCollection.addEventListener('click', () => beginCollectionInput('create', null));
  dom.btnNewCollection.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  dom.btnNewCategory.addEventListener('click', () => beginCategoryInput('create', null));
  dom.btnNewCategory.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  // 分类标题右边那个 🧹：清理菜单（丢失音频 / 空分类 / 清空分类）
  if (dom.btnCleanCategories) {
    dom.btnCleanCategories.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCleanupMenu(dom.btnCleanCategories);
    });
    dom.btnCleanCategories.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }

  for (const el of [dom.libTitle, dom.collectionList]) {
    el.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.side-item.collection');
      e.preventDefault();
      const sel = state.sideSelection;
      const id = row && row.dataset.value;

      // Right-click inside a multi-selection offers the bulk actions.
      if (row && sel.type === 'collection' && sel.ids.size > 1 && sel.ids.has(id)) {
        const n = sel.ids.size;
        showContextMenu(e.clientX, e.clientY, null, [
          { label: `合并所选 ${n} 个资料库`, run: () => mergeCollections([...sel.ids]) },
          { sep: true },
          { label: `删除所选 ${n} 个资料库`, danger: true, run: () => deleteCollections([...sel.ids]) },
          { sep: true },
          { label: '取消选择', muted: true, run: () => resetSideSelection() }
        ]);
        return;
      }

      // Right-clicking an unselected row narrows the selection back to it.
      if (row && sel.ids.size) { clearSideSelection(); renderSidebar(); }

      if (row) {
        showContextMenu(e.clientX, e.clientY, null, [
          { label: '重命名…', run: () => beginCollectionInput('rename', id, collectionName(id)) },
          { sep: true },
          { label: '删除资料库（连同音频）…', danger: true, run: () => deleteCollection(id) },
          { sep: true },
          { label: '新建资料库…', run: () => beginCollectionInput('create', null) }
        ]);
      } else {
        showContextMenu(e.clientX, e.clientY, null, [
          { label: '新建资料库…', run: () => beginCollectionInput('create', null) }
        ]);
      }
    });
  }

  for (const el of [dom.catTitle, dom.categoryList]) {
    el.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.side-item.category');
      e.preventDefault();
      const sel = state.sideSelection;
      const id = row && row.dataset.value;
      const isUncat = !id || id === UNCAT_SENTINEL;

      // Right-click inside a multi-selection offers the bulk actions.
      if (row && !isUncat && sel.type === 'category' && sel.ids.size > 1 && sel.ids.has(id)) {
        const n = sel.ids.size;
        const deletable = [...sel.ids].filter((x) => !(categoryById(x) || {}).pinned);
        const items = [
          { label: `合并所选 ${n} 个分类`, run: () => mergeCategories([...sel.ids]) },
          { sep: true }
        ];
        if (deletable.length) {
          items.push({ label: `删除所选 ${deletable.length} 个分类`, danger: true, run: () => deleteCategories(deletable) });
        }
        items.push({ sep: true }, { label: '取消选择', muted: true, run: () => resetSideSelection() });
        showContextMenu(e.clientX, e.clientY, null, items);
        return;
      }

      // Right-clicking an unselected row narrows the selection back to it.
      if (row && !isUncat && sel.ids.size) { clearSideSelection(); renderSidebar(); }

      const actions = [];
      if (row && !isUncat) {
        const pinned = (categoryById(id) || {}).pinned;
        actions.push({ label: '重命名…', run: () => beginCategoryInput('rename', id, categoryName(id)) });
        actions.push({
          label: '新建子分类…',
          run: () => { revealCategory(id); beginCategoryInput('create', null, '', id); }
        });
        actions.push({ sep: true });
        if (pinned) actions.push({ label: '内置分类，不能删除', muted: true });
        else actions.push({ label: '删除分类（连同音频）…', danger: true, run: () => deleteCategory(id) });
        actions.push({ sep: true });
      }
      actions.push({ label: '新建分类…', run: () => beginCategoryInput('create', null) });
      // 原地就能清理：丢失的音频 / 空分类 / 整个清空
      const missN = missingItemCount();
      const emptyN = emptyCategoryIds().length;
      actions.push({ sep: true });
      actions.push({
        label: missN || emptyN ? `清理…（${missN} 条丢失 · ${emptyN} 个空分类）` : '清理…',
        run: () => openCleanupMenu({ getBoundingClientRect: () => ({ left: e.clientX, bottom: e.clientY }) })
      });
      showContextMenu(e.clientX, e.clientY, null, actions);
    });
  }

  dom.formatList.addEventListener('click', (e) => {
    const chip = e.target.closest('.fmt-chip');
    if (!chip) return;
    const value = chip.dataset.value;
    if (state.filter.type === 'format' && state.filter.value === value) {
      state.filter = { type: 'all', value: null };
    } else {
      state.filter = { type: 'format', value };
    }
    computeView();
    dom.listBody.scrollTop = 0;
    renderSidebar();
    scheduleRender();
  });

  dom.categoryList.addEventListener('click', (e) => {
    // 倒三角只管展开 / 收起，不改变筛选
    const caret = e.target.closest('.side-caret');
    if (caret) {
      const row = caret.closest('.side-item.category');
      const id = row && row.dataset.value;
      if (id && id !== UNCAT_SENTINEL) {
        e.stopPropagation();
        e.preventDefault();
        setCatCollapsed(id, !isCatCollapsed(id));
        scheduleSave();
        renderSidebar();
      }
      return;
    }
    const btn = e.target.closest('.side-item');
    if (!btn) return;
    state.filter = { type: 'category', value: btn.dataset.value };
    refreshSideHighlight();
    computeView();
    dom.listBody.scrollTop = 0;
    scheduleRender();
  });

  for (const el of dom.listHeader.querySelectorAll('.sortable')) {
    el.addEventListener('click', () => {
      if (suppressHeaderClick) return;
      const key = el.dataset.sort;
      if (state.sort.key === key) state.sort.dir *= -1;
      else { state.sort.key = key; state.sort.dir = 1; }
      computeView();
      scheduleRender();
    });
  }

  dom.btnPlay.addEventListener('click', togglePlay);
  dom.btnStop.addEventListener('click', stopPlayback);
  dom.btnPrev.addEventListener('click', () => stepSelection(-1));
  dom.btnNext.addEventListener('click', () => stepSelection(1));
  dom.btnMute.addEventListener('click', toggleMute);
  dom.chipLoop.addEventListener('click', toggleLoop);
  dom.chipMono.addEventListener('click', toggleMono);
  dom.chipWaveGain.addEventListener('click', toggleWaveGain);
  if (dom.chipZoom) {
    dom.chipZoom.addEventListener('click', () => {
      if (wave.zoom > 1.001) wave.resetZoom();
      else wave.zoomBy(2, wave.time);
    });
  }

  dom.volume.addEventListener('input', (e) => setGainDb(parseFloat(e.target.value)));
  dom.volume.addEventListener('dblclick', () => setGainDb(0));
  dom.volume.addEventListener('wheel', (e) => {
    e.preventDefault();
    adjustGain(e.deltaY < 0 ? (e.shiftKey ? 0.1 : 0.5) : (e.shiftKey ? -0.1 : -0.5));
  }, { passive: false });

  // 贴边面板里的增益旋钮：按住上下拖 = 粗调（0.5 dB/px），按住 Alt = 精调（0.1 dB/px）
  if (dom.gainKnob) {
    let kn = null;
    dom.gainKnob.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      kn = { id: e.pointerId, y0: e.screenY, g0: state.gainDb, fine: e.altKey };
      try { dom.gainKnob.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      dom.gainKnob.classList.add('dragging');
    });
    dom.gainKnob.addEventListener('pointermove', (e) => {
      if (!kn || e.pointerId !== kn.id) return;
      const perPx = kn.fine || e.altKey ? 0.1 : 0.5;
      setGainDb(kn.g0 + (kn.y0 - e.screenY) * perPx);
    });
    const knEnd = (e) => {
      if (!kn) return;
      kn = null;
      dom.gainKnob.classList.remove('dragging');
      try { dom.gainKnob.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    dom.gainKnob.addEventListener('pointerup', knEnd);
    dom.gainKnob.addEventListener('pointercancel', knEnd);
    dom.gainKnob.addEventListener('dblclick', () => setGainDb(0));
    dom.gainKnob.addEventListener('wheel', (e) => {
      e.preventDefault();
      adjustGain(e.deltaY < 0 ? (e.altKey ? 0.1 : 0.5) : (e.altKey ? -0.1 : -0.5));
    }, { passive: false });
  }

  dom.btnClearCache.addEventListener('click', async () => {
    await sb.invoke('cache:clear');
    for (const it of state.items) {
      it.peaks = null;
      it.peaksState = 'idle';
      it.playPath = it.path;
      if (it.analysis === 'ready') it.analysis = 'idle';
    }
    const bytes = await sb.invoke('cache:size');
    dom.cacheSize.textContent = fmtSize(bytes);
    toast('缓存已清空');
    scheduleRender();
  });

  dom.btnOpenUserData.addEventListener('click', async () => {
    const info = await sb.invoke('app:info');
    sb.invoke('shell:open', info.userData);
  });

  // 设置页「清理维护」
  if (dom.btnCleanupNow) dom.btnCleanupNow.addEventListener('click', () => cleanupMissingAndEmpty());
  if (dom.btnPurgeMissing) dom.btnPurgeMissing.addEventListener('click', () => purgeMissingItems());
  if (dom.btnPurgeEmptyCats) dom.btnPurgeEmptyCats.addEventListener('click', () => purgeEmptyCategories());
  if (dom.btnClearCategories) dom.btnClearCategories.addEventListener('click', () => clearAllCategories());
  if (dom.btnRelinkCheck) {
    dom.btnRelinkCheck.addEventListener('click', async () => {
      await relinkMissing();
      renderRelinkStats();
    });
  }
  if (dom.btnRelinkFolder) {
    dom.btnRelinkFolder.addEventListener('click', async () => {
      await relinkFromFolder();
      renderRelinkStats();
    });
  }

  // 设置页「数据位置」/「清单备份」/「悬停即试听」
  if (dom.btnStorageOpen) {
    dom.btnStorageOpen.addEventListener('click', async () => {
      const info = await sb.invoke('storage:info').catch(() => null);
      if (info && info.current) sb.invoke('shell:open', info.current);
    });
  }
  if (dom.btnStorageMove) dom.btnStorageMove.addEventListener('click', () => migrateStorage());
  if (dom.btnStorageReset) dom.btnStorageReset.addEventListener('click', () => resetStorage());
  if (dom.btnBackupNow) dom.btnBackupNow.addEventListener('click', () => createBackupNow());
  if (dom.btnBackupOpen) {
    dom.btnBackupOpen.addEventListener('click', async () => {
      const r = await sb.invoke('backup:list').catch(() => null);
      if (r && r.dir) sb.invoke('shell:open', r.dir);
    });
  }
  if (dom.chkHoverAudition) {
    dom.chkHoverAudition.addEventListener('change', () => {
      state.hoverAudition = !!dom.chkHoverAudition.checked;
      applyHoverAudition();
      scheduleSave();
      toast(state.hoverAudition ? '悬停即试听：开' : '悬停即试听：关');
    });
  }
  if (dom.hoverDelay) {
    // 1..30 的滑杆 = 0.1..3.0 秒；拖动时只更新文字，松手再存盘
    dom.hoverDelay.addEventListener('input', () => {
      const v = Number(dom.hoverDelay.value) || 3;
      state.hoverDelay = Math.min(3, Math.max(0.1, v / 10));
      applyHoverAudition();
    });
    dom.hoverDelay.addEventListener('change', () => {
      scheduleSave();
      toast(`悬停 ${Number(state.hoverDelay).toFixed(1)} 秒开始试听`);
    });
  }

  player.onEnded = () => {
    if (state.loop) return;
    state.playing = false;
    updateTransport();
    scheduleRender();
  };

  player.onError = (msg) => {
    state.playing = false;
    updateTransport();
    toast(msg);
  };

  player.onLoaded = () => {
    updateTransport();
    updateWavePanel();
  };

  requestAnimationFrame(tickPlayhead);
  wave.resize();

  // Warm metadata for the first screenful, then let the queue drain the rest
  // in the background (peak caches make this cheap on a restart).
  state.view.slice(0, 30).forEach((it) => {
    if (it.analysis === 'idle') requestAnalysis(it);
  });
  for (const it of state.items) {
    if (it.analysis === 'idle') requestAnalysis(it);
  }

  if (state.items.length) {
    setTimeout(() => {
      if (!state.currentPath && state.view.length) {
        // Highlight the first row without auto-playing.
        state.focusPath = state.view[0].path;
        state.selection.add(state.view[0].path);
        state.currentPath = state.view[0].path;
        requestAnalysis(state.view[0], true);
        updateWavePanel();
        scheduleRender();
      }
    }, 60);
  }
}

init().catch((err) => {
  console.error(err);
  toast('启动失败: ' + err.message);
});

// ---------------------------------------------------------------------------
// Debug hook — lets the devtools console drive the store while developing.
// ---------------------------------------------------------------------------
window.__sb = {
  state,
  player,
  wave,
  fitColWidths,
  applyColWidths,
  resetColWidths,
  addFiles,
  playItem,
  togglePlay,
  computeView,
  renderSidebar,
  renderList,
  updateWavePanel,
  removeSelection,
  saveLibraryNow,
  createCollection,
  renameCollection,
  deleteCollection,
  doDeleteCollection,
  undoDeleteCollection,
  categoryOf,
  addItemsToCollection,
  removeItemsFromCollection,
  countInCollection,
  beginCollectionInput,
  showCollectionPicker,
  renderCollections,
  // categories
  categoryOf,
  categoryRecordOf,
  countInCategory,
  createCategory,
  renameCategory,
  deleteCategory,
  undoDeleteCategory,
  doDeleteCategory,
  // 清理维护
  missingItemCount,
  emptyCategoryIds,
  purgeMissingItems,
  purgeEmptyCategories,
  clearAllCategories,
  cleanupMissingAndEmpty,
  renderCleanupStats,
  openCleanupMenu,
  // 找回丢失素材 / 批量工作流 / 响度与频谱
  missingItems,
  relinkMissing,
  relinkOne,
  relinkFromFolder,
  relinkItemPath,
  renderRelinkStats,
  relinkFromRoot,
  applyRelinkPairs,
  ucsPartsOf,
  makeUcsName,
  showBatchMenu,
  batchCopyToProject,
  doCopyTo,
  planUcsRenames,
  applyUcsRenames,
  batchRenameUcs,
  batchWriteInfo,
  buildPickListCsv,
  exportPickList,
  showBatchDialog,
  closeBatchDialog,
  ensureDeep,
  deepCache,
  addItemsToCategory,
  beginCategoryInput,
  showCategoryPicker,
  renderCategories,
  ensureAllCategories,
  UNCAT_SENTINEL,
  dragGuard: () => dragOutGuardUntil,
  ensureDragFile,
  collectDragFiles,
  trimmableClip,
  dropPaths,
  // 文件夹拖进分类 → 按目录结构建子树
  buildFromFolders,
  importCategoryTree,
  // sidebar multi-selection
  selectSide,
  clearSideSelection,
  resetSideSelection,
  mergeCollections,
  deleteCollections,
  mergeCategories,
  deleteCategories,
  select: (paths) => {
    state.selection = new Set(paths);
    scheduleRender();
  },
  scanAndAdd: async (paths) => {
    const files = await sb.invoke('library:scan', paths);
    return addFiles(files, { analyzeFirst: true });
  },
  // 波形缩放 / 修剪 / 相似 / 信息（给自动化验证用）
  zoomBy: (factor) => wave.zoomBy(factor, wave.hovering ? wave.xToTime(wave.hoverX) : wave.time),
  resetZoom: () => {
    wave.resetZoom();
    wave.follow = true;
  },
  setTrimPoint,
  clearTrimSelection,
  commitTrimSelection,
  exportTrimSelection,
  similarCandidates,
  openSimilarPanel,
  closeSimilarPanel,
  openInfoPanel,
  closeInfoPanel,
  renderInfoPanel,
  fingerprintOf: (it) => (it && it.fp ? { fp: it.fp, zcr: it.zcr, fpHash: it.fpHash } : null),

  // 贴边隐藏 / Agent 检索 / 效果器（给自动化验证用）
  toggleAiList,
  saveAiCurrent,
  restoreAiEntry,
  deleteAiEntry,
  clearAiList,
  recordAiHistory,
  renderAiList,
  aiRecallByHints,
  setSettingsTab,
  dockSet,
  dockRestore,
  applyDockMode,
  openAiPanel,
  genRunCloud,
  genTranslateToEnglish,
  genKindSetup,
  setAiTab,
  loadGenConfig,
  genState,
  closeAiPanel,
  runAiSearch,
  aiDeepScan,
  aiExpandQuery,
  aiAnalyzeImage,
  loadAiImage,
  clearAiImage,
  renderAiImage,
  setAiOnly,
  aiRankMap,
  renderAiResults,
  openFxPanel,
  closeFxPanel,
  fxApply,
  fxBypass,
  fxExport,
  syncFxUI,
  loadAgentConfig,
  saveAgentConfig,
  testAgent,
  scanPluginsNow,
  searchLibrary: (q) => searchLibrary(state.items, q, { limit: AI_LIMIT }),
  parseQuery,
  classifyQuery,
  planPrune: (q) => planPrune(state.items, classifyQuery(q), { libraryOf: libraryKeyOf }),
  libraryKeyOf,
  libraryPrefix,
  // 拖出链路（便于自动化验证：不开真拖拽也能拿到要交给系统的文件路径）
  ensureDragFile,
  ensureFxDragFile,
  fxAudible,
  startDragOut,
  syncAiPanelBounds,
  // 分类树（便于自动化验证）
  createCategory,
  categorySubtreeIds,
  categoryChildren,
  setCatCollapsed,
  isCatCollapsed,
  countInCategoryTree,
  // 采样器（便于自动化验证：不用真的按键也能触发试听/渲染）
  openSamplerPanel,
  closeSamplerPanel,
  samplerSet,
  samplerSyncUI,
  samplerPreview,
  samplerStop,
  samplerRender,
  samplerRestore,
  samplerLoadBuffer,
  renderSampler,
  samplerSig,
  samplerWindow,
  // 拖出前的准备（自动化验证用：不触发原生拖拽也能验证渲染/闸门）
  ensureFxDragFile,
  ensureDragFile,
  collectDragFiles,
  // 存储位置 / 备份 / 悬停试听
  renderStorageInfo,
  migrateStorage,
  resetStorage,
  renderBackupList,
  createBackupNow,
  restoreBackup,
  applyHoverAudition,
  queueHoverPreview,
  cancelHoverPreview,
  storageOf: () => sb.invoke('storage:info'),
  backupsOf: () => sb.invoke('backup:list'),
  // 生成底噪（便于自动化验证：不用点菜单也能开面板、跑生成、试听、入库）
  openSynthPanel,
  closeSynthPanel,
  // 混音（CDP 实测用）
  mixState: () => mix,
  synthRun,
  synthSaveAndImport,
  synthPlay,
  // 合成的候选/参数面板：CDP 实测要用，也方便以后写自动化
  openSynthDetail,
  closeSynthDetail,
  applySynthDetail,
  renderSynthCandidates,
  selectSynthCandidate,
  synthPlayCandidate,
  synthSaveCandidate,
  synthDragCandidate,
  synthTimeTag,
  synthQueryTime,
  setAiTab,
  renderAiModelBar,
  switchAiProfile,
  loadAgentProfiles,
  // 多套 AI 配置（CDP 实测 + 以后做 CLI 用）
  loadAgentProfiles,
  renderAgentProfiles,
  activateAgentProfile,
  saveAgentProfileAsNew,
  deleteAgentProfile,
  synthState: () => synth
};

// ---------------------------------------------------------------------------
// VST3 插件效果器（离线渲染）
//
// 渲染进程没法直接加载 VST3，所以走主进程的 sidecar：选插件 → 读参数 → 渲染成
// 一份 WAV（<userData>\cache\vst\<签名>\），试听和拖出都用这份文件。
// 纯乐器插件（采样器）不接受音频输入，会明确提示。
// ---------------------------------------------------------------------------

const vst = {
  open: false,
  busy: false,
  plugins: [],
  plugin: null,
  names: [],
  name: null,
  params: [],
  values: {},
  lastOut: null,
};

function vstStatus(text, kind = '') {
  const el = document.getElementById('vstStatus');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'ai-status' + (kind ? ' ' + kind : '');
}

function ensureVstDom() {
  if (document.getElementById('vstPanel')) return;
  const scrim = document.createElement('div');
  scrim.className = 'settings-scrim hidden';
  scrim.id = 'vstScrim';

  const panel = document.createElement('aside');
  panel.className = 'settings hidden';
  panel.id = 'vstPanel';
  panel.innerHTML = `
    <div class="settings-head">
      <h3>VST3 插件</h3>
      <button class="icon-btn" id="vstClose" title="关闭">✕</button>
    </div>
    <div class="settings-body">
      <p class="setting-desc small">用一个 VST3 效果器处理当前选中的音频：先在下面挑插件，读到参数后调好，再点「渲染试听」。渲染结果会作为这条素材的播放/拖出版本（缓存里，不动原文件）。</p>
      <div class="ai-status" id="vstStatus">还没扫描插件</div>
      <div class="setting-row spread" style="gap:8px; margin-top:10px">
        <select id="vstPlugin" class="vst-select"><option value="">（先点扫描）</option></select>
        <button class="btn" id="vstScan">扫描</button>
      </div>
      <div class="setting-row spread" id="vstNameRow" style="gap:8px; margin-top:8px; display:none">
        <select id="vstName" class="vst-select"></select>
        <button class="btn" id="vstParams">读参数</button>
      </div>
      <div class="setting-row spread" style="gap:8px; margin-top:8px">
        <input id="vstNameText" class="vst-text" placeholder="子插件名字（壳插件用，可手填）">
        <button class="btn" id="vstNames">列子插件</button>
      </div>
      <div id="vstParamBox" class="vst-params"></div>
      <div class="setting-row wrap" style="gap:8px; margin-top:12px">
        <button class="btn primary" id="vstRender">渲染试听</button>
        <button class="btn" id="vstRestore">还原原始</button>
      </div>
      <p class="setting-desc small" id="vstNote">纯乐器/采样器插件不接受音频输入，这里的流程只适用于效果器。</p>
    </div>`;
  document.body.appendChild(scrim);
  document.body.appendChild(panel);

  document.getElementById('vstClose').addEventListener('click', () => closeVstPanel());
  scrim.addEventListener('click', () => closeVstPanel());
  document.getElementById('vstScan').addEventListener('click', () => vstScan());
  document.getElementById('vstPlugin').addEventListener('change', (e) => vstPick(e.target.value));
  document.getElementById('vstName').addEventListener('change', (e) => { vst.name = e.target.value || null; });
  document.getElementById('vstParams').addEventListener('click', () => vstLoadParams());
  document.getElementById('vstNames').addEventListener('click', () => vstListNames());
  document.getElementById('vstNameText').addEventListener('input', (e) => {
    vst.name = e.target.value.trim() || null;
  });
  document.getElementById('vstRender').addEventListener('click', () => vstRenderNow());
  document.getElementById('vstRestore').addEventListener('click', () => vstRestore());
}

function openVstPanel() {
  ensureVstDom();
  if (state.ai.open) closeAiPanel();
  if (fxOpen) closeFxPanel();
  if (similarTargetPath) closeSimilarPanel();
  if (state.infoOpen) closeInfoPanel(true);
  if (state.settingsOpen) closeSettings();
  vst.open = true;
  document.getElementById('vstPanel').classList.remove('hidden');
  document.getElementById('vstScrim').classList.remove('hidden');
  if (!vst.plugins.length) vstScan();
}

function closeVstPanel() {
  vst.open = false;
  const panel = document.getElementById('vstPanel');
  const scrim = document.getElementById('vstScrim');
  if (panel) panel.classList.add('hidden');
  if (scrim) scrim.classList.add('hidden');
}

async function vstScan() {
  ensureVstDom();
  vstStatus('正在扫描 VST3…', 'busy');
  const res = await sb.invoke('plugins:scan');
  if (!res || !res.ok) {
    vstStatus('扫描失败：' + (res && res.error ? res.error : '未知原因'), 'err');
    return;
  }
  vst.plugins = (res.plugins || []).filter((p) => /\.vst3$/i.test(p.path));
  const sel = document.getElementById('vstPlugin');
  sel.innerHTML = vst.plugins.length
    ? vst.plugins.map((p, i) => `<option value="${i}">${escapeHtml(p.name)}</option>`).join('')
    : '<option value="">（没找到 .vst3）</option>';
  if (vst.plugins.length) {
    sel.value = '0';
    vstStatus(`找到 ${vst.plugins.length} 个 VST3 插件`);
    vstPick('0');
  } else {
    vstStatus('这台机器上没有扫描到 VST3 插件（也可以手动填路径）', 'err');
  }
}

async function vstPick(value) {
  ensureVstDom();
  const idx = Number(value);
  vst.plugin = vst.plugins[idx] ? vst.plugins[idx].path : null;
  vst.name = null;
  vst.names = [];
  vst.params = [];
  vst.values = {};
  document.getElementById('vstParamBox').innerHTML = '';
  const nameRow = document.getElementById('vstNameRow');
  if (!vst.plugin) { nameRow.style.display = 'none'; return; }

  // 壳插件要额外选子插件，但列举很可能慢（Waves 有几百个），
  // 所以不在选中时自动发，而是点「列子插件」才发；也可以直接手填名字。
  nameRow.style.display = 'flex';
  vst.name = null;
  document.getElementById('vstName').innerHTML = '<option value="">（点「列子插件」或直接手填）</option>';
  document.getElementById('vstNameText').value = '';
  vstStatus('插件就绪：普通插件直接点「读参数」；壳插件（比如 Waves）先列子插件或手填名字');
}

async function vstListNames() {
  if (!vst.plugin) { vstStatus('先选插件', 'err'); return; }
  const btn = document.getElementById('vstNames');
  btn.disabled = true;
  vstStatus('正在列举子插件…（壳插件可能要十几秒）', 'busy');
  const res = await sb.invoke('vst:names', { plugin: vst.plugin });
  btn.disabled = false;
  if (!res || !res.ok) {
    vstStatus('列举失败：' + ((res && res.error) || '未知原因') + '（可以在右边直接手填子插件名）', 'err');
    return;
  }
  const names = (res.names || []).filter(Boolean);
  if (!names.length) { vstStatus('这个插件没有子插件', 'err'); return; }
  const sel = document.getElementById('vstName');
  sel.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  vst.names = names;
  vst.name = names[0];
  sel.value = vst.name;
  vstStatus(`壳插件：${names.length} 个子插件，已选「${names[0]}」，可以点「读参数」了`);
}

async function vstLoadParams() {
  if (!vst.plugin) { vstStatus('先选插件', 'err'); return; }
  vstStatus('正在读参数…', 'busy');
  const res = await sb.invoke('vst:params', {
    plugin: vst.plugin,
    pluginName: vst.name,
  });
  if (!res || !res.ok) {
    vstStatus('读参数失败：' + (res && res.error ? res.error : '未知原因'), 'err');
    return;
  }
  vst.params = (res.params || []).filter((p) => typeof p.min_value === 'number' && typeof p.max_value === 'number' && p.max_value > p.min_value);
  vst.values = {};
  for (const p of vst.params) {
    vst.values[p.name] = typeof p.value === 'number' ? p.value : p.min_value;
  }
  renderVstParams();
  vstStatus(`${res.name || '插件'}：${vst.params.length} 个可调参数`);
}

function renderVstParams() {
  const box = document.getElementById('vstParamBox');
  if (!vst.params.length) {
    box.innerHTML = '<p class="setting-desc small">这个插件没有暴露数值参数（有的插件参数只能在它自己的界面里调）。</p>';
    return;
  }
  box.innerHTML = vst.params.slice(0, 40).map((p) => {
    const v = vst.values[p.name];
    const step = (p.max_value - p.min_value) / 200;
    return `<label class="vst-param">
      <span class="vst-param-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
      <input type="range" data-param="${escapeHtml(p.name)}" min="${p.min_value}" max="${p.max_value}" step="${step}" value="${v}">
      <span class="vst-param-val" data-for="${escapeHtml(p.name)}">${fmtVstValue(p.name)}</span>
    </label>`;
  }).join('');
  for (const el of box.querySelectorAll('input[type=range]')) {
    el.addEventListener('input', (e) => {
      const name = e.target.dataset.param;
      vst.values[name] = Number(e.target.value);
      const out = box.querySelector(`[data-for="${CSS.escape(name)}"]`);
      if (out) out.textContent = fmtVstValue(name);
    });
  }
}

function fmtVstValue(name) {
  const p = vst.params.find((x) => x.name === name);
  const v = vst.values[name];
  if (!p || typeof v !== 'number') return '';
  const span = p.max_value - p.min_value;
  const txt = span >= 20 ? v.toFixed(1) : v.toFixed(3);
  return p.label && p.label !== 'None' ? `${txt} ${p.label}` : txt;
}

function currentVstItem() {
  return state.byPath.get(state.currentPath) || null;
}

async function vstRenderNow() {
  const it = currentVstItem();
  if (!it) { vstStatus('先在列表里选一条音频', 'err'); return; }
  if (!vst.plugin) { vstStatus('先选插件', 'err'); return; }
  if (vst.busy) return;
  vst.busy = true;
  vstStatus('正在渲染…（插件处理可能要点时间）', 'busy');
  const t0 = performance.now();
  const res = await sb.invoke('vst:render', {
    plugin: vst.plugin,
    pluginName: vst.name,
    path: it.playPath || it.path,
    params: vst.values,
    label: vst.name || undefined,
    tailSeconds: 0.8,
  });
  vst.busy = false;
  if (!res || !res.ok) {
    vstStatus('渲染失败：' + (res && res.error ? res.error : '未知原因'), 'err');
    return;
  }
  vst.lastOut = res.path;
  const ms = Math.round(performance.now() - t0);
  it.vstPath = res.path;
  it.playPath = res.path;
  scheduleSave();
  // 不自动切播放：插件结果可能比原材料长（尾音/ADSR），自动接管容易让波形和缓存同时重读，
  // 这里只把路径存下来，试听交给用户点播放键
  vstStatus(`渲染好了（${(res.bytes / 1024 / 1024).toFixed(1)} MB，${ms} ms）${res.cached ? '，命中缓存' : ''}，已改用这份文件播放/拖出`, 'ok');
  toast('插件处理完成，按空格试听');
  requestAnimationFrame(() => scheduleRender());
}

function vstRestore() {
  const it = currentVstItem();
  if (!it) { vstStatus('先选一条音频', 'err'); return; }
  delete it.vstPath;
  it.playPath = it.path;
  scheduleSave();
  vstStatus('已还原成原始素材，下次播放就是原文件');
  toast('已还原');
  requestAnimationFrame(() => { scheduleRender(); updateWavePanel(); });
}

// 效果器抽屉底部挂一个入口
(function hookVstEntry() {
  const body = document.querySelector('#fxPanel .settings-body');
  if (!body) return;
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.id = 'fxVstBtn';
  btn.textContent = 'VST3 插件…';
  btn.style.marginTop = '10px';
  btn.addEventListener('click', () => openVstPanel());
  body.appendChild(btn);
})();

// ---------------------------------------------------------------------------
// 内置采样器
//
// 把当前选中的素材当成一条 one-shot 采样：变调、截取区间、循环、包络、滤波、声像。
// 键盘/按钮只做"试听"；点「渲染成这个版本」才会离线渲染成 WAV 落进 cache\sampler，
// 并把这条素材的播放与拖出换成那份文件（和 VST 渲染一个套路，随时可还原）。
// 采样源永远是原始文件（it.path），不会在已渲染版本上再叠一层。
// ---------------------------------------------------------------------------

const samplerUi = {
  open: false,
  busy: false,
  ctx: null,
  buffer: null,
  bufferKey: '',
  voice: null,
};

function samplerStatus(text, kind = '') {
  const el = document.getElementById('spStatus');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'ai-status' + (kind ? ' ' + kind : '');
}

function samplerItem() {
  return state.byPath.get(state.currentPath) || null;
}

function samplerCtx() {
  if (!samplerUi.ctx) samplerUi.ctx = new AudioContext({ latencyHint: 'interactive' });
  if (samplerUi.ctx.state === 'suspended') samplerUi.ctx.resume().catch(() => {});
  return samplerUi.ctx;
}

/** 解码采样源；同一个文件只解一次。 */
async function samplerLoadBuffer(force = false) {
  const it = samplerItem();
  if (!it) throw new Error('先在列表里选一条音频');
  const src = it.path;
  // 缓存键带上大小和修改时间：源文件被替换过就不会拿旧的解码结果
  const key = `${src}|${it.size || 0}|${it.mtimeMs || 0}`;
  if (!force && samplerUi.buffer && samplerUi.bufferKey === key) return samplerUi.buffer;
  const ctx = samplerCtx();
  const url = audioUrl(src);
  const res = await fetch(url);
  if (!res.ok) throw new Error('读不到源文件（' + res.status + '）');
  const data = await res.arrayBuffer();
  const buf = await ctx.decodeAudioData(data.slice(0));
  samplerUi.buffer = buf;
  samplerUi.bufferKey = key;
  return buf;
}

const SAMPLER_SLIDERS = [
  { id: 'spPitch', key: 'pitch', min: -24, max: 24, step: 1, fmt: (v) => (v > 0 ? '+' : '') + v + ' 半音' },
  { id: 'spFine', key: 'fine', min: -100, max: 100, step: 1, fmt: (v) => (v > 0 ? '+' : '') + v + ' 音分' },
  { id: 'spAttack', key: 'attack', min: 0, max: 2, step: 0.005, fmt: (v) => v.toFixed(v < 0.1 ? 3 : 2) + ' s' },
  { id: 'spDecay', key: 'decay', min: 0.01, max: 3, step: 0.01, fmt: (v) => v.toFixed(2) + ' s' },
  { id: 'spSustain', key: 'sustain', min: 0, max: 100, step: 1, fmt: (v) => v + '%' },
  { id: 'spRelease', key: 'release', min: 0.01, max: 4, step: 0.01, fmt: (v) => v.toFixed(2) + ' s' },
  { id: 'spLp', key: 'lp', min: 200, max: 20000, step: 50, fmt: (v) => (v >= 1000 ? (v / 1000).toFixed(1) + ' kHz' : v + ' Hz') },
  { id: 'spHp', key: 'hp', min: 10, max: 2000, step: 5, fmt: (v) => v + ' Hz' },
  { id: 'spGain', key: 'gainDb', min: -60, max: 12, step: 0.5, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB' },
  { id: 'spPan', key: 'pan', min: -100, max: 100, step: 1, fmt: (v) => (v === 0 ? '居中' : (v < 0 ? '左 ' : '右 ') + Math.abs(v) + '%') }
];

function samplerRowHtml(s) {
  return `<div class="setting-row spread"><span class="mini-label">${s.label}</span><span class="muted" id="${s.id}Val"></span></div>
      <input type="range" class="inline-range" id="${s.id}" min="${s.min}" max="${s.max}" step="${s.step}">`;
}

function ensureSamplerDom() {
  if (document.getElementById('samplerPanel')) return;
  const scrim = document.createElement('div');
  scrim.className = 'settings-scrim hidden';
  scrim.id = 'samplerScrim';

  const panel = document.createElement('aside');
  panel.className = 'settings hidden';
  panel.id = 'samplerPanel';
  const rows = [
    { ...SAMPLER_SLIDERS[0], label: '音高' },
    { ...SAMPLER_SLIDERS[1], label: '微调' },
    { ...SAMPLER_SLIDERS[2], label: '启动' },
    { ...SAMPLER_SLIDERS[3], label: '衰减' },
    { ...SAMPLER_SLIDERS[4], label: '延音' },
    { ...SAMPLER_SLIDERS[5], label: '释放' },
    { ...SAMPLER_SLIDERS[6], label: '低通' },
    { ...SAMPLER_SLIDERS[7], label: '高通' },
    { ...SAMPLER_SLIDERS[8], label: '音量' },
    { ...SAMPLER_SLIDERS[9], label: '声像' }
  ];
  panel.innerHTML = `
    <div class="settings-head">
      <h3>采样器</h3>
      <button class="icon-btn" id="spClose" title="关闭">✕</button>
    </div>
    <div class="settings-body">
      <div class="ai-status" id="spStatus">选一条音频，下面调完点「试听」或直接「渲染」</div>
      <div class="setting-row spread" style="margin-top:10px">
        <span class="mini-label">采样源</span><span class="muted" id="spSource">未选择</span>
      </div>
      <div class="setting-row spread" style="margin-top:6px">
        <span class="mini-label">起点</span>
        <span class="muted" id="spStartVal">00:00.000</span>
      </div>
      <input type="range" class="inline-range" id="spStart" min="0" max="1" step="0.005">
      <div class="setting-row spread">
        <span class="mini-label">终点</span>
        <span class="muted" id="spEndVal">整段</span>
      </div>
      <input type="range" class="inline-range" id="spEnd" min="0" max="1" step="0.005">
      <div class="setting-row spread" style="margin-top:6px">
        <span class="mini-label">循环</span>
        <div class="seg" id="spLoop">
          <button class="seg-btn active" data-v="off">关</button>
          <button class="seg-btn" data-v="on">开</button>
        </div>
      </div>
      ${rows.map((s) => samplerRowHtml(s)).join('\n      ')}
      <div class="mini-label" style="margin-top:12px">键盘试听（点格子，或用 A W S E D F T G Y H U J K）</div>
      <div class="sp-keys" id="spKeys"></div>
      <div class="setting-row wrap" style="gap:8px; margin-top:12px">
        <button class="btn" id="spPlay">试听</button>
        <button class="btn primary" id="spRender">渲染成这个版本</button>
        <button class="btn" id="spRestore">还原原始</button>
      </div>
      <p class="setting-desc small" id="spNote">渲染结果会接管这条素材的播放与拖出（缓存在 data\\cache\\sampler，不动原文件）。采样源永远是原始文件。</p>
    </div>`;
  document.body.appendChild(scrim);
  document.body.appendChild(panel);

  const keys = document.getElementById('spKeys');
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B', 'C'];
  for (let i = 0; i < 13; i++) {
    const b = document.createElement('button');
    b.className = 'sp-key' + (names[i].includes('#') ? ' black' : '');
    b.dataset.semi = String(i);
    b.textContent = names[i] + (i === 12 ? '5' : '4');
    keys.appendChild(b);
  }

  document.getElementById('spClose').addEventListener('click', () => closeSamplerPanel());
  scrim.addEventListener('click', () => closeSamplerPanel());
  document.getElementById('spPlay').addEventListener('click', () => {
    if (samplerUi.voice) { samplerStop(); return; }
    samplerPreview(0, true);
  });
  document.getElementById('spRender').addEventListener('click', () => samplerRender());
  document.getElementById('spRestore').addEventListener('click', () => samplerRestore());
  document.getElementById('spLoop').addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    samplerSet({ loop: b.dataset.v });
  });
  for (const s of SAMPLER_SLIDERS) {
    const el = document.getElementById(s.id);
    if (!el) continue;
    el.addEventListener('input', () => {
      const raw = Number(el.value);
      const v = s.key === 'sustain' ? raw / 100 : s.key === 'pan' ? raw / 100 : raw;
      samplerSet({ [s.key]: v });
    });
  }
  document.getElementById('spStart').addEventListener('input', (e) => samplerSet({ start: Number(e.target.value) }));
  document.getElementById('spEnd').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    samplerSet({ end: v >= samplerDuration() - 0.005 ? null : v });
  });
  keys.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('[data-semi]');
    if (!b) return;
    b.setPointerCapture(e.pointerId);
    samplerPreview(Number(b.dataset.semi), false);
  });
  // 松手可能落在键外，所以挂在 window 上，避免"一直响"
  window.addEventListener('pointerup', () => { if (samplerUi.voice) samplerStop(); });
  window.addEventListener('pointercancel', () => { if (samplerUi.voice) samplerStop(); });
}

function samplerDuration() {
  return samplerUi.buffer ? samplerUi.buffer.duration : 0;
}

function samplerSyncUI() {
  const p = state.sampler;
  for (const s of SAMPLER_SLIDERS) {
    const el = document.getElementById(s.id);
    const lab = document.getElementById(s.id + 'Val');
    if (!el || !lab) continue;
    const raw = s.key === 'sustain' || s.key === 'pan' ? Math.round(p[s.key] * 100) : p[s.key];
    el.value = String(raw);
    lab.textContent = s.fmt(raw);
  }
  const dur = samplerDuration();
  const startEl = document.getElementById('spStart');
  const endEl = document.getElementById('spEnd');
  if (startEl && endEl) {
    const max = Math.max(0.01, dur || 1);
    startEl.max = endEl.max = String(max.toFixed(3));
    const win = dur ? samplerWindow(p, dur) : { start: 0, end: max };
    startEl.value = String(win.start.toFixed(3));
    endEl.value = String(win.end.toFixed(3));
  }
  const startLab = document.getElementById('spStartVal');
  const endLab = document.getElementById('spEndVal');
  const win = dur ? samplerWindow(p, dur) : null;
  if (startLab) startLab.textContent = win ? fmtTC(win.start) : '00:00.000';
  if (endLab) endLab.textContent = win ? (p.end === null ? '整段（到结尾）' : fmtTC(win.end)) : '整段';
  const loop = document.getElementById('spLoop');
  if (loop) {
    for (const b of loop.querySelectorAll('[data-v]')) {
      b.classList.toggle('active', b.dataset.v === p.loop);
    }
  }
  const it = samplerItem();
  const src = document.getElementById('spSource');
  if (src) src.textContent = it ? it.name : '未选择';
  const play = document.getElementById('spPlay');
  if (play) play.textContent = samplerUi.voice ? '停止' : '试听';
}

function samplerSet(patch) {
  state.sampler = clampSampler({ ...state.sampler, ...patch });
  samplerSyncUI();
  scheduleSave();
}

function samplerStop() {
  if (samplerUi.voice) {
    try { samplerUi.voice.stop(); } catch { /* 已停止 */ }
    samplerUi.voice = null;
  }
  samplerSyncUI();
}

async function samplerPreview(semiOffset, holdFixed) {
  const it = samplerItem();
  if (!it) { samplerStatus('先在列表里选一条音频', 'err'); return; }
  try {
    const buf = await samplerLoadBuffer();
    samplerStop();
    const ctx = samplerCtx();
    const voice = playSamplerNote(ctx, buf, state.sampler, semiOffset, ctx.destination);
    samplerUi.voice = voice;
    samplerSyncUI();
    samplerStatus(`试听 ${semiOffset > 0 ? '+' : ''}${semiOffset} 半音（${fmtTC(samplerWindow(state.sampler, buf.duration).start)} 起）`);
    if (holdFixed) {
      const p = state.sampler;
      const body = (samplerWindow(p, buf.duration).end - samplerWindow(p, buf.duration).start) / Math.pow(2, (p.pitch + p.fine / 100 + semiOffset) / 12);
      const wait = Math.min(8, body + p.attack + p.decay + 0.05);
      setTimeout(() => {
        if (samplerUi.voice === voice) samplerStop();
      }, wait * 1000);
    }
  } catch (err) {
    samplerStatus('读不了这条音频：' + String(err && err.message ? err.message : err), 'err');
  }
}

async function samplerRender() {
  const it = samplerItem();
  if (!it) { samplerStatus('先在列表里选一条音频', 'err'); return; }
  if (samplerUi.busy) return;
  samplerUi.busy = true;
  samplerStop();
  samplerStatus('正在渲染…', 'busy');
  const t0 = performance.now();
  try {
    const buf = await samplerLoadBuffer();
    const out = await renderSampler(buf, state.sampler, { sampleRate: buf.sampleRate });
    const wav = encodeWav24(out);
    const base = String(it.name || 'audio').replace(/\.[^.]+$/, '');
    const res = await sb.invoke('audio:sampler-wav', {
      buffer: wav,
      base,
      sig: samplerSig(state.sampler, it.path)
    });
    if (!res || !res.ok) throw new Error((res && res.reason) || '写入失败');
    it.samplerPath = res.path;
    it.playPath = res.path;
    scheduleSave();
    const ms = Math.round(performance.now() - t0);
    samplerStatus(`渲染好了（${(res.bytes / 1024).toFixed(0)} KB，${ms} ms），已改用这份文件播放/拖出`, 'ok');
    toast('采样器版本已生效，已切到这一版播放');
    requestAnimationFrame(() => { scheduleRender(); updateWavePanel(); });
    playItem(it);
  } catch (err) {
    samplerStatus('渲染失败：' + String(err && err.message ? err.message : err), 'err');
  } finally {
    samplerUi.busy = false;
  }
}

function samplerRestore() {
  const it = samplerItem();
  if (!it) { samplerStatus('先选一条音频', 'err'); return; }
  delete it.samplerPath;
  it.playPath = it.path;
  samplerStop();
  scheduleSave();
  samplerStatus('已还原成原始素材，下次播放就是原文件');
  toast('已还原');
  requestAnimationFrame(() => { scheduleRender(); updateWavePanel(); });
}

function openSamplerPanel() {
  ensureSamplerDom();
  if (state.ai.open) closeAiPanel();
  if (fxOpen) closeFxPanel();
  if (typeof vst !== 'undefined' && vst && vst.open) closeVstPanel();
  if (similarTargetPath) closeSimilarPanel();
  if (state.infoOpen) closeInfoPanel(true);
  if (state.settingsOpen) closeSettings();
  samplerUi.open = true;
  document.getElementById('samplerPanel').classList.remove('hidden');
  document.getElementById('samplerScrim').classList.remove('hidden');
  samplerSyncUI();
  samplerStatus(samplerItem() ? '调好参数点「试听」，满意再「渲染成这个版本」' : '先在列表里选一条音频');
  // 预解码，省得第一次按键要等一下
  samplerLoadBuffer().then(() => samplerSyncUI()).catch(() => {});
}

function closeSamplerPanel() {
  samplerUi.open = false;
  samplerStop();
  const panel = document.getElementById('samplerPanel');
  const scrim = document.getElementById('samplerScrim');
  if (panel) panel.classList.add('hidden');
  if (scrim) scrim.classList.add('hidden');
}

// 面板打开时接管键盘（A W S E D F T G Y H U J K）
(function hookSamplerKeys() {
  const down = new Set();
  window.addEventListener('keydown', (e) => {
    if (!samplerUi.open) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const k = String(e.key || '').toLowerCase();
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!(k in KEY_MAP)) return;
    e.preventDefault();
    if (down.has(k)) return;
    down.add(k);
    samplerPreview(KEY_MAP[k], false);
  });
  window.addEventListener('keyup', (e) => {
    const k = String(e.key || '').toLowerCase();
    if (!down.has(k)) return;
    down.delete(k);
    samplerStop();
  });
  window.addEventListener('blur', () => { down.clear(); samplerStop(); });
})();

// 切换素材时把采样源一并换掉
(function hookSamplerFollow() {
  let lastPath = null;
  setInterval(() => {
    if (!samplerUi.open) return;
    if (state.currentPath === lastPath) return;
    lastPath = state.currentPath;
    samplerUi.buffer = null;
    samplerUi.bufferKey = '';
    samplerStop();
    samplerSyncUI();
    samplerLoadBuffer().then(() => samplerSyncUI()).catch(() => {});
  }, 600);
})();