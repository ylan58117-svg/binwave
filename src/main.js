'use strict';

const { app, BrowserWindow, ipcMain, protocol, dialog, shell, Menu, screen, globalShortcut, safeStorage } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { Worker } = require('node:worker_threads');

const audio = require('./audio/audio');

// ---------------------------------------------------------------------------
// Portable data directory
//
// 打包后的 SoundBin.exe 旁边放 data\，整个文件夹就能拷着走（换机器、进 U 盘都行）。
// 开发时用 --user-data-dir=data 启动，这里不接管，免得和启动脚本打架。
// 必须在 requestSingleInstanceLock 之前执行：单实例锁就是按 userData 目录算的。
// ---------------------------------------------------------------------------
if (app.isPackaged && !process.argv.some((a) => a.startsWith('--user-data-dir'))) {
  try {
    // macOS 上 exe 在 SoundBin.app/Contents/MacOS/ 里，data 要放到 .app 旁边，
    // 不能写进 bundle（签名会失效）。
    const exe = app.getPath('exe');
    const base = process.platform === 'darwin'
      ? path.resolve(path.dirname(exe), '..', '..', '..')
      : path.dirname(exe);
    const portable = path.join(base, 'data');
    fs.mkdirSync(portable, { recursive: true });
    app.setPath('userData', portable);
  } catch {
    /* 没有写权限就用系统的用户目录，不拦着用户用 */
  }
}

// ---------------------------------------------------------------------------
// 数据位置（存储更换）
//
// 指针文件放在 %APPDATA%\SoundBin\data-location.json —— 不能放进 data\ 里，
// 因为要搬走的正是 data\。存在且目录还在就以它为准（用户自己搬过盘）。
// 由 --user-data-dir 显式指定时以命令行参数为准，测试和便携启动不被劫持。
// ---------------------------------------------------------------------------
function dataLocationFile() {
  return path.join(app.getPath('appData'), 'SoundBin', 'data-location.json');
}
function readDataLocation() {
  try {
    const j = JSON.parse(fs.readFileSync(dataLocationFile(), 'utf8'));
    if (j && typeof j.dir === 'string' && j.dir && fs.existsSync(j.dir)) return j.dir;
  } catch { /* 没有指针文件是最常见的情况 */ }
  return null;
}
if (!process.argv.some((a) => a.startsWith('--user-data-dir'))) {
  const located = readDataLocation();
  if (located) {
    try { app.setPath('userData', located); } catch { /* 目录不可用时退回默认 */ }
  }
}

// ---------------------------------------------------------------------------
// Single instance
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// ---------------------------------------------------------------------------
// Privileged custom scheme.
//
// Everything (UI + audio) is served from snd://app so that <audio> and the
// Web Audio graph share an origin. A cross-origin media element feeding a
// MediaElementAudioSourceNode is silenced by CORS, which would look like
// "the gain slider is broken".
// ---------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([{
  scheme: 'snd',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
    codeCache: true
  }
}]);

const SRC_DIR = __dirname;
const RENDERER_DIR = path.join(SRC_DIR, 'renderer');
// Static files are addressed as snd://app/renderer/... — resolved against src/.
const WEB_ROOTS = [RENDERER_DIR, path.join(SRC_DIR, 'assets')];
const AUDIO_EXT_SET = audio.AUDIO_EXTS;

let mainWindow = null;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
function userDataDir() {
  return app.getPath('userData');
}
function cacheDir() {
  return path.join(userDataDir(), 'cache');
}
function wavCacheDir() {
  return path.join(cacheDir(), 'wav');
}
function peakCacheDir() {
  return path.join(cacheDir(), 'peaks');
}
function artCacheDir() {
  return path.join(cacheDir(), 'art');
}
/** 拖出时用的"修剪后成品"缓存：清单里的条目带 trim 时，拖出去的是这里的文件。 */
function clipCacheDir() {
  return path.join(cacheDir(), 'clips');
}
/** 开着效果器时拖出去的是离线渲染过的版本，按参数签名分目录缓存。 */
function fxCacheDir(sig) {
  return path.join(cacheDir(), 'fx', String(sig || 'default'));
}
/** 采样器渲染出来的版本，同样按参数签名分目录。 */
function samplerCacheDir(sig) {
  return path.join(cacheDir(), 'sampler', String(sig || 'default'));
}
function libraryPath() {
  return path.join(userDataDir(), 'library.json');
}

/** "00m03.250s" — safe in a Windows file name, and readable in a DAW browser. */
function stampSec(sec) {
  const t = Math.max(0, Number(sec) || 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}m${s.toFixed(3).padStart(6, '0')}s`;
}

/** Where a trim export lands when the renderer does not pick a path. */
function defaultTrimPath(filePath, start, end) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  return path.join(dir, `${base}_trim_${stampSec(start)}-${stampSec(end)}.wav`);
}

async function ensureDirs() {
  await fsp.mkdir(wavCacheDir(), { recursive: true });
  await fsp.mkdir(peakCacheDir(), { recursive: true });
  await fsp.mkdir(artCacheDir(), { recursive: true });
  await fsp.mkdir(clipCacheDir(), { recursive: true });
}

// ---------------------------------------------------------------------------
// MIME
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp4': 'audio/mp4',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.aifc': 'audio/aiff'
};

function mimeFor(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// File serving with Range support (needed for seeking inside <audio>)
// ---------------------------------------------------------------------------
async function serveFile(filePath, rangeHeader) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return new Response('not found', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
  if (!stat.isFile()) {
    return new Response('not a file', { status: 404 });
  }

  const size = stat.size;
  const headers = {
    'Content-Type': mimeFor(filePath),
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'no-store'
  };

  if (rangeHeader) {
    const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
    if (m) {
      let start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
      let end = (m[1] !== '' && m[2] !== '') ? Number(m[2]) : size - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= size) end = size - 1;
      if (start > end) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${size}`, 'Access-Control-Allow-Origin': '*' }
        });
      }
      const stream = fs.createReadStream(filePath, { start, end });
      return new Response(Readable.toWeb(stream), {
        status: 206,
        headers: {
          ...headers,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`
        }
      });
    }
  }

  const stream = fs.createReadStream(filePath);
  return new Response(Readable.toWeb(stream), {
    status: 200,
    headers: { ...headers, 'Content-Length': String(size) }
  });
}

// ---------------------------------------------------------------------------
// Peak cache
// ---------------------------------------------------------------------------
// Bumped whenever the peak layout/producer changes: a mismatch silently
// invalidates every cached file, which is cheaper than tracking a schema.
const PEAK_MAGIC = 'SBP3';

async function loadPeakCache(key) {
  const file = path.join(peakCacheDir(), key + '.bin');
  try {
    const buf = await fsp.readFile(file);
    if (buf.length < 20) return null;
    if (buf.toString('latin1', 0, 4) !== PEAK_MAGIC) return null;
    const binsPerSecond = buf.readUInt32LE(4);
    const channels = buf.readUInt32LE(8);
    const bins = buf.readUInt32LE(12);
    const zcrCount = buf.readUInt32LE(16);
    const expected = bins * channels * 2 * 2;
    if (buf.length - 20 < expected) return null;
    const data = new Int16Array(buf.buffer, buf.byteOffset + 20, bins * channels * 2);
    let zcr = null;
    const zcrOff = 20 + expected;
    if (zcrCount > 0 && zcrCount <= 4096 && buf.length - zcrOff >= zcrCount * 4) {
      const f = new Float32Array(buf.buffer, buf.byteOffset + zcrOff, zcrCount);
      zcr = Array.from(f);
    }
    return { binsPerSecond, channels, bins, data, zcr };
  } catch {
    return null;
  }
}

async function savePeakCache(key, peaks) {
  try {
    const head = Buffer.alloc(20);
    head.write(PEAK_MAGIC, 0, 'latin1');
    head.writeUInt32LE(peaks.binsPerSecond, 4);
    head.writeUInt32LE(peaks.channels, 8);
    head.writeUInt32LE(peaks.bins, 12);
    const zcr = Array.isArray(peaks.zcr) ? peaks.zcr : null;
    head.writeUInt32LE(zcr ? zcr.length : 0, 16);
    const body = Buffer.from(peaks.data.buffer, peaks.data.byteOffset, peaks.data.byteLength);
    const parts = [head, body];
    if (zcr && zcr.length) parts.push(Buffer.from(Float32Array.from(zcr).buffer));
    await fsp.writeFile(path.join(peakCacheDir(), key + '.bin'), Buffer.concat(parts));
  } catch {
    /* cache is best-effort */
  }
}

// ---------------------------------------------------------------------------
// Analysis
//
// 分析拆成两步，这是「上万条素材也能用」的关键：
//   probe —— 只读文件头（时长/采样率/声道/位深/标签），单个 2~7 ms；
//   peaks —— 波形包络，要把整个负载读一遍（250 MB ≈ 0.7 s），只给真正要看
//            波形 / 要算指纹的素材做，而且放到工作线程，不堵主进程。
// 早先两步是一起做的：把 9000 个素材拖进来就等于把 100 GB 全部读一遍，
// 主进程被占满、每条素材的峰值（单条最多 1.6 MB）还全留在内存里，
// 于是「导入半天没动静、导入完也卡」。
// ---------------------------------------------------------------------------
const INSPECT_CONCURRENCY = 6;

/** 一个小的并发闸门：超出并发就先排队，不一次性放 9000 个任务进来。 */
function makeLimiter(limit) {
  const queue = [];
  let running = 0;
  return function withLimit(fn) {
    return new Promise((resolve, reject) => {
      const run = () => {
        running++;
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            running--;
            const next = queue.shift();
            if (next) next();
          });
      };
      if (running < limit) run();
      else queue.push(run);
    });
  };
}

const withProbeLimit = makeLimiter(INSPECT_CONCURRENCY);
const withPeaksLimit = makeLimiter(4);
const withReadLimit = makeLimiter(4);

// 峰值计算的线程池。线程数留一个核给界面，最多 4 个，避免把机器榨干。
const PEAK_WORKERS = Math.max(1, Math.min(4, (os.cpus() || []).length - 1));
const peakWorkers = [];
const peakQueue = [];
let peakSeq = 0;

function pumpPeakQueue() {
  while (peakQueue.length) {
    let w = peakWorkers.find((x) => !x.busy);
    if (!w) {
      if (peakWorkers.length >= PEAK_WORKERS) return;
      w = spawnPeakWorker();
    }
    const job = peakQueue.shift();
    w.busy = true;
    w.job = job.resolve;
    w.postMessage({ id: ++peakSeq, pcm: job.pcm, mode: job.mode });
  }
}

function spawnPeakWorker() {
  const w = new Worker(path.join(__dirname, 'peaks-worker.js'));
  w.busy = false;
  w.job = null;
  const settle = (msg) => {
    const job = w.job;
    w.job = null;
    w.busy = false;
    if (job) job(msg);
    pumpPeakQueue();
  };
  w.on('message', (msg) => settle(msg));
  w.on('error', (err) => {
    const idx = peakWorkers.indexOf(w);
    if (idx >= 0) peakWorkers.splice(idx, 1);
    settle({ ok: false, error: String((err && err.message) || err) });
  });
  w.on('exit', (code) => {
    if (code === 0) return;
    const idx = peakWorkers.indexOf(w);
    if (idx >= 0) peakWorkers.splice(idx, 1);
    settle({ ok: false, error: `peaks worker exit ${code}` });
  });
  peakWorkers.push(w);
  return w;
}

function peaksInWorker(pcm, mode = 'peaks') {
  return new Promise((resolve) => {
    peakQueue.push({ pcm, mode, resolve });
    pumpPeakQueue();
  });
}

async function analyze(filePath, opts = {}) {
  // peaks=false 时只读文件头（probe）：几百个素材一起导入也不会去读音频负载。
  // tagBytes 控制标签扫描读多少字节——探测阶段 512 KB 就够，看「信息」面板时再读全。
  const wantPeaks = opts.peaks !== false;
  const tagBytes = Number.isFinite(opts.tagBytes) ? opts.tagBytes : (2 << 20);
  return withProbeLimit(async () => {
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return { ok: false, reason: 'missing', path: filePath };
    }
    if (!stat.isFile()) return { ok: false, reason: 'not-a-file', path: filePath };

    const info = await audio.inspect(filePath);
    const key = audio.cacheKey(filePath, stat.size, stat.mtimeMs);
    const tags = await audio.readTags(filePath, tagBytes).catch(() => null);

    if (!info.ok) {
      return {
        ok: false,
        reason: info.reason || 'unsupported',
        path: filePath,
        format: info.format,
        meta: info.meta || {}
      };
    }

    if (info.kind === 'browser') {
      // Chromium decodes it; the renderer derives peaks from the decoded buffer,
      // but only for the素材 actually being played (see app.js ensurePeaks).
      return {
        ok: true,
        kind: 'browser',
        path: filePath,
        playPath: filePath,
        format: info.format,
        meta: {
          ...info.meta,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          tags: tags ? tags.flat : null,
          tagGroups: tags && tags.groups.length ? tags.groups : null,
          // 只传描述信息：图片字节留在主进程，渲染层需要时走 art:cover 拿缓存文件
          cover: tags && tags.picture
            ? { mime: tags.picture.mime || 'image/jpeg', bytes: tags.picture.bytes || 0, source: 'embedded' }
            : null
        },
        peaks: null
      };
    }

    const pcm = info.pcm;
    pcm.path = filePath;

    let playPath = filePath;

    // AIFF / AIFC can't be decoded by Chromium. Transcode a throwaway WAV into
    // the app cache for auditioning — the library file itself is never touched.
    // 探测阶段不做这件事：一个几百 MB 的 AIFF 转码会拖死导入。
    if (!pcm.nativePlayback && wantPeaks) {
      const wavFile = path.join(wavCacheDir(), key + '.wav');
      let have = false;
      try {
        const st = await fsp.stat(wavFile);
        have = st.size > 44;
      } catch { /* not cached */ }
      if (!have) {
        try {
          await audio.aiffToWav(pcm, wavFile);
        } catch (err) {
          return { ok: false, reason: 'transcode-failed', path: filePath, meta: info.meta };
        }
      }
      playPath = wavFile;
    }

    let peaks = wantPeaks ? await loadPeakCache(key) : null;
    if (wantPeaks && !peaks) {
      try {
        const r = await peaksInWorker(pcm);
        if (r && r.ok && r.data) {
          peaks = {
            binsPerSecond: r.peaks.binsPerSecond,
            channels: r.peaks.channels,
            bins: r.peaks.bins,
            zcr: r.peaks.zcr || null,
            data: r.data
          };
          await savePeakCache(key, peaks);
        }
      } catch (err) {
        peaks = null;
      }
    }

    return {
      ok: true,
      kind: 'pcm',
      path: filePath,
      playPath,
      format: info.format,
      meta: {
        ...info.meta,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        tags: tags ? tags.flat : null,
        tagGroups: tags && tags.groups.length ? tags.groups : null,
        // 只传描述信息：图片字节留在主进程，渲染层需要时走 art:cover 拿缓存文件
        cover: tags && tags.picture
          ? { mime: tags.picture.mime || 'image/jpeg', bytes: tags.picture.bytes || 0, source: 'embedded' }
          : null
      },
      peaks: peaks ? {
        binsPerSecond: peaks.binsPerSecond,
        channels: peaks.channels,
        bins: peaks.bins,
        data: peaks.data,
        zcr: peaks.zcr || null
      } : null
    };
  });
}

// ---------------------------------------------------------------------------
// Library scanning
// ---------------------------------------------------------------------------
const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information']);
const IMAGE_EXT_SET = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']);

/**
 * 把一棵目录扫成「分类树」：只保留**里面确实有音频（直接放着或更深层有）**的分支。
 * 顺带把每层的图片名字带回去，让渲染层知道这层有没有封面可挑。
 */
async function scanTreeDir(dir, depth) {
  if (depth > 8) return null;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const node = { name: path.basename(dir), path: dir, files: [], children: [], images: 0, imageNames: [] };
  for (const ent of entries) {
    const name = ent.name;
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(name.toLowerCase())) continue;
      const child = await scanTreeDir(full, depth + 1);
      if (child && (child.files.length || child.children.length)) node.children.push(child);
    } else if (ent.isFile()) {
      const ext = path.extname(name).toLowerCase();
      if (IMAGE_EXT_SET.has(ext)) {
        node.images++;
        if (node.imageNames.length < 40) node.imageNames.push(name);
        continue;
      }
      if (!AUDIO_EXT_SET.has(ext)) continue;
      let fst;
      try {
        fst = await fsp.stat(full);
      } catch {
        continue;
      }
      node.files.push({ path: full, name, size: fst.size, mtimeMs: fst.mtimeMs });
    }
  }
  node.files.sort((a, b) => a.name.localeCompare(b.name));
  node.children.sort((a, b) => a.name.localeCompare(b.name));
  return node;
}

async function scanOne(target, out, depth) {
  if (depth > 16) return;
  let st;
  try {
    st = await fsp.stat(target);
  } catch {
    return;
  }
  if (st.isFile()) {
    if (AUDIO_EXT_SET.has(path.extname(target).toLowerCase())) {
      out.push({
        path: target,
        name: path.basename(target),
        size: st.size,
        mtimeMs: st.mtimeMs
      });
    }
    return;
  }
  if (!st.isDirectory()) return;

  let entries;
  try {
    entries = await fsp.readdir(target, { withFileTypes: true });
  } catch {
    return;
  }
  const subdirs = [];
  const fileJobs = [];
  for (const ent of entries) {
    const name = ent.name;
    if (name.startsWith('.')) continue;
    const full = path.join(target, name);
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(name.toLowerCase())) subdirs.push(full);
    } else if (ent.isFile()) {
      if (!AUDIO_EXT_SET.has(path.extname(name).toLowerCase())) continue;
      fileJobs.push({ full, name });
    }
  }
  // 同一目录里的 stat 一起发出去。1556 个目录、9000 多个文件，原来是一条条
  // await，光等 stat 就要好几秒；现在一个目录内并发，几百毫秒就扫完了。
  await Promise.all(fileJobs.map(async ({ full, name }) => {
    try {
      const fst = await fsp.stat(full);
      out.push({ path: full, name, size: fst.size, mtimeMs: fst.mtimeMs });
    } catch {
      /* 读不到就跳过，不要让整个扫描失败 */
    }
  }));
  for (const d of subdirs) await scanOne(d, out, depth + 1);
}

// ---------------------------------------------------------------------------
// Library persistence
// ---------------------------------------------------------------------------
// 本次运行有没有成功读到过清单、读到了多少条。用来守住「读到空 → 立刻把好清单
// 覆盖成空」这个事故：只有真的读到过内容、用户自己删干净了，才允许写回空清单。
let libraryLoadedCount = 0;

async function loadLibrary() {
  try {
    const raw = await fsp.readFile(libraryPath(), 'utf8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.items)) {
      throw new Error('library shape is not an object with items[]');
    }
    libraryLoadedCount = data.items.length;
    return data;
  } catch (err) {
    // 读不出来就把这份文件原地留个证据，免得下一次保存把它盖掉之后无从查起
    try {
      const file = libraryPath();
      const st = await fsp.stat(file);
      if (st.size > 0) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        await fsp.copyFile(file, file + '.unreadable-' + stamp);
      }
    } catch {
      /* 文件本来就不存在，没什么可留的 */
    }
    return { items: [], settings: {} };
  }
}

async function saveLibrary(data) {
  const file = libraryPath();
  const tmp = file + '.tmp';
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });

    // The renderer serialises the library itself and hands us the string.
    // Shipping 100k item objects over IPC costs ~400 ms of structured clone in
    // the renderer (measured), while a string copy is nearly free — and this
    // process can afford to write it. `itemCount` lets us keep the guard below
    // without parsing the whole document.
    const pre = typeof data?.json === 'string' ? data : null;
    const itemCount = pre ? Number(pre.itemCount) || 0 : (Array.isArray(data?.items) ? data.items.length : 0);
    // 渲染层只有在「用户自己把条目删光」时才把 allowEmpty 置真。其它情况下的空
    // 清单（刚启动还没读完、读失败、并发实例）一律不许覆盖磁盘上已有的内容。
    const allowEmpty = data?.allowEmpty === true;

    if (itemCount === 0) {
      let prevCount = 0;
      try {
        const prev = JSON.parse(await fsp.readFile(file, 'utf8'));
        if (Array.isArray(prev.items)) prevCount = prev.items.length;
      } catch {
        prevCount = 0;
      }
      if (prevCount > 0) {
        // 先留证据：万一真的是用户的删除，这份备份也还在
        try {
          await fsp.copyFile(file, file + '.beforeempty');
        } catch {
          /* 备份失败不影响判断，下面直接放弃这次写入 */
        }
        if (!allowEmpty) {
          saveLog(`refused empty save: prev=${prevCount} loaded=${libraryLoadedCount}`);
          return false;
        }
      }
      saveLog(`empty save allowed: prev=${prevCount} loaded=${libraryLoadedCount}`);
    }

    await fsp.writeFile(tmp, pre ? pre.json : JSON.stringify(data));
    await fsp.rename(tmp, file);
    libraryLoadedCount = itemCount;
    saveLog(`saved items=${itemCount}`);
    return true;
  } catch (err) {
    saveLog(`save failed: ${err && err.message ? err.message : err}`);
    return false;
  }
}

// 每次写清单留一行记录（只留最近 200 行）。再出「清单变空」这种事时能看出
// 是谁写的、当时读到几条，不用再靠猜。
function saveLog(line) {
  try {
    const file = path.join(path.dirname(libraryPath()), 'save.log');
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    let old = '';
    try { old = fs.readFileSync(file, 'utf8'); } catch { old = ''; }
    const lines = old.split('\n').filter(Boolean);
    lines.push(`${stamp} ${line}`);
    while (lines.length > 200) lines.shift();
    fs.writeFileSync(file, lines.join('\n') + '\n');
  } catch {
    /* 日志写不了就算了，不影响保存 */
  }
}

// 界面层面的异常（卡住、渲染进程崩了、黑屏自救触发）记到 data\ui.log，
// 和 save.log 一样的截断策略，方便事后对时间线。
function uiLog(line) {
  try {
    const file = path.join(path.dirname(libraryPath()), 'ui.log');
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    let old = '';
    try { old = fs.readFileSync(file, 'utf8'); } catch { old = ''; }
    const lines = old.split('\n').filter(Boolean);
    lines.push(`${stamp} ${line}`);
    while (lines.length > 200) lines.shift();
    fs.writeFileSync(file, lines.join('\n') + '\n');
  } catch {
    /* 日志写不了就算了 */
  }
}

// 主进程层面的兜底日志：拖拽闪退时 Application 日志里什么都没有，
// 只能靠自己写。崩了也留个时间线，别让下一次又变成"查无此案"。
process.on('uncaughtException', (err) => {
  uiLog('uncaughtException ' + String((err && (err.stack || err.message)) || err).slice(0, 600));
});
process.on('unhandledRejection', (reason) => {
  uiLog('unhandledRejection ' + String((reason && (reason.stack || reason.message)) || reason).slice(0, 600));
});
app.on('child-process-gone', (_e, details) => {
  uiLog('child-process-gone ' + (details && details.type) +
        ' reason=' + (details && details.reason) +
        ' exit=' + (details && details.exitCode));
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1080,
    minHeight: 640,
    backgroundColor: '#0a0c10',
    icon: path.join(__dirname, 'assets', 'app.ico'),
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0a0c10',
      symbolColor: '#8b97a8',
      height: 40
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.loadURL('snd://app/renderer/index.html');

  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // 界面卡住 / 渲染进程没了的时候，先重绘，再不行就整页重载（清单在磁盘上，不会丢）
  mainWindow.webContents.on('did-start-loading', () => {
    lastUiAlive = Date.now();
    uiSuppressUntil = Date.now() + 15000;
  });
  mainWindow.webContents.on('did-finish-load', () => {
    lastUiAlive = Date.now();
    uiSuppressUntil = Date.now() + 6000;
  });
  mainWindow.on('unresponsive', () => {
    uiLog('window unresponsive');
    dockSafeRepaint([0, 300, 900]);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    uiLog('render-process-gone ' + (details && details.reason));
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      try { mainWindow.webContents.reload(); } catch { /* ignore */ }
    }, 400);
  });

  // A stray file dropped outside our handler must not navigate the window.
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    if (code !== -3) {
      console.error('did-fail-load', code, desc);
      uiLog('did-fail-load ' + code + ' ' + desc);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  await ensureDirs();
  // 每天第一次启动留一份清单备份（保留 7 天）。放后台跑，不拖慢启动。
  autoBackupDaily().catch(() => {});
  // macOS 上「没有菜单栏」就连 Cmd+C / Cmd+V / Cmd+Q 一起没有，所以给一份最小菜单；
  // Windows 的标题栏是自绘的，保持无菜单。
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about', label: '关于 SoundBin' },
          { type: 'separator' },
          { role: 'hide', label: '隐藏 SoundBin' },
          { role: 'hideOthers', label: '隐藏其他' },
          { role: 'unhide', label: '全部显示' },
          { type: 'separator' },
          { role: 'quit', label: '退出 SoundBin' }
        ]
      },
      { role: 'editMenu', label: '编辑' },
      {
        label: '视图',
        submenu: [
          { role: 'reload', label: '重新载入' },
          { role: 'toggleDevTools', label: '开发者工具' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: '全屏' }
        ]
      },
      {
        label: '窗口',
        submenu: [
          { role: 'minimize', label: '最小化' },
          { role: 'zoom', label: '缩放' },
          { role: 'close', label: '关闭窗口' }
        ]
      }
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }

  // Windows 上给任务栏一个稳定的 AppUserModelID（图标分组 / 通知都靠它）；
  // macOS 没有窗口图标的概念，图标要走 dock。
  if (process.platform === 'win32') {
    try { app.setAppUserModelId('com.soundbin.app'); } catch { /* 老系统忽略 */ }
  } else if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(path.join(SRC_DIR, 'assets', 'app.png')); } catch { /* 图标缺失不影响启动 */ }
  }

  protocol.handle('snd', async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('bad url', { status: 400 });
    }

    if (url.hostname !== 'app') {
      return new Response('not found', { status: 404 });
    }

    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/audio') {
      const p = url.searchParams.get('p');
      if (!p) return new Response('missing p', { status: 400 });
      const resolved = path.normalize(p);
      if (!path.isAbsolute(resolved)) return new Response('bad path', { status: 400 });
      return serveFile(resolved, request.headers.get('range'));
    }

    // Static renderer files.
    const rel = pathname.replace(/^\/+/, '');
    const target = path.normalize(path.join(SRC_DIR, rel));
    const allowed = WEB_ROOTS.some((root) => target === root || target.startsWith(root + path.sep));
    if (!allowed) {
      return new Response('forbidden', { status: 403 });
    }
    return serveFile(target, request.headers.get('range'));
  });

  createWindow();
  dockInit();
  uiWatchdogStart();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch { /* ignore */ }
});

app.on('window-all-closed', () => {
  app.quit();
});

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  userData: userDataDir(),
  cache: cacheDir(),
  home: os.homedir()
}));

// 搬完 data\ 或从备份回滚之后，必须重启：清单、缓存、worker 都按旧路径打开着。
ipcMain.handle('app:relaunch', () => {
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 120);
  return { ok: true };
});

ipcMain.handle('library:load', () => loadLibrary());
ipcMain.handle('library:save', (_e, data) => saveLibrary(data));

ipcMain.handle('dialog:pick-files', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '添加音频文件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '音频', extensions: ['wav', 'wave', 'bwf', 'rf64', 'aif', 'aiff', 'aifc', 'mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'caf'] },
      { name: '全部文件', extensions: ['*'] }
    ]
  });
  if (res.canceled) return [];
  return res.filePaths;
});

ipcMain.handle('dialog:pick-folder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '添加文件夹',
    properties: ['openDirectory', 'multiSelections']
  });
  if (res.canceled) return [];
  return res.filePaths;
});

ipcMain.handle('library:scan', async (_e, targets) => {
  const out = [];
  if (!Array.isArray(targets)) return out;
  for (const t of targets) {
    if (typeof t !== 'string' || !t) continue;
    await scanOne(t, out, 0);
  }
  return out;
});

/**
 * 文件夹拖到分类上时用：把目录扫成分类树（主文件夹 → 子文件夹 → …），
 * 只保留里面有音频的分支。图片/封面不进来，但会报数量。
 */
ipcMain.handle('library:scan-tree', async (_e, targets) => {
  const out = [];
  if (!Array.isArray(targets)) return out;
  for (const t of targets) {
    if (typeof t !== 'string' || !t) continue;
    try {
      const st = await fsp.stat(t);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    const node = await scanTreeDir(t, 0);
    if (node) out.push(node);
  }
  return out;
});

/**
 * What a drop actually carried: a folder the user can name a library after, or
 * just files. The renderer cannot tell from a `File` object alone.
 */
ipcMain.handle('drag:inspect', async (_e, paths) => {
  const out = [];
  if (!Array.isArray(paths)) return out;
  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue;
    try {
      const st = await fsp.stat(p);
      out.push({ path: p, isDir: st.isDirectory(), name: path.basename(p) });
    } catch {
      out.push({ path: p, isDir: false, name: path.basename(p) });
    }
  }
  return out;
});

ipcMain.handle('audio:inspect', (_e, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return { ok: false, reason: 'bad-path' };
  return analyze(filePath);
});

// 只要元数据（时长/采样率/声道/位深/标签）：导入时批量调用，单个几毫秒。
// 波形峰值不在这里算——那是按需的（audio:peaks）。
ipcMain.handle('audio:probe', (_e, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return { ok: false, reason: 'bad-path' };
  return analyze(filePath, { peaks: false, tagBytes: 512 * 1024 });
});

// 波形峰值：命中缓存就只读缓存，没有才把负载读一遍（在工作线程里算）。
ipcMain.handle('audio:peaks', (_e, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return { ok: false, reason: 'bad-path' };
  return analyze(filePath, { peaks: true });
});

// 响度（EBU R128 近似）/ 峰值 / 频谱图：都在工作线程里算，不依赖 ffmpeg。
ipcMain.handle('audio:deep', async (_e, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return { ok: false, reason: 'bad-path' };
  const info = await audio.inspect(filePath).catch(() => null);
  if (!info || !info.ok || info.kind !== 'pcm' || !info.pcm) {
    return { ok: false, reason: (info && info.kind) || 'not-pcm' };
  }
  const pcm = info.pcm;
  pcm.path = filePath;
  const r = await peaksInWorker(pcm, 'deep').catch((err) => ({ ok: false, error: String(err) }));
  if (!r || !r.ok || !r.deep) return { ok: false, reason: (r && r.error) || 'worker-failed' };
  return { ok: true, ...r.deep };
});

// 批量判断路径是否还在（找回丢失素材用）。并发 64，1.5 万条大约 1 秒。
ipcMain.handle('fs:exists', async (_e, paths) => {
  const list = Array.isArray(paths) ? paths : [];
  const out = new Array(list.length).fill(false);
  let at = 0;
  const run = async () => {
    for (;;) {
      const i = at++;
      if (i >= list.length) return;
      const p = list[i];
      if (typeof p !== 'string' || !p) continue;
      try {
        const st = await fsp.stat(p);
        out[i] = st.isFile();
      } catch {
        out[i] = false;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(64, list.length || 1) }, run));
  return out;
});

// 把 UCS / 标签字段写回 WAV 的 RIFF LIST-INFO（磁盘文件本身被改写）。
ipcMain.handle('audio:write-info', async (_e, payload) => {
  const { path: filePath, fields } = payload || {};
  if (typeof filePath !== 'string' || !filePath) return { ok: false, reason: 'bad-path' };
  if (!fields || typeof fields !== 'object') return { ok: false, reason: 'no-fields' };
  try {
    return await audio.writeWavInfo(filePath, fields);
  } catch (err) {
    return { ok: false, reason: 'error', error: String((err && err.message) || err) };
  }
});

// 批量复制到工程目录：不移动原文件，重名自动加 (2)(3)。
ipcMain.handle('files:copy', async (_e, payload) => {
  const { paths, dest } = payload || {};
  if (!Array.isArray(paths) || !dest) return { ok: false, reason: 'bad-args' };
  try {
    const st = await fsp.stat(dest);
    if (!st.isDirectory()) return { ok: false, reason: 'not-a-dir' };
  } catch {
    // 目标目录不存在就建（用户可能选到一个还没建的工程子目录）
    try {
      await fsp.mkdir(dest, { recursive: true });
    } catch {
      return { ok: false, reason: 'no-dest' };
    }
  }
  const done = [];
  const failed = [];
  for (const src of paths) {
    if (typeof src !== 'string' || !src) continue;
    try {
      const base = path.basename(src);
      const ext = path.extname(base);
      const stem = base.slice(0, base.length - ext.length);
      let target = path.join(dest, base);
      let i = 2;
      // 已存在就换名，不覆盖别人的素材
      while (true) {
        try {
          const s = await fsp.stat(target);
          if (!s) break;
          target = path.join(dest, `${stem} (${i++})${ext}`);
        } catch {
          break;
        }
      }
      await fsp.copyFile(src, target);
      done.push({ from: src, to: target });
    } catch (err) {
      failed.push({ path: src, reason: String((err && err.message) || err) });
    }
  }
  return { ok: true, copied: done.length, failed: failed.length, dest, done, errors: failed };
});

// 批量改名：任何一条目标已存在就整批不干（避免半途改坏）。
ipcMain.handle('files:rename', async (_e, payload) => {
  const items = (payload && payload.items) || [];
  if (!Array.isArray(items) || !items.length) return { ok: false, reason: 'no-items' };
  const conflicts = [];
  for (const it of items) {
    if (!it || !it.from || !it.to) continue;
    if (path.resolve(it.from) === path.resolve(it.to)) continue;
    try {
      await fsp.stat(it.to);
      conflicts.push(it.to);
    } catch {
      /* 目标不存在，可以改 */
    }
  }
  if (conflicts.length) return { ok: false, reason: 'exists', conflicts: conflicts.slice(0, 20) };
  const done = [];
  const failed = [];
  for (const it of items) {
    if (!it || !it.from || !it.to) continue;
    try {
      if (path.resolve(it.from) === path.resolve(it.to)) continue;
      await fsp.rename(it.from, it.to);
      done.push({ from: it.from, to: it.to });
    } catch (err) {
      failed.push({ path: it.from, reason: String((err && err.message) || err) });
    }
  }
  return { ok: failed.length === 0, renamed: done.length, done, errors: failed };
});

// 保存文本（选片单 CSV / Markdown）
ipcMain.handle('dialog:save-text', async (_e, payload) => {
  const { content, defaultName, filters } = payload || {};
  if (typeof content !== 'string') return { ok: false, reason: 'no-content' };
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const r = await dialog.showSaveDialog(win, {
    defaultPath: defaultName || 'export.txt',
    filters: Array.isArray(filters) && filters.length ? filters : [{ name: '文本', extensions: ['txt'] }]
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    // CSV 加 BOM，Excel 打开中文才不乱码
    const isCsv = /\.csv$/i.test(r.filePath);
    const body = isCsv ? '\ufeff' + content : content;
    await fsp.writeFile(r.filePath, body, 'utf8');
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) };
  }
});

// Zoomed-in waveform detail: reduce only the visible window to `cols` min/max
// columns straight from the samples, instead of interpolating the 320 bins/s
// envelope. Renderer debounces by view window, so this stays cheap.
ipcMain.handle('audio:window', (_e, opts) => {
  const { path: filePath, start, end, cols } = opts || {};
  if (typeof filePath !== 'string' || !filePath) return { ok: false, reason: 'bad-path' };
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { ok: false, reason: 'bad-range' };
  }
  return withReadLimit(async () => {
    try {
      const info = await audio.inspect(filePath);
      if (!info.ok || info.kind !== 'pcm' || !info.pcm) {
        return { ok: false, reason: 'not-pcm' };
      }
      const pcm = info.pcm;
      pcm.path = filePath;
      const win = await audio.readWindow(pcm, start, end, cols);
      if (!win) return { ok: false, reason: 'read-failed' };
      return {
        ok: true,
        channels: win.channels,
        cols: win.cols,
        startSec: win.startSec,
        endSec: win.endSec,
        data: win.data
      };
    } catch (err) {
      return { ok: false, reason: 'error' };
    }
  });
});

// Tags only: cheap enough to refresh lazily for entries restored from an old
// library.json that predates tag support.
ipcMain.handle('audio:tags', async (_e, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return { ok: false, reason: 'bad-path' };
  try {
    const tags = await audio.readTags(filePath);
    return {
      ok: true,
      tags: tags.flat,
      tagGroups: tags.groups,
      cover: tags.picture
        ? { mime: tags.picture.mime || 'image/jpeg', bytes: tags.picture.bytes || 0, source: 'embedded' }
        : null
    };
  } catch {
    return { ok: false, reason: 'error' };
  }
});

// Trim export: copy the selected region out as a normal WAV, next to the source
// by default. The library file is never modified, so the "cut the front off"
// workflow is always reversible — the original stays as it is.
ipcMain.handle('audio:trim', async (_e, opts) => {
  const { path: filePath, start, end, outPath } = opts || {};
  if (typeof filePath !== 'string' || !filePath) return { ok: false, reason: 'bad-path' };
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { ok: false, reason: 'bad-range' };
  }
  try {
    const info = await audio.inspect(filePath);
    if (!info.ok || info.kind !== 'pcm' || !info.pcm) return { ok: false, reason: 'not-pcm' };
    const pcm = info.pcm;
    pcm.path = filePath;
    const dest = (typeof outPath === 'string' && outPath && path.isAbsolute(outPath))
      ? outPath
      : defaultTrimPath(filePath, start, end);
    if (path.resolve(dest) === path.resolve(filePath)) return { ok: false, reason: 'same-file' };
    const res = await audio.writeWavRegion(pcm, start, end, dest);
    if (!res) return { ok: false, reason: 'write-failed' };
    return {
      ok: true,
      path: dest,
      name: path.basename(dest),
      frames: res.frames,
      bytes: res.bytes,
      duration: res.frames / (info.meta.sampleRate || pcm.sampleRate || 1)
    };
  } catch (err) {
    return { ok: false, reason: 'error', message: String(err && err.message) };
  }
});

// Cached "trimmed as a real file" clip, used by drag-out. Dragging a row that
// has a trim region must hand the DAW the trimmed audio (not the whole source),
// so the clip is rendered into data\cache\clips\ once and reused afterwards.
// Key includes size+mtime, so editing the source or moving the trim endpoints
// produces a fresh file instead of a stale one.
ipcMain.handle('audio:clip', async (_e, opts) => {
  const { path: filePath, start, end } = opts || {};
  if (typeof filePath !== 'string' || !filePath) return { ok: false, reason: 'bad-path' };
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { ok: false, reason: 'bad-range' };
  }
  try {
    const st = await fsp.stat(filePath);
    const key = crypto.createHash('sha1')
      .update(`${filePath}|${st.size}|${Math.round(st.mtimeMs)}|${start.toFixed(4)}|${end.toFixed(4)}`)
      .digest('hex');
    const base = path.basename(filePath, path.extname(filePath));
    const dest = path.join(clipCacheDir(), `${base}_trim_${stampSec(start)}-${stampSec(end)}_${key.slice(0, 6)}.wav`);

    // 缓存命中就不必再解析源文件
    try {
      const dst = await fsp.stat(dest);
      if (dst.size > 44) {
        return { ok: true, path: dest, name: path.basename(dest), cached: true, bytes: dst.size - 44 };
      }
    } catch { /* 没有缓存，接着生成 */ }

    const info = await audio.inspect(filePath);
    if (!info.ok || info.kind !== 'pcm' || !info.pcm) return { ok: false, reason: 'not-pcm' };
    const pcm = info.pcm;
    pcm.path = filePath;
    const res = await audio.writeWavRegion(pcm, start, end, dest);
    if (!res) return { ok: false, reason: 'write-failed' };
    return { ok: true, path: dest, name: path.basename(dest), cached: false, bytes: res.bytes };
  } catch (err) {
    return { ok: false, reason: 'error', message: String(err && err.message) };
  }
});

// 开着效果器时拖出去的版本：渲染层用 OfflineAudioContext 跑完效果器链、
// 编成 24-bit WAV 之后发过来，这里按"效果器参数签名"分目录落盘并返回真实路径。
// 放到 cache 下是为了「清空缓存」能一次清干净，也不会污染用户的素材目录。
ipcMain.handle('audio:fx-wav', async (_e, payload) => {
  try {
    const src = payload && payload.buffer;
    if (!src) return { ok: false, reason: 'no-buffer' };
    const bytes = Buffer.isBuffer(src) ? src : Buffer.from(new Uint8Array(src));
    if (bytes.length < 44) return { ok: false, reason: 'too-short' };
    if (bytes.length > 400 * 1024 * 1024) return { ok: false, reason: 'too-big' };
    if (bytes.toString('latin1', 0, 4) !== 'RIFF') return { ok: false, reason: 'not-wav' };

    const sig = String(payload.sig || 'default').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16) || 'default';
    const rawBase = String(payload.base || 'audio').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80) || 'audio';
    const dir = fxCacheDir(sig);
    await fsp.mkdir(dir, { recursive: true });
    const dest = path.join(dir, `${rawBase} (fx).wav`);
    await fsp.writeFile(dest, bytes);
    return { ok: true, path: dest, name: path.basename(dest), bytes: bytes.length };
  } catch (err) {
    return { ok: false, reason: 'error', message: String(err && err.message) };
  }
});

// 采样器渲染出来的版本：渲染层按采样器参数离线渲一遍、编成 24-bit WAV 发过来，
// 这里按"参数签名"分目录落盘并返回真实路径。同样放 cache 下，清缓存能一起清掉。
ipcMain.handle('audio:sampler-wav', async (_e, payload) => {
  try {
    const src = payload && payload.buffer;
    if (!src) return { ok: false, reason: 'no-buffer' };
    const bytes = Buffer.isBuffer(src) ? src : Buffer.from(new Uint8Array(src));
    if (bytes.length < 44) return { ok: false, reason: 'too-short' };
    if (bytes.length > 400 * 1024 * 1024) return { ok: false, reason: 'too-big' };
    if (bytes.toString('latin1', 0, 4) !== 'RIFF') return { ok: false, reason: 'not-wav' };

    const sig = String(payload.sig || 'default').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16) || 'default';
    const rawBase = String(payload.base || 'audio').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80) || 'audio';
    const dir = samplerCacheDir(sig);
    await fsp.mkdir(dir, { recursive: true });
    const dest = path.join(dir, `${rawBase} (sampler).wav`);
    await fsp.writeFile(dest, bytes);
    return { ok: true, path: dest, name: path.basename(dest), bytes: bytes.length };
  } catch (err) {
    return { ok: false, reason: 'error', message: String(err && err.message) };
  }
});

// Cover art for one audio file: embedded art when present, otherwise the
// folder's cover/folder image. Cached as a real file so the renderer can use a
// normal <img src="snd://..."> (no data: URL bloat, no CSP change).
const MAX_COVER_BYTES = 16 << 20;
function sniffImageMime(data, fallback) {
  if (data.length > 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (data.length > 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (data.length > 6 && data.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  if (data.length > 2 && data.toString('latin1', 0, 2) === 'BM') return 'image/bmp';
  return fallback || 'image/jpeg';
}

ipcMain.handle('art:cover', async (_e, opts) => {
  const filePath = typeof opts === 'string' ? opts : (opts && opts.path);
  if (typeof filePath !== 'string' || !filePath) return { ok: false, reason: 'bad-path' };
  try {
    const art = await audio.extractCover(filePath);
    if (!art.ok) return art;
    if (art.data.length > MAX_COVER_BYTES) return { ok: false, reason: 'too-big' };

    const mime = sniffImageMime(art.data, art.mime);
    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp'
      : mime === 'image/gif' ? 'gif' : mime === 'image/bmp' ? 'bmp' : 'jpg';

    let key;
    try {
      const st = await fsp.stat(filePath);
      key = audio.cacheKey(filePath, st.size, st.mtimeMs);
    } catch {
      key = crypto.createHash('sha1').update(filePath).digest('hex');
    }

    const dest = path.join(artCacheDir(), `${key}.${ext}`);
    let have = false;
    try {
      const st = await fsp.stat(dest);
      have = st.size > 32;
    } catch { /* write it */ }
    if (!have) {
      await fsp.mkdir(artCacheDir(), { recursive: true });
      await fsp.writeFile(dest, art.data);
    }

    return {
      ok: true,
      url: `snd://app/audio?p=${encodeURIComponent(dest)}`,
      mime,
      bytes: art.data.length,
      source: art.source,
      from: art.from,
      rel: art.rel || null
    };
  } catch {
    return { ok: false, reason: 'error' };
  }
});

// 判断一个盘还在不在（移动盘拔掉时，整卷的素材都算缺失，不用逐个 stat）。
// 结果缓存 3 秒，避免一次核对里对同一个盘反复 access。
const VOLUME_ALIVE = new Map();
async function volumeAlive(root) {
  const hit = VOLUME_ALIVE.get(root);
  if (hit && Date.now() - hit.at < 3000) return hit.ok;
  let ok = true;
  try { await fsp.access(root); } catch { ok = false; }
  VOLUME_ALIVE.set(root, { ok, at: Date.now() });
  return ok;
}

/**
 * 批量核对文件是否还在。
 *
 * 老实现是 `Promise.all(paths.map(stat))`——5 万条素材会同时甩出 5 万个 stat，
 * 全部挤进 libuv 的 4 个线程，把主进程的磁盘队列占满：启动后界面能点，
 * 但任何要读盘的操作（音频、峰值、保存）都排在后面，看起来就是"卡很久"。
 * 现在：先按盘分组，盘不在就直接判缺失；在的按 16 路并发 stat。
 */
ipcMain.handle('file:exists', async (_e, paths) => {
  const result = {};
  if (!Array.isArray(paths)) return result;

  const byRoot = new Map();
  for (const p of paths) {
    if (typeof p !== 'string' || !p) { result[p] = { ok: false }; continue; }
    let root = path.parse(p).root;
    if (!root) root = '';
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(p);
  }

  const LIMIT = 16;
  const statOne = async (p) => {
    try {
      const st = await fsp.stat(p);
      result[p] = st.isFile() ? { ok: true, size: st.size, mtimeMs: st.mtimeMs } : { ok: false };
    } catch {
      result[p] = { ok: false };
    }
  };

  const roots = [...byRoot.keys()];
  const alive = new Map();
  await Promise.all(roots.map(async (r) => {
    if (!r) return;
    // 网络路径（\\server\share）和空根不做整卷判断，逐条 stat
    if (!/^[A-Za-z]:\\/.test(r)) return;
    alive.set(r, await volumeAlive(r));
  }));

  const queue = [];
  for (const [root, list] of byRoot) {
    if (alive.get(root) === false) {
      for (const p of list) result[p] = { ok: false };
    } else {
      for (const p of list) queue.push(p);
    }
  }

  let idx = 0;
  const worker = async () => {
    while (idx < queue.length) {
      const p = queue[idx++];
      await statOne(p);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LIMIT, queue.length) }, worker));
  return result;
});

ipcMain.handle('shell:reveal', (_e, filePath) => {
  if (typeof filePath === 'string' && filePath) shell.showItemInFolder(filePath);
});

ipcMain.handle('shell:open', (_e, filePath) => {
  if (typeof filePath === 'string' && filePath) shell.openPath(filePath);
});

ipcMain.handle('cache:size', async () => {
  let total = 0;
  async function walk(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(full);
      else {
        try { total += (await fsp.stat(full)).size; } catch { /* ignore */ }
      }
    }
  }
  await walk(cacheDir());
  return total;
});

ipcMain.handle('cache:clear', async () => {
  try {
    await fsp.rm(cacheDir(), { recursive: true, force: true });
    await ensureDirs();
    return true;
  } catch {
    return false;
  }
});

// ---------------------------------------------------------------------------
// 数据位置 / 备份
//
// 「存储更换」：把整个 data\ 搬到别的盘。指针写进 %APPDATA%\SoundBin\，下次启动
// 就按指针走；搬完要重启（清单、缓存、worker 全部按旧路径打开的）。
// 备份：每天第一次启动自动留一份 library.json，保留 7 天；搬盘/误删之后能回滚。
// ---------------------------------------------------------------------------
function dataLocationPath() {
  return path.join(app.getPath('appData'), 'SoundBin', 'data-location.json');
}
function backupDir() {
  return path.join(userDataDir(), 'backups');
}
function backupStamp(d) {
  const t = d || new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
// 备份文件名：「library-2026-11-14.json」是当天自动那份，
// 「library-2026-11-14-153012.json」是手动那份；两种都能恢复。
const BACKUP_RE = /^library-\d{4}-\d{2}-\d{2}(?:-\d{6})?\.json$/;
async function dirSizeBytes(dir) {
  let total = 0;
  async function walk(d) {
    let ents;
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        try { total += (await fsp.stat(p)).size; } catch { /* 正在被写的文件跳过 */ }
      }
    }
  }
  await walk(dir);
  return total;
}
async function pruneBackups(keep = 7) {
  let names = [];
  try {
    names = (await fsp.readdir(backupDir())).filter((n) => BACKUP_RE.test(n));
  } catch { return; }
  names.sort().reverse();
  for (const n of names.slice(keep)) {
    try { await fsp.unlink(path.join(backupDir(), n)); } catch { /* ignore */ }
  }
}
async function autoBackupDaily() {
  const lib = libraryPath();
  try {
    const st = await fsp.stat(lib);
    if (!st.isFile() || st.size < 1024) return; // 空清单不值得备份
    await fsp.mkdir(backupDir(), { recursive: true });
    const target = path.join(backupDir(), `library-${backupStamp()}.json`);
    try {
      await fsp.access(target);
      return; // 今天已经备份过
    } catch { /* 继续写 */ }
    await fsp.copyFile(lib, target);
    await pruneBackups(7);
  } catch { /* 首次启动还没有清单 */ }
}

ipcMain.handle('storage:info', async () => {
  const cur = userDataDir();
  let size = 0;
  try { size = await dirSizeBytes(cur); } catch { /* ignore */ }
  let libBytes = 0;
  try { libBytes = (await fsp.stat(libraryPath())).size; } catch { /* ignore */ }
  return {
    ok: true,
    current: cur,
    portable: app.isPackaged && !process.argv.some((a) => a.startsWith('--user-data-dir')),
    size,
    libraryBytes: libBytes,
    custom: !!readDataLocation(),
    pointer: dataLocationPath()
  };
});

ipcMain.handle('storage:migrate', async (_e, target) => {
  if (typeof target !== 'string' || !target) return { ok: false, reason: 'bad-target' };
  const dest = path.resolve(target);
  const cur = path.resolve(userDataDir());
  if (dest === cur) return { ok: false, reason: 'same-dir' };
  if (dest.startsWith(cur + path.sep) || cur.startsWith(dest + path.sep)) {
    return { ok: false, reason: 'nested' };
  }
  try {
    await fsp.mkdir(dest, { recursive: true });
    // data\ 里的清单必须一起搬；cache\ 可以重建，但一起搬省得下次重新分析
    await fsp.cp(cur, dest, { recursive: true, force: true, errorOnExist: false });
    const need = path.join(dest, 'library.json');
    const src = path.join(cur, 'library.json');
    // 源有清单就必须在目标里看到它，否则不算搬成功
    if (fs.existsSync(src) && !fs.existsSync(need)) return { ok: false, reason: 'verify-failed' };
    await fsp.mkdir(path.dirname(dataLocationPath()), { recursive: true });
    await fsp.writeFile(dataLocationPath(), JSON.stringify({ dir: dest, at: Date.now() }, null, 2), 'utf8');
    return { ok: true, dir: dest };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) };
  }
});

ipcMain.handle('storage:reset', async () => {
  try {
    await fsp.rm(dataLocationPath(), { force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) };
  }
});

ipcMain.handle('backup:list', async () => {
  const out = [];
  try {
    const names = (await fsp.readdir(backupDir())).filter((n) => BACKUP_RE.test(n));
    for (const n of names.sort().reverse()) {
      try {
        const st = await fsp.stat(path.join(backupDir(), n));
        out.push({ name: n, bytes: st.size, mtime: st.mtimeMs });
      } catch { /* ignore */ }
    }
  } catch { /* 没有备份目录 */ }
  return { ok: true, dir: backupDir(), list: out };
});

ipcMain.handle('backup:create', async () => {
  try {
    await fsp.mkdir(backupDir(), { recursive: true });
    // 手动备份带上时分秒，不会覆盖当天自动那份
    const now = new Date();
    const hhmmss = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const target = path.join(backupDir(), `library-${backupStamp(now)}-${hhmmss}.json`);
    await fsp.copyFile(libraryPath(), target);
    await pruneBackups(7);
    return { ok: true, name: path.basename(target) };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) };
  }
});

ipcMain.handle('backup:restore', async (_e, name) => {
  if (typeof name !== 'string' || !BACKUP_RE.test(name)) {
    return { ok: false, reason: 'bad-name' };
  }
  try {
    const src = path.join(backupDir(), name);
    await fsp.access(src);
    // 覆盖前把当前清单再留一份，回滚进去也能退回来
    try {
      await fsp.copyFile(libraryPath(), path.join(backupDir(), `library-before-restore-${Date.now()}.json`));
    } catch { /* 当前可能还没有清单 */ }
    await fsp.copyFile(src, libraryPath());
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) };
  }
});

// Drag-and-drop out to the OS (this is what makes DAW drops work).
// `handle` rather than `on` on purpose: startDrag blocks until the mouse button
// is released, so the resolved promise is the renderer's only reliable signal
// that the drag is over. Without it the renderer cannot tell its own drag from
// an external file drag and would offer to re-import what it just dragged out.
ipcMain.handle('drag:start', (event, payload) => {
  try {
    let files = Array.isArray(payload?.files) ? payload.files.filter((f) => typeof f === 'string' && f) : [];
    if (!files.length) return { ok: false };
    // 一次只允许一个拖拽在跑。并发 startDrag 会把 OLE 拖拽源搞成两份，
    // 表现就是 DAW 拿到半截数据、或者目标进程直接崩。
    if (dockState.dragging) return { ok: false, busy: true };
    dockState.dragging = true;
    dockClearCollapse();
    // 记一行：拖的哪些文件、多大。闪退之后能对时间线。
    try {
      const sizes = files.map((f) => {
        try { return fs.statSync(f).size; } catch { return -1; }
      });
      uiLog('drag start n=' + files.length + ' sizes=' + sizes.join(','));
    } catch { /* ignore */ }
    if (files.length === 1) {
      const file = files[0];
      event.sender.startDrag({
        file,
        icon: payload?.icon || path.join(__dirname, 'assets', 'drag-icon.png')
      });
    } else {
      event.sender.startDrag({
        files,
        icon: payload?.icon || path.join(__dirname, 'assets', 'drag-icon.png')
      });
    }
    // startDrag 返回 = 鼠标已松开。等 250 ms 再放开贴边轮询，
    // 让 DAW 那边先把数据收完，免得窗口在拖拽收尾阶段还在 setBounds。
    setTimeout(() => {
      dockState.dragging = false;
      uiLog('drag end');
    }, 250);
    // 拖拽结束后把窗口拉回前台并重绘一次：某些 DAW 拿完数据后不还焦点，
    // 看起来就像卡住了（窗口不响应、也不重绘）
    setTimeout(() => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.focus();
          repaintWindow();
        }
      } catch { /* ignore */ }
    }, 30);
    return { ok: true, files: files.length };
  } catch (err) {
    console.error('drag:start failed', err);
    dockState.dragging = false;
    return { ok: false, error: String(err) };
  }
});

// ===========================================================================
// 贴边隐藏（QQ 式的侧边面板）
//
// 做法：窗口**始终贴在工作区边缘**，收起时宽度收到 DOCK_HANDLE（8 px），
// 展开时宽度回到设置的宽度。因为左边框固定跟着宽度走（右边贴边隐藏时
// x = 右边缘 - 宽度），窗口宽度从 8 长到 480 的过程看起来就是「从边上滑出来」。
//
// 为什么不用「把 480 px 宽的窗口挪到屏幕外、只留 8 px」那种写法：
// 多显示器 + 高 DPI 下系统会把窗口夹回某个显示器的工作区，实测在双屏机器上
// 会被扔到第二块屏幕上、宽度也被改掉。缩宽度没有这个问题。
//
// 收起状态下渲染层会切换成紧凑布局（body.dock-collapsed），只显示一条边缘把手。
// ===========================================================================
const DOCK_HANDLE = 8;

const dockState = {
  enabled: false,
  edge: 'right',
  width: 480,
  hidden: false,
  pinned: false,
  // 拖边界改宽度时临时钉住面板（不然鼠标一离开窗口就收起了）。
  // 和键盘/接口钉的 pinned 不同，这个「软钉」在鼠标重新进到面板里时自动解除。
  pinSoft: false,
  animating: false,
  shrinkMode: true,
  before: null,
  wa: null,
  poll: null,
  collapseTimer: null,
  lastExpandAt: 0,
  // 原生拖拽进行中：这期间一律不动窗口（不然 OLE 拖拽和 setBounds 抢窗口，容易崩）
  dragging: false,
  // 上一次收起的时间：收起后短时间内不要再展开，否则边界上会来回抽
  lastCollapseAt: 0
};

// 展开/收起各跑一条 170 ms 的补间，两条撞在一起会互相 setBounds。
// 每次开新补间就把代数 +1，旧的那条一看到代数变了就立刻收手。
let dockAnimGen = 0;

function dockInit() {
  // 窗口被关掉时别让定时器继续碰 null
  app.on('browser-window-created', (_e, win) => {
    win.on('closed', () => {
      if (win === mainWindow) dockStopPolling();
    });
  });
  // 不管贴边隐藏开没开，Ctrl+Alt+S 都注册上——
  // 没开的时候给个提示（不然按了完全没反应，用户会以为快捷键坏了）
  dockRegisterShortcut();
}

function dockDisplayWorkArea() {
  if (dockState.wa) return dockState.wa;
  try {
    const b = mainWindow ? mainWindow.getBounds() : null;
    const d = b ? screen.getDisplayMatching(b) : screen.getPrimaryDisplay();
    return d.workArea;
  } catch {
    return screen.getPrimaryDisplay().workArea;
  }
}

function dockTargetWidth(wa) {
  const half = Math.floor(wa.width * 0.5);
  const w = Number(dockState.width) || 480;
  return Math.max(320, Math.min(w, Math.max(320, half)));
}

/** 贴边窗口的矩形：宽度给定，贴左或贴右，高度铺满工作区。 */
function dockRect(width) {
  const wa = dockDisplayWorkArea();
  const w = Math.max(DOCK_HANDLE, Math.min(Math.round(width), wa.width));
  return {
    x: dockState.edge === 'right' ? wa.x + wa.width - w : wa.x,
    y: wa.y,
    width: w,
    height: wa.height
  };
}

function expandedRect() {
  return dockRect(dockTargetWidth(dockDisplayWorkArea()));
}

function collapsedRect() {
  return dockRect(DOCK_HANDLE);
}

function dockSend() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send('dock:mode', {
      enabled: dockState.enabled,
      edge: dockState.edge,
      hidden: dockState.hidden,
      shrinkMode: dockState.shrinkMode,
      width: dockState.width,
      panelWidth: mainWindow.getBounds().width
    });
  } catch { /* 窗口正在销毁 */ }
}

// 动画步数刻意压得很低：每调一次 setBounds，Windows 都要重建一次 DWM 表面，
// 8 ms 一步地连推二十几次，渲染进程一慢就整块黑掉（实测过）。7 步 / 260 ms
// 看起来仍然是滑出来的，但表面重建次数少了三分之二，黑屏几率大幅下降。
function dockAnimateTo(target, done) {
  if (!mainWindow || mainWindow.isDestroyed()) { done && done(); return; }
  const gen = ++dockAnimGen;
  // 动画途中又被要求去别的尺寸（鼠标在边界上来回蹭最容易出现）：
  // 别让两段补间互相打断——那正是肉眼看到的"抽一下"。直接硬切到位。
  if (dockState.animating) {
    try { mainWindow.setBounds(target); } catch { /* ignore */ }
    dockState.animating = false;
    dockAnchor(4);
    dockSafeRepaint();
    done && done();
    return;
  }
  const from = mainWindow.getBounds();
  const t0 = Date.now();
  const dur = 240;
  const stepMs = 34;
  dockState.animating = true;

  const step = () => {
    if (gen !== dockAnimGen) return;
    if (!mainWindow || mainWindow.isDestroyed()) { dockState.animating = false; done && done(); return; }
    const k = Math.min(1, (Date.now() - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    const rect = {
      x: Math.round(from.x + (target.x - from.x) * e),
      y: Math.round(from.y + (target.y - from.y) * e),
      width: Math.round(from.width + (target.width - from.width) * e),
      height: Math.round(from.height + (target.height - from.height) * e)
    };
    try { mainWindow.setBounds(rect); } catch { /* 忽略 */ }
    if (k < 1) setTimeout(step, stepMs);
    else {
      dockState.animating = false;
      dockAnchor(4);
      dockSafeRepaint();
      done && done();
      // 尺寸定下来之后再发一次权威状态：渲染层的 hidden 是异步消息，
      // 动画被打断时可能停在旧值上，于是「窗口半屏宽、界面却按收起藏起来」= 黑屏。
      setTimeout(() => { if (gen === dockAnimGen) dockSend(); }, 60);
    }
  };
  step();
}

// 系统会把窗口宽度夹到最小值（实测约 25–33 DIP），位置也可能被挤到屏幕外；
// 收尾时按实际宽度重新贴边，多试几次直到贴住——保证露出来的那截就在屏幕边缘上。
function dockAnchor(tries) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wa = dockDisplayWorkArea();
  let b;
  try { b = mainWindow.getBounds(); } catch { return; }
  const wantX = dockState.edge === 'right' ? wa.x + wa.width - b.width : wa.x;
  if (Math.abs(b.x - wantX) <= 1) return;
  try {
    mainWindow.setBounds({ x: wantX, y: wa.y, width: b.width, height: wa.height });
  } catch { return; }
  if (tries > 1) setTimeout(() => dockAnchor(tries - 1), 24);
}

function dockExpand() {
  if (!dockState.enabled || !dockState.hidden || !mainWindow) return;
  dockState.hidden = false;
  dockOverlayHeight(40);
  dockSend();
  dockAnimateTo(expandedRect());
}

function dockCollapse() {
  if (!dockState.enabled || dockState.hidden || !mainWindow) return;
  if (dockState.pinned) return;
  // 原生拖拽期间绝对不动窗口
  if (dockState.dragging) return;
  dockState.hidden = true;
  dockState.lastCollapseAt = Date.now();
  dockOverlayHeight(1);
  dockSend();
  dockAnimateTo(collapsedRect(), () => repaintWindow());
}

// 收起时窗口只剩几十像素宽，原生那三个窗口按钮会被挤成一团（最坏情况只剩一个 ✕，
// 点一下就把应用关了）。把标题栏叠加层高度压到 1 px 就看不见了，展开再还原。
function dockOverlayHeight(h) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    // 收起时把符号颜色也压成背景色：高度设 1 在某些 Windows 版本上仍然画得出 ✕
    mainWindow.setTitleBarOverlay(h < 10
      ? { color: '#0a0c10', symbolColor: '#0a0c10', height: h }
      : { color: '#0a0c10', symbolColor: '#8b97a8', height: h });
  } catch { /* 某些平台改不了就算了，不影响主功能 */ }
}

// 贴边模式来回切窗口属性时，Windows 会重建 DWM 表面，偶尔客户区整块黑掉。
// 抖一下高度能救回来，这里再补一次「整页重绘」把黑帧清掉。
function repaintWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.invalidate(); } catch { /* ignore */ }
}

// 把窗口摆回贴边该在的位置（宽度用设置里的值，x 贴着屏幕边）。
// hide/show 之后 Windows 会自己 restore 一次尺寸，所以这里要能被调用两次。
function dockRepin() {
  if (!mainWindow || mainWindow.isDestroyed() || !dockState.enabled) return;
  try {
    mainWindow.setBounds(dockState.hidden ? collapsedRect() : dockRect(dockState.width));
  } catch { /* ignore */ }
}

// 强制让窗口「重新画一遍」：贴边时把高度抖 1 px 再还原（DWM 会因此重建表面），
// 再让渲染进程整页重绘。抖的时候用「工作区高度」当基准，而不是读当前高度再加减，
// 否则几次叠加之后窗口会悄悄长高（实测 +4 px）。
function dockSafeRepaint(times = [0, 120, 420]) {
  for (const t of times) {
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      try {
        if (!dockState.enabled || dockState.hidden) { repaintWindow(); return; }
        const wa = dockDisplayWorkArea();
        const b = mainWindow.getBounds();
        if (Math.abs(b.height - wa.height) > 1) {
          mainWindow.setBounds({ x: b.x, y: b.y, width: b.width, height: wa.height });
        }
        mainWindow.setBounds({ x: b.x, y: b.y, width: b.width, height: wa.height - 1 });
        repaintWindow();
        setTimeout(() => {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          const b2 = mainWindow.getBounds();
          try { mainWindow.setBounds({ x: b2.x, y: b2.y, width: b2.width, height: wa.height }); } catch { /* ignore */ }
          repaintWindow();
        }, 40);
      } catch { /* ignore */ }
    }, t);
  }
}

// 界面心跳：渲染层在 rAF 里节流到每 400 ms 发一次 ui:alive。
// 窗口明明可见却好几秒没心跳，说明界面真卡住了（或者 DWM 表面丢了）：
// 5 秒先强制重绘；8 秒以后 hide/show 一下把 DWM 表面整个重建（不销毁渲染进程，
// 不会丢界面状态）。**这里刻意不自动重载**——渲染进程真崩了会有
// render-process-gone 兜底；对一个只是很慢的界面强行 reload 只会变成重载死循环。
let lastUiAlive = Date.now();
let lastUiRepair = 0;
let lastUiKick = 0;
let uiSuppressUntil = 0;

ipcMain.on('ui:alive', () => { lastUiAlive = Date.now(); });

function uiWatchdogStart() {
  setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (Date.now() < uiSuppressUntil) return;
    let visible = false;
    try { visible = mainWindow.isVisible() && !mainWindow.isMinimized(); } catch { return; }
    if (!visible) return;
    const silent = Date.now() - lastUiAlive;
    if (silent < 5000) return;
    if (silent < 8000) {
      if (Date.now() - lastUiRepair > 2000) {
        lastUiRepair = Date.now();
        uiLog('ui silent ' + Math.round(silent / 1000) + 's, force repaint');
        dockSafeRepaint([0, 200]);
      }
      return;
    }
    if (Date.now() - lastUiKick < 6000) return;
    lastUiKick = Date.now();
    uiLog('ui silent ' + Math.round(silent / 1000) + 's, hide/show kick');
    try {
      mainWindow.hide();
      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.show();
        // hide/show 之后 Windows 可能把边框重新算一遍，宽度会长出几十像素；
        // 这里按贴边规则把矩形摆回去（再等 260 ms 补一次，等它 restore 完）。
        dockRepin();
        setTimeout(dockRepin, 260);
        dockSafeRepaint([0, 150]);
      }, 120);
    } catch { /* ignore */ }
  }, 1000);
}

function dockPoll() {
  if (!mainWindow || mainWindow.isDestroyed() || dockState.animating) return;
  if (!dockState.enabled) return;
  // 原生拖拽期间窗口不能动：拖拽是阻塞式模态，这时候再 setBounds
  // 会让 OLE 拖拽源和目标窗口抢消息队列，轻则抖动重则崩。
  if (dockState.dragging) {
    dockClearCollapse();
    return;
  }

  let pt;
  try { pt = screen.getCursorScreenPoint(); } catch { return; }
  const wa = dockDisplayWorkArea();
  const b = mainWindow.getBounds();

  if (dockState.hidden) {
    const withinY = pt.y >= b.y - 2 && pt.y <= b.y + b.height + 2;
    const atEdge = dockState.edge === 'right'
      ? pt.x >= wa.x + wa.width - 4
      : pt.x <= wa.x + 3;
    // 刚收起 350 ms 内不再展开：鼠标压在边界上来回动的时候，
    // 收起→立刻再展开会变成肉眼可见的抽动。
    if (withinY && atEdge && Date.now() - dockState.lastExpandAt > 220 &&
        Date.now() - dockState.lastCollapseAt > 350) {
      dockState.lastExpandAt = Date.now();
      dockClearCollapse();
      dockExpand();
    }
    return;
  }

  const inside = pt.x >= b.x - 6 && pt.x <= b.x + b.width + 6 &&
                 pt.y >= b.y - 6 && pt.y <= b.y + b.height + 6;
  // 光标只是刚离开窗口几个像素时不算"离开"：贴边面板的边缘正是鼠标最容易
  // 来回蹭的地方，这个缓冲区把"蹭一下"和"真的走开"分开。
  const farOutside = pt.x < b.x - 18 || pt.x > b.x + b.width + 18 ||
                     pt.y < b.y - 18 || pt.y > b.y + b.height + 18;
  if (inside) {
    dockClearCollapse();
    // 拖完宽度鼠标只要回到面板里，就把「软钉」摘掉，之后照常按鼠标进出收起
    if (dockState.pinSoft) {
      dockState.pinSoft = false;
      dockState.pinned = false;
    }
  } else if (!farOutside) {
    dockClearCollapse();
  } else if (!dockState.collapseTimer) {
    dockState.collapseTimer = setTimeout(() => {
      dockState.collapseTimer = null;
      dockCollapse();
    }, 620);
  }
}

function dockClearCollapse() {
  if (dockState.collapseTimer) {
    clearTimeout(dockState.collapseTimer);
    dockState.collapseTimer = null;
  }
}

function dockStartPolling() {
  dockStopPolling();
  dockState.poll = setInterval(dockPoll, 120);
}

function dockStopPolling() {
  if (dockState.poll) { clearInterval(dockState.poll); dockState.poll = null; }
  dockClearCollapse();
}

function dockRegisterShortcut() {
  try {
    if (globalShortcut.isRegistered('Control+Alt+S')) return;
    globalShortcut.register('Control+Alt+S', () => {
      if (!mainWindow) return;
      if (!dockState.enabled) {
        // 还没开贴边隐藏：把窗口叫到前面、打开设置里那一节，别让按键毫无反应
        try {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('dock:hint');
        } catch { /* ignore */ }
        return;
      }
      // 键盘切出来的面板就让它待着，别因为鼠标不在上面又被自动收回去
      dockState.pinSoft = false;
      if (dockState.hidden) { dockState.pinned = true; dockExpand(); }
      else { dockState.pinned = false; dockCollapse(); }
    });
  } catch { /* 组合键被别的程序占了就算了 */ }
}

function dockApply(opts) {
  if (!mainWindow) return { ok: false, error: 'no window' };
  const want = !!opts?.enabled;
  const edge = opts?.edge === 'left' ? 'left' : 'right';
  const width = Number(opts?.width) || dockState.width;

  if (!want) {
    dockStopPolling();
    dockState.pinSoft = false;
    if (dockState.enabled) {
      dockState.enabled = false;
      dockState.hidden = false;
      dockState.pinned = false;
      dockState.shrinkMode = true;
      dockState.wa = null;
      try {
        mainWindow.setAlwaysOnTop(false);
        mainWindow.setResizable(true);
        mainWindow.setMinimumSize(1080, 640);
        if (dockState.before) {
          mainWindow.setBounds(dockState.before);
        } else {
          mainWindow.center();
        }
      } catch { /* ignore */ }
      dockState.before = null;
      dockOverlayHeight(40);
      dockSend();
      dockSafeRepaint();
    }
    return { ok: true, enabled: false };
  }

  dockState.enabled = true;
  dockState.edge = edge;
  dockState.width = width;
  dockState.wa = dockDisplayWorkArea();

  if (!dockState.before) {
    try {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      dockState.before = mainWindow.getBounds();
    } catch { /* ignore */ }
  }

  try {
    // 收起时要真的能缩到 8 px，最小宽度必须放开
    mainWindow.setMinimumSize(DOCK_HANDLE, 200);
    mainWindow.setResizable(false);
    mainWindow.setAlwaysOnTop(true, 'floating');
    mainWindow.setBounds(expandedRect());
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  dockState.hidden = false;
  dockClearCollapse();
  dockStartPolling();
  dockRegisterShortcut();
  dockSend();
  // 尺寸定下来后尽快重绘两次，缩短“表面还没内容”的时间
  setTimeout(repaintWindow, 16);
  setTimeout(repaintWindow, 90);
  dockSafeRepaint();
  return { ok: true, enabled: true, bounds: mainWindow.getBounds() };
}

ipcMain.handle('dock:set', (_e, opts) => dockApply(opts));

ipcMain.handle('dock:state', () => {
  const b = mainWindow ? mainWindow.getBounds() : null;
  let shortcut = false;
  try { shortcut = globalShortcut.isRegistered('Control+Alt+S'); } catch { /* ignore */ }
  return {
    enabled: dockState.enabled,
    edge: dockState.edge,
    width: dockState.width,
    hidden: dockState.hidden,
    pinned: dockState.pinned,
    shrinkMode: dockState.shrinkMode,
    shortcut,
    // 排查用：轮询是否在跑、是否有动画/拖拽卡住
    polling: !!dockState.poll,
    animating: !!dockState.animating,
    dragging: !!dockState.dragging,
    bounds: b
  };
});

ipcMain.handle('dock:pin', (_e, pinned) => {
  dockState.pinned = !!pinned;
  dockState.pinSoft = false;
  if (!dockState.pinned) dockClearCollapse();
  return dockState.pinned;
});

ipcMain.handle('dock:toggle', () => {
  if (!dockState.enabled) return { ok: false };
  dockState.pinSoft = false;
  if (dockState.hidden) dockExpand();
  else { dockState.pinned = false; dockCollapse(); }
  return { ok: true, hidden: dockState.hidden };
});

// 展开/收起时告诉渲染层，好让它换一套紧凑布局、显示边缘把手
ipcMain.handle('dock:peek', () => {
  if (!dockState.enabled) return { ok: false };
  dockExpand();
  return { ok: true, hidden: dockState.hidden };
});

// 展开状态下拖窗口内侧那条边改宽度。窗口是 setResizable(false) 的（不放开的话
// 系统边框还能从别的方向拖，容易跟"拖动标题栏解除贴边"打架），所以这里自己算宽度：
// 渲染层抓住鼠标，把目标宽度发过来，主进程按贴边规则重排矩形。
function dockClampWidth(w) {
  const wa = dockDisplayWorkArea();
  const half = Math.floor(wa.width * 0.5);
  return Math.max(320, Math.min(Math.round(Number(w) || dockState.width), Math.max(320, half)));
}

ipcMain.handle('dock:resize-start', () => {
  if (!dockState.enabled) return { ok: false };
  dockState.resizing = true;
  // 拖到窗口外面的时候鼠标已经不在窗口里了，这里先钉住，免得被自动收起
  dockState.pinned = true;
  dockState.pinSoft = true;
  dockClearCollapse();
  return { ok: true, width: dockState.width };
});

ipcMain.handle('dock:resize', (_e, payload) => {
  if (!mainWindow || !dockState.enabled) return { ok: false };
  const w = dockClampWidth(payload?.width);
  dockState.width = w;
  const target = dockRect(w);
  const cur = mainWindow.getBounds();
  // 宽度没变就别动窗口：多一次 setBounds 就多一次重排，拖宽时最容易闪黑
  if (Math.abs(cur.width - target.width) < 2 && Math.abs(cur.x - target.x) < 2) {
    return { ok: true, width: w, skipped: true };
  }
  try {
    mainWindow.setBounds(target);
  } catch {
    return { ok: false };
  }
  return { ok: true, width: w };
});

ipcMain.handle('dock:resize-end', (_e, payload) => {
  dockState.resizing = false;
  // 这里不直接把 pinned 放开：松手时鼠标通常还在窗口外缘，
  // 一放开就会在 0.5 秒后自己收回去，用户刚调完的宽度就没了。
  // 交给 dockPoll：鼠标回到面板里时自动摘掉软钉。
  if (!mainWindow || !dockState.enabled) return { ok: false };
  const w = dockClampWidth(payload?.width);
  dockState.width = w;
  try { mainWindow.setBounds(dockRect(w)); } catch { /* ignore */ }
  dockSend();
  // 拖完补一次整窗重绘，防止新露出的区域还停在旧内容上
  dockSafeRepaint([60, 260]);
  return { ok: true, width: w };
});

// 把窗口从贴边状态拖走：恢复普通窗口（可缩放、有最小尺寸、不再置顶），
// 落在鼠标所在的那块屏幕里，尺寸回到进贴边之前的大小。
ipcMain.handle('window:detach', (_e, pos) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
  if (!dockState.enabled) return { ok: true, enabled: false };
  const before = dockState.before || { width: 1560, height: 980 };
  dockStopPolling();
  dockState.enabled = false;
  dockState.hidden = false;
  dockState.pinned = false;
  dockState.pinSoft = false;
  dockState.resizing = false;
  dockState.wa = null;

  let d = screen.getPrimaryDisplay();
  if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
    try { d = screen.getDisplayNearestPoint({ x: Math.round(pos.x), y: Math.round(pos.y) }); } catch { /* ignore */ }
  }
  const wa = d.workArea;
  const w = Math.max(1080, Math.min(before.width || 1560, wa.width));
  const h = Math.max(640, Math.min(before.height || 980, wa.height));
  const wantX = Number.isFinite(pos?.x) ? pos.x : wa.x + 80;
  const wantY = Number.isFinite(pos?.y) ? pos.y : wa.y + 60;
  const x = Math.max(wa.x, Math.min(Math.round(wantX), wa.x + wa.width - w));
  const y = Math.max(wa.y, Math.min(Math.round(wantY), wa.y + wa.height - h));

  // 顺序很关键：先把窗口放到目标矩形（此时还是 setResizable(false)，setBounds 不会
  // 触发系统的 resize 循环），再放开可缩放和最小尺寸。反过来的话，setMinimumSize
  // 会先让 Windows 把 480 宽的贴边窗口顶到 1080，和后面的 setBounds 打架，
  // 偶发整块客户区黑掉（DWM 重建表面时丢帧）。
  try { mainWindow.setAlwaysOnTop(false); } catch { /* ignore */ }
  try { mainWindow.setBounds({ x, y, width: w, height: h }); } catch { /* ignore */ }
  try {
    mainWindow.setResizable(true);
    mainWindow.setMinimumSize(1080, 640);
  } catch { /* ignore */ }
  dockOverlayHeight(40);

  dockState.before = null;
  dockSend();
  const bounds = mainWindow.getBounds();

  // 上面几次窗口属性变化会让 Windows 重建一次绘制表面，偶尔会黑一帧。
  // 高度抖 1 像素再还原，强制它把客户区完整重画一遍，最后再让渲染器整页重绘一次。
  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try { mainWindow.setBounds({ ...bounds, height: Math.max(200, bounds.height - 1) }); } catch { /* ignore */ }
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      try { mainWindow.setBounds(bounds); } catch { /* ignore */ }
      repaintWindow();
    }, 80);
  }, 80);

  return { ok: true, enabled: false, bounds };
});

// 解除贴边之后跟着鼠标挪窗口
ipcMain.handle('window:move-to', (_e, pos) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
  if (!Number.isFinite(pos?.x) || !Number.isFinite(pos?.y)) return { ok: false };
  try {
    mainWindow.setPosition(Math.round(pos.x), Math.round(pos.y));
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

// ===========================================================================
// Agent 接入（OpenAI 兼容的 /chat/completions）
//
// 密钥不写进 library.json（那份文件用户会拷来拷去），单独放 data\agent.json，
// 能用系统钥匙串加密就加密（safeStorage），拿不到再加个明文兜底。
// 渲染进程只拿到 hasKey，永远看不到 key 本身。
// ===========================================================================
function agentConfigPath() {
  return path.join(app.getPath('userData'), 'agent.json');
}

function readAgentFile() {
  try {
    return JSON.parse(fs.readFileSync(agentConfigPath(), 'utf8')) || {};
  } catch {
    return {};
  }
}

function agentKey() {
  const cfg = readAgentFile();
  if (cfg.keyEnc && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(cfg.keyEnc, 'base64'));
    } catch { return ''; }
  }
  return typeof cfg.keyPlain === 'string' ? cfg.keyPlain : '';
}

function agentPublic() {
  const cfg = readAgentFile();
  const key = agentKey();
  return {
    baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl : '',
    model: typeof cfg.model === 'string' ? cfg.model : '',
    temperature: Number.isFinite(cfg.temperature) ? cfg.temperature : 0.3,
    hasKey: !!(cfg.keyEnc || cfg.keyPlain),
    // 只回尾号，用来确认「上次那个 key 还记得」，明文一律不出主进程
    keyTail: key ? key.slice(-4) : '',
    hasPlainKey: !!cfg.keyPlain
  };
}

ipcMain.handle('agent:config-load', () => agentPublic());

ipcMain.handle('agent:config-save', (_e, payload) => {
  const cur = readAgentFile();
  const next = {
    baseUrl: typeof payload?.baseUrl === 'string' ? payload.baseUrl.trim() : (cur.baseUrl || ''),
    model: typeof payload?.model === 'string' ? payload.model.trim() : (cur.model || ''),
    temperature: Number.isFinite(Number(payload?.temperature)) ? Number(payload.temperature) : (cur.temperature ?? 0.3),
    keyEnc: cur.keyEnc,
    keyPlain: cur.keyPlain
  };

  if (payload && Object.prototype.hasOwnProperty.call(payload, 'apiKey')) {
    const k = payload.apiKey;
    if (k === null) {
      delete next.keyEnc;
      delete next.keyPlain;
    } else if (typeof k === 'string' && k.trim()) {
      const plain = k.trim();
      if (safeStorage.isEncryptionAvailable()) {
        try {
          next.keyEnc = safeStorage.encryptString(plain).toString('base64');
          delete next.keyPlain;
        } catch {
          next.keyPlain = plain;
        }
      } else {
        next.keyPlain = plain;
      }
    }
  }

  try {
    fs.mkdirSync(path.dirname(agentConfigPath()), { recursive: true });
    fs.writeFileSync(agentConfigPath(), JSON.stringify(next, null, 2), 'utf8');
    // 改的是「当前生效」这一套，顺带把它在配置列表里的那份也更新掉
    try {
      const file = ensureProfilesSeed();
      if (file.active) {
        const profiles = file.profiles.map((p) => (p.id === file.active
          ? { ...p, baseUrl: next.baseUrl, model: next.model, temperature: next.temperature, keyEnc: next.keyEnc, keyPlain: next.keyPlain }
          : p));
        writeProfilesFile({ active: file.active, profiles });
      }
    } catch { /* 配置列表坏掉不该挡住保存 */ }
    return { ok: true, ...agentPublic() };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// ---------------------------------------------------------------------------
// 多套 AI 配置（不同厂家的 key / 模型各存一套，随时切换）
//
// agent.json 仍然是「当前生效的那一套」（所有请求都读它），另外用
// agent-profiles.json 存若干具名配置；切换 = 把选中的那套覆盖进 agent.json。
// ---------------------------------------------------------------------------
function agentProfilesPath() {
  return path.join(app.getPath('userData'), 'agent-profiles.json');
}

function readProfilesFile() {
  try {
    const obj = JSON.parse(fs.readFileSync(agentProfilesPath(), 'utf8')) || {};
    return { active: typeof obj.active === 'string' ? obj.active : '', profiles: Array.isArray(obj.profiles) ? obj.profiles : [] };
  } catch {
    return { active: '', profiles: [] };
  }
}

function writeProfilesFile(obj) {
  fs.mkdirSync(path.dirname(agentProfilesPath()), { recursive: true });
  fs.writeFileSync(agentProfilesPath(), JSON.stringify(obj, null, 2), 'utf8');
}

function profileKey(p) {
  if (p && p.keyEnc && safeStorage.isEncryptionAvailable()) {
    try { return safeStorage.decryptString(Buffer.from(p.keyEnc, 'base64')); } catch { return ''; }
  }
  return p && typeof p.keyPlain === 'string' ? p.keyPlain : '';
}

function profilePublic(p) {
  const key = profileKey(p);
  return {
    id: String(p.id || ''),
    name: String(p.name || ''),
    baseUrl: String(p.baseUrl || ''),
    model: String(p.model || ''),
    temperature: Number.isFinite(Number(p.temperature)) ? Number(p.temperature) : 0.3,
    hasKey: !!(p.keyEnc || p.keyPlain),
    keyTail: key ? key.slice(-4) : ''
  };
}

/** 老用户只有 agent.json：第一次打开时把它搬成一套叫「默认」的配置。 */
function ensureProfilesSeed() {
  const file = readProfilesFile();
  if (file.profiles.length) return file;
  const cfg = readAgentFile();
  if (!cfg.baseUrl && !cfg.model && !cfg.keyEnc && !cfg.keyPlain) return file;
  const id = 'p' + Date.now().toString(36);
  const seeded = {
    id,
    name: (cfg.model || '默认配置') + (agentKey() ? '（' + agentKey().slice(-4) + '）' : ''),
    baseUrl: cfg.baseUrl || '',
    model: cfg.model || '',
    temperature: Number.isFinite(cfg.temperature) ? cfg.temperature : 0.3,
    keyEnc: cfg.keyEnc,
    keyPlain: cfg.keyPlain
  };
  const next = { active: id, profiles: [seeded] };
  try { writeProfilesFile(next); } catch { /* 写不了就算了，不影响主流程 */ }
  return next;
}

function profilesPublic() {
  const file = ensureProfilesSeed();
  return { active: file.active, profiles: file.profiles.map(profilePublic) };
}

/** 把某套配置写成 agent.json（保留另一套的密钥形式不变）。 */
function activateProfile(id) {
  const file = ensureProfilesSeed();
  const p = file.profiles.find((x) => x.id === id);
  if (!p) return { ok: false, error: '找不到这套配置' };
  const next = {
    baseUrl: p.baseUrl || '',
    model: p.model || '',
    temperature: Number.isFinite(Number(p.temperature)) ? Number(p.temperature) : 0.3
  };
  if (p.keyEnc) next.keyEnc = p.keyEnc;
  if (p.keyPlain) next.keyPlain = p.keyPlain;
  fs.mkdirSync(path.dirname(agentConfigPath()), { recursive: true });
  fs.writeFileSync(agentConfigPath(), JSON.stringify(next, null, 2), 'utf8');
  writeProfilesFile({ active: id, profiles: file.profiles });
  return { ok: true, ...agentPublic(), profiles: profilesPublic() };
}

ipcMain.handle('agent:profiles', () => profilesPublic());

ipcMain.handle('agent:profile-activate', (_e, payload) => {
  try {
    const r = activateProfile(String(payload?.id || ''));
    return r.ok ? { ...r, ...profilesPublic() } : r;
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('agent:profile-save', (_e, payload) => {
  try {
    const file = ensureProfilesSeed();
    let id = String(payload?.id || '');
    // 没给 id 时先按名字找：同一个名字再存一次就是改它，而不是又添一条一模一样的
    if (!id) {
      const wantName = String(payload?.name || '').trim();
      const same = wantName ? file.profiles.find((x) => String(x.name || '').trim() === wantName) : null;
      id = same ? same.id : 'p' + Date.now().toString(36);
    }
    const name = String(payload?.name || '').trim() || '未命名配置';
    const baseUrl = String(payload?.baseUrl || '').trim();
    const model = String(payload?.model || '').trim();
    const temperature = Number.isFinite(Number(payload?.temperature)) ? Number(payload.temperature) : 0.3;
    const exist = file.profiles.find((x) => x.id === id);
    const rec = {
      id,
      name,
      baseUrl,
      model,
      temperature,
      keyEnc: exist ? exist.keyEnc : undefined,
      keyPlain: exist ? exist.keyPlain : undefined
    };
    const apiKey = payload?.apiKey;
    if (typeof apiKey === 'string' && apiKey.trim()) {
      const plain = apiKey.trim();
      if (safeStorage.isEncryptionAvailable()) {
        try { rec.keyEnc = safeStorage.encryptString(plain).toString('base64'); rec.keyPlain = undefined; } catch { rec.keyPlain = plain; rec.keyEnc = undefined; }
      } else {
        rec.keyPlain = plain;
        rec.keyEnc = undefined;
      }
    }
    const profiles = file.profiles.filter((x) => x.id !== id);
    profiles.unshift(rec);
    writeProfilesFile({ active: id, profiles });
    const applied = activateProfile(id);
    if (!applied.ok) return applied;
    return { ok: true, id, ...applied, ...profilesPublic() };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('agent:profile-delete', (_e, payload) => {
  try {
    const file = ensureProfilesSeed();
    const id = String(payload?.id || '');
    const profiles = file.profiles.filter((x) => x.id !== id);
    const active = file.active === id ? (profiles[0] ? profiles[0].id : '') : file.active;
    writeProfilesFile({ active, profiles });
    if (active) activateProfile(active);
    else {
      try { fs.unlinkSync(agentConfigPath()); } catch { /* 没有就算了 */ }
    }
    return { ok: true, ...profilesPublic() };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// ---------------------------------------------------------------------------
// 音频生成（云端 AI）：和 Agent 一样，key 只留在主进程，可以存多套命名配置。
//
// 支持三种：Stability（Stable Audio）、ElevenLabs（SFX）、自定义（POST JSON，
// 返回二进制音频或 {audio|audio_base64|data} 的 base64）。生成结果落到
// %APPDATA%\SoundBin\generated\，由渲染层「入库」再进清单。
// ---------------------------------------------------------------------------
const GEN_DEFAULTS = {
  stability: {
    name: 'Stability',
    endpoint: 'https://api.stability.ai',
    model: 'stable-audio-2'
  },
  elevenlabs: {
    name: 'ElevenLabs',
    endpoint: 'https://api.elevenlabs.io',
    model: 'sound-generation'
  },
  custom: {
    name: '自定义',
    endpoint: '',
    model: ''
  }
};

function genProfilesPath() {
  return path.join(app.getPath('userData'), 'gen-profiles.json');
}

function readGenFile() {
  try {
    const obj = JSON.parse(fs.readFileSync(genProfilesPath(), 'utf8')) || {};
    return {
      active: typeof obj.active === 'string' ? obj.active : '',
      profiles: Array.isArray(obj.profiles) ? obj.profiles : []
    };
  } catch {
    return { active: '', profiles: [] };
  }
}

function writeGenFile(obj) {
  fs.mkdirSync(path.dirname(genProfilesPath()), { recursive: true });
  fs.writeFileSync(genProfilesPath(), JSON.stringify(obj, null, 2), 'utf8');
}

function genKey(p) {
  if (p && p.keyEnc && safeStorage.isEncryptionAvailable()) {
    try { return safeStorage.decryptString(Buffer.from(p.keyEnc, 'base64')); } catch { return ''; }
  }
  return p && typeof p.keyPlain === 'string' ? p.keyPlain : '';
}

function genPublic(p) {
  const key = genKey(p);
  const provider = String(p.provider || 'stability');
  const defaults = GEN_DEFAULTS[provider] || GEN_DEFAULTS.stability;
  return {
    id: String(p.id || ''),
    name: String(p.name || defaults.name),
    provider,
    endpoint: String(p.endpoint || defaults.endpoint || ''),
    model: String(p.model || defaults.model || ''),
    hasKey: !!(p.keyEnc || p.keyPlain),
    keyTail: key ? key.slice(-4) : ''
  };
}

function genProfilesPublic() {
  const file = readGenFile();
  const active = file.profiles.find((x) => x.id === file.active) || file.profiles[0] || null;
  return {
    providers: Object.entries(GEN_DEFAULTS).map(([id, d]) => ({ id, name: d.name, endpoint: d.endpoint, model: d.model })),
    active: file.active,
    profiles: file.profiles.map(genPublic),
    current: active ? genPublic(active) : null
  };
}

ipcMain.handle('gen:profiles', () => genProfilesPublic());

ipcMain.handle('gen:profile-save', (_e, payload) => {
  try {
    const file = readGenFile();
    let id = String(payload?.id || '');
    const name = String(payload?.name || '').trim();
    if (!id) {
      const same = name ? file.profiles.find((x) => String(x.name || '').trim() === name) : null;
      id = same ? same.id : 'g' + Date.now().toString(36);
    }
    const provider = GEN_DEFAULTS[payload?.provider] ? String(payload.provider) : 'stability';
    const defaults = GEN_DEFAULTS[provider];
    const exist = file.profiles.find((x) => x.id === id);
    const rec = {
      id,
      name: name || (exist ? exist.name : defaults.name),
      provider,
      endpoint: String(payload?.endpoint || '').trim() || defaults.endpoint,
      model: String(payload?.model || '').trim() || defaults.model,
      keyEnc: exist ? exist.keyEnc : undefined,
      keyPlain: exist ? exist.keyPlain : undefined
    };
    const key = typeof payload?.apiKey === 'string' ? payload.apiKey.trim() : '';
    if (payload?.apiKey === null) {
      rec.keyEnc = undefined;
      rec.keyPlain = undefined;
    } else if (key) {
      if (safeStorage.isEncryptionAvailable()) {
        try { rec.keyEnc = safeStorage.encryptString(key).toString('base64'); rec.keyPlain = undefined; } catch { rec.keyPlain = key; rec.keyEnc = undefined; }
      } else {
        rec.keyPlain = key;
        rec.keyEnc = undefined;
      }
    }
    const profiles = exist ? file.profiles.map((x) => (x.id === id ? rec : x)) : [...file.profiles, rec];
    writeGenFile({ active: file.active || id, profiles });
    return { ok: true, ...genProfilesPublic() };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('gen:profile-activate', (_e, payload) => {
  try {
    const file = readGenFile();
    const id = String(payload?.id || '');
    if (!file.profiles.find((x) => x.id === id)) return { ok: false, error: '找不到这套配置' };
    writeGenFile({ active: id, profiles: file.profiles });
    return { ok: true, ...genProfilesPublic() };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('gen:profile-delete', (_e, payload) => {
  try {
    const file = readGenFile();
    const id = String(payload?.id || '');
    const profiles = file.profiles.filter((x) => x.id !== id);
    const active = file.active === id ? (profiles[0] ? profiles[0].id : '') : file.active;
    writeGenFile({ active, profiles });
    return { ok: true, ...genProfilesPublic() };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

/** 取当前生效的一套（含明文 key），只在本文件里用。 */
function genActive() {
  const file = readGenFile();
  const rec = file.profiles.find((x) => x.id === file.active) || file.profiles[0] || null;
  if (!rec) return null;
  return { ...genPublic(rec), key: genKey(rec) };
}

function genExtFor(contentType, url) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('wav')) return '.wav';
  if (ct.includes('mpeg') || ct.includes('mp3')) return '.mp3';
  if (ct.includes('ogg')) return '.ogg';
  if (ct.includes('flac')) return '.flac';
  const m = /\.(wav|mp3|ogg|flac)(\?|$)/i.exec(String(url || ''));
  return m ? '.' + m[1].toLowerCase() : '.mp3';
}

/** 把响应变成音频 Buffer（二进制或 JSON 里的 base64 都认）。 */
async function genReadAudio(res) {
  const ct = res.headers.get('content-type') || '';
  if (/json/i.test(ct)) {
    const obj = await res.json().catch(() => null);
    const b64 = obj && (obj.audio || obj.audio_base64 || obj.data || obj.audioData);
    if (typeof b64 === 'string' && b64.length > 64) {
      const ext = obj.output_format ? '.' + String(obj.output_format).replace(/^\./, '') : '.wav';
      return { buffer: Buffer.from(b64, 'base64'), ext };
    }
    return { buffer: null, ext: '', json: obj };
  }
  const ab = await res.arrayBuffer();
  return { buffer: Buffer.from(ab), ext: genExtFor(ct) };
}

ipcMain.handle('gen:generate', async (_e, payload) => {
  const cfg = genActive();
  if (!cfg) return { ok: false, error: '还没配置音频生成接口，去 设置 → 音频生成 里填一个' };
  if (!cfg.key) return { ok: false, error: '这套配置还没有密钥' };

  const prompt = String(payload?.prompt || '').trim();
  if (!prompt) return { ok: false, error: '先写一句你要的声音' };
  const seconds = Math.min(180, Math.max(1, Number(payload?.seconds) || 20));
  const saveDir = path.join(app.getPath('userData'), 'generated');
  try { fs.mkdirSync(saveDir, { recursive: true }); } catch { /* ignore */ }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(payload?.timeoutMs) || 240000);
  const started = Date.now();
  try {
    let url;
    let headers;
    let body;
    if (cfg.provider === 'stability') {
      const base = String(cfg.endpoint || GEN_DEFAULTS.stability.endpoint).replace(/\/+$/, '');
      url = base + '/v2beta/audio/stable-audio-2/text-to-audio';
      // 这个接口只收 multipart/form-data（JSON 会 400: must be multipart/form-data）
      const form = new FormData();
      form.append('prompt', prompt);
      form.append('duration', String(Math.min(190, Math.max(1, Math.round(seconds)))));
      form.append('steps', '30');
      form.append('cfg_scale', '7');
      form.append('output_format', 'wav');
      form.append('seed', '0');
      headers = { Authorization: 'Bearer ' + cfg.key, Accept: 'audio/*' };
      body = form;
    } else if (cfg.provider === 'elevenlabs') {
      const base = String(cfg.endpoint || GEN_DEFAULTS.elevenlabs.endpoint).replace(/\/+$/, '');
      url = base + '/v1/sound-generation';
      headers = { 'xi-api-key': cfg.key, 'Content-Type': 'application/json' };
      body = JSON.stringify({
        text: prompt,
        duration_seconds: Math.min(22, Math.max(0.5, seconds)),
        prompt_influence: 0.3
      });
    } else {
      url = String(cfg.endpoint || '').trim();
      if (!url) return { ok: false, error: '自定义接口要填一个地址' };
      headers = { Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'application/json' };
      body = JSON.stringify({ prompt, seconds, model: cfg.model || undefined, duration: seconds });
    }

    const res = await fetch(url, { method: 'POST', headers, body, signal: ctrl.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let hint = '';
      if (res.status === 401) hint = '（密钥不对）';
      else if (res.status === 402 || res.status === 429) hint = '（额度用完或请求太频繁）';
      else if (res.status === 404) hint = '（接口地址或模型名不对）';
      else if (res.status === 403 && /content_moderation|flagged|moderation/i.test(text)) {
        return {
          ok: false,
          status: 403,
          error: '描述被服务商的内容审核拦下了（本次不计费）。把「撞击 / 爆炸 / 尖叫 / 猛砸」这类词换成中性说法，例如「猛地关上」→「轻轻关上」，再试一次'
        };
      }
      return { ok: false, error: `HTTP ${res.status}${hint} ${text.slice(0, 300)}`.trim(), status: res.status };
    }
    const got = await genReadAudio(res);
    if (!got.buffer || got.buffer.length < 512) {
      return { ok: false, error: '接口没返回音频数据：' + JSON.stringify(got.json || {}).slice(0, 200) };
    }
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const safe = prompt.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 24) || 'gen';
    const file = path.join(saveDir, `GEN_${safe}_${stamp}${got.ext}`);
    fs.writeFileSync(file, got.buffer);
    return { ok: true, path: file, bytes: got.buffer.length, ms: Date.now() - started, provider: cfg.provider, name: cfg.name };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  } finally {
    clearTimeout(timer);
  }
});

ipcMain.handle('gen:balance', async () => {
  const cfg = genActive();
  if (!cfg) return { ok: false, error: '还没配置音频生成接口' };
  if (!cfg.key) return { ok: false, error: '这套配置还没有密钥' };
  if (cfg.provider !== 'stability') return { ok: false, error: '只有 Stability 有余额接口' };
  try {
    const base = String(cfg.endpoint || GEN_DEFAULTS.stability.endpoint).replace(/\/+$/, '');
    const res = await fetch(base + '/v1/user/balance', { headers: { Authorization: 'Bearer ' + cfg.key } });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 200)}` };
    let credits = null;
    try { credits = JSON.parse(text).credits ?? null; } catch { /* ignore */ }
    return { ok: true, credits, raw: text.slice(0, 300) };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

function agentEndpoint(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  if (/\/chat\/completions$/i.test(raw)) return raw;
  return raw + '/chat/completions';
}

async function agentRequest(messages, opts = {}) {
  const cfg = agentPublic();
  const url = agentEndpoint(cfg.baseUrl);
  if (!url) return { ok: false, error: '还没填接口地址（例如 https://api.deepseek.com/v1）' };
  if (!cfg.model) return { ok: false, error: '还没填模型名（例如 deepseek-chat）' };

  const key = agentKey();
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = 'Bearer ' + key;

  const body = {
    model: cfg.model,
    messages,
    temperature: Number.isFinite(opts.temperature) ? opts.temperature : cfg.temperature,
    stream: false
  };
  if (Number.isFinite(opts.maxTokens)) body.max_tokens = opts.maxTokens;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 60000);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        ms: Date.now() - started,
        error: text.slice(0, 400) || ('HTTP ' + res.status)
      };
    }
    let json;
    try { json = JSON.parse(text); } catch { return { ok: false, error: '接口返回的不是 JSON', ms: Date.now() - started }; }
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      return { ok: false, error: '返回里没有 choices[0].message.content', ms: Date.now() - started };
    }
    const trimmed = content.trim();
    if (!trimmed) {
      // 带推理的新模型会先把 max_tokens 花在 reasoning 上，content 就空了
      const used = json?.usage?.completion_tokens;
      return {
        ok: false,
        error: '接口返回了空内容' + (used ? `（completion_tokens=${used}）` : '') +
          '：多半是 max_tokens 被推理过程吃掉了，把这一栏调大一点',
        ms: Date.now() - started
      };
    }
    return { ok: true, text: content, ms: Date.now() - started, usage: json.usage || null };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || /abort/i.test(String(err)));
    return { ok: false, error: aborted ? '请求超时' : String(err), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

ipcMain.handle('agent:chat', (_e, payload) => {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  if (!messages.length) return { ok: false, error: '没有消息' };
  return agentRequest(messages, { temperature: payload?.temperature, maxTokens: payload?.maxTokens, timeoutMs: payload?.timeoutMs });
});

ipcMain.handle('agent:test', async () => {
  // 预算给宽一点：带推理的新模型会把 tokens 先花在 reasoning 上，
  // max_tokens 太小就会只剩一截 thinking、content 为空
  const r = await agentRequest(
    [{ role: 'user', content: '只回复两个字：可用' }],
    { maxTokens: 1200, temperature: 0, timeoutMs: 45000 }
  );
  return r.ok ? { ok: true, ms: r.ms, reply: r.text.trim().slice(0, 60) } : r;
});

// ===========================================================================
// 本机音频插件清单（只看不用）
//
// 说清楚：SoundBin 自己**不加载** VST/VST3/CLAP——宿主协议 + 授权 + 崩溃隔离
// 不是这个项目该背的。这里扫出来只是让你知道这台机器上有什么，
// 效果器本身用的是 Web Audio 自带的那几个节点。
// ===========================================================================
const PLUGIN_DIRS = [
  ['VST3', path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Common Files', 'VST3')],
  ['VST3', path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Common Files', 'VST3')],
  ['VST3', path.join(process.env.APPDATA || '', 'VST3')],
  ['VST2', path.join(process.env.ProgramFiles || 'C:\\Program Files', 'VstPlugins')],
  ['VST2', path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steinberg', 'VstPlugins')],
  ['CLAP', path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Common Files', 'CLAP')],
  ['CLAP', path.join(process.env.ProgramFiles || 'C:\\Program Files', 'CLAP')]
];

async function scanPlugins() {
  const plugins = [];
  const dirs = [];
  const seen = new Set();
  let truncated = false;

  async function walk(dir, format, depth) {
    if (truncated || depth > 3) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (plugins.length >= 3000) { truncated = true; return; }
      const full = path.join(dir, ent.name);
      const lower = ent.name.toLowerCase();
      if (lower.endsWith('.vst3')) {
        // Windows 上 .vst3 是目录；把包名当插件名，不再往里钻
        if (seen.has(full)) continue;
        seen.add(full);
        let size = 0;
        try { size = (await fsp.stat(full)).size; } catch { /* ignore */ }
        plugins.push({ name: ent.name.replace(/\.vst3$/i, ''), path: full, format: 'VST3', kind: ent.isDirectory() ? 'bundle' : 'file', size });
      } else if (ent.isDirectory()) {
        await walk(full, format, depth + 1);
      } else if (lower.endsWith('.dll') && format === 'VST2') {
        if (seen.has(full)) continue;
        seen.add(full);
        let size = 0;
        try { size = (await fsp.stat(full)).size; } catch { /* ignore */ }
        plugins.push({ name: ent.name.replace(/\.dll$/i, ''), path: full, format: 'VST2', kind: 'file', size });
      } else if (lower.endsWith('.clap')) {
        if (seen.has(full)) continue;
        seen.add(full);
        plugins.push({ name: ent.name.replace(/\.clap$/i, ''), path: full, format: 'CLAP', kind: 'file', size: 0 });
      }
    }
  }

  for (const [format, dir] of PLUGIN_DIRS) {
    if (!dir) continue;
    let exists = false;
    try { exists = (await fsp.stat(dir)).isDirectory(); } catch { exists = false; }
    if (!exists) continue;
    const before = plugins.length;
    await walk(dir, format, 0);
    dirs.push({ format, path: dir, count: plugins.length - before });
  }

  return {
    ok: true,
    platform: process.platform,
    dirs,
    plugins: plugins.sort((a, b) => a.name.localeCompare(b.name)),
    truncated
  };
}

ipcMain.handle('plugins:scan', () => scanPlugins());

// ===========================================================================
// 导出处理后的音频（渲染进程离线渲染 + 编码 WAV，这里只负责落盘）
// ===========================================================================
ipcMain.handle('audio:save-wav', async (_e, payload) => {
  const src = payload?.buffer;
  if (!src || typeof src.length !== 'number' || src.length < 44) {
    return { ok: false, error: '音频数据为空' };
  }
  if (src.length > 600 * 1024 * 1024) {
    return { ok: false, error: '文件超过 600 MB，先在 DAW 里处理更合适' };
  }
  const suggested = typeof payload?.name === 'string' && payload.name ? payload.name : 'soundbin_fx.wav';
  const res = await dialog.showSaveDialog(mainWindow, {
    title: '导出处理后的音频',
    defaultPath: path.join(payload?.dir || app.getPath('music'), suggested),
    filters: [{ name: 'WAV', extensions: ['wav'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try {
    await fsp.writeFile(res.filePath, Buffer.from(src));
    return { ok: true, path: res.filePath, size: src.length };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// ===========================================================================
// 声音合成（缝合底噪）落盘
//
// 为什么写进 <userData>\generated：数据目录是可以在设置里整体搬盘的（storage:migrate
// 会把 data\ 挪到别的盘），所以这里一律走 userDataDir() 而不是写死某个绝对路径，
// 搬迁之后生成的音频跟着数据目录走，不会留下一堆孤儿文件。
// 生成的条目不入库，用户点「保存并入库」才写盘，所以这里只管写文件、不做库操作。
// ===========================================================================

/** 把渲染进程递过来的二进制统一成 Buffer：Uint8Array / ArrayBuffer / 类数组对象都可能。 */
function synthBytes(src) {
  if (!src) return null;
  if (Buffer.isBuffer(src)) return src;
  if (src instanceof ArrayBuffer) return Buffer.from(new Uint8Array(src));
  if (ArrayBuffer.isView(src)) return Buffer.from(src.buffer, src.byteOffset, src.byteLength);
  // 跨进程结构化克隆过的 Uint8Array 有时会退化成 { 0:.., 1:.., length:.. } 这样的普通对象
  if (typeof src.length === 'number' && src.length >= 0) {
    const out = Buffer.allocUnsafe(src.length);
    for (let i = 0; i < src.length; i++) out[i] = src[i] & 0xff;
    return out;
  }
  return null;
}

/** 文件名消毒：去扩展名、去 Windows 非法字符、去首尾空白和结尾的点。空则给默认名。 */
function synthSafeName(raw) {
  let base = typeof raw === 'string' ? raw : '';
  base = base.trim();                                        // 先 trim，否则 "底噪.wav " 的扩展名去不掉
  base = base.replace(/\.[A-Za-z0-9]{1,5}$/, '');            // 扩展名统一由这里补 .wav
  base = base.replace(/[\\/:*?"<>|]/g, '');                  // Windows 不允许的字符
  base = base.replace(/[\u0000-\u001f]/g, '');               // 控制字符
  base = base.replace(/[.\s]+$/, '');                        // Windows 不允许结尾是点或空格
  if (!base) base = 'soundbin_synth';
  if (base.length > 120) base = base.slice(0, 120);          // 防 ENAMETOOLONG
  return base;
}

/** 重名时依次试 name.wav、name (2).wav…；用 wx 独占打开，避免并发写穿。 */
async function synthWriteUnique(dir, base, buf) {
  for (let i = 1; i <= 999; i++) {
    const full = path.join(dir, i === 1 ? `${base}.wav` : `${base} (${i}).wav`);
    try {
      await fsp.writeFile(full, buf, { flag: 'wx' });
      return full;
    } catch (err) {
      if (err && err.code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error('同名文件过多，换个名字再存');
}

ipcMain.handle('synth:stage', async (_e, payload) => {
  // 生成完先落一份到 generated\_preview：这样结果行立刻能拖进 DAW，
  // 不用先「保存并入库」；用户不要的预览文件由这里的机会式清理收走。
  try {
    const raw = payload?.buffer;
    const declared = raw && typeof raw === 'object'
      ? (typeof raw.byteLength === 'number' ? raw.byteLength : raw.length)
      : undefined;
    if (typeof declared === 'number' && declared > 600 * 1024 * 1024) {
      return { ok: false, error: '文件超过 600 MB，换个更短的时长' };
    }
    const buf = synthBytes(raw);
    if (!buf || buf.length < 44) return { ok: false, error: '音频数据为空或不是有效的 WAV' };
    const dir = path.join(userDataDir(), 'generated', '_preview');
    await fsp.mkdir(dir, { recursive: true });
    const full = await synthWriteUnique(dir, synthSafeName(payload?.name), buf);
    synthPrunePreview(dir).catch(() => {});
    return { ok: true, path: full, bytes: buf.length };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

/** 预览目录只留最近 60 个文件：用户生成十几次就会堆几十条，别让临时文件长成垃圾场。 */
async function synthPrunePreview(dir) {
  const list = await fsp.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const d of list) {
    if (!d.isFile() || !/\.wav$/i.test(d.name)) continue;
    const full = path.join(dir, d.name);
    const st = await fsp.stat(full).catch(() => null);
    if (st) files.push({ full, t: st.mtimeMs });
  }
  files.sort((a, b) => b.t - a.t);
  for (const f of files.slice(60)) await fsp.unlink(f.full).catch(() => {});
}

ipcMain.handle('synth:save', async (_e, payload) => {
  try {
    const dir = path.join(userDataDir(), 'generated');
    await fsp.mkdir(dir, { recursive: true });

    // 预览文件转正：直接复制过去，省得把几百 MB 再从渲染层传一遍
    const from = typeof payload?.from === 'string' ? payload.from : '';
    if (from) {
      if (!/\.wav$/i.test(from)) return { ok: false, error: '来源文件不是 WAV' };
      const st = await fsp.stat(from).catch(() => null);
      if (!st || !st.isFile()) return { ok: false, error: '来源文件不存在' };
      const full = await synthWriteUnique(dir, synthSafeName(payload?.name), await fsp.readFile(from));
      return { ok: true, path: full, bytes: st.size };
    }

    const raw = payload?.buffer;
    // 先按声明的长度挡一次：类数组形态要真分配内存，600 MB 以上没必要转
    const declared = raw && typeof raw === 'object'
      ? (typeof raw.byteLength === 'number' ? raw.byteLength : raw.length)
      : undefined;
    if (typeof declared === 'number' && declared > 600 * 1024 * 1024) {
      return { ok: false, error: '文件超过 600 MB，换个更短的时长' };
    }
    const buf = synthBytes(raw);
    if (!buf || buf.length < 44) return { ok: false, error: '音频数据为空或不是有效的 WAV' };

    const full = await synthWriteUnique(dir, synthSafeName(payload?.name), buf);
    return { ok: true, path: full, bytes: buf.length };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('synth:open-folder', async () => {
  try {
    const dir = path.join(userDataDir(), 'generated');
    await fsp.mkdir(dir, { recursive: true });
    const err = await shell.openPath(dir);
    return err ? { ok: false, error: err } : { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// ---------------------------------------------------------------------------
// VST3 离线渲染（内置 Python + pedalboard）
//
// 应用里没法在渲染进程里直接加载 VST3，所以在 resources\py 里带了一份精简的
// Python 运行时和 pedalboard，主进程用 sidecar 的方式调它：
//   参数查询：python vst_render.py --job job.json  (mode=params / names)
//   渲染：    python vst_render.py --job job.json  (mode=render)
// 渲染结果写到 <userData>\cache\vst\<签名>\ 下，拖出/试听都用这个文件。
// ---------------------------------------------------------------------------

/** 内置运行时位置：打包后 resources\py，开发时项目根 pyrt\。 */
function vstRuntimeExe() {
  const roots = [];
  if (process.resourcesPath) roots.push(path.join(process.resourcesPath, 'py'));
  roots.push(path.join(SRC_DIR, '..', 'pyrt'));
  for (const dir of roots) {
    const exe = path.join(dir, 'python.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

/** 渲染脚本：打包后在 resources\py 里，开发时用 src\vst。 */
function vstRenderScript() {
  const roots = [];
  if (process.resourcesPath) roots.push(path.join(process.resourcesPath, 'py', 'vst_render.py'));
  roots.push(path.join(SRC_DIR, 'vst', 'vst_render.py'));
  for (const p of roots) if (fs.existsSync(p)) return p;
  return null;
}

/** 跑一次 sidecar，返回脚本最后一行 JSON。 */
async function vstRunJob(job, timeoutMs = 240000) {
  const exe = vstRuntimeExe();
  const script = vstRenderScript();
  if (!exe) return { ok: false, error: '缺少内置 Python 运行时（resources\\py）' };
  if (!script) return { ok: false, error: '缺少 vst_render.py' };

  const tmpDir = path.join(cacheDir(), 'vst', 'jobs');
  await fsp.mkdir(tmpDir, { recursive: true });
  const jobPath = path.join(tmpDir, `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.json`);
  await fsp.writeFile(jobPath, JSON.stringify(job), 'utf8');

  return await new Promise((resolve) => {
    const { spawn } = require('node:child_process');
    const child = spawn(exe, [script, '--job', jobPath], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    let out = '';
    let err = '';
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fsp.unlink(jobPath).catch(() => {});
      resolve(payload);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退出了 */ }
      finish({ ok: false, error: '插件处理超时（超过 ' + Math.round(timeoutMs / 1000) + ' 秒）' });
    }, timeoutMs);

    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', (e) => finish({ ok: false, error: '启动插件运行环境失败：' + e.message }));
    child.on('close', () => {
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const last = lines.length ? lines[lines.length - 1] : '';
      let parsed = null;
      try { parsed = JSON.parse(last); } catch { /* 不是 JSON */ }
      if (!parsed) {
        finish({ ok: false, error: '插件没有返回结果', detail: (err || out).slice(-400) });
        return;
      }
      finish(parsed);
    });
  });
}

/** 非 WAV 的素材先解成 WAV，再交给插件；转换结果按原文件指纹缓存。 */
async function vstInputWav(item) {
  const src = item && item.path;
  if (!src || !fs.existsSync(src)) return { ok: false, error: '文件不存在' };
  if (path.extname(src).toLowerCase() === '.wav') return { ok: true, path: src };

  const st = await fsp.stat(src);
  const key = crypto.createHash('sha1')
    .update(`${src}|${st.size}|${Math.round(st.mtimeMs)}`)
    .digest('hex')
    .slice(0, 8);
  const base = path.basename(src, path.extname(src));
  const dest = path.join(cacheDir(), 'vst', 'input', `${base}_${key}.wav`);
  try {
    const dst = await fsp.stat(dest);
    if (dst.size > 44) return { ok: true, path: dest };
  } catch { /* 还没有缓存 */ }

  const info = await audio.inspect(src);
  if (!info.ok || !info.pcm) return { ok: false, error: '这个格式解不开，先转成 WAV 再试' };
  const pcm = info.pcm;
  pcm.path = src;
  const dur = info.duration || (pcm.frames ? pcm.frames / (pcm.sampleRate || 44100) : 0);
  if (!(dur > 0)) return { ok: false, error: '读不出时长' };
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const res = await audio.writeWavRegion(pcm, 0, dur, dest);
  if (!res || res.ok === false) return { ok: false, error: '转 WAV 失败' };
  return { ok: true, path: dest };
}

ipcMain.handle('vst:status', async () => {
  const exe = vstRuntimeExe();
  return { ok: !!exe && !!vstRenderScript(), exe, script: vstRenderScript() };
});

ipcMain.handle('vst:names', async (_e, payload) => {
  const plugin = payload && payload.plugin;
  if (typeof plugin !== 'string' || !plugin) return { ok: false, error: '缺少插件路径' };
  // 壳插件（Waves 这种）列举子插件可能很慢，超时就放弃，不能把界面挂住
  return await vstRunJob({ mode: 'names', plugin }, 25000);
});

ipcMain.handle('vst:params', async (_e, payload) => {
  const plugin = payload && payload.plugin;
  if (typeof plugin !== 'string' || !plugin) return { ok: false, error: '缺少插件路径' };
  return await vstRunJob({
    mode: 'params',
    plugin,
    pluginName: payload.pluginName || null,
  }, 120000);
});

ipcMain.handle('vst:render', async (_e, payload) => {
  const opts = payload || {};
  if (typeof opts.plugin !== 'string' || !opts.plugin) return { ok: false, error: '缺少插件路径' };
  if (typeof opts.path !== 'string' || !opts.path) return { ok: false, error: '缺少素材路径' };
  if (!fs.existsSync(opts.plugin)) return { ok: false, error: '插件文件不在了：' + opts.plugin };

  const prepared = await vstInputWav({ path: opts.path });
  if (!prepared.ok) return prepared;

  const st = await fsp.stat(opts.path);
  const sig = crypto.createHash('sha1')
    .update(JSON.stringify({
      p: opts.path,
      s: st.size,
      m: Math.round(st.mtimeMs),
      plugin: opts.plugin,
      name: opts.pluginName || '',
      params: opts.params || {},
      tail: opts.tailSeconds || 0,
    }))
    .digest('hex')
    .slice(0, 10);
  const base = path.basename(opts.path, path.extname(opts.path));
  const tag = (opts.label || path.basename(opts.plugin, path.extname(opts.plugin)))
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 40);
  const destDir = path.join(cacheDir(), 'vst', sig);
  const dest = path.join(destDir, `${base} (vst ${tag}).wav`);
  await fsp.mkdir(destDir, { recursive: true });

  try {
    const dst = await fsp.stat(dest);
    if (dst.size > 44) return { ok: true, path: dest, cached: true, bytes: dst.size - 44, sig };
  } catch { /* 还没渲染过 */ }

  const res = await vstRunJob({
    mode: 'render',
    plugin: opts.plugin,
    pluginName: opts.pluginName || null,
    in: prepared.path,
    out: dest,
    paramValues: opts.params || {},
    tailSeconds: opts.tailSeconds || 0,
  });
  if (!res.ok) return res;

  let bytes = 0;
  try { bytes = (await fsp.stat(dest)).size - 44; } catch { /* 插件没写出文件 */ }
  if (!bytes) return { ok: false, error: '插件没有产生音频（可能是纯乐器插件，不接受音频输入）' };
  return { ok: true, path: dest, bytes, sig };
});
