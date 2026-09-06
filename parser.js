/*
 * 微信账单核心逻辑（纯前端、零依赖、无网络请求）
 *   1) decodeBytes     —— 编码探测解码（UTF-8 BOM / UTF-16 / 严格 UTF-8 / GBK 回退）
 *   2) parseWeChatBill —— 解析「微信支付」导出的账单明细 CSV（zip 解压后的 csv）
 *   3) buildRemark     —— 依据所选账单与模板，生成群收款备注 / 明细文案
 * 浏览器与测试页共用；全部为纯函数。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WxBillCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- 编码探测 ---------------- */
  function decodeBytes(buf) {
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    // UTF-8 BOM
    if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
      return { text: new TextDecoder('utf-8').decode(u8.subarray(3)), encoding: 'utf-8' };
    }
    // UTF-16 LE BOM（个别表格软件另存导致）
    if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) {
      return { text: new TextDecoder('utf-16le').decode(u8.subarray(2)), encoding: 'utf-16le' };
    }
    // 严格 UTF-8 失败 → 按 GBK 解（微信账单 zip 内 CSV 常为 GBK/ANSI）
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(u8), encoding: 'utf-8' };
    } catch (e) {
      try { return { text: new TextDecoder('gbk').decode(u8), encoding: 'gbk' }; }
      catch (e2) { return { text: new TextDecoder('utf-8').decode(u8), encoding: 'utf-8' }; }
    }
  }

  /* ---------------- CSV（RFC4180：支持引号内逗号/换行/双写转义） ---------------- */
  function parseCSV(text) {
    var rows = [], row = [], field = '', inQ = false, i, c;
    for (i = 0; i < text.length; i++) {
      c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQ = false;
        } else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  var FIELD_ALIASES = {
    datetime:     ['交易时间'],
    kind:         ['交易类型'],
    counterparty: ['交易对方'],
    product:      ['商品'],
    direction:    ['收/支', '收支'],
    amount:       ['金额(元)', '金额（元）', '金额'],
    payMethod:    ['支付方式'],
    status:       ['当前状态'],
    txnId:        ['交易单号'],
    mchId:        ['商户单号'],
    note:         ['备注']
  };

  function locateHeader(rows) {
    for (var i = 0; i < rows.length; i++) {
      var cells = rows[i].map(function (s) { return (s || '').trim(); });
      var hasDate = cells.indexOf('交易时间') >= 0;
      var hasAmt = cells.some(function (c) { return c.indexOf('金额') === 0; });
      if (hasDate && hasAmt) return i;
    }
    return -1;
  }

  function parseAmount(s) {
    if (s == null) return null;
    var t = String(s).replace(/[¥￥\s,，]/g, '');
    if (!t || t === '/') return null;
    var n = Number(t);
    return isFinite(n) ? Math.round(n * 100) / 100 : null;
  }

  var RE_DT = /^(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/;
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function parseDateTime(s) {
    var m = RE_DT.exec((s || '').trim());
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3], h = +(m[4] || 0), mi = +(m[5] || 0), sec = +(m[6] || 0);
    var date = new Date(y, mo - 1, d, h, mi, sec);
    if (isNaN(date.getTime()) || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
    return {
      ts: date.getTime(),
      dateStr: y + '-' + pad2(mo) + '-' + pad2(d),
      timeStr: pad2(h) + ':' + pad2(mi),
      datetime: y + '-' + pad2(mo) + '-' + pad2(d) + ' ' + pad2(h) + ':' + pad2(mi) + ':' + pad2(sec)
    };
  }

  function classifyDirection(raw) {
    var t = (raw || '').trim();
    if (t === '收入') return { dir: 'income', label: '收入' };
    if (t === '支出') return { dir: 'expense', label: '支出' };
    return { dir: 'neutral', label: '中性' };
  }

  /* 从「二维字符串数组」构建账单（CSV 与 XLSX 两条导入路径共用） */
  function billsFromRows(rowsIn) {
    // 稀疏行补齐，避免 map/loc 遇到空洞
    var rows = rowsIn.map(function (r) {
      return Array.isArray(r) ? r.map(function (c) { return c == null ? '' : c; }) : [];
    });
    var hi = locateHeader(rows);
    if (hi < 0) throw new Error('未找到表头行（需要包含“交易时间”和“金额”）。请导入微信支付导出的账单明细。');
    var header = rows[hi].map(function (s) { return (s || '').trim(); });
    var col = {};
    Object.keys(FIELD_ALIASES).forEach(function (key) {
      for (var i = 0; i < header.length; i++) {
        if (FIELD_ALIASES[key].indexOf(header[i]) >= 0) { col[key] = i; return; }
      }
    });
    if (col.datetime == null || col.amount == null) {
      throw new Error('账单表头缺少“交易时间 / 金额(元)”列，导出格式可能已变更。');
    }

    var bills = [], skipped = [];
    for (var r = hi + 1; r < rows.length; r++) {
      var cells = rows[r];
      if (!cells || cells.every(function (c) { return !c || !c.trim(); })) continue;
      var get = function (key) {
        var i2 = col[key];
        return i2 == null ? '' : (cells[i2] == null ? '' : cells[i2].trim());
      };
      var dt = parseDateTime(get('datetime'));
      if (!dt) { skipped.push({ row: r + 1, reason: '交易时间无法解析：' + get('datetime') }); continue; }
      var amount = parseAmount(get('amount'));
      if (amount == null) { skipped.push({ row: r + 1, reason: '金额无法解析：' + get('amount') }); continue; }
      var dirInfo = classifyDirection(get('direction'));
      var txnId = get('txnId') || ('local-' + dt.ts + '-' + amount + '-' + get('counterparty') + '-' + r);
      bills.push({
        txnId: txnId,
        ts: dt.ts, dateStr: dt.dateStr, timeStr: dt.timeStr, datetime: dt.datetime,
        kind: get('kind'), counterparty: get('counterparty'), product: get('product'),
        dir: dirInfo.dir, dirLabel: dirInfo.label,
        amount: amount, payMethod: get('payMethod'), status: get('status'),
        mchId: get('mchId'), note: get('note'), source: 'wechat'
      });
    }
    return { bills: bills, skipped: skipped, headerRow: hi + 1 };
  }

  /* 解析账单 CSV 文本 */
  function parseWeChatBillText(text) {
    return billsFromRows(parseCSV(text));
  }

  function parseWeChatBill(buffer) {
    var dec = decodeBytes(buffer);
    var out = parseWeChatBillText(dec.text);
    out.encoding = dec.encoding;
    return out;
  }

  /* ---------------- 金额工具（以「分」累加，避免浮点误差） ---------------- */
  function toFen(yuan) { return Math.round(yuan * 100); }
  function toYuan(fen) { return fen / 100; }
  function sumAmounts(bills) {
    return toYuan(bills.reduce(function (a, b) { return a + toFen(b.amount); }, 0));
  }

  /* ---------------- 群收款文案生成 ---------------- */
  function detailLine(b) {
    var src = b.counterparty || b.product || b.kind || '消费';
    return b.dateStr + ' ' + b.timeStr + ' ' + src + ' ¥' + b.amount.toFixed(2);
  }

  /*
   * bills: 已选账单（内部自动按时间升序）
   * opts : { tpl, people }
   * 可用占位符：{笔数} {合计} {人均} {人数} {日期} {时间段} {来源} {明细} {明细单行}
   */
  function buildRemark(bills, opts) {
    if (!bills || !bills.length) return '';
    opts = opts || {};
    var list = bills.slice().sort(function (a, b) { return a.ts - b.ts; });
    var n = list.length;
    var total = sumAmounts(list);
    var people = Math.max(1, parseInt(opts.people, 10) || 1);
    var per = toYuan(Math.round(toFen(total) / people));

    var first = list[0], last = list[n - 1];
    var sameDay = first.dateStr === last.dateStr;
    var dateStr = sameDay ? first.dateStr : (first.dateStr.slice(5) + '至' + last.dateStr.slice(5));
    var range = sameDay ? (first.timeStr + (n > 1 ? '~' + last.timeStr : '')) : '';
    var source = n === 1
      ? (first.counterparty || first.product || '消费')
      : ((first.counterparty || '消费') + '等' + n + '笔');

    var ctx = {
      '笔数': String(n),
      '合计': total.toFixed(2),
      '人均': per.toFixed(2),
      '人数': String(people),
      '日期': dateStr,
      '时间段': range,
      '来源': source,
      '明细': list.map(detailLine).join('\n'),
      '明细单行': list.map(detailLine).join(' ＋ ')
    };
    var tpl = opts.tpl || '{日期} {笔数}笔消费 合计¥{合计}';
    return tpl.replace(/\{([^{}]+)\}/g, function (m, k) {
      return Object.prototype.hasOwnProperty.call(ctx, k) ? ctx[k] : m;
    });
  }

  /* 群里发布的完整明细消息（多行、带标题与合计） */
  function buildDetailMessage(bills, opts) {
    if (!bills || !bills.length) return '';
    opts = opts || {};
    var list = bills.slice().sort(function (a, b) { return a.ts - b.ts; });
    var n = list.length;
    var total = sumAmounts(list);
    var people = Math.max(1, parseInt(opts.people, 10) || 1);
    var per = toYuan(Math.round(toFen(total) / people));
    var head = '【收款明细】' + list[0].dateStr + (n > 1 ? ' ~ ' + last(list).dateStr : '');
    return head + '\n' + list.map(detailLine).join('\n') +
      '\n合计 ¥' + total.toFixed(2) + '（' + n + '笔）· 人均 ¥' + per.toFixed(2) + '（' + people + '人）';

    function last(a) { return a[a.length - 1]; }
  }

  return {
    decodeBytes: decodeBytes,
    parseCSV: parseCSV,
    parseWeChatBillText: parseWeChatBillText,
    parseWeChatBill: parseWeChatBill,
    billsFromRows: billsFromRows,
    sumAmounts: sumAmounts,
    buildRemark: buildRemark,
    buildDetailMessage: buildDetailMessage,
    detailLine: detailLine
  };
});
