'use strict';
// 内置采样器：把一条音频当 one-shot 采样来试听与渲染。
// 纯逻辑 + Web Audio，不碰 DOM，也不依赖 VST / Python / AI 任何一侧。
// 渲染层（app.js）负责界面，这里只负责「参数 → 声音」和「参数 → 离线 WAV」。

export const SAMPLER_DEFAULTS = {
  pitch: 0,        // 半音 -24..24
  fine: 0,         // 音分 -100..100
  start: 0,        // 采样起点（秒）
  end: null,       // 采样终点（秒），null = 到结尾
  loop: 'off',     // off | on
  attack: 0.004,
  decay: 0.18,
  sustain: 0.85,
  release: 0.14,
  gainDb: 0,
  pan: 0,          // -1..1
  lp: 18000,
  hp: 20,
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

/** 把任意输入收敛成合法参数；end 依赖采样时长，由调用方再夹一次。 */
export function clampSampler(p = {}) {
  const src = { ...SAMPLER_DEFAULTS, ...(p || {}) };
  const out = {
    pitch: Math.round(clamp(num(src.pitch, 0), -24, 24)),
    fine: Math.round(clamp(num(src.fine, 0), -100, 100)),
    start: Math.max(0, num(src.start, 0)),
    end: src.end === null || src.end === undefined ? null : Math.max(0, num(src.end, null)),
    loop: src.loop === 'on' ? 'on' : 'off',
    attack: clamp(num(src.attack, SAMPLER_DEFAULTS.attack), 0.001, 4),
    decay: clamp(num(src.decay, SAMPLER_DEFAULTS.decay), 0.001, 4),
    sustain: clamp(num(src.sustain, SAMPLER_DEFAULTS.sustain), 0, 1),
    release: clamp(num(src.release, SAMPLER_DEFAULTS.release), 0.01, 6),
    gainDb: clamp(num(src.gainDb, 0), -60, 12),
    pan: clamp(num(src.pan, 0), -1, 1),
    lp: clamp(num(src.lp, SAMPLER_DEFAULTS.lp), 200, 20000),
    hp: clamp(num(src.hp, SAMPLER_DEFAULTS.hp), 10, 4000),
  };
  if (out.end !== null && out.end <= out.start + 0.005) out.end = null;
  return out;
}

/** 采样窗口（秒）。end 为 null 时取到结尾。 */
export function samplerWindow(params, duration) {
  const p = clampSampler(params);
  const dur = Math.max(0.01, num(duration, 0.01));
  const start = clamp(p.start, 0, Math.max(0, dur - 0.01));
  let end = p.end === null ? dur : clamp(p.end, start + 0.01, dur);
  if (!(end > start)) end = dur;
  return { start, end, dur };
}

/** 播放速率：音高（半音 + 音分）再叠加键盘偏移。 */
export function samplerRatio(params, semitoneOffset = 0) {
  const p = clampSampler(params);
  return Math.pow(2, (p.pitch + p.fine / 100 + semitoneOffset) / 12);
}

/** 缓存目录用的短签名（参数 + 采样路径一起参与，同名文件不同参数不会撞）。 */
export function samplerSig(params, sourcePath = '') {
  const p = clampSampler(params);
  const text = JSON.stringify({ ...p, src: String(sourcePath || '') });
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = (h1 ^ c) * 0x01000193 >>> 0;
    h2 = (h2 + c * (i + 7)) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).replace(/[^a-z0-9]/gi, '').slice(0, 10) || 'default';
}

/** 建一条「采样 → 包络 → 滤波 → 声像 → 音量」的链，返回可控制的对象。 */
function buildChain(ctx, buffer, params, semitoneOffset, destination) {
  const p = clampSampler(params);
  const { start, end } = samplerWindow(p, buffer.duration);
  const ratio = samplerRatio(p, semitoneOffset);

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = ratio;
  if (p.loop === 'on') {
    src.loop = true;
    src.loopStart = start;
    src.loopEnd = end;
  }

  const env = ctx.createGain();
  env.gain.value = 0;

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = p.hp;
  hp.Q.value = 0.7;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = p.lp;
  lp.Q.value = 0.7;

  const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if (pan) pan.pan.value = p.pan;

  const master = ctx.createGain();
  master.gain.value = Math.pow(10, p.gainDb / 20);

  src.connect(env);
  env.connect(hp);
  hp.connect(lp);
  if (pan) {
    lp.connect(pan);
    pan.connect(master);
  } else {
    lp.connect(master);
  }
  master.connect(destination);

  return { src, env, hp, lp, pan, master, start, end, ratio };
}

/** 在已有的 AudioContext 上试听一个音（keys 按下/抬起控制）。 */
export function playSamplerNote(ctx, buffer, params, semitoneOffset, destination) {
  const p = clampSampler(params);
  const chain = buildChain(ctx, buffer, p, semitoneOffset, destination);
  const now = ctx.currentTime;
  const { start, end, ratio } = chain;
  const body = Math.max(0.02, (end - start) / ratio);
  chain.offset = start;

  chain.env.gain.cancelScheduledValues(now);
  chain.env.gain.setValueAtTime(0, now);
  chain.env.gain.linearRampToValueAtTime(1, now + p.attack);
  chain.env.gain.linearRampToValueAtTime(Math.max(0.0001, p.sustain), now + p.attack + p.decay);
  chain.src.start(now, start, p.loop === 'on' ? undefined : Math.min(body, 600));

  chain.stop = () => {
    const t = ctx.currentTime;
    const g = chain.env.gain;
    try {
      g.cancelScheduledValues(t);
      g.setValueAtTime(Math.max(0.0001, g.value), t);
      g.linearRampToValueAtTime(0, t + p.release);
    } catch { /* 已停止 */ }
    try { chain.src.stop(t + p.release + 0.02); } catch { /* 已停止 */ }
  };
  return chain;
}

/** 离线渲染：把当前参数应用到整条采样，返回 AudioBuffer。 */
export async function renderSampler(buffer, params, { semitoneOffset = 0, sampleRate = 0 } = {}) {
  const p = clampSampler(params);
  const rate = Math.max(8000, Math.min(384000, Math.round(sampleRate || buffer.sampleRate || 44100)));
  const { start, end } = samplerWindow(p, buffer.duration);
  const ratio = samplerRatio(p, semitoneOffset);
  const body = Math.max(0.02, (end - start) / ratio);
  const total = Math.min(600, body + p.attack + p.decay + p.release + 0.1);
  const frames = Math.max(1, Math.ceil(total * rate));
  const channels = Math.max(1, Math.min(2, buffer.numberOfChannels || 1));
  const ctx = new OfflineAudioContext(channels, frames, rate);
  const chain = buildChain(ctx, buffer, p, semitoneOffset, ctx.destination);

  const t0 = 0.001;
  chain.env.gain.setValueAtTime(0, t0);
  chain.env.gain.linearRampToValueAtTime(1, t0 + p.attack);
  chain.env.gain.linearRampToValueAtTime(Math.max(0.0001, p.sustain), t0 + p.attack + p.decay);
  const relAt = t0 + body;
  chain.env.gain.setValueAtTime(Math.max(0.0001, p.sustain), relAt);
  chain.env.gain.linearRampToValueAtTime(0, relAt + p.release);
  chain.src.start(t0, start, p.loop === 'on' ? body : Math.min(body, 600));
  chain.src.stop(relAt + p.release + 0.05);

  return ctx.startRendering();
}

/** 键盘映射：白键 a s d f g h j k、黑键 w e t y u，返回半音偏移。 */
export const KEY_MAP = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12,
};
