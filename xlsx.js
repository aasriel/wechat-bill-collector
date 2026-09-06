/*
 * 零依赖 XLSX 读取器（基于 ZipReader 解包 + 轻量 XML 提取）。
 * 支持：sharedStrings / inlineStr / 数值 / Excel 串行日期（内置及自定义日期格式）。
 * 输出：rows = 二维字符串数组（与 CSV 解析后的形态一致，日期已转为 YYYY-MM-DD HH:mm:ss）。
 * 不支持：公式重算（直接取缓存值）、多表合并（只取第一个工作表）、加密 xlsx（极罕见）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root.ZipReader || require('./unzip.js'));
  else root.XlsxReader = factory(root.ZipReader);
})(typeof self !== 'undefined' ? self : this, function (ZipReader) {
  'use strict';

  function decodeText(u8) { return new TextDecoder('utf-8').decode(u8); }

  function xmlDecode(s) {
    return String(s).replace(/&(amp|lt|gt|quot|apos|#x[0-9A-Fa-f]+|#\d+);/g, function (m, g) {
      if (g === 'amp') return '&';
      if (g === 'lt') return '<';
      if (g === 'gt') return '>';
      if (g === 'quot') return '"';
      if (g === 'apos') return "'";
      if (g.charAt(1) === 'x' || g.charAt(1) === 'X') return String.fromCharCode(parseInt(g.slice(1), 16));
      return String.fromCharCode(parseInt(g.slice(1), 10));
    });
  }

  function attr(tag, name) {
    var m = new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(tag);
    return m ? xmlDecode(m[1]) : null;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* Excel 串行日期（1900 体系）→ 'YYYY-MM-DD HH:mm:ss'（UTC 计算，避免时区漂移） */
  function serialToString(n) {
    var ms = Math.round((n - 25569) * 86400000);
    var d = new Date(ms);
    if (isNaN(d.getTime())) return String(n);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) +
      ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
  }

  var BUILTIN_DATE_FMT = (function () {
    var s = {};
    [14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47].forEach(function (i) { s[i] = true; });
    for (var i = 27; i <= 36; i++) s[i] = true;
    for (var j = 50; j <= 58; j++) s[j] = true;
    return s;
  })();

  function isDateFormat(numFmtId, customFmt) {
    if (BUILTIN_DATE_FMT[numFmtId]) return true;
    if (customFmt) {
      var stripped = customFmt.replace(/\[[^\]]*\]|"[^"]*"|\\./g, '');
      return /[dmyhs]/i.test(stripped);
    }
    return false;
  }

  function colIndex(ref) {
    var m = /^[A-Za-z]+/.exec(ref || '');
    if (!m) return null;
    var s = m[0].toUpperCase(), n = 0;
    for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
    return n - 1;
  }

  /* ---------- XML 片段提取 ---------- */
  function parseSharedStrings(xml) {
    var out = [];
    var re = /<si\b[^>]*>([\s\S]*?)<\/si>/g, m;
    while ((m = re.exec(xml))) {
      var text = '', tre = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, tm;
      while ((tm = tre.exec(m[1]))) text += xmlDecode(tm[1]);
      out.push(text);
    }
    return out;
  }

  function parseStyleDates(xml) {
    var custom = {};
    var nre = /<numFmt\b([^>]*)\/?>/g, m;
    while ((m = nre.exec(xml))) {
      var id = parseInt(attr(m[1], 'numFmtId'), 10);
      if (!isNaN(id)) custom[id] = attr(m[1], 'formatCode');
    }
    var flags = [];
    var xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
    if (xfs) {
      var xre = /<xf\b([^>]*)>/g, xm;
      while ((xm = xre.exec(xfs[1]))) {
        var fid = parseInt(attr(xm[1], 'numFmtId'), 10);
        flags.push(isDateFormat(isNaN(fid) ? 0 : fid, custom[isNaN(fid) ? -1 : fid]));
      }
    }
    return flags;
  }

  function firstSheetPath(workbookXml, relsXml) {
    var sheetTag = /<sheet\b[^>]*>/.exec(workbookXml);
    if (!sheetTag) throw new Error('xlsx 中没有工作表');
    var rid = attr(sheetTag[0], 'r:id') || attr(sheetTag[0], 'id');
    var re = /<Relationship\b[^>]*>/g, m;
    while ((m = re.exec(relsXml))) {
      if (attr(m[0], 'Id') === rid) {
        var target = attr(m[0], 'Target');
        if (!target) break;
        target = target.replace(/^\//, '');
        if (target.indexOf('xl/') === 0) return target;
        return 'xl/' + target;
      }
    }
    throw new Error('xlsx 工作表关系解析失败');
  }

  function parseSheetRows(xml, shared, styleDates) {
    var rows = [];
    var rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g, rm;
    while ((rm = rowRe.exec(xml))) {
      var rowTag = rm[1], inner = rm[2];
      var rowNum = parseInt(attr(rowTag, 'r'), 10);
      if (isNaN(rowNum)) rowNum = rows.length + 1;
      while (rows.length < rowNum - 1) rows.push([]);
      var cells = [];
      var cellRe = /<c\b([^>]*?)>([\s\S]*?)<\/c>/g, cm;
      var fallbackIdx = 0;
      while ((cm = cellRe.exec(inner))) {
        var cTag = cm[1], cInner = cm[2];
        var idx = colIndex(attr(cTag, 'r'));
        if (idx == null) { idx = fallbackIdx; }
        fallbackIdx = idx + 1;
        var t = attr(cTag, 't') || 'n';
        var sIdx = parseInt(attr(cTag, 's'), 10);
        var value;
        if (t === 'inlineStr') {
          value = '';
          var tre = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, tm;
          while ((tm = tre.exec(cInner))) value += xmlDecode(tm[1]);
        } else {
          var vm = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(cInner);
          var raw = vm ? xmlDecode(vm[1]) : '';
          if (t === 's') value = shared[parseInt(raw, 10)] != null ? shared[parseInt(raw, 10)] : '';
          else if (t === 'b') value = (raw === '1') ? 'TRUE' : 'FALSE';
          else {
            var isDate = !isNaN(sIdx) && styleDates[sIdx];
            var num = parseFloat(raw);
            if (isDate && raw !== '' && !isNaN(num)) value = serialToString(num);
            else value = raw;
          }
        }
        cells[idx] = value;
      }
      rows[rowNum - 1] = cells;
    }
    return rows;
  }

  /* zipEntries 来自 ZipReader.readZip() 的 { name, data } 列表 */
  function readXlsxEntries(zipEntries) {
    var byName = {};
    zipEntries.forEach(function (e) { byName[e.name.replace(/^\//, '')] = e.data; });
    var wbData = byName['xl/workbook.xml'];
    if (!wbData) throw new Error('不是有效的 xlsx 文件（缺少 xl/workbook.xml）');
    var relsData = byName['xl/_rels/workbook.xml.rels'];
    var sharedXml = byName['xl/sharedStrings.xml'] ? decodeText(byName['xl/sharedStrings.xml']) : '';
    var stylesXml = byName['xl/styles.xml'] ? decodeText(byName['xl/styles.xml']) : '';

    var shared = parseSharedStrings(sharedXml);
    var styleDates = parseStyleDates(stylesXml);
    var sheetPath = firstSheetPath(decodeText(wbData), relsData ? decodeText(relsData) : '');
    var sheetData = byName[sheetPath];
    if (!sheetData) throw new Error('xlsx 中找不到工作表：' + sheetPath);
    var rows = parseSheetRows(decodeText(sheetData), shared, styleDates);
    return { rows: rows, sheet: sheetPath };
  }

  function readXlsx(buffer, password) {
    return ZipReader.readZip(buffer, password).then(function (zip) {
      return readXlsxEntries(zip.entries);
    });
  }

  return { readXlsx: readXlsx, readXlsxEntries: readXlsxEntries, serialToString: serialToString, xmlDecode: xmlDecode };
});
