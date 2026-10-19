/**
 * png.js — minimal dependency-free PNG encoder (8-bit RGBA, filter 0).
 * Used to encode captured window bitmaps without pulling sharp into the plugin.
 */
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crcBuf]);
}

/**
 * Encode raw RGBA pixels as a PNG.
 * @param {Buffer} rgba - width*height*4 bytes, top-down, RGBA.
 * @param {number} width
 * @param {number} height
 * @returns {Buffer} PNG bytes.
 */
export function encodePng(rgba, width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Convert a top-down BGRA buffer to RGBA in place-ish (returns new buffer). */
export function bgraToRgba(src, out) {
  const dst = out ?? Buffer.allocUnsafe(src.length);
  for (let i = 0; i < src.length; i += 4) {
    dst[i] = src[i + 2];
    dst[i + 1] = src[i + 1];
    dst[i + 2] = src[i];
    dst[i + 3] = src[i + 3];
  }
  return dst;
}
