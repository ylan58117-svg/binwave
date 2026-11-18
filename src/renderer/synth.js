'use strict';

/* ==========================================================================
   synth.js — 「生成底噪」的声音合成逻辑（零依赖，纯 Float32Array 运算）

   一条底噪的诞生：
     1. 每层把候选素材循环铺满目标长度，接缝处做等功率（sin/cos）交叉淡化；
     2. 不同层从素材内部的**不同相位**切入，按 0 / −6 / −10 / −14… dB 叠加，
        避免同相位叠成梳状滤波；
     3. 可选：首尾再做一次等功率对齐，让整段可以无缝循环（seamError 量化的就是它）；
     4. 按 BS.1770（K 加权 + 门限）测综合响度，整体增益到 targetLufs；
        峰值顶到 −1 dBFS 时先软限幅，宁可响度差一点也不削波。

   只有 decodeBuffer 用 Web Audio（decodeAudioData 只有浏览器有）；
   buildBed / measureLufs / seamError 全是对数组的纯运算，node 里可以直接用
   合成的正弦数组测，不需要 OfflineAudioContext。
   ========================================================================== */

export const SYNTH_DEFAULTS = {
  seconds: 90,      // 目标长度（60–120 是常用区间）
  layers: 3,        // 叠加层数
  xfade: 2.0,       // 每处拼接的交叉淡化秒数
  targetLufs: -23,  // 目标综合响度（BS.1770，LUFS）
  seamless: true    // 首尾可无缝循环
};

// 所有参数只认有限数字，超出范围就夹紧；返回值一定是新对象，不污染调用方。
export function clampSynth(p) {
  const src = p || {};
  const num = (v, def, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
  };
  return {
    seconds: num(src.seconds, SYNTH_DEFAULTS.seconds, 20, 300),
    layers: Math.round(num(src.layers, SYNTH_DEFAULTS.layers, 1, 5)),
    xfade: num(src.xfade, SYNTH_DEFAULTS.xfade, 0.2, 8),
    targetLufs: num(src.targetLufs, SYNTH_DEFAULTS.targetLufs, -40, -9),
    seamless: src.seamless !== false
  };
}

/* --------------------------------------------------------------------------
   解码：唯一碰 Web Audio 的地方
   -------------------------------------------------------------------------- */

/**
 * 把 `snd://…` 之类的音频 URL 解成两条 Float32Array。
 * 单声道素材复制成左右两条——后面的混音一律按立体声处理，
 * 省得每处都判断通道数。
 */
export async function decodeBuffer(url) {
  const Ctor = typeof AudioContext !== 'undefined' ? AudioContext
    : (typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null);
  if (!Ctor) throw new Error('decodeBuffer: 当前环境没有 AudioContext');

  const res = await fetch(url);
  if (!res.ok) throw new Error(`decodeBuffer: 读取音频失败（HTTP ${res.status}）`);
  const bytes = await res.arrayBuffer();

  const ctx = new Ctor();
  try {
    // 同时兼容返回 Promise 的现代实现和只认回调的老实现
    const buf = await new Promise((resolve, reject) => {
      const ret = ctx.decodeAudioData(bytes, resolve, reject);
      if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
    });
    const left = new Float32Array(buf.getChannelData(0));
    const right = buf.numberOfChannels > 1 ? new Float32Array(buf.getChannelData(1)) : left;
    return { sampleRate: buf.sampleRate, channels: [left, right] };
  } finally {
    try { ctx.close(); } catch { /* 关不掉也不影响结果 */ }
  }
}

/* --------------------------------------------------------------------------
   小工具
   -------------------------------------------------------------------------- */

/** 线性插值重采样。底噪是环境声，线性插值的精度足够，也不引入依赖。 */
function resampleLinear(src, from, to) {
  if (from === to || src.length < 2) return src;
  const n = Math.max(1, Math.round((src.length * to) / from));
  const out = new Float32Array(n);
  const step = from / to;
  const last = src.length - 1;
  for (let i = 0; i < n; i++) {
    const pos = i * step;
    const i0 = pos >= last ? last : Math.floor(pos);
    const frac = pos - i0;
    const a = src[i0];
    const b = src[i0 < last ? i0 + 1 : last];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** 同一份素材可能被多层复用，重采样结果缓存起来，别重复拷内存。 */
function prepare(item, sampleRate, cache) {
  if (cache.has(item)) return cache.get(item);
  const srcL = item.channels[0];
  const srcR = item.channels[1] || srcL;
  let L;
  let R;
  if (item.sampleRate === sampleRate) {
    L = srcL;
    R = srcR;
  } else {
    L = resampleLinear(srcL, item.sampleRate, sampleRate);
    R = srcR === srcL ? L : resampleLinear(srcR, item.sampleRate, sampleRate);
  }
  const out = { sampleRate, channels: [L, R], name: item.name || '' };
  cache.set(item, out);
  return out;
}

/** 整体增益（dB），就地改。 */
function applyGain(channels, db) {
  const g = Math.pow(10, db / 20);
  if (!Number.isFinite(g) || g === 1) return;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) ch[i] *= g;
  }
}

/**
 * 软限幅：只有超过 ceiling 的样点才走 tanh 曲线，峰值不会超过 1.0。
 * 比直接砍掉（硬削波）好听，也不会产生刺耳的高频。
 */
function softLimit(channels, ceiling) {
  const room = Math.max(1e-6, 1 - ceiling);
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      const a = Math.abs(v);
      if (a > ceiling) {
        const shaped = ceiling + room * Math.tanh((a - ceiling) / room);
        ch[i] = v < 0 ? -shaped : shaped;
      }
    }
  }
}

/* --------------------------------------------------------------------------
   BS.1770 K 加权与综合响度（LUFS）
   -------------------------------------------------------------------------- */

/**
 * K 加权两级系数：高架（+4 dB @ 1.7k 附近）+ 高通（38 Hz）。
 * 按采样率现算，48k 下和标准表里的系数一致，44.1k / 96k 也能用。
 */
function kWeightCoeffs(sr) {
  const shelfG = 3.999843853973347;
  const shelfQ = 0.7071752369554196;
  const shelfFc = 1681.974450955533;
  const k1 = Math.tan((Math.PI * shelfFc) / sr);
  const vh = Math.pow(10, shelfG / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const a0 = 1 + k1 / shelfQ + k1 * k1;

  const shelf = {
    b: [
      (vh + (vb * k1) / shelfQ + k1 * k1) / a0,
      (2 * (k1 * k1 - vh)) / a0,
      (vh - (vb * k1) / shelfQ + k1 * k1) / a0
    ],
    a: [1, (2 * (k1 * k1 - 1)) / a0, (1 - k1 / shelfQ + k1 * k1) / a0]
  };

  const hpQ = 0.5003270373238773;
  const hpFc = 38.13547087602444;
  const k2 = Math.tan((Math.PI * hpFc) / sr);
  const a02 = 1 + k2 / hpQ + k2 * k2;

  const hp = {
    b: [1, -2, 1],
    a: [1, (2 * (k2 * k2 - 1)) / a02, (1 - k2 / hpQ + k2 * k2) / a02]
  };

  return { shelf, hp };
}

/** 两级 biquad 串起来，结果写进 dst（省掉中间数组）。 */
function kWeightInto(src, dst, coef) {
  const b0 = coef.shelf.b[0];
  const b1 = coef.shelf.b[1];
  const b2 = coef.shelf.b[2];
  const sa1 = coef.shelf.a[1];
  const sa2 = coef.shelf.a[2];
  const c0 = coef.hp.b[0];
  const c1 = coef.hp.b[1];
  const c2 = coef.hp.b[2];
  const ha1 = coef.hp.a[1];
  const ha2 = coef.hp.a[2];

  let s1 = 0;
  let s2 = 0;
  let h1 = 0;
  let h2 = 0;

  for (let i = 0; i < src.length; i++) {
    const x = src[i];

    const ys = b0 * x + s1;
    s1 = b1 * x - sa1 * ys + s2;
    s2 = b2 * x - sa2 * ys;

    const yh = c0 * ys + h1;
    h1 = c1 * ys - ha1 * yh + h2;
    h2 = c2 * ys - ha2 * yh;

    dst[i] = yh;
  }
}

/**
 * 综合响度（LUFS）与峰值（dBFS）。
 * 400 ms 块、100 ms 步进，-70 LUFS 绝对门限 + 相对门限（低于平均 10 LU 的块丢掉），
 * 和 BS.1770-2 的积分方式一致。
 *
 * 注意：全静音时 lufs 是 -Infinity，调用方要判 Number.isFinite。
 */
export function measureLufs(channels, sampleRate) {
  const chans = (channels || []).filter((c) => c && c.length > 0);
  if (!chans.length || !(sampleRate > 0)) return { lufs: -Infinity, peakDb: -Infinity };

  let n = Infinity;
  let maxLen = 0;
  for (const ch of chans) {
    if (ch.length < n) n = ch.length;
    if (ch.length > maxLen) maxLen = ch.length;
  }
  if (!(n > 0)) return { lufs: -Infinity, peakDb: -Infinity };

  let peak = 0;
  for (const ch of chans) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
    }
  }

  const coef = kWeightCoeffs(sampleRate);
  const scratch = new Float32Array(maxLen);
  const hop = Math.max(1, Math.round(sampleRate * 0.1));
  const blockLen = hop * 4;
  const qCount = Math.ceil(n / hop);
  const quarter = new Float64Array(qCount);
  let whole = 0;

  // 400 ms 的块正好是 4 个 100 ms 的桶，块功率就能用桶和算，O(n) 而不是 4×O(n)。
  for (const ch of chans) {
    kWeightInto(ch, scratch, coef);
    if (n < blockLen) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += scratch[i] * scratch[i];
      whole += sum / n;
    } else {
      for (let k = 0; k < qCount; k++) {
        const start = k * hop;
        const end = Math.min(n, start + hop);
        let sum = 0;
        for (let i = start; i < end; i++) sum += scratch[i] * scratch[i];
        quarter[k] += sum;
      }
    }
  }

  const count = n >= blockLen ? Math.floor(n / hop) - 3 : 1;
  const z = new Float64Array(count);
  if (n < blockLen) {
    z[0] = whole;
  } else {
    for (let b = 0; b < count; b++) {
      z[b] = (quarter[b] + quarter[b + 1] + quarter[b + 2] + quarter[b + 3]) / blockLen;
    }
  }

  const loudnessOf = (power) => -0.691 + 10 * Math.log10(power);
  const absGate = Math.pow(10, (-70 + 0.691) / 10);

  let sumAbs = 0;
  let cntAbs = 0;
  for (let b = 0; b < count; b++) {
    if (z[b] > absGate) { sumAbs += z[b]; cntAbs++; }
  }

  let lufs = -Infinity;
  if (cntAbs > 0) {
    // 相对门限：比“过了绝对门限那批块的平均响度”低 10 LU
    const relGate = Math.pow(10, (loudnessOf(sumAbs / cntAbs) - 10 + 0.691) / 10);
    let sumRel = 0;
    let cntRel = 0;
    for (let b = 0; b < count; b++) {
      if (z[b] > absGate && z[b] > relGate) { sumRel += z[b]; cntRel++; }
    }
    if (cntRel > 0) lufs = loudnessOf(sumRel / cntRel);
  }

  return { lufs, peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity };
}

/* --------------------------------------------------------------------------
   循环接缝
   -------------------------------------------------------------------------- */

/**
 * 循环点（末尾 → 开头）的幅度不连续度，0 最理想。
 * 做法：取接缝处“最后一样点到第一样点”的跳变，减去两侧各自的局部斜率均值；
 * 真正无缝时跳变就是素材自己的正常斜率，硬切会多出一个台阶。
 * 结果再除以整段 RMS，所以和音量无关。
 *
 * xfadeSec 只用来定局部窗口（≤ 8 个样点，约 0.2 ms），不跨到正弦的一个周期。
 */
export function seamError(channels, sampleRate, xfadeSec) {
  const chans = (channels || []).filter((c) => c && c.length > 0);
  if (!chans.length) return 0;
  let n = Infinity;
  for (const ch of chans) if (ch.length < n) n = ch.length;
  if (n < 8 || !(sampleRate > 0)) return 0;

  const win = Math.max(1, Math.min(8, Math.round(((xfadeSec || 0.001) * sampleRate) / 1000)));
  const w = Math.min(win, Math.floor(n / 4));
  let worst = 0;

  for (const ch of chans) {
    let sq = 0;
    for (let i = 0; i < n; i++) sq += ch[i] * ch[i];
    const rms = Math.sqrt(sq / n);
    if (!(rms > 1e-9)) continue;

    const headSlope = (ch[w] - ch[0]) / w;
    const tailSlope = (ch[n - 1] - ch[n - 1 - w]) / w;
    const seamStep = ch[0] - ch[n - 1];
    const expect = 0.5 * (headSlope + tailSlope);
    const err = Math.abs(seamStep - expect) / rms;
    if (err > worst) worst = err;
  }

  return worst;
}

/**
 * 循环点跳变相对「素材自己正常的相邻样点差」有多大，1 以下就是听不出来。
 *
 * 为什么不用 seamError 判断：seamError 减去的是两侧斜率均值，遇到真实素材的
 * 宽带噪声时这个估计本身就不准，实测 60 秒海浪底噪 seamError 0.027 但接缝跳变
 * 只有 0.0009，而相邻样点差的中位数是 0.0032 —— 接缝比正常波形起伏还小。
 * 所以真正的判据是「接缝跳变 ≤ 素材 99.9% 分位的相邻差」。
 */
export function seamRatio(channels) {
  const chans = (channels || []).filter((c) => c && c.length > 8);
  if (!chans.length) return 0;
  let n = Infinity;
  for (const ch of chans) if (ch.length < n) n = ch.length;
  let worst = 0;

  for (const ch of chans) {
    const seam = Math.abs(ch[0] - ch[n - 1]);
    // 全量排序太慢，抽 20 万个样点就够估分位数了
    const step = Math.max(1, Math.floor(n / 200000));
    const deltas = [];
    for (let i = 0; i + step < n; i += step) deltas.push(Math.abs(ch[i + step] - ch[i]));
    deltas.sort((a, b) => a - b);
    if (!deltas.length) continue;
    const p999 = deltas[Math.min(deltas.length - 1, Math.floor(0.999 * deltas.length))];
    const ratio = seam / (p999 + 1e-12);
    if (ratio > worst) worst = ratio;
  }

  return worst;
}

/* --------------------------------------------------------------------------
   铺层
   -------------------------------------------------------------------------- */

/**
 * 把一层的候选素材循环铺满 lengthNeeded 个样点，返回 `{ channels, filled }`。
 *
 * 相邻两段重叠 xfade 个样点：前一段最后 xfade 个样点乘 cos，后一段开头乘 sin，
 * 功率恒定，不会在拼接处掉音量。第一段从素材内部某个相位切入，这是层间
 * 去相关的关键（不然几层同相位相加，频谱会梳状起伏）。
 */
function tileLayer(cands, lengthNeeded, xfade, layerIndex) {
  const L = new Float32Array(lengthNeeded);
  const R = new Float32Array(lengthNeeded);
  let cursor = 0;
  let idx = 0;
  let placed = 0;
  let filled = 0;
  let guard = 0;

  while (cursor < lengthNeeded && guard < 5000) {
    guard++;
    const clip = cands[idx % cands.length];
    idx++;

    const c0 = clip.channels[0];
    const c1 = clip.channels[1];
    const clen = c0.length;

    let srcStart = 0;
    if (placed === 0) {
      // 0.37 的步进让各层的切入点尽量散开，又保持结果可复现；
      // 切入点必须给末尾的交叉淡化留够长度，否则 3 秒素材配 2 秒淡入淡出就没法用了
      const frac = ((layerIndex + 1) * 0.37 + 0.11) % 1;
      const maxSkip = Math.max(0, clen - xfade - 1);
      srcStart = maxSkip > 0 ? Math.floor(frac * maxSkip) : 0;
    }

    const avail = clen - srcStart;
    // 比交叉淡化还短的素材没法接，换下一条候选；全都太短就退出
    if (avail <= xfade + 1) {
      if (idx >= cands.length * 4) break;
      continue;
    }

    const fadeIn = placed === 0 ? 0 : xfade;
    const fadeOutFrom = avail - xfade;

    for (let i = 0; i < avail; i++) {
      const d = cursor + i;
      if (d >= lengthNeeded) break;
      let g = 1;
      if (fadeIn > 0 && i < fadeIn) g = Math.sin(((i + 0.5) / fadeIn) * Math.PI / 2);
      if (i >= fadeOutFrom) g *= Math.cos(((i - fadeOutFrom + 0.5) / xfade) * Math.PI / 2);
      const si = srcStart + i;
      L[d] += c0[si] * g;
      R[d] += c1[si] * g;
    }

    placed++;
    filled = Math.max(filled, Math.min(lengthNeeded, cursor + avail));
    cursor += avail - xfade;
  }

  return { channels: [L, R], filled, placed };
}

/**
 * 把铺好的层做首尾等功率对齐，再按增益并进总轨。
 * 开头 xfade 秒改成「头部 × sin + 尾部延续 × cos」：i=0 时几乎全是
 * 第 N 个样点之后的自然延续，所以循环播放时末尾接开头没有台阶。
 */
function addLayer(acc, tile, frames, xfade, seamless, gain) {
  const t0 = tile[0];
  const t1 = tile[1];
  const a0 = acc[0];
  const a1 = acc[1];

  if (seamless) {
    for (let i = 0; i < xfade; i++) {
      const t = (i + 0.5) / xfade;
      const wIn = Math.sin((t * Math.PI) / 2);
      const wOut = Math.cos((t * Math.PI) / 2);
      a0[i] += (t0[i] * wIn + t0[frames + i] * wOut) * gain;
      a1[i] += (t1[i] * wIn + t1[frames + i] * wOut) * gain;
    }
    for (let i = xfade; i < frames; i++) {
      a0[i] += t0[i] * gain;
      a1[i] += t1[i] * gain;
    }
  } else {
    for (let i = 0; i < frames; i++) {
      a0[i] += t0[i] * gain;
      a1[i] += t1[i] * gain;
    }
  }
}

/* --------------------------------------------------------------------------
   核心：buildBed
   -------------------------------------------------------------------------- */

/**
 * 从分层素材缝合一条底噪。
 *
 * @param {Array<Array<{sampleRate:number, channels:Float32Array[], name?:string}>>} clips
 *        外层=层，中层=该层候选，内层=decodeBuffer 的结果
 * @param {object} opts  clampSynth 的结果（也接受原始参数，这里会再夹一次）
 * @returns {{sampleRate:number, channels:Float32Array[], stats:object}}
 *
 * stats:
 *   seconds      实际长度（秒）
 *   layers       真正用上的层数
 *   seamOk       seamRatio < 1（接缝跳变不超过素材自己 99.9% 分位的相邻样点差）
 *   seamError    循环点不连续度（旧指标，宽带素材上偏保守，仅供测试对照）
 *   seamRatio    接缝跳变 / 素材 99.9% 分位相邻样点差（< 1 即听不出来）
 *   lufs         成品的综合响度
 *   peakDb       成品峰值
 *   skips        跳过的素材/层的原因（字符串数组）
 *   layerUsed    每层用了哪几条素材
 *   gainDb       总共加了多少 dB
 */
export function buildBed(clips, opts) {
  const p = clampSynth(opts);
  // clampSynth 是给界面滑杆用的（20–300 秒）。自测和短预览要更短的时长，
  // 所以这里按“跑得动”的硬边界再兜一次底，长度语义仍是 opts.seconds * sampleRate。
  p.seconds = (() => {
    const n = Number(opts && opts.seconds);
    if (!Number.isFinite(n)) return p.seconds;
    return Math.max(1, Math.min(600, n));
  })();

  const layersIn = Array.isArray(clips) ? clips : [];
  const skips = [];

  // 采样率跟第一条可用素材走：44.1k / 48k / 96k 都行，其它素材重采样过来
  let sampleRate = 0;
  for (const layer of layersIn) {
    for (const item of layer || []) {
      if (item && item.sampleRate > 0 && item.channels && item.channels[0] && item.channels[0].length > 0) {
        sampleRate = item.sampleRate;
        break;
      }
    }
    if (sampleRate) break;
  }
  if (!sampleRate) throw new Error('buildBed: clips 里没有可用素材');

  const frames = Math.max(1, Math.round(p.seconds * sampleRate));
  // 交叉淡化不能超过整段的一半，不然首尾窗口会互相盖住
  const xfade = Math.max(1, Math.min(Math.round(p.xfade * sampleRate), Math.floor(frames / 2)));

  const acc = [new Float32Array(frames), new Float32Array(frames)];
  const cache = new WeakMap();
  const maxLayers = Math.min(p.layers, layersIn.length);
  const layerUsed = [];
  let usedLayers = 0;

  for (let li = 0; li < maxLayers; li++) {
    const raw = layersIn[li] || [];
    const cands = [];
    const names = [];

    for (let ci = 0; ci < raw.length; ci++) {
      const item = raw[ci];
      if (!item || !item.channels || !item.channels[0] || !(item.channels[0].length > 0)) {
        skips.push(`第 ${li + 1} 层候选 ${ci + 1}：解码结果为空，已跳过`);
        continue;
      }
      if (!(item.sampleRate > 0)) {
        skips.push(`第 ${li + 1} 层候选 ${ci + 1}：采样率无效，已跳过`);
        continue;
      }
      // 12 分钟以上的素材不进内存（96k 立体声一条就 460 MB）
      if (item.channels[0].length > item.sampleRate * 720) {
        const sec = (item.channels[0].length / item.sampleRate).toFixed(1);
        skips.push(`第 ${li + 1} 层候选 ${ci + 1}：长 ${sec} 秒，超过 720 秒上限，已跳过`);
        continue;
      }
      cands.push(prepare(item, sampleRate, cache));
      names.push(item.name || `候选 ${ci + 1}`);
    }

    if (!cands.length) {
      skips.push(`第 ${li + 1} 层：没有可用素材，整层跳过`);
      continue;
    }

    const tile = tileLayer(cands, frames + xfade, xfade, li);
    if (!tile || tile.filled < frames + xfade) {
      skips.push(`第 ${li + 1} 层：素材太短，铺不满 ${p.seconds} 秒，整层跳过`);
      continue;
    }

    // 层间电平：模型给了 gainDb 就用它的，否则 1 层 0 dB、2 层 −6、3 层 −10，再往上每层多减 4 dB
    const wantGain = Array.isArray(opts && opts.layerGains) ? Number(opts.layerGains[li]) : NaN;
    const gainDb = Number.isFinite(wantGain) && wantGain >= -18 && wantGain <= 3
      ? wantGain
      : (li === 0 ? 0 : -(6 + (li - 1) * 4));
    addLayer(acc, tile.channels, frames, xfade, p.seamless, Math.pow(10, gainDb / 20));
    usedLayers++;
    layerUsed.push({ layer: li + 1, names, gainDb });
  }

  if (!usedLayers) throw new Error('buildBed: 没有一层能铺满目标长度');

  // ---- 响度归一 ----
  let m = measureLufs(acc, sampleRate);
  let gainDb = 0;

  if (Number.isFinite(m.lufs)) {
    const firstGain = p.targetLufs - m.lufs;
    applyGain(acc, firstGain);
    gainDb += firstGain;
    m = measureLufs(acc, sampleRate);

    if (m.peakDb > -1) {
      // 归一后峰值还顶到 −1 dBFS：先软限幅削峰，再按限幅后的响度补增益。
      // 两轮之后如果还顶，就整体降下来——宁可响度差一点，也绝不削波。
      const ceiling = Math.pow(10, -1 / 20);
      for (let pass = 0; pass < 2 && m.peakDb > -1; pass++) {
        softLimit(acc, ceiling);
        m = measureLufs(acc, sampleRate);
        if (Number.isFinite(m.lufs)) {
          const g = p.targetLufs - m.lufs;
          gainDb += g;
          applyGain(acc, g);
          m = measureLufs(acc, sampleRate);
        }
      }
      if (m.peakDb > -1) {
        const peak = Math.pow(10, m.peakDb / 20);
        const g = Math.pow(10, -1 / 20) / peak;
        gainDb += 20 * Math.log10(g);
        applyGain(acc, 20 * Math.log10(g));
        m = measureLufs(acc, sampleRate);
      }
    }
  }

  const seam = seamError(acc, sampleRate, p.xfade);
  const seamR = seamRatio(acc);
  const stats = {
    seconds: frames / sampleRate,
    layers: usedLayers,
    seamOk: seamR < 1,
    seamError: seam,
    seamRatio: seamR,
    lufs: m.lufs,
    peakDb: m.peakDb,
    skips,
    layerUsed,
    sampleRate,
    targetLufs: p.targetLufs,
    gainDb
  };

  return { sampleRate, channels: acc, stats };
}

/* ==========================================================================
   程序化纹理（B 方案）：不靠素材，直接合成持续型底噪

   棕噪 / 粉噪 / 白噪 三种底色 → 高低切塑形 → 慢 LFO 呼吸 + 阵风起伏 →
   可选低频轰鸣 → 首尾等功率交叉淡化保证可循环 → 响度归一。

   为什么这条路线值得有：风、雨、机房、空调、远处车流这类「没有事件、只有底色」
   的声音，素材库里往往找不到长度/密度刚好合适的；合成出来的反而更干净、更可控，
   而且天然可循环（长度任意、接缝我们自己补）。

   `extras` 用来做混合模式：把缝合出来的库素材细节层按增益叠进来。
   ========================================================================== */

export const TEXTURE_DEFAULTS = {
  seconds: 90,
  sampleRate: 48000,
  color: 'brown',   // brown | pink | white
  lowCut: 25,       // Hz，二阶高通
  highCut: 9000,    // Hz，二阶低通
  lfoRate: 0.05,    // Hz，整体呼吸
  lfoDepth: 0.28,   // 0–1
  gust: 0.35,       // 阵风/起伏强度 0–1（用平滑随机走）
  rumble: 0,        // 低频轰鸣量 0–1（车流/机房/远雷）
  width: 0.85,      // 立体声宽度 0–1（1 = 左右完全独立）
  seed: 1,
  targetLufs: -23,
  xfade: 1.5,       // 首尾对齐长度（秒）
  seamless: true
};

export function clampTexture(p) {
  const src = p || {};
  const num = (v, def, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
  };
  const color = ['brown', 'pink', 'white'].includes(src.color) ? src.color : TEXTURE_DEFAULTS.color;
  return {
    seconds: num(src.seconds, TEXTURE_DEFAULTS.seconds, 5, 600),
    sampleRate: Math.round(num(src.sampleRate, TEXTURE_DEFAULTS.sampleRate, 8000, 192000)),
    color,
    lowCut: num(src.lowCut, TEXTURE_DEFAULTS.lowCut, 5, 2000),
    highCut: num(src.highCut, TEXTURE_DEFAULTS.highCut, 200, 20000),
    lfoRate: num(src.lfoRate, TEXTURE_DEFAULTS.lfoRate, 0.005, 2),
    lfoDepth: num(src.lfoDepth, TEXTURE_DEFAULTS.lfoDepth, 0, 1),
    gust: num(src.gust, TEXTURE_DEFAULTS.gust, 0, 1),
    rumble: num(src.rumble, TEXTURE_DEFAULTS.rumble, 0, 1),
    width: num(src.width, TEXTURE_DEFAULTS.width, 0, 1),
    seed: Math.round(num(src.seed, TEXTURE_DEFAULTS.seed, 1, 1e9)),
    targetLufs: num(src.targetLufs, TEXTURE_DEFAULTS.targetLufs, -40, -9),
    xfade: num(src.xfade, TEXTURE_DEFAULTS.xfade, 0.2, 8),
    seamless: src.seamless !== false
  };
}

/** 确定性伪随机（mulberry32）：同 seed 同结果，方便复现和对比。 */
function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 二阶 RBJ 双二阶（低通 / 高通），直接对数组就地跑，不做零相位补偿。 */
function biquadInPlace(ch, type, freq, sampleRate, q) {
  const w = (2 * Math.PI * freq) / sampleRate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * (q || 0.707));
  let b0, b1, b2;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  if (type === 'lowpass') {
    b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
  } else {
    b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
  }
  const nb0 = b0 / a0, nb1 = b1 / a0, nb2 = b2 / a0;
  const na1 = a1 / a0, na2 = a2 / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < ch.length; i++) {
    const x = ch[i];
    const y = nb0 * x + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
    x2 = x1; x1 = x;
    y2 = y1; y1 = y;
    ch[i] = y;
  }
}

function genNoise(n, color, rng) {
  const out = new Float32Array(n);
  if (color === 'white') {
    for (let i = 0; i < n; i++) out[i] = rng() * 2 - 1;
    return out;
  }
  if (color === 'pink') {
    // Paul Kellett 经济型粉噪：三级一阶低通相加
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < n; i++) {
      const w = rng() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.15;
    }
    return out;
  }
  // brown：白噪做一阶积分（漏积分，避免直流漂移）
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc = acc * 0.995 + (rng() * 2 - 1) * 0.05;
    out[i] = acc;
  }
  return out;
}

function buildTexture(p, extras) {
  const frames = Math.max(1, Math.round(p.seconds * p.sampleRate));
  const xfade = Math.max(1, Math.min(Math.round(p.xfade * p.sampleRate), Math.floor(frames / 2)));
  const total = frames + xfade;
  const rngL = makeRng(p.seed * 7919 + 13);
  const rngR = makeRng(p.seed * 104729 + 7);

  const L = genNoise(total, p.color, rngL);
  const R0 = genNoise(total, p.color, rngR);

  // 立体声宽度：width=1 左右独立；width=0 左右同一条（单声道感）
  const wMix = Math.max(0, Math.min(1, p.width));
  const R = new Float32Array(total);
  for (let i = 0; i < total; i++) R[i] = R0[i] * wMix + L[i] * (1 - wMix);

  for (const ch of [L, R]) {
    biquadInPlace(ch, 'highpass', Math.min(p.lowCut, p.sampleRate / 2 - 10), p.sampleRate, 0.707);
    biquadInPlace(ch, 'lowpass', Math.min(p.highCut, p.sampleRate / 2 - 10), p.sampleRate, 0.707);
  }

  // 阵风/起伏：两路平滑随机（每 0.4–1.2 秒换一个目标值，线性插值），幅度由 gust 控制
  const gustGain = (n, rng) => {
    const g = new Float32Array(n);
    let cur = 0.5, target = 0.5, stepLeft = 0;
    const stepLen = Math.round(p.sampleRate * 0.6);
    for (let i = 0; i < n; i++) {
      if (stepLeft <= 0) {
        target = rng();
        stepLeft = Math.round(stepLen * (0.6 + rng() * 0.9));
      }
      stepLeft--;
      cur += (target - cur) * 0.0008;
      g[i] = 1 - p.gust * 0.75 + p.gust * 0.75 * cur * 2;
    }
    return g;
  };
  const gL = gustGain(total, makeRng(p.seed * 31 + 5));
  const gR = gustGain(total, makeRng(p.seed * 37 + 9));

  const lfoW = 2 * Math.PI * p.lfoRate / p.sampleRate;
  for (let i = 0; i < total; i++) {
    const lfo = 1 - p.lfoDepth * 0.5 + p.lfoDepth * 0.5 * Math.sin(lfoW * i);
    L[i] *= gL[i] * lfo;
    R[i] *= gR[i] * lfo;
  }

  // 低频轰鸣：45–70 Hz 附近的噪声加一点正弦，给车流/机房那种"垫在底下"的体感
  if (p.rumble > 0) {
    const rl = genNoise(total, 'brown', makeRng(p.seed * 53 + 21));
    const rr = genNoise(total, 'brown', makeRng(p.seed * 59 + 23));
    for (const ch of [rl, rr]) {
      biquadInPlace(ch, 'lowpass', 120, p.sampleRate, 0.9);
      biquadInPlace(ch, 'highpass', 28, p.sampleRate, 0.707);
    }
    const f = 52 + (p.seed % 17);
    const w = 2 * Math.PI * f / p.sampleRate;
    for (let i = 0; i < total; i++) {
      const tone = Math.sin(w * i) * 0.12;
      L[i] += (rl[i] * 2.2 + tone) * p.rumble * 0.55;
      R[i] += (rr[i] * 2.2 + tone * 0.9) * p.rumble * 0.55;
    }
  }

  // 首尾对齐：把多出来的 xfade 段按等功率淡进开头，循环点就没有台阶
  const chans = [new Float32Array(frames), new Float32Array(frames)];
  for (let c = 0; c < 2; c++) {
    const src = c === 0 ? L : R;
    const dst = chans[c];
    for (let i = 0; i < frames; i++) dst[i] = src[i];
    if (p.seamless) {
      for (let i = 0; i < xfade; i++) {
        const t = (i + 0.5) / xfade;
        const wIn = Math.sin((t * Math.PI) / 2);
        const wOut = Math.cos((t * Math.PI) / 2);
        dst[i] = src[i] * wIn + src[frames + i] * wOut;
      }
    }
  }

  // 混合模式：把库素材细节层按增益叠进来
  const added = [];
  for (const ex of (extras || [])) {
    const ec = ex && ex.channels;
    if (!ec || !ec[0] || !ec[0].length) continue;
    const g = Math.pow(10, (Number(ex.gainDb) || 0) / 20);
    const n = Math.min(frames, ec[0].length);
    for (let i = 0; i < n; i++) {
      chans[0][i] += ec[0][i] * g;
      chans[1][i] += (ec[1] || ec[0])[i] * g;
    }
    added.push({ name: ex.name || '细节层', gainDb: Number(ex.gainDb) || 0 });
  }

  // 归一：先按响度给增益，再压峰
  let m = measureLufs(chans, p.sampleRate);
  let gainDb = 0;
  if (Number.isFinite(m.lufs)) {
    const g0 = p.targetLufs - m.lufs;
    applyGain(chans, g0);
    gainDb += g0;
    m = measureLufs(chans, p.sampleRate);
    if (m.peakDb > -1) {
      const ceiling = Math.pow(10, -1 / 20);
      for (let pass = 0; pass < 2 && m.peakDb > -1; pass++) {
        softLimit(chans, ceiling);
        m = measureLufs(chans, p.sampleRate);
        if (Number.isFinite(m.lufs)) {
          const g = p.targetLufs - m.lufs;
          gainDb += g;
          applyGain(chans, g);
          m = measureLufs(chans, p.sampleRate);
        }
      }
      if (m.peakDb > -1) {
        const g = ceiling / Math.pow(10, m.peakDb / 20);
        gainDb += 20 * Math.log10(g);
        applyGain(chans, 20 * Math.log10(g));
        m = measureLufs(chans, p.sampleRate);
      }
    }
  }

  const seamR = seamRatio(chans);
  return {
    sampleRate: p.sampleRate,
    channels: chans,
    stats: {
      seconds: frames / p.sampleRate,
      layers: 0,
      mode: 'texture',
      color: p.color,
      seamOk: seamR < 1,
      seamRelative: seamR,
      lufs: m.lufs,
      peakDb: m.peakDb,
      skips: [],
      layerUsed: added,
      sampleRate: p.sampleRate,
      targetLufs: p.targetLufs,
      gainDb
    }
  };
}

export { buildTexture };
