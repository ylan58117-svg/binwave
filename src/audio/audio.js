'use strict';

/**
 * Zero-dependency audio inspection.
 *
 * Handles the formats a sound designer actually keeps on disk:
 *   - WAV / BWF / RF64 (PCM 8/16/24/32, IEEE float 32/64)
 *   - AIFF / AIFC  (PCM; AIFC is transcoded to a temp WAV for the player,
 *                   because Chromium cannot decode AIFF)
 *   - anything else that Chromium can decode (mp3, flac, ogg, m4a) is
 *     reported as "browser-decodable" and the renderer computes its peaks.
 *
 * Two jobs:
 *   inspect(filePath)  -> metadata + exact PCM location
 *   peaks(filePath)    -> min/max envelope, computed by streaming the PCM
 *                         (never loads the whole file into RAM)
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

// Envelope resolution. 320 bins/second is smooth enough to look like a real
// waveform on a 4K display while keeping a 10-minute file at ~380 KB.
const PEAK_BINS_PER_SECOND = 320;

const HEAD_READ = 1024 * 1024; // plenty for fmt/data/COMM before the payload

const AUDIO_EXTS = new Set([
  '.wav', '.wave', '.bwf', '.rf64', '.w64',
  '.aif', '.aiff', '.aifc',
  '.mp3', '.flac', '.ogg', '.oga', '.opus', '.m4a', '.aac', '.mp4',
  '.caf', '.sd2', '.amb', '.wv', '.ape', '.aac', '.au', '.wma'
]);

// Extensions Chromium's audio pipeline can decode natively.
const DECODABLE_EXTS = new Set([
  '.wav', '.wave', '.bwf', '.mp3', '.flac', '.ogg', '.oga', '.opus',
  '.m4a', '.aac', '.mp4'
]);

function isAudioExt(p) {
  return AUDIO_EXTS.has(path.extname(p).toLowerCase());
}

function isDecodableExt(p) {
  return DECODABLE_EXTS.has(path.extname(p).toLowerCase());
}

// ---------------------------------------------------------------------------
// 80-bit IEEE extended float (AIFF sample rate field)
// ---------------------------------------------------------------------------
function readFloat80(buf, off) {
  if (off + 10 > buf.length) return 0;
  const expon = ((buf[off] << 8) | buf[off + 1]) & 0x7fff;
  const hi = buf.readUInt32BE(off + 2);
  const lo = buf.readUInt32BE(off + 6);
  if (expon === 0 && hi === 0 && lo === 0) return 0;
  const sign = (buf[off] & 0x80) ? -1 : 1;
  const mant = hi * 4294967296 + lo;
  return sign * mant * Math.pow(2, expon - 16446);
}

// ---------------------------------------------------------------------------
// WAV / BWF / RF64
// ---------------------------------------------------------------------------
function parseFmtChunk(buf, off, size) {
  if (size < 16 || off + 16 > buf.length) return null;
  const audioFormat = buf.readUInt16LE(off);
  const channels = buf.readUInt16LE(off + 2);
  const sampleRate = buf.readUInt32LE(off + 4);
  const byteRate = buf.readUInt32LE(off + 8);
  const blockAlign = buf.readUInt16LE(off + 12);
  const containerBits = buf.readUInt16LE(off + 14);

  let subFormat = audioFormat;
  let bitsPerSample = containerBits;

  if (audioFormat === 0xfffe && size >= 40 && off + 40 <= buf.length) {
    bitsPerSample = buf.readUInt16LE(off + 18) || containerBits;
    subFormat = buf.readUInt16LE(off + 24); // first 2 bytes of the SubFormat GUID
  }

  let codec;
  switch (subFormat) {
    case 1: codec = 'PCM'; break;
    case 3: codec = 'Float'; break;
    case 6: codec = 'A-law'; break;
    case 7: codec = 'µ-law'; break;
    case 0x55: codec = 'MP3'; break;
    case 0x2000: codec = 'AC-3'; break;
    case 0x0002: codec = 'MS ADPCM'; break;
    default: codec = 'codec 0x' + subFormat.toString(16).toUpperCase();
  }

  return {
    audioFormat, subFormat, codec, channels, sampleRate, byteRate,
    blockAlign, bitsPerSample, containerBits
  };
}

function parseWav(buf, fileSize) {
  if (buf.length < 12) return null;
  const riff = buf.toString('latin1', 0, 4);
  if (riff !== 'RIFF' && riff !== 'RF64' && riff !== 'BW64') return null;
  if (buf.toString('latin1', 8, 12) !== 'WAVE') return null;

  let fmt = null;
  let dataOffset = -1;
  let dataSize = 0;
  let ds64DataSize = 0;
  let isBWF = false;
  let hasIXML = false;

  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;

    if (id === 'ds64' && body + 24 <= buf.length) {
      ds64DataSize = Number(buf.readBigUInt64LE(body + 8));
    } else if (id === 'fmt ') {
      fmt = parseFmtChunk(buf, body, Math.min(size, buf.length - body));
    } else if (id === 'bext') {
      isBWF = true;
    } else if (id === 'iXML') {
      hasIXML = true;
    } else if (id === 'data') {
      dataOffset = body;
      dataSize = (size === 0xffffffff || size === 0) && ds64DataSize
        ? ds64DataSize
        : size;
      break;
    }

    if (size === 0xffffffff) break; // truncated read; stop scanning
    off = body + size + (size & 1);
  }

  if (!fmt || dataOffset < 0) return null;
  if (dataOffset > fileSize) return null;
  dataSize = Math.min(dataSize, fileSize - dataOffset);

  const blockAlign = fmt.blockAlign || (Math.ceil(fmt.bitsPerSample / 8) * fmt.channels);
  const frames = blockAlign > 0 ? Math.floor(dataSize / blockAlign) : 0;

  return {
    kind: 'pcm',
    container: riff === 'RF64' ? 'RF64' : (riff === 'BW64' ? 'BW64' : 'WAV'),
    codec: fmt.codec,
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitDepth: fmt.bitsPerSample,
    containerBits: fmt.containerBits,
    frames,
    duration: fmt.sampleRate > 0 ? frames / fmt.sampleRate : 0,
    dataOffset,
    dataSize,
    blockAlign,
    isFloat: fmt.subFormat === 3,
    bigEndian: false,
    isBWF,
    hasIXML,
    nativePlayback: fmt.subFormat === 1 || fmt.subFormat === 3
  };
}

// ---------------------------------------------------------------------------
// AIFF / AIFC
// ---------------------------------------------------------------------------
function parseAiff(buf, fileSize) {
  if (buf.length < 12) return null;
  if (buf.toString('latin1', 0, 4) !== 'FORM') return null;
  const formType = buf.toString('latin1', 8, 12);
  if (formType !== 'AIFF' && formType !== 'AIFC') return null;

  let comm = null;
  let ssnd = null;

  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32BE(off + 4);
    const body = off + 8;

    if (id === 'COMM' && size >= 18 && body + 18 <= buf.length) {
      const channels = buf.readUInt16BE(body);
      const frames = buf.readUInt32BE(body + 2);
      const sampleSize = buf.readUInt16BE(body + 6);
      const sampleRate = readFloat80(buf, body + 8);
      let compression = 'NONE';
      if (formType === 'AIFC' && size >= 22 && body + 22 <= buf.length) {
        compression = buf.toString('latin1', body + 18, body + 22);
      }
      comm = { channels, frames, sampleSize, sampleRate, compression };
    } else if (id === 'SSND' && size >= 8) {
      const dataOffsetInSSND = buf.readUInt32BE(body);
      const blockSize = buf.readUInt32BE(body + 4);
      const dataStart = body + 8 + dataOffsetInSSND;
      ssnd = {
        dataOffset: dataStart,
        dataSize: Math.min(size - 8 - dataOffsetInSSND, fileSize - dataStart),
        blockSize
      };
      break;
    }

    off = body + size + (size & 1);
  }

  if (!comm || !ssnd) return null;

  // AIFC compression types that are still linear PCM.
  const pcmCompressions = new Set(['NONE', 'twos', 'sowt', 'raw ', 'in24', 'in32', 'fl32', 'FL32', 'fl64', 'FL64']);
  const isPcm = formType === 'AIFF' || pcmCompressions.has(comm.compression);
  const isFloat = comm.compression === 'fl32' || comm.compression === 'FL32' ||
                  comm.compression === 'fl64' || comm.compression === 'FL64';
  const bigEndian = comm.compression !== 'sowt';

  const bytesPerSample = Math.ceil(comm.sampleSize / 8) || 2;

  return {
    kind: isPcm ? 'pcm' : 'unsupported',
    container: formType,
    codec: isPcm ? (isFloat ? 'Float' : 'PCM') : 'AIFC ' + comm.compression,
    sampleRate: comm.sampleRate,
    channels: comm.channels,
    bitDepth: comm.sampleSize,
    frames: comm.frames,
    duration: comm.sampleRate > 0 ? comm.frames / comm.sampleRate : 0,
    dataOffset: ssnd.dataOffset,
    dataSize: ssnd.dataSize,
    blockAlign: bytesPerSample * comm.channels,
    isFloat,
    bigEndian,
    // Chromium cannot decode AIFF at all; we transcode to WAV on demand.
    nativePlayback: false,
    compression: comm.compression
  };
}

// ---------------------------------------------------------------------------
// Public: inspect a file
// ---------------------------------------------------------------------------
async function readHead(filePath) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const stat = await fh.stat();
    const len = Math.min(stat.size, HEAD_READ);
    const buf = Buffer.alloc(len);
    if (len > 0) await fh.read(buf, 0, len, 0);
    return { buf, size: stat.size };
  } finally {
    await fh.close();
  }
}

/**
 * @returns {{ok:boolean, kind:'pcm'|'browser'|'unsupported', ext:string,
 *            format:string, meta:object, reason?:string}}
 */
async function inspect(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let head;
  try {
    head = await readHead(filePath);
  } catch (err) {
    return { ok: false, kind: 'unsupported', ext, reason: 'unreadable' };
  }

  let info = null;
  try {
    info = parseWav(head.buf, head.size) || parseAiff(head.buf, head.size);
  } catch (err) {
    info = null;
  }

  if (info) {
    if (info.kind === 'pcm') {
      return {
        ok: true,
        kind: 'pcm',
        ext,
        format: info.container,
        meta: {
          duration: info.duration,
          sampleRate: info.sampleRate,
          channels: info.channels,
          bitDepth: info.bitDepth,
          codec: info.codec,
          container: info.container,
          isBWF: !!info.isBWF,
          isFloat: !!info.isFloat,
          frames: info.frames
        },
        pcm: info
      };
    }
    return {
      ok: false,
      kind: 'unsupported',
      ext,
      format: info.container,
      meta: {
        duration: info.duration,
        sampleRate: info.sampleRate,
        channels: info.channels,
        bitDepth: info.bitDepth,
        codec: info.codec,
        container: info.container
      },
      reason: 'compressed-aifc'
    };
  }

  // Not PCM. Let Chromium try.
  if (isDecodableExt(filePath)) {
    return {
      ok: true,
      kind: 'browser',
      ext,
      format: ext.replace('.', '').toUpperCase(),
      meta: { duration: 0, sampleRate: 0, channels: 0, bitDepth: 0, codec: ext.replace('.', '').toUpperCase() }
    };
  }

  return { ok: false, kind: 'unsupported', ext, format: ext.replace('.', '').toUpperCase(), reason: 'unknown-format' };
}

// ---------------------------------------------------------------------------
// Peak envelope (streaming)
// ---------------------------------------------------------------------------
function decodeSampleReader(buf, blockAlign, channels, bytesPerSample, isFloat, bigEndian, is8bitUnsigned) {
  // Returns a function(frameIndexInBuffer) -> ch sample or null.
  // Kept as a switch outside the loop for speed.
  if (isFloat) {
    if (bytesPerSample === 4) {
      return bigEndian
        ? (b, i) => b.readFloatBE(i * 4)
        : (b, i) => b.readFloatLE(i * 4);
    }
    return bigEndian
      ? (b, i) => b.readDoubleBE(i * 8)
      : (b, i) => b.readDoubleLE(i * 8);
  }
  switch (bytesPerSample) {
    case 1:
      // WAV 8-bit is unsigned 0..255; AIFF 8-bit is signed.
      return is8bitUnsigned
        ? (b, i) => (b[i] - 128) / 128
        : (b, i) => b.readInt8(i) / 128;
    case 2:
      return bigEndian
        ? (b, i) => b.readInt16BE(i * 2) / 32768
        : (b, i) => b.readInt16LE(i * 2) / 32768;
    case 3: {
      const scale = 1 / 8388608;
      return bigEndian
        ? (b, i) => {
            const o = i * 3;
            let v = (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
            if (v & 0x800000) v -= 0x1000000;
            return v * scale;
          }
        : (b, i) => {
            const o = i * 3;
            let v = (b[o + 2] << 16) | (b[o + 1] << 8) | b[o];
            if (v & 0x800000) v -= 0x1000000;
            return v * scale;
          };
    }
    case 4:
      return bigEndian
        ? (b, i) => b.readInt32BE(i * 4) / 2147483648
        : (b, i) => b.readInt32LE(i * 4) / 2147483648;
    default:
      return () => 0;
  }
}

/**
 * Compute a min/max envelope by streaming only the audio payload.
 * @returns {{binsPerSecond:number, channels:number, bins:number, data:Int16Array}}
 *          data layout: bin-major, then [ch0.min, ch0.max, ch1.min, ch1.max, ...]
 */
async function computePeaks(pcm) {
  const {
    dataOffset, dataSize, sampleRate, channels, frames,
    blockAlign, isFloat, bigEndian, container: containerName
  } = pcm;

  const bytesPerSample = Math.max(1, Math.round(blockAlign / Math.max(1, channels)));
  const is8bitUnsigned = !isFloat && bytesPerSample === 1 && !bigEndian &&
                         pcm.container !== 'AIFF' && pcm.container !== 'AIFC';
  const reader = decodeSampleReader(pcm, blockAlign, channels, bytesPerSample,
                                    isFloat, bigEndian, is8bitUnsigned);

  const chCount = Math.min(Math.max(1, channels), 2);
  const duration = sampleRate > 0 ? frames / sampleRate : 0;
  const bins = Math.max(1, Math.min(400000, Math.ceil(duration * PEAK_BINS_PER_SECOND)));
  const framesPerBin = frames / bins;

  const data = new Int16Array(bins * chCount * 2);
  for (let i = 0; i < data.length; i += 2) data[i] = 32767; // mins
  for (let i = 1; i < data.length; i += 2) data[i] = -32768; // maxes

  // Zero-crossing profile: 64 segments of "how often the waveform changes sign".
  // It is a cheap brightness/pitch descriptor, and it is what tells two clips
  // with the same envelope but different content apart during similarity search.
  const zcrBins = Math.min(64, Math.max(1, bins));
  const zcrCross = new Float64Array(zcrBins);
  const zcrFrames = new Float64Array(zcrBins);
  const segFrames = Math.max(1, frames / zcrBins);
  const lastSign = new Int8Array(chCount);

  const chunkFrames = Math.max(1, Math.floor((1 << 20) / blockAlign));
  const buf = Buffer.allocUnsafe(Math.min(chunkFrames, Math.max(1, frames)) * blockAlign);

  const fh = await fsp.open(pcm.path || '', 'r').catch(() => null);
  let pos = dataOffset;
  let remaining = dataSize;
  let frameBase = 0;

  try {
    while (remaining > 0) {
      const wantFrames = Math.min(chunkFrames, Math.floor(remaining / blockAlign));
      if (wantFrames <= 0) break;
      const want = wantFrames * blockAlign;
      const n = await readAt(fh, buf, 0, want, pos);
      if (!n || n <= 0) break;
      const nFrames = Math.floor(n / blockAlign);
      if (nFrames <= 0) break;

      for (let f = 0; f < nFrames; f++) {
        const frame = frameBase + f;
        let bin = (frame / framesPerBin) | 0;
        if (bin >= bins) bin = bins - 1;
        // `base` indexes the current chunk buffer, so it must stay chunk-local;
        // only `bin` needs the global frame number.
        const base = f * channels;
        let zi = (frame / segFrames) | 0;
        if (zi >= zcrBins) zi = zcrBins - 1;
        zcrFrames[zi] += 1;
        for (let c = 0; c < chCount; c++) {
          let v = reader(buf, base + c);
          if (v > 1) v = 1; else if (v < -1) v = -1;
          const q = (v * 32767) | 0;
          const o = bin * chCount * 2 + c * 2;
          if (q < data[o]) data[o] = q;
          if (q > data[o + 1]) data[o + 1] = q;

          const sign = q > 0 ? 1 : q < 0 ? -1 : 0;
          if (sign !== 0) {
            if (lastSign[c] !== 0 && sign !== lastSign[c]) zcrCross[zi] += 1;
            lastSign[c] = sign;
          }
        }
      }

      pos += nFrames * blockAlign;
      remaining -= nFrames * blockAlign;
      frameBase += nFrames;
    }
  } finally {
    if (fh) await fh.close().catch(() => {});
  }

  // Flatten empty bins (gaps) so they read as silence rather than full-scale.
  for (let b = 0; b < bins; b++) {
    for (let c = 0; c < chCount; c++) {
      const o = b * chCount * 2 + c * 2;
      if (data[o] === 32767 && data[o + 1] === -32768) data[o + 1] = 0, data[o] = 0;
    }
  }

  // 每个采样帧贡献 chCount 次符号比较，归一化成 0..1 的过零率。
  const zcr = new Array(zcrBins);
  for (let i = 0; i < zcrBins; i++) {
    const denom = zcrFrames[i] * chCount;
    zcr[i] = denom > 0 ? Math.min(1, zcrCross[i] / denom) : 0;
  }

  return { binsPerSecond: PEAK_BINS_PER_SECOND, channels: chCount, bins, data, zcr };
}

async function readAt(fh, buf, offset, length, position) {
  if (!fh) return 0;
  const r = await fh.read(buf, offset, length, position);
  return r.bytesRead;
}

// ---------------------------------------------------------------------------
// AIFF -> WAV transcode (playback only; the library file is never touched)
// ---------------------------------------------------------------------------
async function aiffToWav(pcm, destPath) {
  const bytesPerSample = Math.max(1, Math.round(pcm.blockAlign / Math.max(1, pcm.channels)));
  const blockAlign = bytesPerSample * pcm.channels;
  const frames = pcm.frames;
  const dataBytes = frames * blockAlign;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(pcm.isFloat ? 3 : 1, 20);
  header.writeUInt16LE(pcm.channels, 22);
  header.writeUInt32LE(pcm.sampleRate, 24);
  header.writeUInt32LE(pcm.sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bytesPerSample * 8, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(dataBytes, 40);

  await fsp.mkdir(path.dirname(destPath), { recursive: true });

  const fh = await fsp.open(pcm.path, 'r');
  const out = fs.createWriteStream(destPath);
  const write = (chunk) => new Promise((res, rej) => {
    if (out.write(chunk)) res(); else out.once('drain', res);
  });
  try {
    await write(header);

    const chunkFrames = Math.max(1, Math.floor((1 << 20) / blockAlign));
    const buf = Buffer.allocUnsafe(chunkFrames * blockAlign);
    let pos = pcm.dataOffset;
    let remaining = dataBytes;
    const bigEndian = pcm.bigEndian && !pcm.isFloat;

    while (remaining > 0) {
      const wantFrames = Math.min(chunkFrames, Math.floor(remaining / blockAlign));
      if (wantFrames <= 0) break;
      const want = wantFrames * blockAlign;
      const n = await readAt(fh, buf, 0, want, pos);
      if (!n || n <= 0) break;
      const framesRead = Math.floor(n / blockAlign);
      const slice = buf.subarray(0, framesRead * blockAlign);

      if (bytesPerSample === 1) {
        for (let i = 0; i < slice.length; i++) slice[i] = (slice[i] + 128) & 0xff;
        await write(Buffer.from(slice));
      } else if (bytesPerSample === 2 && bigEndian) {
        for (let i = 0; i < slice.length; i += 2) { const t = slice[i]; slice[i] = slice[i + 1]; slice[i + 1] = t; }
        await write(Buffer.from(slice));
      } else if (bytesPerSample === 3 && bigEndian) {
        for (let i = 0; i < slice.length; i += 3) {
          const t = slice[i]; slice[i] = slice[i + 2]; slice[i + 2] = t;
        }
        await write(Buffer.from(slice));
      } else if (bytesPerSample === 4 && bigEndian) {
        for (let i = 0; i < slice.length; i += 4) {
          const t0 = slice[i], t1 = slice[i + 1];
          slice[i] = slice[i + 3]; slice[i + 1] = slice[i + 2];
          slice[i + 2] = t1; slice[i + 3] = t0;
        }
        await write(Buffer.from(slice));
      } else {
        await write(Buffer.from(slice));
      }

      pos += framesRead * blockAlign;
      remaining -= framesRead * blockAlign;
    }
  } finally {
    await new Promise((res) => out.end(res));
    await fh.close().catch(() => {});
  }

  return destPath;
}

// ---------------------------------------------------------------------------
// Zoom detail: raw PCM min/max for one visible window (sample-accurate zoom)
// ---------------------------------------------------------------------------
/**
 * Read only the frames inside [startSec, endSec) and reduce them to `cols`
 * min/max columns. Used when the user zooms past the 320 bins/s envelope.
 * @returns {Promise<{channels:number, cols:number, data:Int16Array,
 *                    startSec:number, endSec:number, stride:number}|null>}
 */
async function readWindow(pcm, startSec, endSec, cols) {
  if (!pcm || !pcm.path || !pcm.blockAlign || !pcm.dataSize) return null;
  const {
    dataOffset, dataSize, sampleRate, channels, blockAlign,
    isFloat, bigEndian, container: containerName
  } = pcm;

  const bytesPerSample = Math.max(1, Math.round(blockAlign / Math.max(1, channels)));
  const is8bitUnsigned = !isFloat && bytesPerSample === 1 && !bigEndian &&
                         containerName !== 'AIFF' && containerName !== 'AIFC';
  const reader = decodeSampleReader(pcm, blockAlign, channels, bytesPerSample,
                                    isFloat, bigEndian, is8bitUnsigned);
  const chCount = Math.min(Math.max(1, channels), 2);
  const sr = sampleRate || 48000;
  const totalFrames = Math.max(1, Math.floor(dataSize / blockAlign));

  let a = Math.floor(Math.max(0, startSec || 0) * sr);
  let b = Math.ceil((endSec || 0) * sr);
  if (b <= a) b = a + 1;
  if (a > totalFrames - 1) a = totalFrames - 1;
  if (b > totalFrames) b = totalFrames;
  const nFrames = Math.max(1, b - a);

  const outCols = Math.max(1, Math.min(8192, Math.round(cols) || 1));
  const data = new Int16Array(outCols * chCount * 2);
  for (let i = 0; i < data.length; i += 2) data[i] = 32767;
  for (let i = 1; i < data.length; i += 2) data[i] = -32768;

  // Cap one request at ~12 MB of file data; beyond that, sample with a stride.
  const MAX_BYTES = 12 << 20;
  const maxFrames = Math.max(1, Math.floor(MAX_BYTES / blockAlign));
  const stride = nFrames > maxFrames ? Math.ceil(nFrames / maxFrames) : 1;
  const wantFrames = Math.ceil(nFrames / stride);
  const framesPerCol = nFrames / outCols;

  const chunkFrames = Math.min(wantFrames, Math.max(1, Math.floor((1 << 20) / blockAlign)));
  const buf = Buffer.allocUnsafe(chunkFrames * blockAlign);

  const fh = await fsp.open(pcm.path, 'r').catch(() => null);
  if (!fh) return null;
  let emitted = 0;
  let pos = dataOffset + a * blockAlign;
  try {
    while (emitted < wantFrames) {
      const take = Math.min(chunkFrames, wantFrames - emitted);
      const n = await readAt(fh, buf, 0, take * blockAlign, pos);
      const got = Math.floor(n / blockAlign);
      if (got <= 0) break;
      for (let f = 0; f < got; f++) {
        const gpos = (emitted + f) * stride;
        let col = (gpos / framesPerCol) | 0;
        if (col >= outCols) col = outCols - 1;
        const base = f * channels;
        for (let c = 0; c < chCount; c++) {
          let v = reader(buf, base + c);
          if (v > 1) v = 1; else if (v < -1) v = -1;
          const q = (v * 32767) | 0;
          const o = col * chCount * 2 + c * 2;
          if (q < data[o]) data[o] = q;
          if (q > data[o + 1]) data[o + 1] = q;
        }
      }
      emitted += got;
      pos += got * stride * blockAlign;
    }
  } finally {
    await fh.close().catch(() => {});
  }

  for (let i = 0; i < data.length; i += 2) {
    if (data[i] === 32767 && data[i + 1] === -32768) { data[i] = 0; data[i + 1] = 0; }
  }

  return {
    channels: chCount,
    cols: outCols,
    data,
    startSec: a / sr,
    endSec: b / sr,
    stride
  };
}

// ---------------------------------------------------------------------------
// Descriptive metadata (tags)
// ---------------------------------------------------------------------------
// A sound library lives or dies on this text: BWF bext/iXML, LIST-INFO,
// AIFF text chunks and whatever ID3 / Vorbis / MP4 atoms a compressed file
// carries. Everything here is best-effort and never throws: a broken tag is
// worth nothing, but a thrown exception would fail the whole import.

function syncsafe(buf, off) {
  return ((buf[off] & 0x7f) << 21) | ((buf[off + 1] & 0x7f) << 14) |
         ((buf[off + 2] & 0x7f) << 7) | (buf[off + 3] & 0x7f);
}

function latin1(buf, start, len) {
  return buf.toString('latin1', start, Math.min(buf.length, start + len));
}

function trimNul(s) {
  return String(s).replace(/\u0000+$/g, '').trim();
}

function decodeId3Text(buf, start, len) {
  if (len <= 0) return '';
  const enc = buf[start];
  const body = start + 1;
  const n = Math.min(len - 1, buf.length - body);
  if (n <= 0) return '';
  let s = '';
  if (enc === 1) {
    // UTF-16 with BOM
    const be = !(n >= 2 && buf[body] === 0xff && buf[body + 1] === 0xfe);
    s = buf.toString(be ? 'utf16le' : 'utf16le', body, body + n);
    // Node only has utf16le: byte-swap for BE payloads.
    if (be) {
      const copy = Buffer.from(buf.subarray(body, body + n));
      copy.swap16();
      s = copy.toString('utf16le');
    }
  } else if (enc === 2) {
    const copy = Buffer.from(buf.subarray(body, body + n));
    if (copy.length % 2 === 0) copy.swap16();
    s = copy.toString('utf16le');
  } else if (enc === 3) {
    s = buf.toString('utf8', body, body + n);
  } else {
    s = buf.toString('latin1', body, body + n);
  }
  return trimNul(s.replace(/\u0000/g, ' '));
}

const ID3_LABELS = {
  TIT2: '标题', TPE1: '艺术家', TPE2: '专辑艺术家', TALB: '专辑', TCOM: '作曲',
  TCON: '风格', TDRC: '日期', TYER: '年份', TRCK: '音轨', TPUB: '出版',
  TSSE: '编码器', TBPM: 'BPM', TKEY: '调性', TENC: '编码', TOAL: '原专辑',
  TPE3: '指挥', TEXT: '作词', TSRC: 'ISRC', TIT1: '分组', TIT3: '副标题',
  TCMP: '合辑', TSHO: '杭州话', TCAT: '类别', TDES: '描述', TCMT: '备注',
  TSCM: '场景', TOWN: '所有者', TRSN: '电台', TGID: '分组 ID', TDOR: '原始日期'
};

function parseId3Frames(buf, base, limit, sink) {
  if (base + 10 > limit) return null;
  if (latin1(buf, base, 3) !== 'ID3') return null;
  const ver = buf[base + 3];
  const flags = buf[base + 5];
  const size = syncsafe(buf, base + 6);
  if (size <= 0) return null;
  const end = Math.min(limit, base + 10 + size);

  let p = base + 10;
  if (flags & 0x40) {
    const extSize = ver >= 4 ? syncsafe(buf, p) : buf.readUInt32BE(p) + 4;
    p += Math.max(0, extSize);
  }

  while (p + 10 <= end) {
    const id = latin1(buf, p, 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const frameSize = ver >= 4 ? syncsafe(buf, p + 4) : buf.readUInt32BE(p + 4);
    const frameFlags = buf.readUInt16BE(p + 8);
    const body = p + 10;
    if (frameSize <= 0 || body + frameSize > end) break;
    if (!(frameFlags & 0x000c)) { // not compressed / encrypted
      try {
        if (id === 'TXXX') {
          const enc = buf[body];
          const raw = buf.subarray(body + 1, body + frameSize);
          const sep = raw.indexOf(0);
          let desc = '';
          let valStart = 0;
          if (sep >= 0) {
            desc = trimNul(enc === 3 ? raw.toString('utf8', 0, sep) : raw.toString('latin1', 0, sep));
            valStart = sep + (enc === 1 || enc === 2 ? 2 : 1);
          }
          const tmp = Buffer.concat([Buffer.from([enc]), raw.subarray(valStart)]);
          const val = decodeId3Text(tmp, 0, tmp.length);
          if (desc) sink.text(`ID3 自定义 · ${desc}`, val);
        } else if (id === 'COMM' || id === 'USLT') {
          const enc = buf[body];
          const lang = latin1(buf, body + 1, 3);
          const raw = buf.subarray(body + 4, body + frameSize);
          const sep = enc === 1 || enc === 2 ? indexOfWide(raw) : raw.indexOf(0);
          const valRaw = sep >= 0 ? (enc === 1 || enc === 2 ? raw.subarray(sep + 2) : raw.subarray(sep + 1)) : raw;
          const tmp = Buffer.concat([Buffer.from([enc]), valRaw]);
          sink.text(id === 'COMM' ? `ID3 注释 (${lang})` : `ID3 歌词 (${lang})`, decodeId3Text(tmp, 0, tmp.length));
        } else if (id === 'APIC' || id === 'PIC') {
          const enc = buf[body];
          let q = body + 1;
          let mime = '';
          if (id === 'APIC') {
            const m = indexOfByte(buf, 0, q, body + frameSize);
            mime = latin1(buf, q, Math.max(0, m - q));
            q = m + 1;
          } else {
            mime = 'image/' + latin1(buf, q, 3).toLowerCase();
            q += 3;
          }
          const picType = buf[q];
          q += 1;
          const sep = enc === 1 || enc === 2
            ? indexOfWide(buf, q, body + frameSize)
            : indexOfByte(buf, 0, q, body + frameSize);
          const desc = sep >= q ? encodeId3Text(buf, enc, q, sep) : '';
          const dataStart = sep >= 0 ? sep + (enc === 1 || enc === 2 ? 2 : 1) : q;
          sink.picture({ mime: mime || 'image/jpeg', type: picType, bytes: Math.max(0, body + frameSize - dataStart), description: desc, data: Buffer.from(buf.subarray(dataStart, body + frameSize)) });
        } else if (id[0] === 'T') {
          const val = decodeId3Text(buf, body, frameSize);
          if (val) sink.text(`ID3 · ${ID3_LABELS[id] || id}`, val);
        }
      } catch {
        /* keep going: one bad frame must not kill the rest */
      }
    }
    p = body + frameSize;
  }
  return end;
}

function encodeId3Text(buf, enc, start, end) {
  if (end <= start) return '';
  const tmp = Buffer.concat([Buffer.from([enc]), buf.subarray(start, end)]);
  return decodeId3Text(tmp, 0, tmp.length);
}

function indexOfByte(buf, byte, from, to) {
  for (let i = from; i < to && i < buf.length; i++) if (buf[i] === byte) return i;
  return -1;
}

function indexOfWide(buf, from, to) {
  for (let i = from; i + 1 < to && i + 1 < buf.length; i += 2) {
    if (buf[i] === 0 && buf[i + 1] === 0) return i;
  }
  // 退回逐字节扫描，容忍奇数起点
  for (let i = from; i + 1 < to && i + 1 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0) return i;
  }
  return -1;
}

function parseInfoList(buf, off, size) {
  // LIST chunk body at off, size bytes; expect 'INFO' + subchunks
  const rows = [];
  if (latin1(buf, off, 4) !== 'INFO') return rows;
  const end = Math.min(buf.length, off + size);
  let p = off + 4;
  const names = {
    INAM: '标题', IART: '艺术家', ICMT: '注释', ICRD: '日期', ISFT: '软件',
    IGNR: '风格', IKEY: '关键词', ITCH: '技术员', ISRC: '来源', IENG: '工程师',
    IPRD: '产品', ITRK: '音轨', ICOP: '版权', ISBJ: '主题', IARL: '存档'
  };
  while (p + 8 <= end) {
    const id = latin1(buf, p, 4);
    const sz = buf.readUInt32LE(p + 4);
    if (sz < 0 || p + 8 + sz > end) break;
    const val = trimNul(latin1(buf, p + 8, sz));
    if (val) rows.push([names[id] || id, val]);
    p += 8 + sz + (sz & 1);
  }
  return rows;
}

function parseBext(buf, off, size) {
  if (size < 256) return [];
  // 有些库（例如 BOOM）会在日期/作者字段里写进 \0 和 0x80 之类不可打印字节，
  // 直接显示会变成一串方块，这里统一只保留可打印字符。
  const printable = (str) => {
    let out = '';
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c >= 32 && c !== 127) out += str[i];
    }
    return out.replace(/\s+/g, ' ').trim();
  };
  const s = (from, len) => printable(trimNul(latin1(buf, off + from, len)));
  const desc = printable(trimNul(latin1(buf, off, 256)));
  const orig = s(256, 32);
  const origRef = s(288, 32);
  const date = s(320, 10);
  const time = s(330, 8);
  const timeRefLow = buf.readUInt32LE(off + 338);
  const timeRefHigh = size >= 348 ? buf.readUInt32LE(off + 342) : 0;
  const version = size >= 348 ? buf.readUInt16LE(off + 346) : 0;
  const umid = size >= 412 ? latin1(buf, off + 348, 64) : '';
  // bext 的固定头到 602 字节为止：UMID(64) + 响度五元组(10) + 保留(180)。
  // 编码历史在 602 之后，长度不固定，要读到块尾。旧文件（version 0/1）没有响度字段。
  const coding = size > 602 ? latin1(buf, off + 602, size - 602) : '';
  let loudness = null;
  if (version >= 2 && size >= 422) {
    const lv = buf.readInt16LE(off + 412);
    const lr = buf.readInt16LE(off + 414);
    const peak = buf.readInt16LE(off + 416);
    if (lv !== 0 || peak !== 0) {
      loudness = `整体 ${(lv / 100).toFixed(1)} LUFS · 范围 ${(lr / 100).toFixed(1)} LU · 真峰值 ${(peak / 100).toFixed(1)} dBTP`;
    }
  }

  const rows = [];
  if (desc) rows.push(['描述', desc]);
  if (orig) rows.push(['制作者', orig]);
  if (origRef) rows.push(['引用', origRef]);
  if (/\d/.test(date) || /\d/.test(time)) rows.push(['原始时间', `${date} ${time}`.trim()]);
  const frames = timeRefHigh * 4294967296 + timeRefLow;
  if (frames) rows.push(['时间参考', `${frames} 帧 = ${(frames / 48000).toFixed(3)} s (48k)`]);
  if (version) rows.push(['bext 版本', String(version)]);
  if (umid && /[^\u0000\s]/.test(umid)) rows.push(['UMID', printable(umid)]);
  const codingText = coding ? printable(coding.replace(/\r?\n/g, ' ')).slice(0, 400) : '';
  if (loudness) rows.push(['响度', loudness]);
  if (codingText) rows.push(['编码历史', codingText]);
  return rows;
}

/** 极简 XML → 扁平键值（sound 素材里的 iXML 都是浅层结构，够用） */
function parseXmlFlat(text, maxRows = 40) {
  const rows = [];
  const clean = text.replace(/<\?xml[^>]*\?>/i, '').trim();
  const re = /<([A-Za-z_][\w.:-]*)(?:\s[^>]*)?>([^<]*)<\/\1>/g;
  let m;
  while ((m = re.exec(clean)) && rows.length < maxRows) {
    const tag = m[1];
    const val = m[2].trim();
    if (val) rows.push([tag, val]);
  }
  return rows;
}

function parseXmpFlat(text, maxRows = 24) {
  const rows = [];
  const keys = ['dc:title', 'dc:creator', 'dc:description', 'dc:subject', 'xmp:CreatorTool',
                'photoshop:Credit', 'Iptc4xmpCore:CreatorContactInfo'];
  for (const k of keys) {
    const re = new RegExp(`<(?:${k}|[\\w]+:${k.split(':')[1]})[^>]*>([^<]{1,400})<`, 'i');
    const m = text.match(re);
    if (m && m[1].trim()) rows.push([k, m[1].trim()]);
    if (rows.length >= maxRows) break;
  }
  return rows;
}

function parseFlacMeta(buf, limit) {
  const out = { rows: [], picture: null };
  if (latin1(buf, 0, 4) !== 'fLaC') return out;
  let p = 4;
  let guard = 0;
  while (p + 4 <= limit && guard++ < 64) {
    const header = buf[p];
    const isLast = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const size = (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3];
    const body = p + 4;
    if (body + size > limit) break;
    if (type === 4) {
      try {
        let q = body;
        const vendorLen = buf.readUInt32LE(q); q += 4;
        const vendor = buf.toString('utf8', q, q + vendorLen); q += vendorLen;
        const count = buf.readUInt32LE(q); q += 4;
        if (vendor) out.rows.push(['编码器', vendor]);
        for (let i = 0; i < count && q + 4 <= body + size; i++) {
          const len = buf.readUInt32LE(q); q += 4;
          const pair = buf.toString('utf8', q, q + len); q += len;
          const eq = pair.indexOf('=');
          if (eq > 0) {
            const key = pair.slice(0, eq).toUpperCase();
            const val = pair.slice(eq + 1);
            const label = { TITLE: '标题', ARTIST: '艺术家', ALBUM: '专辑', DATE: '日期',
                            GENRE: '风格', COMMENT: '注释', DESCRIPTION: '描述',
                            TRACKNUMBER: '音轨', COPYRIGHT: '版权', ENCODER: '编码器' }[key] || `FLAC · ${key}`;
            if (val.trim()) out.rows.push([label, val.trim()]);
          }
        }
      } catch { /* ignore */ }
    } else if (type === 6) {
      try {
        let q = body;
        const picType = buf.readUInt32BE(q); q += 4;
        const mimeLen = buf.readUInt32BE(q); q += 4;
        const mime = buf.toString('latin1', q, q + mimeLen); q += mimeLen;
        const descLen = buf.readUInt32BE(q); q += 4;
        const desc = buf.toString('utf8', q, q + descLen); q += descLen;
        const dataLen = buf.readUInt32BE(q); q += 4;
        const data = Buffer.from(buf.subarray(q, Math.min(q + dataLen, body + size)));
        out.picture = { mime: mime || 'image/jpeg', type: picType, bytes: data.length || size, description: desc, data };
      } catch { /* ignore */ }
    }
    p = body + size;
    if (isLast) break;
  }
  return out;
}

function parseVorbisComments(buf, start, end) {
  const rows = [];
  const vendorLen = buf.readUInt32LE(start);
  let q = start + 4 + vendorLen;
  const count = buf.readUInt32LE(q); q += 4;
  for (let i = 0; i < count && q + 4 <= end; i++) {
    const len = buf.readUInt32LE(q); q += 4;
    if (len <= 0 || q + len > end) break;
    const pair = buf.toString('utf8', q, q + len); q += len;
    const eq = pair.indexOf('=');
    if (eq > 0) {
      const key = pair.slice(0, eq).toUpperCase();
      const val = pair.slice(eq + 1);
      const label = { TITLE: '标题', ARTIST: '艺术家', ALBUM: '专辑', DATE: '日期',
                      GENRE: '风格', COMMENT: '注释', DESCRIPTION: '描述',
                      TRACKNUMBER: '音轨', COPYRIGHT: '版权', ENCODER: '编码器' }[key] || `Vorbis · ${key}`;
      if (val.trim()) rows.push([label, val.trim()]);
    }
  }
  return rows;
}

function parseOggTags(buf, limit) {
  const out = { rows: [] };
  let p = 0;
  let guard = 0;
  while (p + 27 <= limit && guard++ < 6) {
    if (latin1(buf, p, 4) !== 'OggS') break;
    const segs = buf[p + 26];
    const tableStart = p + 27;
    let bodyLen = 0;
    for (let i = 0; i < segs; i++) bodyLen += buf[tableStart + i];
    const body = tableStart + segs;
    const payload = buf.subarray(body, Math.min(limit, body + bodyLen));
    if (payload.length > 8 && latin1(payload, 0, 7) === '\x01vorbis') {
      out.rows.push(['编码', 'Vorbis']);
    } else if (payload.length > 8 && latin1(payload, 0, 8) === 'OpusTags') {
      try {
        out.rows.push(...parseVorbisComments(payload, 8, payload.length));
      } catch { /* ignore */ }
      break;
    } else if (payload.length > 8 && latin1(payload, 0, 7) === '\x03vorbis') {
      try {
        const tmp = Buffer.from(payload.subarray(7));
        out.rows.push(...parseVorbisComments(tmp, 0, tmp.length));
      } catch { /* ignore */ }
      break;
    }
    p = body + bodyLen;
  }
  return out;
}

const MP4_ATOM_LABELS = {
  '\u00a9nam': '标题', '\u00a9ART': '艺术家', aART: '专辑艺术家', '\u00a9alb': '专辑',
  '\u00a9day': '日期', '\u00a9cmt': '注释', '\u00a9gen': '风格', '\u00a9wrt': '作曲',
  '\u00a9too': '编码器', '\u00a9des': '描述', '\u00a9cpy': '版权', cprt: '版权',
  trkn: '音轨', disk: '碟号', '\u00a9lyr': '歌词', '\u00a9mak': '制作', '\u00a9mod': '型号'
};

function walkAtoms(buf, start, end, onAtom) {
  let p = start;
  for (let guard = 0; guard < 512 && p + 8 <= end;) {
    let size = buf.readUInt32BE(p);
    const type = latin1(buf, p + 4, 4);
    let body = p + 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = Number(buf.readBigUInt64BE(p + 8));
      body = p + 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < 8 || p + size > end) break;
    onAtom(type, body, p + size);
    p += size;
  }
}

function parseMp4Tags(buf, limit) {
  const out = { rows: [], picture: null };
  const ilstEntries = [];

  // moov/udta/meta 都是容器；meta 的 body 前面还有 4 字节 version/flags。
  const descend = (start, end, depth) => {
    if (depth > 6) return;
    walkAtoms(buf, start, end, (type, body, atomEnd) => {
      if (type === 'ilst') {
        walkAtoms(buf, body, atomEnd, (t, b, e) => ilstEntries.push([t, b, e]));
      } else if (type === 'moov' || type === 'udta' || type === 'trak' || type === 'mdia') {
        descend(body, atomEnd, depth + 1);
      } else if (type === 'meta') {
        descend(body + 4, atomEnd, depth + 1);
      }
    });
  };
  descend(0, limit, 0);

  for (const [type, body, end] of ilstEntries) {
    let value = '';
    let isPicture = false;
    walkAtoms(buf, body, end, (t, b, e) => {
      if (t !== 'data') return;
      const kind = buf.readUInt32BE(b) & 0x00ffffff;
      const payload = buf.subarray(b + 8, e);
      if (type === 'covr' || kind === 13 || kind === 14) { isPicture = true; return; }
      if (kind === 1 || kind === 2 || kind === 21) {
        value = payload.toString('utf8').replace(/\u0000/g, '').trim();
      } else if (kind === 0) {
        value = payload.toString('latin1').replace(/\u0000/g, '').trim();
      } else if (kind === 22) {
        value = String(payload.readUInt32BE(0) || '');
      }
    });
    if (isPicture) {
      const coverData = Buffer.from(buf.subarray(body + 8, end));
      out.picture = { mime: 'image/jpeg', type: 0, bytes: coverData.length, description: '', data: coverData };
      continue;
    }
    if (!value) continue;
    out.rows.push([MP4_ATOM_LABELS[type] || `MP4 · ${type}`, value]);
  }
  return out;
}

function wrapRows(groups) {
  return groups.filter((g) => g && g.rows && g.rows.length);
}

async function readSlice(filePath, want, fromEnd) {
  const fh = await fsp.open(filePath, 'r').catch(() => null);
  if (!fh) return null;
  try {
    const st = await fh.stat();
    const size = Math.min(want, st.size);
    const start = fromEnd ? Math.max(0, st.size - size) : 0;
    const buf = Buffer.allocUnsafe(size);
    const { bytesRead } = await fh.read(buf, 0, size, start);
    return { buf: buf.subarray(0, bytesRead), fileSize: st.size, offset: start };
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * Read every descriptive tag we know how to find.
 * @returns {{groups:Array<{key:string,title:string,rows:Array<[string,string]>}>,
 *            flat:Object, picture:Object|null}}
 */
async function readTags(filePath, sliceBytes = 2 << 20) {
  const groups = [];
  const flat = {};
  let picture = null;

  const setFlat = (label, val) => {
    if (!val) return;
    if (/专辑艺术家/.test(label)) { if (!flat.albumArtist) flat.albumArtist = val; return; }
    if (/标题|Title/i.test(label) && !flat.title) flat.title = val;
    else if (/艺术家|Artist/i.test(label) && !flat.artist) flat.artist = val;
    else if (/专辑|Album/i.test(label) && !flat.album) flat.album = val;
    else if (/注释|Comment|描述|Description/i.test(label) && !flat.comment) flat.comment = val;
    else if (/日期|Date|年份/i.test(label) && !flat.date) flat.date = val;
    else if (/风格|Genre|类别/i.test(label) && !flat.genre) flat.genre = val;
  };
  const sink = {
    text: (label, val) => { if (val) setFlat(label, val); },
    picture: (pic) => { if (!picture && pic && pic.bytes > 64) picture = pic; }
  };

  try {
    const head = await readSlice(filePath, Math.max(64 * 1024, sliceBytes | 0), false);
    if (!head) return { groups: [], flat, picture };
    const { buf } = head;

    const riff = latin1(buf, 0, 4) === 'RIFF' || latin1(buf, 0, 4) === 'RF64' || latin1(buf, 0, 4) === 'BW64';
    const form = latin1(buf, 0, 4) === 'FORM';

    if (riff) {
      const end = buf.length;
      let p = 12;
      const infoRows = [];
      const bextGroups = [];
      const ixmlRows = [];
      const xmpRows = [];
      while (p + 8 <= end) {
        const id = latin1(buf, p, 4);
        const sz = buf.readUInt32LE(p + 4);
        const body = p + 8;
        if (sz < 0 || body + Math.min(sz, 16) > end) break;
        if (id === 'bext') {
          bextGroups.push(...parseBext(buf, body, sz));
        } else if (id === 'iXML' || id === 'ixml') {
          ixmlRows.push(...parseXmlFlat(buf.toString('utf8', body, Math.min(end, body + sz))));
        } else if (id === 'LIST') {
          infoRows.push(...parseInfoList(buf, body, sz));
        } else if (id === 'id3 ' || id === 'ID3 ') {
          const id3rows = [];
          const wrapped = {
            text: (label, val) => { if (val) id3rows.push([label, val]); },
            picture: (pic) => sink.picture(pic)
          };
          parseId3Frames(buf, body, Math.min(end, body + sz), wrapped);
          if (id3rows.length) groups.push({ key: 'id3', title: 'ID3', rows: id3rows });
        } else if (id === 'XMP ' || id === 'XMP_') {
          xmpRows.push(...parseXmpFlat(buf.toString('utf8', body, Math.min(end, body + sz))));
        } else if (id === 'data') {
          break;
        }
        p = body + sz + (sz & 1);
      }
      // ID3 已在上面通过 sink 直接吞入，这里把 ID3 行收进组
      if (bextGroups.length) groups.push({ key: 'bext', title: 'BWF bext', rows: bextGroups });
      if (ixmlRows.length) groups.push({ key: 'ixml', title: 'iXML', rows: ixmlRows });
      if (infoRows.length) groups.push({ key: 'info', title: 'LIST-INFO', rows: infoRows });
      if (xmpRows.length) groups.push({ key: 'xmp', title: 'XMP', rows: xmpRows });
    } else if (form) {
      let p = 12;
      const end = buf.length;
      const textRows = [];
      while (p + 8 <= end) {
        const id = latin1(buf, p, 4);
        const sz = buf.readUInt32BE(p + 4);
        const body = p + 8;
        if (sz < 0 || body + sz > end) break;
        const label = { NAME: '标题', AUTH: '艺术家', '(c) ': '版权', ANNO: '注释' }[id];
        if (label) {
          const val = trimNul(buf.toString('utf8', body, body + sz));
          if (val) textRows.push([label, val]);
        } else if (id === 'ID3 ' || id === 'id3 ') {
          parseId3Frames(buf, body, Math.min(end, body + sz), sink);
        } else if (id === 'APPL') {
          textRows.push(['APPL', trimNul(buf.toString('latin1', body, Math.min(body + sz, body + 64)))]);
        }
        p = body + sz + (sz & 1);
      }
      if (textRows.length) groups.push({ key: 'aiff', title: 'AIFF 文本块', rows: textRows });
    } else if (latin1(buf, 0, 4) === 'fLaC') {
      const meta = parseFlacMeta(buf, buf.length);
      if (meta.rows.length) groups.push({ key: 'flac', title: 'FLAC 标签', rows: meta.rows });
      if (meta.picture) picture = meta.picture;
    } else if (latin1(buf, 0, 4) === 'OggS') {
      const ogg = parseOggTags(buf, buf.length);
      if (ogg.rows.length) groups.push({ key: 'ogg', title: 'Ogg 标签', rows: ogg.rows });
    } else if (latin1(buf, 4, 4) === 'ftyp' || latin1(buf, 4, 4) === 'moov') {
      const mp4head = parseMp4Tags(buf, buf.length);
      if (mp4head.rows.length) groups.push({ key: 'mp4', title: 'MP4 标签', rows: mp4head.rows });
      if (mp4head.picture) picture = mp4head.picture;
      if (!mp4head.rows.length) {
        const tail = await readSlice(filePath, 2 << 20, true);
        if (tail && tail.offset > 0) {
          const mp4tail = parseMp4Tags(tail.buf, tail.buf.length);
          if (mp4tail.rows.length) groups.push({ key: 'mp4', title: 'MP4 标签', rows: mp4tail.rows });
          if (!picture && mp4tail.picture) picture = mp4tail.picture;
        }
      }
    }

    // 裸 ID3（mp3 最常见）：文件头就是 ID3
    if (latin1(buf, 0, 3) === 'ID3') {
      const rows = [];
      const wrapped = {
        text: (label, val) => { if (val) rows.push([label, val]); setFlat(label, val); },
        picture: (pic) => sink.picture(pic)
      };
      parseId3Frames(buf, 0, buf.length, wrapped);
      if (rows.length) groups.push({ key: 'id3', title: 'ID3', rows });
    }

    // 文件尾部可能还有 ID3v1（老 mp3）
    const tail = await readSlice(filePath, 128, true);
    if (tail && tail.fileSize >= 128 && latin1(tail.buf, 0, 3) === 'TAG') {
      const t = (from, len) => trimNul(tail.buf.toString('latin1', from, from + len));
      const rows = [];
      if (t(3, 30)) rows.push(['标题', t(3, 30)]);
      if (t(33, 30)) rows.push(['艺术家', t(33, 30)]);
      if (t(63, 30)) rows.push(['专辑', t(63, 30)]);
      if (t(93, 4)) rows.push(['年份', t(93, 4)]);
      if (t(97, 30)) rows.push(['注释', t(97, 30)]);
      if (rows.length && !groups.some((g) => g.key === 'id3')) {
        groups.push({ key: 'id3v1', title: 'ID3v1', rows });
      }
    }
  } catch {
    /* best effort */
  }

  for (const g of groups) for (const [label, val] of g.rows) setFlat(label, val);
  return { groups: wrapRows(groups), flat, picture };
}

// ---------------------------------------------------------------------------
// Cover art
// ---------------------------------------------------------------------------
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']);

function mimeForImageExt(ext) {
  switch (ext) {
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.bmp': return 'image/bmp';
    default: return 'image/jpeg';
  }
}

const ART_SUBDIR_RE = /^(?:artwork|art|cover|covers|coverart|cover ?art|images|pictures|packshots?|_artwork|artwork ?\d+)$/i;
const PREFERRED_ART_RE = /^(?:cover|folder|front|album|packshot|artwork|thumb)/i;

// 目录内容缓存：同一次导入会有成百上千个文件问同一个目录，readdir 只做一次。
const dirListingCache = new Map();

async function listDir(dir) {
  const hit = dirListingCache.get(dir);
  if (hit) return hit;
  const out = { files: [], dirs: [] };
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile()) {
        if (IMAGE_EXTS.has(path.extname(e.name).toLowerCase())) out.files.push(e.name);
      } else if (e.isDirectory()) {
        out.dirs.push(e.name);
      }
    }
    out.files.sort((a, b) => a.localeCompare(b));
  } catch { /* 目录读不了就当没有图 */ }
  if (dirListingCache.size > 4096) dirListingCache.clear();
  dirListingCache.set(dir, out);
  return out;
}

/**
 * 在一组图片里挑一张：与音频同名 > cover/folder/front 之类的常规名 >
 * 与目录同名 > 目录里只有一张。
 */
function pickArt(images, audioBase, dirBase) {
  if (!images.length) return null;
  const lower = (s) => s.toLowerCase();
  const sameAsAudio = images.find((n) => lower(path.parse(n).name) === audioBase);
  if (sameAsAudio) return sameAsAudio;
  const conventional = images.find((n) => PREFERRED_ART_RE.test(n));
  if (conventional) return conventional;
  const wantDir = dirBase ? lower(dirBase) : '';
  const sameAsDir = wantDir ? images.find((n) => lower(path.parse(n).name) === wantDir) : null;
  if (sameAsDir) return sameAsDir;
  return images.length === 1 ? images[0] : null;
}

/**
 * Cover for one audio file: embedded first (APIC / FLAC PICTURE / MP4 covr),
 * then the folder artwork sound libraries ship next to the audio
 * (cover.*, folder.*, front.*, album*) — the same convention Soundminer and
 * BaseHead use, so an imported folder gets its picture automatically.
 */
async function extractCover(filePath) {
  try {
    const tags = await readTags(filePath);
    if (tags.picture && tags.picture.data && tags.picture.data.length > 64) {
      return {
        ok: true,
        mime: tags.picture.mime || 'image/jpeg',
        data: tags.picture.data,
        source: 'embedded',
        from: filePath,
        rel: null
      };
    }
  } catch { /* fall through to folder art */ }

  const startDir = path.dirname(filePath);
  const startBase = path.basename(startDir);
  const audioBase = path.parse(filePath).name.toLowerCase();

  const finish = async (full, source) => {
    const st = await fsp.stat(full);
    if (!st.isFile() || st.size < 32 || st.size > (16 << 20)) {
      return { ok: false, reason: 'bad-image' };
    }
    const data = await fsp.readFile(full);
    return {
      ok: true,
      mime: mimeForImageExt(path.extname(full).toLowerCase()),
      data,
      source,
      from: full,
      rel: path.relative(startDir, full) || path.basename(full)
    };
  };

  try {
    let ambiguous = false;
    let dir = startDir;

    // 0 = 音频自己那层，1 和 2 = 往上两级（很多音效包把封面放在包根）
    for (let level = 0; level <= 2; level++) {
      const listing = await listDir(dir);
      const dirBase = level === 0 ? startBase : path.basename(dir);

      // 先看这一层里的封面目录：Artwork / Covers / Images / Pictures …
      for (const d of listing.dirs) {
        if (!ART_SUBDIR_RE.test(d)) continue;
        const sub = await listDir(path.join(dir, d));
        const pick = pickArt(sub.files, audioBase, dirBase);
        if (pick) return await finish(path.join(dir, d, pick), 'artwork');
      }

      // 再看这一层目录本身放的图
      const here = pickArt(listing.files, audioBase, dirBase);
      if (here) return await finish(path.join(dir, here), level === 0 ? 'folder' : 'ancestor');

      if (level === 0 && listing.files.length > 1) ambiguous = true;

      const parent = path.dirname(dir);
      if (!parent || parent === dir) break; // 到盘根了
      dir = parent;
    }

    return { ok: false, reason: ambiguous ? 'ambiguous' : 'no-cover' };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

// ---------------------------------------------------------------------------
// Trim: write one region of a parsed PCM file out as a plain WAV
// ---------------------------------------------------------------------------
/**
 * Copy [startSec, endSec) of `pcm` into a new WAV file, keeping the source
 * sample rate, channel count and bit depth (float stays float).
 *
 * This is the "portable edit" path: the library file is never modified, and a
 * DAW gets a normal WAV it can drop on a track. Only formats we parse
 * ourselves (WAV/BWF/RF64/W64 and AIFF/AIFC, uncompressed) can be trimmed —
 * anything Chromium has to decode has no sample reader here.
 *
 * @returns {Promise<{path:string, frames:number, bytes:number}|null>}
 */
async function writeWavRegion(pcm, startSec, endSec, destPath) {
  const sr = pcm.sampleRate | 0;
  const channels = pcm.channels | 0;
  const inBlock = pcm.blockAlign | 0;
  if (!sr || !channels || !inBlock) return null;

  const bytesPerSample = Math.max(1, Math.round(inBlock / channels));
  const framesTotal = pcm.frames || Math.floor(pcm.dataSize / inBlock);
  const from = Math.max(0, Math.min(framesTotal, Math.floor(Math.max(0, startSec) * sr)));
  const to = Math.max(from, Math.min(framesTotal, Math.ceil(Math.max(0, endSec) * sr)));
  const frames = to - from;
  if (frames <= 0) return null;

  const isFloat = !!pcm.isFloat;
  const outBits = isFloat ? 32 : Math.min(32, Math.max(16, pcm.bitDepth || bytesPerSample * 8));
  const outBytes = outBits / 8;
  const outBlock = outBytes * channels;
  const dataBytes = frames * outBlock;

  // AIFF 8-bit is signed, WAV 8-bit is unsigned — decodeSampleReader needs to know.
  const is8bitUnsigned = !isFloat && bytesPerSample === 1 && !pcm.bigEndian;
  const reader = decodeSampleReader(pcm, inBlock, channels, bytesPerSample,
                                    isFloat, pcm.bigEndian, is8bitUnsigned);

  // Bit-exact fast path: same integer width going out as coming in.
  const rawCopy = !isFloat && outBits === bytesPerSample * 8 && bytesPerSample >= 2;
  const swapEndian = rawCopy && !!pcm.bigEndian;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(isFloat ? 3 : 1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sr, 24);
  header.writeUInt32LE(sr * outBlock, 28);
  header.writeUInt16LE(outBlock, 32);
  header.writeUInt16LE(outBits, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(dataBytes, 40);

  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const fh = await fsp.open(pcm.path, 'r');
  const out = fs.createWriteStream(destPath);
  const put = (chunk) => new Promise((res, rej) => {
    if (out.write(chunk)) res(); else out.once('drain', res);
  });

  const chunkFrames = Math.max(1, Math.floor((1 << 20) / inBlock));
  const inBuf = Buffer.allocUnsafe(chunkFrames * inBlock);
  let pos = pcm.dataOffset + from * inBlock;
  let left = frames;

  try {
    await put(header);
    while (left > 0) {
      const wantFrames = Math.min(chunkFrames, left);
      const n = await readAt(fh, inBuf, 0, wantFrames * inBlock, pos);
      const got = Math.floor(n / inBlock);
      if (got <= 0) break;

      // 同宽整型直接搬字节：16/24/32 bit 的裁剪应该是逐位相同，
      // 走一遍 float 只会引入 ±1 LSB 的舍入误差。
      if (rawCopy) {
        const outBuf = Buffer.from(inBuf.subarray(0, got * inBlock));
        if (swapEndian) {
          for (let i = 0; i < outBuf.length; i += outBytes) {
            for (let a = 0, b = outBytes - 1; a < b; a++, b--) {
              const t = outBuf[i + a];
              outBuf[i + a] = outBuf[i + b];
              outBuf[i + b] = t;
            }
          }
        }
        await put(outBuf);
        pos += got * inBlock;
        left -= got;
        continue;
      }

      const outBuf = Buffer.allocUnsafe(got * outBlock);
      let o = 0;
      for (let f = 0; f < got; f++) {
        for (let c = 0; c < channels; c++) {
          let v = reader(inBuf, f * channels + c);
          if (v > 1) v = 1; else if (v < -1) v = -1;
          if (isFloat) {
            outBuf.writeFloatLE(v, o);
            o += 4;
          } else if (outBytes === 2) {
            outBuf.writeInt16LE(Math.round(v * 32767), o);
            o += 2;
          } else if (outBytes === 3) {
            const q = Math.round(v * 8388607);
            outBuf[o] = q & 0xff;
            outBuf[o + 1] = (q >> 8) & 0xff;
            outBuf[o + 2] = (q >> 16) & 0xff;
            o += 3;
          } else {
            outBuf.writeInt32LE(Math.round(v * 2147483647), o);
            o += 4;
          }
        }
      }
      await put(outBuf);
      pos += got * inBlock;
      left -= got;
    }
  } finally {
    await new Promise((res) => out.end(res));
    await fh.close().catch(() => {});
  }

  return { path: destPath, frames: frames - left, bytes: dataBytes };
}

// ---------------------------------------------------------------------------
// Cache keys
// ---------------------------------------------------------------------------
function cacheKey(filePath, size, mtimeMs) {
  return crypto.createHash('sha1')
    .update(`${filePath}|${size}|${Math.round(mtimeMs)}`)
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Loudness / true-peak / spectrogram (all local, no ffmpeg, no Python)
// ---------------------------------------------------------------------------
// K-weighting 按 ITU-R BS.1770 的两级滤波器实现：高架 + 高通，系数用 RBJ 公式
// 按采样率现算，所以 44.1k / 48k / 96k 都成立，不是抄一组固定数字。
function kCoeffs(fs) {
  const shelf = biquadCoef('highshelf', fs, 1681.974450955533, 0.7071752369554196, 3.999843853973347);
  const hp = biquadCoef('highpass', fs, 38.13547087602444, 0.5003270373238773, 0);
  return { shelf, hp };
}

function biquadCoef(kind, fs, f0, q, gainDb) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / fs;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  let b0;
  let b1;
  let b2;
  let a0;
  let a1;
  let a2;
  if (kind === 'highshelf') {
    const alpha = (sin / 2) * Math.sqrt((A + 1 / A) * (1 / q - 1) + 2);
    const k = 2 * Math.sqrt(A) * alpha;
    b0 = A * ((A + 1) + (A - 1) * cos + k);
    b1 = -2 * A * ((A - 1) + (A + 1) * cos);
    b2 = A * ((A + 1) + (A - 1) * cos - k);
    a0 = (A + 1) - (A - 1) * cos + k;
    a1 = 2 * ((A - 1) - (A + 1) * cos);
    a2 = (A + 1) - (A - 1) * cos - k;
  } else {
    const alpha = sin / (2 * q);
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function biquadRun(c, x, st) {
  const y = c.b0 * x + c.b1 * st.x1 + c.b2 * st.x2 - c.a1 * st.y1 - c.a2 * st.y2;
  st.x2 = st.x1;
  st.x1 = x;
  st.y2 = st.y1;
  st.y1 = y;
  return y;
}

// 就地 FFT（radix-2），返回 re/im；只用于频谱图。
function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

const SPECTRUM_COLS = 320;
const SPECTRUM_ROWS = 96;
const SPECTRUM_FFT = 2048;

async function analyzeDeep(pcm, opts = {}) {
  const {
    dataOffset, dataSize, sampleRate, channels, frames,
    blockAlign, isFloat, bigEndian, container: containerName
  } = pcm;
  const bytesPerSample = Math.max(1, Math.round(blockAlign / Math.max(1, channels)));
  const is8bitUnsigned = !isFloat && bytesPerSample === 1 && !bigEndian &&
                         containerName !== 'AIFF' && containerName !== 'AIFC';
  const reader = decodeSampleReader(pcm, blockAlign, channels, bytesPerSample,
                                    isFloat, bigEndian, is8bitUnsigned);
  const chCount = Math.min(Math.max(1, channels), 8);

  const k = kCoeffs(sampleRate);
  const states = [];
  for (let c = 0; c < chCount; c++) {
    states.push({ shelf: { x1: 0, x2: 0, y1: 0, y2: 0 }, hp: { x1: 0, x2: 0, y1: 0, y2: 0 } });
  }

  const segFrames = Math.max(1, Math.round(sampleRate * 0.1));
  const segCount = Math.max(1, Math.ceil(frames / segFrames));
  const segSq = new Float64Array(segCount * chCount);
  const segCnt = new Float64Array(segCount);
  let peak = 0;

  const chunkFrames = Math.max(1, Math.floor((1 << 20) / blockAlign));
  const buf = Buffer.allocUnsafe(Math.min(chunkFrames, Math.max(1, frames)) * blockAlign);
  const fh = await fsp.open(pcm.path || '', 'r').catch(() => null);
  let pos = dataOffset;
  let remaining = dataSize;
  let frameBase = 0;
  let failed = !fh;
  try {
    while (!failed && remaining > 0) {
      const wantFrames = Math.min(chunkFrames, Math.floor(remaining / blockAlign));
      if (wantFrames <= 0) break;
      const n = await readAt(fh, buf, 0, wantFrames * blockAlign, pos);
      if (!n || n <= 0) break;
      const nFrames = Math.floor(n / blockAlign);
      if (nFrames <= 0) break;
      for (let f = 0; f < nFrames; f++) {
        const base = f * channels;
        const seg = Math.min(segCount - 1, ((frameBase + f) / segFrames) | 0);
        segCnt[seg] += 1;
        for (let c = 0; c < chCount; c++) {
          let v = reader(buf, base + c);
          const a = v < 0 ? -v : v;
          if (a > peak) peak = a;
          const st = states[c];
          v = biquadRun(k.shelf, v, st.shelf);
          v = biquadRun(k.hp, v, st.hp);
          segSq[seg * chCount + c] += v * v;
        }
      }
      pos += nFrames * blockAlign;
      remaining -= nFrames * blockAlign;
      frameBase += nFrames;
    }
  } finally {
    if (fh) await fh.close().catch(() => {});
  }

  // 每 100 ms 段能量（K 加权后各声道均方和）
  const segEnergy = new Float64Array(segCount);
  for (let s = 0; s < segCount; s++) {
    const cnt = segCnt[s] || 1;
    let e = 0;
    for (let c = 0; c < chCount; c++) e += segSq[s * chCount + c] / cnt;
    segEnergy[s] = e;
  }

  const loudnessOf = (e) => (e > 0 ? -0.691 + 10 * Math.log10(e) : -Infinity);

  // 400 ms 块，75% 重叠（每 100 ms 一块）
  const blocks = [];
  for (let s = 0; s + 3 < segCount; s++) {
    const e = (segEnergy[s] + segEnergy[s + 1] + segEnergy[s + 2] + segEnergy[s + 3]) / 4;
    blocks.push({ e, l: loudnessOf(e) });
  }
  const absGate = Math.pow(10, (-70 + 0.691) / 10);
  const above = blocks.filter((b) => b.e > absGate);
  let integrated = -Infinity;
  if (above.length) {
    const mean = above.reduce((a, b) => a + b.e, 0) / above.length;
    const relGate = mean * Math.pow(10, -1);
    const kept = above.filter((b) => b.e > relGate);
    const m2 = kept.reduce((a, b) => a + b.e, 0) / Math.max(1, kept.length);
    integrated = loudnessOf(m2);
  }

  // 3 秒短时响度（给 LRA 用）
  const st = [];
  for (let s = 0; s + 29 < segCount; s += 10) {
    let e = 0;
    for (let i = 0; i < 30; i++) e += segEnergy[s + i];
    st.push(loudnessOf(e / 30));
  }
  st.sort((a, b) => a - b);
  const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : -Infinity);
  const lra = st.length >= 5 ? Math.max(0, pct(st, 0.95) - pct(st, 0.1)) : 0;

  // ---- spectrogram（随机访问 320 列 × 2048 帧）----
  let spectrum = null;
  if (opts.spectrum !== false && frames > SPECTRUM_FFT && fh) {
    const fh2 = await fsp.open(pcm.path || '', 'r').catch(() => null);
    if (fh2) {
      try {
        const cols = SPECTRUM_COLS;
        const rows = SPECTRUM_ROWS;
        const n = SPECTRUM_FFT;
        const out = Buffer.alloc(cols * rows);
        const re = new Float64Array(n);
        const im = new Float64Array(n);
        const win = new Float64Array(n);
        for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
        const nyq = sampleRate / 2;
        const fLo = 30;
        const fHi = Math.min(20000, nyq * 0.98);
        const logLo = Math.log(fLo);
        const logHi = Math.log(fHi);
        const bandEdges = new Int32Array(rows + 1);
        for (let r = 0; r <= rows; r++) {
          const hz = Math.exp(logLo + ((logHi - logLo) * r) / rows);
          bandEdges[r] = Math.min(n / 2 - 1, Math.max(1, Math.round((hz / nyq) * (n / 2))));
        }
        const readBuf = Buffer.allocUnsafe(n * blockAlign);
        for (let col = 0; col < cols; col++) {
          const startFrame = Math.round((col * (frames - n)) / Math.max(1, cols - 1));
          const got = await readAt(fh2, readBuf, 0, n * blockAlign, dataOffset + startFrame * blockAlign);
          const gotFrames = Math.floor(got / blockAlign);
          re.fill(0);
          im.fill(0);
          for (let f = 0; f < n; f++) {
            let v = 0;
            if (f < gotFrames) {
              for (let c = 0; c < Math.min(chCount, channels); c++) v += reader(readBuf, f * channels + c);
              v /= Math.min(chCount, channels);
            }
            re[f] = v * win[f];
          }
          fftInPlace(re, im);
          for (let r = 0; r < rows; r++) {
            const a = bandEdges[r];
            const b = Math.max(a, bandEdges[r + 1] - 1);
            let m = 0;
            for (let k = a; k <= b; k++) {
              const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / (n / 4);
              if (mag > m) m = mag;
            }
            const db = 20 * Math.log10(m + 1e-9);
            const q = Math.max(0, Math.min(255, Math.round(((db + 96) / 96) * 255)));
            // row 0 = 低频，渲染时翻转
            out[col * rows + r] = q;
          }
        }
        spectrum = { cols, rows, data: out };
      } finally {
        await fh2.close().catch(() => {});
      }
    }
  }

  return {
    ok: !failed,
    duration: sampleRate > 0 ? frames / sampleRate : 0,
    channels,
    sampleRate,
    loudness: {
      integrated,
      peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
      lra,
      blocks: blocks.length,
      segments: segCount
    },
    spectrum
  };
}

// ---------------------------------------------------------------------------
// WAV 元数据写回（RIFF LIST/INFO）
// ---------------------------------------------------------------------------
const INFO_IDS = {
  title: 'INAM',
  artist: 'IART',
  genre: 'IGNR',
  comment: 'ICMT',
  keywords: 'IKEY',
  software: 'ISFT',
  date: 'ICRD',
  engineer: 'IENG',
  technician: 'ITCH',
  source: 'ISRC'
};

function buildInfoChunk(fields) {
  const parts = [];
  for (const [key, id] of Object.entries(INFO_IDS)) {
    const raw = fields && fields[key];
    if (raw == null) continue;
    const text = String(raw);
    if (!text) continue;
    // INFO 文本按 Windows-1252 写；中文转成 UTF-8 字节会让别的软件读成乱码，
    // 这里用 Buffer.from(latin1) 兜底，调用方负责给出 ASCII 或转写过的值。
    const body = Buffer.from(text + '\0', 'latin1');
    const head = Buffer.alloc(8);
    head.write(id, 0, 'latin1');
    head.writeUInt32LE(body.length, 4);
    parts.push(head, body);
    if (body.length % 2) parts.push(Buffer.alloc(1));
  }
  if (!parts.length) return null;
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.write('LIST', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('INFO', 8, 'latin1');
  return Buffer.concat([head, body]);
}

async function writeWavInfo(filePath, fields) {
  const info = buildInfoChunk(fields);
  if (!info) return { ok: false, reason: 'no-fields' };

  const fh = await fsp.open(filePath, 'r').catch(() => null);
  if (!fh) return { ok: false, reason: 'open-failed' };
  let chunks = [];
  try {
    const head = Buffer.alloc(12);
    await fh.read(head, 0, 12, 0);
    if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') {
      return { ok: false, reason: 'not-wav' };
    }
    let pos = 12;
    const st = await fh.stat();
    while (pos + 8 <= st.size) {
      const ch = Buffer.alloc(8);
      const n = await fh.read(ch, 0, 8, pos).then((r) => r.bytesRead).catch(() => 0);
      if (n < 8) break;
      const id = ch.toString('latin1', 0, 4);
      const size = ch.readUInt32LE(4);
      chunks.push({ id, size, pos, dataPos: pos + 8 });
      pos += 8 + size + (size % 2);
      if (size > st.size) break;
    }
  } finally {
    await fh.close().catch(() => {});
  }
  if (!chunks.length) return { ok: false, reason: 'no-chunks' };

  const tmp = filePath + '.sb-tmp';
  const out = await fsp.open(tmp, 'w').catch(() => null);
  if (!out) return { ok: false, reason: 'tmp-failed' };
  try {
    const header = Buffer.alloc(12);
    header.write('RIFF', 0, 'latin1');
    header.writeUInt32LE(0, 4);
    header.write('WAVE', 8, 'latin1');
    await out.write(header, 0, 12, 0);
    let written = 12;
    const src = await fsp.open(filePath, 'r');
    const cache = Buffer.allocUnsafe(4 << 20);
    try {
      let inserted = false;
      for (const c of chunks) {
        if (c.id === 'LIST' || c.id === 'id3 ' || c.id === 'ID3 ') {
          // 老的 INFO 丢掉，换新的
          continue;
        }
        const head = Buffer.alloc(8);
        head.write(c.id, 0, 'latin1');
        head.writeUInt32LE(c.size, 4);
        await out.write(head, 0, 8, written);
        written += 8;
        let left = c.size;
        let at = c.dataPos;
        while (left > 0) {
          const want = Math.min(cache.length, left);
          const got = await src.read(cache, 0, want, at);
          if (!got.bytesRead) break;
          await out.write(cache, 0, got.bytesRead, written);
          written += got.bytesRead;
          at += got.bytesRead;
          left -= got.bytesRead;
        }
        if (c.size % 2) {
          await out.write(Buffer.alloc(1), 0, 1, written);
          written += 1;
        }
        if (!inserted && c.id === 'fmt ') {
          await out.write(info, 0, info.length, written);
          written += info.length;
          inserted = true;
        }
      }
      if (!inserted) {
        await out.write(info, 0, info.length, written);
        written += info.length;
      }
    } finally {
      await src.close().catch(() => {});
    }
    const fix = Buffer.alloc(4);
    fix.writeUInt32LE(written - 8, 0);
    await out.write(fix, 0, 4, 4);
    await out.sync().catch(() => {});
  } finally {
    await out.close().catch(() => {});
  }

  const bak = filePath + '.sb-bak';
  try {
    await fsp.rename(filePath, bak);
    await fsp.rename(tmp, filePath);
    await fsp.unlink(bak).catch(() => {});
  } catch (err) {
    await fsp.rename(bak, filePath).catch(() => {});
    await fsp.unlink(tmp).catch(() => {});
    return { ok: false, reason: 'replace-failed' };
  }
  const st = await fsp.stat(filePath).catch(() => null);
  return { ok: true, bytes: st ? st.size : 0, infoBytes: info.length };
}

module.exports = {
  AUDIO_EXTS,
  PEAK_BINS_PER_SECOND,
  isAudioExt,
  isDecodableExt,
  readFloat80,
  inspect,
  computePeaks,
  readWindow,
  readTags,
  extractCover,
  aiffToWav,
  writeWavRegion,
  analyzeDeep,
  writeWavInfo,
  cacheKey
};
