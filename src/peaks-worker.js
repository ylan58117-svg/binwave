'use strict';

/**
 * 波形峰值（peaks）计算工作线程。
 *
 * 为什么单独开线程：峰值要把整个音频负载读一遍，一个 250 MB 的 5.1 素材就要
 * 700 ms 左右的纯 CPU。放在主进程里算，几千个素材一起分析时 IPC 全被堵住，
 * 界面点一下要等半天——用户看到的就是「软件卡死」。
 *
 * 主进程（src/main.js）里的 peakPool 负责排队，这里只管算。
 */

const { parentPort } = require('node:worker_threads');
const audio = require('./audio/audio.js');

parentPort.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  const { id, pcm, mode } = msg;
  try {
    if (mode === 'deep') {
      // 响度/峰值/频谱图：同样要把整个负载读一遍，所以也放在这里算。
      const deep = await audio.analyzeDeep(pcm);
      const spec = deep.spectrum;
      const transfer = spec && spec.data && spec.data.buffer ? [spec.data.buffer] : [];
      parentPort.postMessage({
        id,
        ok: deep.ok,
        deep: {
          duration: deep.duration,
          channels: deep.channels,
          sampleRate: deep.sampleRate,
          loudness: deep.loudness,
          spectrum: spec
            ? { cols: spec.cols, rows: spec.rows, data: spec.data }
            : null
        }
      }, transfer);
      return;
    }
    const peaks = await audio.computePeaks(pcm);
    const data = peaks.data;
    parentPort.postMessage({
      id,
      ok: true,
      peaks: {
        binsPerSecond: peaks.binsPerSecond,
        channels: peaks.channels,
        bins: peaks.bins,
        zcr: peaks.zcr || null
      },
      data
    }, data && data.buffer ? [data.buffer] : []);
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
});
