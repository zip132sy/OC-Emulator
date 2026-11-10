// ============================================================
// lib/zip.js - minimal ZIP read/write (no third-party dependencies)
//
// Write: entries prefer deflate (method 8) and fall back to stored (method 0)
// when compression makes them bigger.
// Read: supports method 0 (stored) and method 8 (deflate), parsing output from
//       PowerShell Compress-Archive / git archive / common archivers.
// ============================================================
'use strict';

const zlib = require('zlib');

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d) {
  const dt = d instanceof Date ? d : new Date();
  const time = ((dt.getHours() & 31) << 11) | ((dt.getMinutes() & 63) << 5) | ((dt.getSeconds() >> 1) & 31);
  const date = (((Math.max(dt.getFullYear(), 1980) - 1980) & 127) << 9) | (((dt.getMonth() + 1) & 15) << 5) | (dt.getDate() & 31);
  return { time, date };
}

// ---------- write ----------
// entries: [{ name: 'a/b.txt', data: Buffer, mtime?: Date }]
// Returns a Buffer holding the zip file.
function zipEntries(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(String(entry.name).replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '');
    const { time, date } = dosDateTime(entry.mtime);
    const crc = crc32(data);

    let method = 0;
    let payload = data;
    if (data.length > 0) {
      const deflated = zlib.deflateRawSync(data, { level: 9 });
      if (deflated.length < data.length) {
        method = 8;
        payload = deflated;
      }
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // UTF-8 filename flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // extra length
    chunks.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);               // version made by
    cd.writeUInt16LE(20, 6);               // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);               // extra
    cd.writeUInt16LE(0, 32);               // comment
    cd.writeUInt16LE(0, 34);               // disk number
    cd.writeUInt16LE(0, 36);               // internal attrs
    cd.writeUInt32LE(nameBuf.length > 0 && entry.name.endsWith('/') ? 0x10 : 0, 38); // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));

    offset += 30 + nameBuf.length + payload.length;
  }

  const cdStart = offset;
  const cdBuf = Buffer.concat(central);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// ---------- read ----------
// Parse a zip Buffer, returning [{ name, data, isDir }]. Encrypted / multi-volume archives unsupported.
function unzipEntries(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf || '');
  if (buf.length < 22) throw new Error('不是有效的 ZIP 文件');

  // Scan backwards from the end for the EOCD (allows a comment of up to 64KB)
  let eocd = -1;
  const scanStart = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= scanStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件 (缺少目录结尾)');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];

  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error('ZIP 目录损坏');
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) {
      throw new Error('ZIP 条目损坏: ' + name);
    }
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) throw new Error('ZIP 条目越界: ' + name);

    const isDir = name.endsWith('/');
    let data = Buffer.alloc(0);
    if (!isDir && compSize > 0) {
      const raw = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) {
        data = Buffer.from(raw);
      } else if (method === 8) {
        data = zlib.inflateRawSync(raw);
      } else {
        throw new Error(`不支持的压缩方式 (${method}): ${name}`);
      }
    }

    out.push({ name, data, isDir });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return out;
}

module.exports = { zipEntries, unzipEntries, crc32 };
