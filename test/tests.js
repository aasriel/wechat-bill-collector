/* 浏览器内测试套件：通过 test/test.html 运行（需经 http 访问才能测 GBK/zip 文件用例） */
(async function () {
  'use strict';
  var C = window.WxBillCore;
  var Z = window.ZipReader;
  var T = window.ZipTestUtils;
  var X = window.XlsxReader;
  var out = [], pass = 0, fail = 0, skip = 0;

  function esc(s) { return String(s).replace(/[&<>]/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]; }); }
  function eq(a, b, msg) { if (a !== b) throw new Error((msg || '') + '：期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a)); }
  function ok(v, msg) { if (!v) throw new Error(msg || '断言失败'); }
  function skipErr(msg) { var e = new Error(msg); e.__skip = true; return e; }

  function t(name, fn) {
    try { fn(); pass++; out.push('<div class="case pass">✓ ' + esc(name) + '</div>'); }
    catch (e) { fail++; out.push('<div class="case fail">✗ ' + esc(name) + ' —— ' + esc(e.message) + '</div>'); }
  }
  async function at(name, fn) {
    try { await fn(); pass++; out.push('<div class="case pass">✓ ' + esc(name) + '</div>'); }
    catch (e) {
      if (e && e.__skip) { skip++; out.push('<div class="case skip">- 跳过：' + esc(name) + '（' + esc(e.message) + '）</div>'); }
      else { fail++; out.push('<div class="case fail">✗ ' + esc(name) + ' —— ' + esc(e.message) + '</div>'); }
    }
  }

  var SAMPLE = [
    '微信支付账单明细',
    '----------------------微信支付账单明细--------------------',
    '起始时间：[2026-07-01 00:00:00]  结束时间：[2026-09-06 23:59:59]',
    '导出类型：[全部]',
    '导出时间：[2026-09-06 20:00:00]',
    '共 9 笔记录',
    '收入：1笔  66.00元',
    '支出：7笔  576.50元',
    '中性交易：1笔  500.00元',
    '备注：以下是微信支付账单明细列表',
    '----------------------微信支付账单明细列表--------------------',
    '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
    '2026-09-06 12:30:15,商户消费,示例-老王家常菜,"晚市套餐,两荤一素",支出,¥128.00,零钱,支付成功,10001202609061230150001,880026090601,/',
    '2026-09-06 13:05:40,商户消费,示例-便利蜂超市,饮料零食,支出,¥15.50,零钱,支付成功,10001202609061305400002,880026090602,/',
    '2026-09-06 15:20:03,商户消费,示例-蜜雪冰城,珍珠奶茶x2,支出,¥13.00,招商银行储蓄卡(8888),支付成功,10001202609061520030003,880026090603,/',
    '2026-09-05 19:10:22,商户消费,示例-海底捞火锅,"含""服务费""的火锅晚餐",支出,¥286.00,零钱,支付成功,10001202609051910220004,880026090504,/',
    '2026-09-05 08:41:10,商户消费,示例-滴滴出行,快车-通勤,支出,¥23.40,零钱,支付成功,10001202609050841100005,880026090505,/',
    '2026-09-04 21:02:56,微信红包,来自示例-张三,微信红包,收入,¥66.00,零钱,已存入零钱,10001202609042102560006,/,/',
    '2026-09-03 12:15:30,商户消费,示例-美团外卖,午餐-黄焖鸡米饭,支出,¥22.60,零钱,支付成功,10001202609031215300007,880026090307,/',
    '2026-09-01 10:00:00,微信红包,发给示例-李四,微信红包,支出,¥88.00,零钱,已领取,10001202609011000000008,/,/',
    '2026-08-31 09:00:00,零钱充值,/,零钱充值,/,¥500.00,招商银行储蓄卡(8888),充值成功,10001202608310900000009,/,/'
  ].join('\n');

  function byTxn(bills, suffix) {
    return bills.filter(function (b) { return b.txnId.slice(-4) === suffix; })[0];
  }

  /* ---- 同步用例：CSV 解析 ---- */
  var parsed = null;
  t('解析标准格式：9 笔、0 跳过、表头在第 12 行', function () {
    parsed = C.parseWeChatBillText(SAMPLE);
    eq(parsed.bills.length, 9, '笔数');
    eq(parsed.skipped.length, 0, '跳过数');
    eq(parsed.headerRow, 12, '表头行号');
  });
  t('字段解析：引号内逗号、金额、方向、时间', function () {
    var b0 = parsed.bills[0];
    eq(b0.counterparty, '示例-老王家常菜', '交易对方');
    eq(b0.product, '晚市套餐,两荤一素', '商品（引号内逗号应保留）');
    eq(b0.amount, 128, '金额');
    eq(b0.dir, 'expense', '方向');
    eq(b0.txnId, '10001202609061230150001', '交易单号');
    eq(b0.dateStr, '2026-09-06', '日期');
    eq(b0.timeStr, '12:30', '时间');
  });
  t('转义引号：商品含双引号', function () {
    var b = byTxn(parsed.bills, '0004');
    eq(b.product, '含"服务费"的火锅晚餐', '商品');
  });
  t('收入与中性交易分类', function () {
    var inc = byTxn(parsed.bills, '0006');
    eq(inc.dir, 'income', '红包收入');
    eq(inc.amount, 66, '红包金额');
    var neutral = byTxn(parsed.bills, '0009');
    eq(neutral.dir, 'neutral', '充值中性');
    eq(neutral.amount, 500, '充值金额');
  });
  t('支出求和 576.50（分单位累加无浮点误差）', function () {
    var expenses = parsed.bills.filter(function (b) { return b.dir === 'expense'; });
    eq(C.sumAmounts(expenses), 576.5, '支出合计');
  });
  t('按交易单号去重', function () {
    var again = C.parseWeChatBillText(SAMPLE).bills;
    var exist = {}, unique = [];
    again.concat(parsed.bills).forEach(function (b) {
      if (exist[b.txnId]) return;
      exist[b.txnId] = true; unique.push(b);
    });
    eq(unique.length, 9, '去重后笔数');
  });
  t('buildRemark：多笔明细含日期/时间/来源/金额，合计与人均正确', function () {
    var sel = [byTxn(parsed.bills, '0001'), byTxn(parsed.bills, '0002'), byTxn(parsed.bills, '0003')];
    var tpl = '{日期} {笔数}笔消费 合计¥{合计}\n{明细}\n人均¥{人均}（{人数}人AA）';
    var r = C.buildRemark(sel, { tpl: tpl, people: 2 });
    ok(r.indexOf('2026-09-06 3笔消费 合计¥156.50') === 0, '首行汇总');
    ok(r.indexOf('2026-09-06 12:30 示例-老王家常菜 ¥128.00') >= 0, '明细行1');
    ok(r.indexOf('2026-09-06 13:05 示例-便利蜂超市 ¥15.50') >= 0, '明细行2');
    ok(r.indexOf('2026-09-06 15:20 示例-蜜雪冰城 ¥13.00') >= 0, '明细行3');
    ok(r.indexOf('人均¥78.25（2人AA）') >= 0, '人均');
  });
  t('buildRemark：跨天日期与单行明细', function () {
    var sel = [byTxn(parsed.bills, '0001'), byTxn(parsed.bills, '0004')];
    var r = C.buildRemark(sel, { tpl: '{日期} {笔数}笔 合计¥{合计} {明细单行}', people: 3 });
    ok(r.indexOf('09-05至09-06') === 0, '跨天日期范围（按时间升序）');
    ok(r.indexOf(' ＋ ') >= 0, '单行明细连接符');
  });
  t('buildDetailMessage：群明细带标题与合计（不含人均）', function () {
    var sel = [byTxn(parsed.bills, '0001'), byTxn(parsed.bills, '0002')];
    var m = C.buildDetailMessage(sel, { people: 2 });
    ok(m.indexOf('【收款明细】2026-09-06') === 0, '标题');
    ok(m.indexOf('合计 ¥143.50（2笔）') >= 0, '合计行');
    eq(m.indexOf('人均'), -1, '明细消息不应含人均');
  });
  t('GBK 解码：微信真实导出的编码', function () {
    var bytes = new Uint8Array([206, 162, 208, 197, 214, 167, 184, 182, 213, 203, 181, 165, 195, 247, 207, 184]);
    var dec = C.decodeBytes(bytes);
    eq(dec.encoding, 'gbk', '编码探测');
    ok(dec.text.indexOf('微信支付账单明细') === 0, '解码内容');
  });
  t('容错：无表头的文本应报错', function () {
    var threw = false;
    try { C.parseWeChatBillText('姓名,电话\n张三,123'); } catch (e) { threw = true; }
    ok(threw, '应抛出未找到表头错误');
  });
  t('容错：坏行进入 skipped，不影响其他行', function () {
    var bad = SAMPLE + '\n坏行,没有金额\n2026-09-07 10:00:00,商户消费,示例-新店,商品,支出,¥9.90,零钱,支付成功,10001202609071000000010,880026090710,/';
    var out2 = C.parseWeChatBillText(bad);
    eq(out2.bills.length, 10, '有效行');
    eq(out2.skipped.length, 1, '坏行跳过');
    eq(out2.skipped[0].reason.indexOf('交易时间无法解析') >= 0 ? 1 : 0, 1, '坏行原因');
  });

  /* ---- 异步用例：真实 GBK 文件 ---- */
  async function fetchSampleBytes() {
    try {
      var r = await fetch('../sample/wechat-bill-sample-gbk.csv');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      throw skipErr('无法读取示例文件，请经 http://localhost:8432 访问本页');
    }
  }

  await at('真实 GBK 示例文件端到端解析', async function () {
    var bytes = await fetchSampleBytes();
    var res = C.parseWeChatBill(bytes);
    eq(res.bills.length, 9, '笔数');
    eq(res.encoding, 'gbk', '编码');
    eq(C.sumAmounts(res.bills.filter(function (b) { return b.dir === 'expense'; })), 576.5, '支出合计');
  });

  /* ---- 异步用例：ZIP（含 ZipCrypto） ---- */
  await at('zip：store（不压缩）无密码', async function () {
    var data = new TextEncoder().encode('hello 微信账单,测试');
    var zip = await T.buildZip([{ name: 'a.csv', data: data, store: true }], {});
    var res = await Z.readZip(zip);
    eq(res.entries.length, 1, '条目数');
    eq(res.entries[0].name, 'a.csv', '文件名');
    eq(new TextDecoder().decode(res.entries[0].data), 'hello 微信账单,测试', '内容');
  });
  await at('zip：deflate 压缩（原生 DecompressionStream）', async function () {
    var data = new Uint8Array(2048);
    for (var i = 0; i < data.length; i++) data[i] = i % 251;
    var zip = await T.buildZip([{ name: 'big.bin', data: data }], {});
    var res = await Z.readZip(zip);
    eq(res.entries[0].method, 8, '压缩方式');
    eq(res.entries[0].data.length, 2048, '解压长度');
    eq(res.entries[0].data[100], (100 % 251), '抽查字节');
    eq(res.entries[0].data[2047], (2047 % 251), '抽查字节');
  });
  await at('zip：ZipCrypto 密码正确/错误/缺失', async function () {
    var data = new TextEncoder().encode('secret-账单数据');
    var zip = await T.buildZip([{ name: 'x.csv', data: data }], { password: 'abc123' });
    var res = await Z.readZip(zip, 'abc123');
    eq(new TextDecoder().decode(res.entries[0].data), 'secret-账单数据', '正确密码解密');

    var wrong = null;
    try { await Z.readZip(zip, '000000'); } catch (e) { wrong = e; }
    ok(wrong && wrong.code === 'bad-password', '错误密码应报 bad-password，实际 ' + (wrong && wrong.code));

    var missing = null;
    try { await Z.readZip(zip); } catch (e) { missing = e; }
    ok(missing && missing.needPassword === true, '缺密码应提示 needPassword');
  });
  await at('zip：校验字节为「时间高位」的写法也能解', async function () {
    var data = new TextEncoder().encode('time-check-账单');
    var zip = await T.buildZip([{ name: 't.csv', data: data, checkTime: true }], { password: '9' });
    var res = await Z.readZip(zip, '9');
    eq(new TextDecoder().decode(res.entries[0].data), 'time-check-账单', '内容');
  });
  await at('端到端：真实 GBK 账单 CSV → 加密 zip → 解压 → 解析出 9 笔', async function () {
    var bytes = await fetchSampleBytes();
    var zip = await T.buildZip([{ name: '微信支付账单(2026.07.01-2026.09.06).csv', data: bytes }], { password: '88888888' });
    var res = await Z.readZip(zip, '88888888');
    eq(res.entries.length, 1, 'zip 条目数');
    var bills = C.parseWeChatBill(res.entries[0].data);
    eq(bills.encoding, 'gbk', '编码');
    eq(bills.bills.length, 9, '笔数');
    eq(bills.bills[0].counterparty, '示例-老王家常菜', '交易对方');
  });
  await at('zip：非 zip 文件应报 not-zip', async function () {
    var e = null;
    try { await Z.readZip(new TextEncoder().encode('交易时间,金额\nx,y')); } catch (err) { e = err; }
    ok(e && e.code === 'not-zip', '应报 not-zip，实际 ' + (e && e.code));
  });

  /* ---- 异步用例：XLSX（微信电脑版导出的 Excel 形态） ---- */
  function buildWeChatXlsx() {
    var ss = ['交易时间', '交易类型', '交易对方', '商品', '收/支', '金额(元)', '支付方式', '当前状态', '交易单号',
      '商户消费', '示例-老王家常菜', '晚市套餐,两荤一素', '支出', '零钱', '支付成功', '2026-09-05 19:10:22', '示例-便利蜂超市', '饮料零食',
      '10001202609061230150001', '10001202609061305400002'];
    var escXml = function (s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
    var sst = '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' + ss.length + '">' +
      ss.map(function (s) { return '<si><t>' + escXml(s) + '</t></si>'; }).join('') + '</sst>';
    var styles = '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts>' +
      '<cellXfs count="2"><xf numFmtId="0" xfId="0"/><xf numFmtId="164" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>';
    var wb = '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>';
    var rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
    var serial = Date.UTC(2026, 8, 6, 12, 30, 15) / 86400000 + 25569;
    var c = function (ref, style, tIdx) { return '<c r="' + ref + '" t="s"><v>' + tIdx + '</v></c>'; };
    var sheet = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="1">' + c('A1', 0, 0) + c('B1', 0, 1) + c('C1', 0, 2) + c('D1', 0, 3) + c('E1', 0, 4) + c('F1', 0, 5) + c('G1', 0, 6) + c('H1', 0, 7) + c('I1', 0, 8) + '</row>' +
      '<row r="2"><c r="A2" s="1"><v>' + serial + '</v></c>' + c('B2', 0, 9) + c('C2', 0, 10) + c('D2', 0, 11) + c('E2', 0, 12) + '<c r="F2"><v>128</v></c>' + c('G2', 0, 13) + c('H2', 0, 14) + c('I2', 0, 18) + '</row>' +
      '<row r="3">' + c('A3', 0, 15) + c('B3', 0, 9) + c('C3', 0, 16) + c('D3', 0, 17) + c('E3', 0, 12) + '<c r="F3"><v>15.5</v></c>' + c('G3', 0, 13) + c('H3', 0, 14) + c('I3', 0, 19) + '</row>' +
      '</sheetData></worksheet>';
    return T.buildZip([
      { name: 'xl/workbook.xml', data: new TextEncoder().encode(wb) },
      { name: 'xl/_rels/workbook.xml.rels', data: new TextEncoder().encode(rels) },
      { name: 'xl/styles.xml', data: new TextEncoder().encode(styles) },
      { name: 'xl/sharedStrings.xml', data: new TextEncoder().encode(sst) },
      { name: 'xl/worksheets/sheet1.xml', data: new TextEncoder().encode(sheet) }
    ], {});
  }

  await at('xlsx：Excel 串行日期转换精确', function () {
    var serial = Date.UTC(2026, 8, 6, 12, 30, 15) / 86400000 + 25569;
    eq(X.serialToString(serial), '2026-09-06 12:30:15', '串行转日期');
  });
  await at('xlsx：整表解析（共享字符串/含逗号商品/串行+文本日期）', async function () {
    var zipBytes = await buildWeChatXlsx();
    var parsed2 = X.readXlsxEntries((await Z.readZip(zipBytes)).entries);
    eq(parsed2.rows.length, 3, '行数（含表头）');
    var bills = C.billsFromRows(parsed2.rows);
    eq(bills.bills.length, 2, '账单数');
    var b0 = bills.bills[0];
    eq(b0.dateStr, '2026-09-06', '串行日期');
    eq(b0.timeStr, '12:30', '时间');
    eq(b0.counterparty, '示例-老王家常菜', '交易对方');
    eq(b0.product, '晚市套餐,两荤一素', '商品（含逗号）');
    eq(b0.amount, 128, '金额');
    eq(b0.txnId, '10001202609061230150001', '交易单号');
    var b1 = bills.bills[1];
    eq(b1.dateStr, '2026-09-05', '文本日期');
    eq(b1.timeStr, '19:10', '文本时间');
    eq(b1.amount, 15.5, '金额');
  });

  /* ---- 同步用例：银行账单列映射解析 ---- */
  t('银行列映射：双金额列 + 双时间列 + 紧凑日期 + 稳定去重ID', function () {
    var rows = [
      ['中国银行交易流水（示例）'],
      ['储蓄卡账户 6217****1234'],
      ['账户', '交易日期', '交易时间', '摘要', '支出金额', '收入金额', '余额'],
      ['储蓄卡', '20260906', '123015', '转出-餐饮', '128.00', '', '5000.00'],
      ['储蓄卡', '20260906', '130504', '工资入账', '', '8000.00', '13000.00'],
      ['储蓄卡', '20260906', '130504', '工资入账', '', '8000.00', '21000.00']
    ];
    eq(C.guessHeaderRow(rows), 2, '猜表头应跳过标题行');
    var m = {
      headerRow: 2, dirMode: 'col',
      cols: { time: '1', time2: '2', amount: '4', amount2: '5', dir: '', who: '3', what: '', note: '', id: '' }
    };
    var out = C.billsFromMappedRows(rows, m);
    eq(out.bills.length, 3, '账单数');
    var b0 = out.bills[0];
    eq(b0.dateStr, '2026-09-06', '紧凑日期');
    eq(b0.timeStr, '12:30', '时间第二列拼接');
    eq(b0.dir, 'expense', '双金额列：支出');
    eq(b0.amount, 128, '支出金额');
    eq(b0.counterparty, '转出-餐饮', '摘要');
    var b1 = out.bills[1];
    eq(b1.dir, 'income', '双金额列：收入');
    eq(b1.amount, 8000, '收入金额');
    eq(b1.timeStr, '13:05', '时间');
    ok(b1.txnId.indexOf('bank-') === 0, '无单号时生成稳定ID');
    eq(out.bills[2].txnId, b1.txnId, '相同内容两行ID一致（可去重）');
  });
  t('银行列映射：三种方向判定模式', function () {
    var rows = [
      ['交易时间', '金额', '摘要'],
      ['2026-09-06 12:00', '50', '超市'],
      ['2026-09-06 13:00', '-30', '退款']
    ];
    var cols = { time: '0', amount: '1', amount2: '', dir: '', who: '2', what: '', note: '', id: '' };
    // plus-income：正数=收入，负数=支出
    var o1 = C.billsFromMappedRows(rows, { headerRow: 0, dirMode: 'plus-income', cols: cols });
    eq(o1.bills[0].dir, 'income', 'plus-income：正数=收入');
    eq(o1.bills[0].amount, 50, '金额取绝对值');
    eq(o1.bills[1].dir, 'expense', 'plus-income：负数=支出');
    eq(o1.bills[1].amount, 30, '金额取绝对值');
    // plus-expense：正数=支出，负数=收入
    var o2 = C.billsFromMappedRows(rows, { headerRow: 0, dirMode: 'plus-expense', cols: cols });
    eq(o2.bills[0].dir, 'expense', 'plus-expense：正数=支出');
    eq(o2.bills[1].dir, 'income', 'plus-expense：负数=收入');
    // expense-all：全部算支出
    var o3 = C.billsFromMappedRows(rows, { headerRow: 0, dirMode: 'expense-all', cols: cols });
    o3.bills.forEach(function (b) { eq(b.dir, 'expense', '全部算支出'); });
  });
  t('银行列映射：方向列文字识别（收/贷/借/支）与单列紧凑日期', function () {
    var rows = [
      ['交易时间', '借贷标志', '金额', '对方'],
      ['20260906123015', '贷', '100', '张三'],
      ['20260906133015', '借', '40', '李四']
    ];
    var out = C.billsFromMappedRows(rows, {
      headerRow: 0, dirMode: 'col',
      cols: { time: '0', time2: '', amount: '2', amount2: '', dir: '1', who: '3', what: '', note: '', id: '' }
    });
    eq(out.bills[0].dir, 'income', '贷=收入');
    eq(out.bills[0].timeStr, '12:30', '14位紧凑日期含时间');
    eq(out.bills[1].dir, 'expense', '借=支出');
  });

  /* ---- 汇总 ---- */
  var total = pass + fail + skip;
  document.getElementById('summary').textContent =
    '通过 ' + pass + ' / 失败 ' + fail + ' / 跳过 ' + skip + (fail ? '　← 有失败用例！' : '　全部通过');
  document.getElementById('summary').style.color = fail ? '#c62828' : '#0a8f3c';
  document.getElementById('out').innerHTML = out.join('');
  document.title = (fail ? 'FAIL' : 'PASS') + ' ' + pass + '/' + total;
})();
