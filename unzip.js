/*
 * 零依赖 ZIP 读取器（只读）。
 * 支持：传统 ZipCrypto 密码加密（微信/支付宝账单 zip 用的标准加密）、
 *       存储(0) 与 deflate(8)（deflate 走浏览器原生 DecompressionStream）。
 * 不支持：AES 加密（标志位 0x40，报友好错误）、Zip64、分卷。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ZipReader = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ u8[i]) & 0xFF];
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* PKWARE 传统加密（标准算法） */
  function ZipCrypto(passwordBytes) {
    var k0 = 0x12345678, k1 = 0x23456789, k2 = 0x34567890;
    function upd(c) {
      k0 = ((k0 >>> 8) ^ CRC_TABLE[(k0 ^ c) & 0xFF]) >>> 0;
      k1 = ((k1 + (k0 & 0xFF)) * 134775813 + 1) >>> 0;
      k2 = ((k2 >>> 8) ^ CRC_TABLE[(k2 ^ ((k1 >>> 24) & 0xFF)) & 0xFF]) >>> 0;
    }
    for (var i = 0; i < passwordBytes.length; i++) upd(passwordBytes[i]);
    this.stream = function (data) {
      var out = new Uint8Array(data.length);
      for (var j = 0; j < data.length; j++) {
        var temp = (k2 | 2) & 0xFFFF;
        var plain = data[j] ^ (((temp * (temp ^ 1)) >>> 8) & 0xFF);
        upd(plain);
        out[j] = plain;
      }
      return out;
    };
  }

  function u16(v, o) { return v[o] | (v[o + 1] << 8); }
  function u32(v, o) { return (v[o] | (v[o + 1] << 8) | (v[o + 2] << 16) | (v[o + 3] << 24)) >>> 0; }

  function decodeName(bytes, utf8Flag) {
    if (utf8Flag) return new TextDecoder('utf-8').decode(bytes);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (e) {
      try { return new TextDecoder('gbk').decode(bytes); }
      catch (e2) { return new TextDecoder('utf-8').decode(bytes); }
    }
  }

  function findEOCD(v) {
    var min = Math.max(0, v.length - 22 - 65535);
    for (var i = v.length - 22; i >= min; i--) {
      if (v[i] === 0x50 && v[i + 1] === 0x4b && v[i + 2] === 0x05 && v[i + 3] === 0x06) return i;
    }
    return -1;
  }

  function inflateRaw(data) {
    if (typeof DecompressionStream === 'undefined') {
      var e = new Error('当前浏览器不支持原生解压（DecompressionStream），请换新版浏览器，或手动解压 zip 后导入其中的 CSV。');
      e.code = 'no-inflate';
      throw e;
    }
    var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }

  function fail(msg, code, needPassword) {
    var e = new Error(msg);
    e.code = code;
    if (needPassword) e.needPassword = true;
    return e;
  }

  /*
   * readZip(u8, password?) -> Promise<{ entries: [{ name, data, encrypted, method, crc32 }] }>
   * password 仅在包内有加密条目时必需。
   */
  function readZip(u8, password) {
    var v = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
    var eocd = findEOCD(v);
    if (eocd < 0) return Promise.reject(fail('不是有效的 zip 文件（或文件已损坏）', 'not-zip'));
    var count = u16(v, eocd + 10);
    if (!count) return Promise.resolve({ entries: [] });
    var p = u32(v, eocd + 16);
    var entries = [];
    for (var i = 0; i < count; i++) {
      if (u32(v, p) !== 0x02014b50) return Promise.reject(fail('zip 目录解析失败（可能是不支持的 Zip64 格式或文件损坏）', 'bad-cd'));
      var flags = u16(v, p + 8);
      var nameLen = u16(v, p + 28), extraLen = u16(v, p + 30), commentLen = u16(v, p + 32);
      entries.push({
        name: decodeName(v.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0),
        encrypted: (flags & 0x1) !== 0,
        aes: (flags & 0x40) !== 0,
        method: u16(v, p + 10),
        crc32: u32(v, p + 16),
        compressedSize: u32(v, p + 20),
        _modTime: u16(v, p + 12),
        _localOff: u32(v, p + 42)
      });
      p += 46 + nameLen + extraLen + commentLen;
    }

    var out = [];
    var chain = Promise.resolve();
    entries.forEach(function (e) {
      chain = chain.then(function () {
        if (e.name.charAt(e.name.length - 1) === '/') return; // 目录
        var lo = e._localOff;
        if (u32(v, lo) !== 0x04034b50) throw fail('zip 本地头校验失败，文件可能已损坏', 'bad-lfh');
        var start = lo + 30 + u16(v, lo + 26) + u16(v, lo + 28);
        var raw = v.subarray(start, start + e.compressedSize);
        var data = raw;

        if (e.encrypted) {
          if (e.aes) throw fail('该压缩包使用了 AES 加密（本工具只支持标准 zip 加密），请手动解压后导入其中的 CSV。', 'aes');
          if (!password) throw fail('该压缩包有密码，请先填写解压密码。', 'need-password', true);
          var zc = new ZipCrypto(new TextEncoder().encode(String(password)));
          var header = zc.stream(raw.subarray(0, 12));
          var check = header[11];
          if (check !== ((e.crc32 >>> 24) & 0xFF) && check !== ((e._modTime >>> 8) & 0xFF)) {
            throw fail('解压密码不正确。', 'bad-password', true);
          }
          data = zc.stream(raw.subarray(12));
        }

        var ready = (e.method === 0) ? Promise.resolve(data)
          : (e.method === 8) ? inflateRaw(data)
          : Promise.reject(fail('不支持的 zip 压缩方式：' + e.method, 'bad-method'));

        return ready.then(function (plain) {
          if (plain.length && crc32(plain) !== e.crc32) {
            if (e.encrypted) throw fail('解压密码不正确（数据校验失败）。', 'bad-password', true);
            throw fail('zip 数据校验失败（CRC 不匹配），文件可能已损坏。', 'bad-crc');
          }
          out.push({ name: e.name, data: plain, encrypted: e.encrypted, method: e.method, crc32: e.crc32 });
        });
      });
    });

    return chain.then(function () { return { entries: out }; });
  }

  return { readZip: readZip, crc32: crc32 };
});
