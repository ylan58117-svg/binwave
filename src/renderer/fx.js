'use strict';

/* ==========================================================================
   fx.js — 试听用的效果链（纯 Web Audio，零依赖）

   链序：输入 → 低切 → 高切 → 中频 → 压缩 → [干声 / 混响] → 输出

   同一个图同时给两条路径用：
   - 实时试听：Player 把它插在 <audio> 和总音量之间；
   - 导出成品：OfflineAudioContext 里跑一遍，再编码成 WAV。

   因为用的是 Chromium 自带的 BiquadFilter / DynamicsCompressor / Convolver，
   所以不需要任何原生模块，也不依赖本机装没装 VST。
   ========================================================================== */

export const FX_DEFAULTS = {
  enabled: false,
  hp: 20,            // Hz，低切
  lp: 18000,         // Hz，高切
  bellFreq: 900,     // Hz，中频中心
  bellGain: 0,       // dB，-18..+18
  bellQ: 0.9,
  compOn: false,
  compThreshold: -24, // dB
  compRatio: 4,
  compAttack: 0.008,
  compRelease: 0.22,
  revOn: false,
  revMix: 0.18,       // 0..1 湿声比例
  revTime: 1.6,       // 秒
  revDamp: 5200       // Hz，混响高频衰减
};

export function clampFx(p) {
  const src = p || {};
  const num = (v, def, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
  };
  return {
    enabled: !!src.enabled,
    hp: num(src.hp, FX_DEFAULTS.hp, 20, 2000),
    lp: num(src.lp, FX_DEFAULTS.lp, 500, 20000),
    bellFreq: num(src.bellFreq, FX_DEFAULTS.bellFreq, 120, 9000),
    bellGain: num(src.bellGain, FX_DEFAULTS.bellGain, -18, 18),
    bellQ: num(src.bellQ, FX_DEFAULTS.bellQ, 0.2, 8),
    compOn: !!src.compOn,
    compThreshold: num(src.compThreshold, FX_DEFAULTS.compThreshold, -60, 0),
    compRatio: num(src.compRatio, FX_DEFAULTS.compRatio, 1, 20),
    compAttack: num(src.compAttack, FX_DEFAULTS.compAttack, 0.001, 0.2),
    compRelease: num(src.compRelease, FX_DEFAULTS.compRelease, 0.02, 1.2),
    revOn: !!src.revOn,
    revMix: num(src.revMix, FX_DEFAULTS.revMix, 0, 1),
    revTime: num(src.revTime, FX_DEFAULTS.revTime, 0.15, 8),
    revDamp: num(src.revDamp, FX_DEFAULTS.revDamp, 400, 18000)
  };
}

/** 混响用的脉冲响应：指数衰减噪声 + 一阶低通做高频阻尼，听感比纯噪声自然。 */
function makeImpulse(ctx, seconds, dampHz) {
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(2, len, sr);
  const damp = Math.max(0.02, Math.min(1, (dampHz || 5000) / (sr / 2)));
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let z = 0;
    // 前后两段不同的随机种子，左右声道去相关，声像才不会挤在中间
    let seed = (ch ? 0x9e3779b1 : 0x85ebca6b) >>> 0;
    for (let i = 0; i < len; i++) {
      seed ^= seed << 13; seed >>>= 0;
      seed ^= seed >> 17;
      seed ^= seed << 5; seed >>>= 0;
      const n = (seed / 0xffffffff) * 2 - 1;
      z += damp * (n - z);
      const t = i / len;
      // 前 8 ms 淡入，避免一上来一个爆音
      const attack = Math.min(1, i / (sr * 0.008));
      d[i] = z * Math.pow(1 - t, 2.2) * attack;
    }
  }
  return buf;
}

/**
 * 建立一条效果链。返回 input/output 两个 GainNode，外部只管两头。
 * update() 是幂等的：实时试听时拖动滑杆会反复调用。
 */
export function createFxChain(ctx, params) {
  const p0 = clampFx(params);

  const input = ctx.createGain();
  const output = ctx.createGain();

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = p0.hp;
  hp.Q.value = 0.707;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = p0.lp;
  lp.Q.value = 0.707;

  const bell = ctx.createBiquadFilter();
  bell.type = 'peaking';
  bell.frequency.value = p0.bellFreq;
  bell.gain.value = p0.bellGain;
  bell.Q.value = p0.bellQ;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = p0.compThreshold;
  comp.ratio.value = p0.compRatio;
  comp.attack.value = p0.compAttack;
  comp.release.value = p0.compRelease;
  comp.knee.value = 12;

  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const conv = ctx.createConvolver();
  conv.normalize = true;
  conv.buffer = makeImpulse(ctx, p0.revTime, p0.revDamp);

  // 串联主链
  input.connect(hp);
  hp.connect(lp);
  lp.connect(bell);
  bell.connect(comp);

  // 干湿并联
  comp.connect(dry);
  dry.connect(output);
  comp.connect(conv);
  conv.connect(wet);
  wet.connect(output);

  let lastRevTime = p0.revTime;
  let lastDamp = p0.revDamp;

  function ramp(param, value, tc = 0.02) {
    try {
      param.cancelScheduledValues(ctx.currentTime);
      param.setTargetAtTime(value, ctx.currentTime, tc);
    } catch {
      param.value = value;
    }
  }

  function update(params) {
    const p = clampFx(params);
    ramp(hp.frequency, p.hp);
    ramp(lp.frequency, p.lp);
    ramp(bell.frequency, p.bellFreq);
    ramp(bell.gain, p.bellGain);

    // 压缩器关掉的时候把阈值推到顶、比例 1:1，等于直通
    if (p.compOn) {
      ramp(comp.threshold, p.compThreshold);
      ramp(comp.ratio, p.compRatio);
      ramp(comp.attack, p.compAttack);
      ramp(comp.release, p.compRelease);
    } else {
      ramp(comp.threshold, 0);
      ramp(comp.ratio, 1);
    }

    const mix = p.revOn ? p.revMix : 0;
    ramp(dry.gain, 1 - mix * 0.35);
    ramp(wet.gain, mix);

    if (Math.abs(p.revTime - lastRevTime) > 0.05 || Math.abs(p.revDamp - lastDamp) > 50) {
      lastRevTime = p.revTime;
      lastDamp = p.revDamp;
      conv.buffer = makeImpulse(ctx, p.revTime, p.revDamp);
    }
  }

  update(p0);

  function dispose() {
    try { input.disconnect(); } catch { /* ignore */ }
    try { output.disconnect(); } catch { /* ignore */ }
  }

  return { input, output, update, dispose, nodes: { hp, lp, bell, comp, dry, wet, conv } };
}

/**
 * 离线跑一遍效果链，返回处理后的 AudioBuffer。
 * 只取前两个声道（SoundBin 的试听和修剪都是立体声语义），多声道素材会在 UI 上提示。
 */
export async function renderOffline(buffer, params) {
  const ch = Math.min(2, buffer.numberOfChannels);
  const off = new OfflineAudioContext(ch, buffer.length, buffer.sampleRate);
  const chain = createFxChain(off, params);

  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(chain.input);
  chain.output.connect(off.destination);
  src.start(0);

  return await off.startRendering();
}

// ---------------------------------------------------------------------------
// WAV 编码（24-bit PCM，DAW 里通用，且比 float32 小 1/4）
// ---------------------------------------------------------------------------
export function encodeWav24(buffer) {
  const ch = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytesPerSample = 3;
  const dataBytes = frames * ch * bytesPerSample;
  const ab = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(ab);

  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);                       // PCM
  view.setUint16(22, ch, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * ch * bytesPerSample, true);
  view.setUint16(32, ch * bytesPerSample, true);
  view.setUint16(34, 24, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);

  const chans = [];
  for (let c = 0; c < ch; c++) chans.push(buffer.getChannelData(c));

  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      let s = chans[c][i];
      if (!Number.isFinite(s)) s = 0;
      s = Math.max(-1, Math.min(1, s));
      const v = Math.round(s * 8388607);
      view.setUint8(off, v & 0xff);
      view.setUint8(off + 1, (v >> 8) & 0xff);
      view.setUint8(off + 2, (v >> 16) & 0xff);
      off += 3;
    }
  }

  return new Uint8Array(ab);
}

/** 峰值电平（dBFS），导出后提示用。 */
export function bufferPeakDb(buffer) {
  let max = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i += 3) {
      const v = Math.abs(d[i]);
      if (v > max) max = v;
    }
  }
  return max > 0 ? 20 * Math.log10(max) : -Infinity;
}
