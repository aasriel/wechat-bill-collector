/*
 * 测试专用：按 ZIP 规范反向构建压缩包（独立于 unzip.js 的实现，用于交叉验证）。
 * 暴露 window.ZipTestUtils = { buildZip, crc32 }
 *  - buildZip(entries, { password, store }) -> Promise<Uint8Array>
 *    entries: [{ name, data:Uint8Array, store?:bool }]
 *    默认 deflate-raw 压缩（走浏览器原生 CompressionStream）；store:true 不压缩。
 */
(function (root) {
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

  /* 独立实现的 PKWARE 传统加密（加密方向） */
  function ZipCryptoEnc(passwordBytes) {
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
        var cipher = data[j] ^ (((temp * (temp ^ 1)) >>> 8) & 0xFF);
        upd(data[j]);
        out[j] = cipher;
      }
      return out;
    };
  }

  function concat(parts) {
    var len = 0;
    parts.forEach(function (p) { len += p.length; });
    var out = new Uint8Array(len), o = 0;
    parts.forEach(function (p) { out.set(p, o); o += p.length; });
    return out;
  }

  function w16(arr, v) { arr.push(v & 0xFF, (v >>> 8) & 0xFF); }
  function w32(arr, v) { arr.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF); }
  function bytesOf(arr) { return new Uint8Array(arr); }

  function deflateRaw(u8) {
    var cs = new CompressionStream('deflate-raw');
    var stream = new Blob([u8]).stream().pipeThrough(cs);
    return new Response(stream).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }

  function buildZip(entries, opts) {
    opts = opts || {};
    var pw = opts.password != null ? new TextEncoder().encode(String(opts.password)) : null;
    var now = new Date();
    var dosTime = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | ((now.getSeconds() >> 1) & 31);
    var dosDate = (((now.getFullYear() - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);

    var pending = entries.map(function (e) {
      var crc = crc32(e.data);
      var method = 0;
      var body = Promise.resolve(e.data);
      if (!e.store) { method = 8; body = deflateRaw(e.data); }
      return body.then(function (comp) {
        var flags = 0;
        var stored = comp;
        if (pw) {
          flags |= 1;
          var zc = new ZipCryptoEnc(pw);
          var hdr = new Uint8Array(12);
          if (root.crypto && crypto.getRandomValues) crypto.getRandomValues(hdr);
          // 校验字节：一半用 CRC 高位，一半用时间高位，覆盖两种业界写法
          hdr[11] = e.checkTime ? ((dosTime >>> 8) & 0xFF) : ((crc >>> 24) & 0xFF);
          stored = concat([zc.stream(hdr), zc.stream(comp)]);
        }
        return { name: e.name, crc: crc, method: method, flags: flags, comp: stored, raw: e.data };
      });
    });

    return Promise.all(pending).then(function (items) {
      var parts = [], central = [], offset = 0;
      items.forEach(function (it) {
        var nameB = new TextEncoder().encode(it.name);
        var lfh = [];
        w32(lfh, 0x04034b50); w16(lfh, 20); w16(lfh, it.flags); w16(lfh, it.method);
        w16(lfh, dosTime); w16(lfh, dosDate);
        w32(lfh, it.crc); w32(lfh, it.comp.length); w32(lfh, it.raw.length);
        w16(lfh, nameB.length); w16(lfh, 0);
        var lfhB = bytesOf(lfh);
        parts.push(lfhB, nameB, it.comp);

        var cdr = [];
        w32(cdr, 0x02014b50); w16(cdr, 20); w16(cdr, 20); w16(cdr, it.flags); w16(cdr, it.method);
        w16(cdr, dosTime); w16(cdr, dosDate);
        w32(cdr, it.crc); w32(cdr, it.comp.length); w32(cdr, it.raw.length);
        w16(cdr, nameB.length); w16(cdr, 0); w16(cdr, 0); w16(cdr, 0); w16(cdr, 0);
        w32(cdr, 0); w32(cdr, offset);
        central.push(bytesOf(cdr), nameB);

        offset += lfhB.length + nameB.length + it.comp.length;
      });

      var cdSize = central.reduce(function (a, b) { return a + b.length; }, 0);
      var eocd = [];
      w32(eocd, 0x06054b50); w16(eocd, 0); w16(eocd, 0);
      w16(eocd, items.length); w16(eocd, items.length);
      w32(eocd, cdSize); w32(eocd, offset); w16(eocd, 0);
      parts.push.apply(parts, central);
      parts.push(bytesOf(eocd));
      return concat(parts);
    });
  }

  root.ZipTestUtils = { buildZip: buildZip, crc32: crc32 };
})(typeof self !== 'undefined' ? self : this);
