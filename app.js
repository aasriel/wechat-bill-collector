/* 账单拼收款 —— 页面逻辑。
 * 账单数据只保存在本机浏览器（IndexedDB），不发送任何网络请求。
 */
(function () {
  'use strict';
  var C = window.WxBillCore;
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* ---------------- 存储（IndexedDB；不可用时退化为内存） ---------------- */
  var DB_NAME = 'wxbc', STORE = 'bills';
  var dbOk = true;
  var memory = {};
  var state = {
    bills: [],          // 全部账单，时间倒序
    selected: {},       // txnId -> true
    filters: { q: '', from: '', to: '', dir: 'all', source: 'real' }
  };

  function openDB() {
    return new Promise(function (resolve) {
      try {
        if (!window.indexedDB) { dbOk = false; return resolve(null); }
        var req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function () {
          req.result.createObjectStore(STORE, { keyPath: 'txnId' });
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { dbOk = false; resolve(null); };
      } catch (e) { dbOk = false; resolve(null); }
    });
  }

  function idbGetAll() {
    return openDB().then(function (db) {
      if (!db) return Object.keys(memory).map(function (k) { return memory[k]; });
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, 'readonly');
        var req = t.objectStore(STORE).getAll();
        t.oncomplete = function () { resolve(req.result || []); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }

  function idbPutMany(bills) {
    if (!bills.length) return Promise.resolve();
    return openDB().then(function (db) {
      if (!db) { bills.forEach(function (b) { memory[b.txnId] = b; }); return; }
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, 'readwrite');
        var s = t.objectStore(STORE);
        bills.forEach(function (b) { s.put(b); });
        t.oncomplete = function () { resolve(); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }

  function idbClear() {
    memory = {};
    return openDB().then(function (db) {
      if (!db) return;
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, 'readwrite');
        t.objectStore(STORE).clear();
        t.oncomplete = function () { resolve(); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }

  function idbDeleteMany(ids) {
    if (!ids.length) return Promise.resolve();
    return openDB().then(function (db) {
      if (!db) { ids.forEach(function (id) { delete memory[id]; }); return; }
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, 'readwrite');
        var s = t.objectStore(STORE);
        ids.forEach(function (id) { s.delete(id); });
        t.oncomplete = function () { resolve(); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }

  /* ---------------- Toast ---------------- */
  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  /* ---------------- 复制（含旧浏览器回退） ---------------- */
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
  function copyText(text, okMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { toast(okMsg || '已复制'); },
        function () { toast(legacyCopy(text) ? '已复制' : '复制失败，请手动选择文本'); }
      );
    } else {
      toast(legacyCopy(text) ? '已复制' : '复制失败，请手动选择文本');
    }
  }

  /* ---------------- 数据操作 ---------------- */
  function sortBills() {
    state.bills.sort(function (a, b) { return b.ts - a.ts || (a.txnId < b.txnId ? 1 : -1); });
  }

  /* 合并导入：按 txnId 去重，返回 {added, dup} */
  function addBills(incoming) {
    var exist = {};
    state.bills.forEach(function (b) { exist[b.txnId] = true; });
    var fresh = [];
    var dup = 0;
    incoming.forEach(function (b) {
      if (!b || !b.txnId) return;
      if (exist[b.txnId]) { dup++; return; }
      exist[b.txnId] = true;
      fresh.push(b);
    });
    state.bills = state.bills.concat(fresh);
    sortBills();
    return idbPutMany(fresh).then(function () {
      renderAll();
      return { added: fresh.length, dup: dup };
    });
  }

  function selectedBills() {
    return state.bills.filter(function (b) { return state.selected[b.txnId]; });
  }

  /* ---------------- 筛选与渲染 ---------------- */
  function filteredBills() {
    var f = state.filters;
    var q = f.q.trim().toLowerCase();
    return state.bills.filter(function (b) {
      // 来源开关：真实账单（默认）/ 示例账单 / 全部
      if (f.source === 'real' && b.source === 'demo') return false;
      if (f.source === 'demo' && b.source !== 'demo') return false;
      if (f.dir !== 'all' && b.dir !== f.dir) return false;
      if (f.from && b.dateStr < f.from) return false;
      if (f.to && b.dateStr > f.to) return false;
      if (q) {
        var hay = (b.counterparty + ' ' + b.product + ' ' + b.kind + ' ' + b.note).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }

  function renderList() {
    var list = filteredBills();
    var box = $('billList');
    $('billCount').textContent = '（共 ' + state.bills.length + ' 笔 · 筛选出 ' + list.length + ' 笔）';
    if (!list.length) {
      var demoExists = state.bills.some(function (b) { return b.source === 'demo'; });
      var realExists = state.bills.some(function (b) { return b.source !== 'demo'; });
      var msg;
      if (!state.bills.length) msg = '还没有账单：先导入微信账单 CSV，或点上方「载入示例账单」试用';
      else if (state.filters.source === 'real' && demoExists && !realExists) msg = '真实账单为空——点上方「示例账单」可查看演示数据';
      else if (state.filters.source === 'demo' && !demoExists) msg = '没有示例账单（点上方「载入示例账单」可添加）';
      else msg = '没有符合筛选条件的账单';
      box.innerHTML = '<div class="empty">' + msg + '</div>';
      return;
    }
    var html = [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      var src = b.counterparty || b.product || b.kind || '（无商户信息）';
      var sub = [b.product, b.kind, b.payMethod, b.status].filter(function (x) { return x && x !== '/'; }).join(' · ');
      var amtCls = b.dir === 'income' ? 'income' : (b.dir === 'neutral' ? 'neutral' : 'expense');
      var amtSign = b.dir === 'income' ? '+' : (b.dir === 'neutral' ? '' : '-');
      var tag = b.source === 'demo' ? '<span class="b-tag">示例</span>' : '';
      html.push(
        '<label class="bill" data-id="' + esc(b.txnId) + '">' +
        '<input type="checkbox" ' + (state.selected[b.txnId] ? 'checked' : '') + ' aria-label="选择该笔">' +
        '<span class="b-main"><span class="b-src">' + tag + esc(src) + '</span>' +
        '<span class="b-sub">' + esc(sub) + '</span></span>' +
        '<span class="b-side"><span class="b-amt ' + amtCls + '">' + amtSign + b.amount.toFixed(2) + '</span>' +
        '<span class="b-when">' + esc(b.dateStr.slice(5)) + ' ' + esc(b.timeStr) + '</span></span>' +
        '</label>'
      );
    }
    box.innerHTML = html.join('');
  }

  function updateSelBar() {
    var sel = selectedBills();
    var total = C.sumAmounts(sel);
    $('selCount').textContent = String(sel.length);
    $('selTotal').textContent = '¥' + total.toFixed(2);
    $('btnMake').disabled = !sel.length;
  }

  function updateStorageNote() {
    $('storageNote').textContent = dbOk
      ? '✓ 已启用本机持久化，关闭页面后数据仍在。'
      : '⚠️ 当前环境（如 file:// 部分浏览器）不支持持久化，数据仅本次打开有效。建议通过 http://localhost 或 https 访问。';
  }

  function updateClearDemoBtn() {
    $('btnClearDemo').hidden = !state.bills.some(function (b) { return b.source === 'demo'; });
  }

  function renderAll() { renderList(); updateSelBar(); updateClearDemoBtn(); }

  /* ---------------- 导入 ---------------- */
  function handleFile(file) {
    file.arrayBuffer()
      .then(function (buf) { return handleBytes(buf, file.name); })
      .catch(function (e) { failImport(e && e.message ? e.message : '文件读取失败'); });
  }

  /* 多文件批量：逐个解析（自动去重），识别不了的进入列映射 */
  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList);
    if (!files.length) return;
    if (files.length === 1) { handleFile(files[0]); return; }
    var totals = { added: 0, dup: 0, ok: 0, failed: 0, mapper: 0 }, firstErr = '';
    var chain = Promise.resolve();
    files.forEach(function (file) {
      chain = chain.then(function () {
        return file.arrayBuffer()
          .then(function (buf) { return handleBytes(buf, file.name); })
          .then(function (res) {
            if (res && res.needMapper) { totals.mapper++; return; }
            if (res && typeof res.added === 'number') { totals.added += res.added; totals.dup += res.dup; totals.ok++; }
          })
          .catch(function (e) { totals.failed++; if (!firstErr) firstErr = (e && e.message) || '未知错误'; });
      });
    });
    chain.then(function () {
      $('importResult').innerHTML =
        '<span class="ok">✓ 批量导入 ' + files.length + ' 个文件：新增 ' + totals.added + ' 笔，跳过重复 ' + totals.dup + ' 笔</span>' +
        (totals.mapper ? '<span class="warn">，' + totals.mapper + ' 个待手动列映射</span>' : '') +
        (totals.failed ? '<span class="warn">，' + totals.failed + ' 个失败（' + esc(firstErr) + '）</span>' : '');
      toast('批量导入完成');
    });
  }

  /* 按文件内容自动分流：zip(微信zip / 内含xlsx) / json 备份 / csv 文本 */
  function handleBytes(buf, fileName) {
    var u8 = new Uint8Array(buf);
    if (u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4b) return handleZipBytes(u8, fileName);
    var headText = '';
    try { headText = new TextDecoder('utf-8').decode(u8.subarray(0, 1)).trim(); } catch (e) { /* ignore */ }
    if (headText === '{' || headText === '[') { restoreBackup(u8); return Promise.resolve(); }
    return handleCsvBytes(u8, fileName);
  }

  function importParsed(out, label, encoding) {
    return addBills(out.bills).then(function (res) {
      var extra = out.skipped.length
        ? '<span class="warn">，另有 ' + out.skipped.length + ' 行无法解析</span>'
        : '';
      $('importResult').innerHTML =
        '<span class="ok">✓ 从 ' + esc(label) + ' 导入：新增 ' + res.added + ' 笔，跳过重复 ' + res.dup + ' 笔</span>' +
        (encoding ? '（' + esc(encoding) + '）' : '') + extra;
      toast(res.added > 0 ? '已导入 ' + res.added + ' 笔账单' : '账单均与已有记录重复');
      return res;
    });
  }

  /* CSV/文本：微信格式 → 直接导入；否则进入列映射（银行等） */
  function handleCsvBytes(bytes, fileName) {
    var dec = C.decodeBytes(bytes);
    var rows = C.parseCSV(dec.text);
    var out;
    try { out = C.billsFromRows(rows); }
    catch (e) { openMapper(rows, fileName, dec.encoding); return Promise.resolve({ needMapper: true }); }
    return importParsed(out, fileName, dec.encoding);
  }

  /* 微信发来的 zip：浏览器内直接解压（ZipCrypto），无需手动解压 */
  function getZipPassword() {
    var fromInput = $('zipPwd').value.trim();
    if (fromInput) return fromInput;
    try { return localStorage.getItem('wxbc_zippwd') || ''; } catch (e) { return ''; }
  }

  function rememberZipPwd(pwd) {
    try { if ($('zipPwdRemember').checked && pwd) localStorage.setItem('wxbc_zippwd', pwd); } catch (e) { /* 忽略 */ }
  }

  function handleZipBytes(u8, fileName) {
    var pwd = getZipPassword();
    return ZipReader.readZip(u8, pwd || undefined).then(function (zip) {
      // xlsx 本质上也是 zip 包：整个文件是 xlsx，或压缩包里嵌着 xlsx（中国银行等银行导出的形态）
      var isXlsx = zip.entries.some(function (e) { return /^xl\/workbook\.xml$/i.test(e.name); });
      if (isXlsx) { rememberZipPwd(pwd); return handleXlsxEntries(zip.entries, fileName); }
      var xl = zip.entries.filter(function (e) { return /\.xlsx$/i.test(e.name) && e.data && e.data.length; })
        .sort(function (a, b) { return b.data.length - a.data.length; })[0];
      if (xl) {
        rememberZipPwd(pwd);
        return ZipReader.readZip(xl.data).then(function (inner) { return handleXlsxEntries(inner.entries, fileName + ' 中的 ' + xl.name); });
      }
      var csvs = zip.entries.filter(function (e) { return /\.csv$/i.test(e.name) && e.data && e.data.length; });
      if (!csvs.length) throw new Error('压缩包里没有找到账单 CSV / Excel 文件，也不是有效的 xlsx');
      var pick = csvs.sort(function (a, b) { return b.data.length - a.data.length; })[0];
      rememberZipPwd(pwd);
      return handleCsvBytes(pick.data, fileName + ' 中的 ' + pick.name);
    }).catch(function (e) {
      if (e && (e.code === 'need-password' || e.code === 'bad-password')) {
        $('importResult').innerHTML = '<span class="warn">✗ ' + esc(e.message) + ' 解压密码在导出页面（或银行 App 的导出历史）里查看。</span>';
        $('zipPwd').focus();
        toast(e.code === 'bad-password' ? '密码不对，请检查' : '请填写解压密码');
        return;
      }
      failImport(e && e.message ? e.message : 'zip 解压失败');
    });
  }

  function handleXlsxEntries(entries, fileName) {
    var parsed2;
    try { parsed2 = XlsxReader.readXlsxEntries(entries); }
    catch (e) { failImport(e && e.message ? e.message : 'xlsx 解析失败'); return Promise.resolve(); }
    var out;
    try { out = C.billsFromRows(parsed2.rows); }
    catch (e) { openMapper(parsed2.rows, fileName, 'xlsx'); return Promise.resolve({ needMapper: true }); }
    return importParsed(out, fileName, 'xlsx');
  }

  function restoreBackup(u8) {
    try {
      var text = C.decodeBytes(u8).text;
      var data = JSON.parse(text);
      var bills = (data && data.bills) || [];
      if (!Array.isArray(bills) || !bills.length) throw new Error('备份文件中没有账单数据');
      addBills(bills).then(function (res) {
        $('importResult').innerHTML = '<span class="ok">✓ 从备份恢复 ' + res.added + ' 笔，跳过重复 ' + res.dup + ' 笔</span>';
        toast('备份已恢复');
      });
    } catch (e) {
      failImport('备份文件解析失败：' + e.message);
    }
  }

  function failImport(msg) {
    $('importResult').innerHTML = '<span class="warn">✗ ' + esc(msg) + '</span>';
    toast('导入失败');
  }

  /* ---------------- 示例数据 ---------------- */
  function demoBills() {
    var now = new Date();
    function t(daysAgo, h, m) { return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, h, m, 0); }
    function mk(i, d, kind, cp, prod, dir, amount) {
      return {
        txnId: 'demo-' + i, ts: d.getTime(),
        dateStr: d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()),
        timeStr: pad2(d.getHours()) + ':' + pad2(d.getMinutes()),
        datetime: d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':00',
        kind: kind, counterparty: cp, product: prod,
        dir: dir, dirLabel: dir === 'income' ? '收入' : (dir === 'neutral' ? '中性' : '支出'),
        amount: amount, payMethod: '零钱', status: '支付成功', mchId: '', note: '示例数据', source: 'demo'
      };
    }
    return [
      mk(0, t(0, 12, 30), '商户消费', '示例-老王家常菜', '晚市套餐', 'expense', 128),
      mk(1, t(0, 13, 5), '商户消费', '示例-便利蜂超市', '饮料零食', 'expense', 15.5),
      mk(2, t(0, 15, 20), '商户消费', '示例-蜜雪冰城', '珍珠奶茶x2', 'expense', 13),
      mk(3, t(1, 19, 10), '商户消费', '示例-海底捞火锅', '火锅晚餐', 'expense', 286),
      mk(4, t(1, 8, 41), '商户消费', '示例-滴滴出行', '快车通勤', 'expense', 23.4),
      mk(5, t(3, 12, 15), '商户消费', '示例-美团外卖', '午餐黄焖鸡', 'expense', 22.6),
      mk(6, t(4, 21, 2), '微信红包', '来自示例-张三', '微信红包', 'income', 66)
    ];
  }

  /* ---------------- 群收款弹层 ---------------- */
  var TPL_DETAIL = '{日期} {笔数}笔消费 合计¥{合计}\n{明细}';
  var TPL_ONELINE = '{日期} {笔数}笔消费 合计¥{合计}';
  // 旧版默认模板（含人均），用于把老用户记住的模板自动升级
  var OLD_TPL_DETAIL = '{日期} {笔数}笔消费 合计¥{合计}\n{明细}\n人均¥{人均}（{人数}人AA）';
  var OLD_TPL_ONELINE = '{日期} {笔数}笔消费 合计¥{合计}（人均¥{人均}，{人数}人）';

  function currentTplText() { return $('mkTplText').value; }
  function currentPeople() { return Math.max(1, parseInt($('mkPeople').value, 10) || 1); }

  function updatePreview() {
    var sel = selectedBills();
    var total = C.sumAmounts(sel);
    var remark = C.buildRemark(sel, { tpl: currentTplText(), people: currentPeople() });
    $('mkPreview').textContent = remark || '（未选择账单）';
    $('mkPreview').dataset.remark = remark;
    $('mkPreview').dataset.total = total.toFixed(2);
    try {
      localStorage.setItem('wxbc_tpl_text', currentTplText());
      localStorage.setItem('wxbc_tpl_sel', $('mkTpl').value);
      localStorage.setItem('wxbc_people', String(currentPeople()));
    } catch (e) { /* 忽略 */ }
  }

  function openModal() {
    var sel = selectedBills();
    if (!sel.length) return;
    var asc = sel.slice().sort(function (a, b) { return a.ts - b.ts; });
    var total = C.sumAmounts(sel);
    $('mkList').innerHTML = asc.map(function (b) {
      return '<div><span>' + esc(b.dateStr.slice(5) + ' ' + b.timeStr + ' ' + (b.counterparty || b.product || b.kind)) +
        '</span><span>¥' + b.amount.toFixed(2) + '</span></div>';
    }).join('') + '<div style="border-top:1px solid var(--line);margin-top:4px;padding-top:4px;font-weight:700">' +
      '<span>合计（' + sel.length + ' 笔）</span><span>¥' + total.toFixed(2) + '</span></div>';

    var savedTpl = null, savedSel = 'detail', savedPeople = 2;
    try {
      savedTpl = localStorage.getItem('wxbc_tpl_text');
      savedSel = localStorage.getItem('wxbc_tpl_sel') || 'detail';
      savedPeople = parseInt(localStorage.getItem('wxbc_people'), 10) || 2;
    } catch (e) { /* 忽略 */ }
    // 旧默认模板自动升级为去人均的新默认
    if (savedTpl === OLD_TPL_DETAIL) { savedTpl = TPL_DETAIL; savedSel = 'detail'; }
    if (savedTpl === OLD_TPL_ONELINE) { savedTpl = TPL_ONELINE; savedSel = 'oneline'; }
    $('mkTpl').value = savedTpl ? savedSel : 'detail';
    $('mkTplText').value = savedTpl || TPL_DETAIL;
    $('mkPeople').value = String(savedPeople);
    updatePreview();
    $('overlay').classList.add('show');
  }

  function closeModal() { $('overlay').classList.remove('show'); }

  /* ---------------- 银行 / 其他账单：列映射导入 ---------------- */
  var BANK_TPL_KEY = 'wxbc_bank_tpls';
  var MAPPER_SELECTS = ['colTime', 'colTime2', 'colAmount', 'colAmount2', 'colDir', 'colWho', 'colWhat', 'colNote', 'colId'];
  var mapperCtx = null;

  function loadBankTpls() {
    try { return JSON.parse(localStorage.getItem(BANK_TPL_KEY) || '[]') || []; }
    catch (e) { return []; }
  }
  function saveBankTpls(list) {
    try { localStorage.setItem(BANK_TPL_KEY, JSON.stringify(list)); } catch (e) { /* 忽略 */ }
  }

  function fillColSelects(header) {
    var opts = ['<option value="">（不使用）</option>'];
    header.forEach(function (h, i) {
      opts.push('<option value="' + i + '">' + esc(h || ('第' + (i + 1) + '列')) + '</option>');
    });
    MAPPER_SELECTS.forEach(function (id) { $(id).innerHTML = opts.join(''); });
  }
  function setColByRe(id, header, re) {
    var el = $(id);
    for (var i = 0; i < header.length; i++) {
      if (header[i] && re.test(header[i])) { el.value = String(i); return; }
    }
  }
  function readMapperMapping() {
    return {
      headerRow: Math.max(1, parseInt($('mapperHeaderRow').value, 10) || 1) - 1,
      dirMode: $('dirMode').value,
      cols: {
        time: $('colTime').value, time2: $('colTime2').value, amount: $('colAmount').value, amount2: $('colAmount2').value,
        dir: $('colDir').value, who: $('colWho').value, what: $('colWhat').value,
        note: $('colNote').value, id: $('colId').value
      }
    };
  }
  function updateMapperPreview() {
    if (!mapperCtx) return;
    try {
      var out = C.billsFromMappedRows(mapperCtx.rows, readMapperMapping());
      var lines = out.bills.slice(0, 3).map(function (b) {
        return b.dateStr + ' ' + b.timeStr + ' ' + (b.counterparty || b.product || '（无对方信息）') + ' ' +
          (b.dir === 'income' ? '+' : b.dir === 'neutral' ? '' : '−') + b.amount.toFixed(2);
      });
      $('mapperPreview').textContent =
        '共识别 ' + out.bills.length + ' 笔，预览前 ' + Math.min(3, out.bills.length) + ' 笔：\n' + lines.join('\n') +
        (out.skipped.length ? '\n（另有 ' + out.skipped.length + ' 行无法解析将跳过）' : '');
      $('mapperPreview').dataset.ok = out.bills.length ? '1' : '';
    } catch (e) {
      $('mapperPreview').textContent = '× ' + e.message;
      $('mapperPreview').dataset.ok = '';
    }
  }
  function applyBankTpl(t) {
    $('mapperHeaderRow').value = String(t.headerRow + 1);
    Object.keys(t.cols).forEach(function (k) {
      var el = $('col' + k.charAt(0).toUpperCase() + k.slice(1));
      if (el) el.value = t.cols[k];
    });
    $('dirMode').value = t.dirMode;
    $('mapperSaveTpl').checked = true;
    $('mapperTplName').value = t.name;
    updateMapperPreview();
  }
  function refreshMapperTplSelect(selectedName) {
    var tpls = loadBankTpls();
    $('mapperTpl').innerHTML = '<option value="">不使用（手动映射）</option>' +
      tpls.map(function (t, i) { return '<option value="' + i + '">' + esc(t.name) + '</option>'; }).join('');
    if (selectedName) {
      tpls.forEach(function (t, i) { if (t.name === selectedName) $('mapperTpl').value = String(i); });
    }
  }
  function openMapper(rows, fileName, encoding) {
    mapperCtx = { rows: rows, fileName: fileName || '', encoding: encoding || '' };
    var headerRow = C.guessHeaderRow(rows);
    $('mapperHeaderRow').value = String(headerRow + 1);
    var header = rows[headerRow] || [];
    fillColSelects(header);
    setColByRe('colTime', header, /日期|时间/);
    setColByRe('colTime2', header, /时间/);
    if ($('colTime2').value === $('colTime').value) $('colTime2').value = '';
    setColByRe('colAmount', header, /支出金额|金额|发生额/);
    setColByRe('colAmount2', header, /收入金额/);
    setColByRe('colDir', header, /收支|借贷|方向|标志/);
    setColByRe('colWho', header, /对方|摘要|商户|名称/);
    setColByRe('colWhat', header, /商品|用途|附言|备注/);
    setColByRe('colNote', header, /备注|附言/);
    setColByRe('colId', header, /单号|流水号|凭证/);
    refreshMapperTplSelect();
    var tpls = loadBankTpls();
    var headerKey = header.join('\u0001');
    var matched = null;
    tpls.forEach(function (t) { if (!matched && t.headerKey === headerKey) matched = t; });
    if (matched) {
      $('mapperTpl').value = String(tpls.indexOf(matched));
      applyBankTpl(matched);
    } else {
      $('dirMode').value = ($('colDir').value !== '') ? 'col' : 'plus-expense';
      $('mapperSaveTpl').checked = true;
      $('mapperTplName').value = (fileName || '').replace(/\.[^.]+$/, '') || '我的银行模板';
      updateMapperPreview();
    }
    $('mapperOverlay').classList.add('show');
  }
  function closeMapper() { $('mapperOverlay').classList.remove('show'); mapperCtx = null; }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    var drop = $('dropZone'), fileInput = $('fileInput');
    drop.addEventListener('click', function () { fileInput.click(); });
    drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
    ['dragover', 'dragenter'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('on'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('on'); });
    });
    drop.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files.length) { handleFiles(fileInput.files); fileInput.value = ''; }
    });

    $('btnDemo').addEventListener('click', function () {
      addBills(demoBills()).then(function (res) {
        $('importResult').innerHTML = '<span class="ok">✓ 已载入示例账单 ' + res.added + ' 笔（都是假数据，可随时清空）</span>';
        toast('示例账单已载入');
      });
    });

    // 来源开关（真实/示例/全部）
    $('srcSeg').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-src]');
      if (!btn) return;
      state.filters.source = btn.dataset.src;
      Array.prototype.forEach.call($('srcSeg').children, function (b) {
        var on = b === btn;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      // 已选账单若不属于当前来源，自动移出选择，保持底部合计一致
      var visible = {};
      filteredBills().forEach(function (b) { visible[b.txnId] = true; });
      var pruned = 0;
      Object.keys(state.selected).forEach(function (id) {
        if (!visible[id]) { delete state.selected[id]; pruned++; }
      });
      renderAll();
      if (pruned) toast('已从选择中移除 ' + pruned + ' 笔（不属于当前来源）');
    });
    $('btnClearDemo').addEventListener('click', function () {
      var demoIds = state.bills.filter(function (b) { return b.source === 'demo'; }).map(function (b) { return b.txnId; });
      if (!demoIds.length) return;
      if (!confirm('确定删除全部 ' + demoIds.length + ' 笔示例账单？真实账单不受影响。')) return;
      var removed = {};
      demoIds.forEach(function (id) { removed[id] = true; delete state.selected[id]; });
      state.bills = state.bills.filter(function (b) { return !removed[b.txnId]; });
      idbDeleteMany(demoIds).then(function () { renderAll(); toast('示例账单已删除'); });
    });

    // 筛选
    var qT = null;
    $('q').addEventListener('input', function () {
      clearTimeout(qT);
      qT = setTimeout(function () { state.filters.q = $('q').value; renderList(); }, 150);
    });
    $('from').addEventListener('change', function () { state.filters.from = $('from').value; renderList(); });
    $('to').addEventListener('change', function () { state.filters.to = $('to').value; renderList(); });
    $('dirSeg').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-dir]');
      if (!btn) return;
      state.filters.dir = btn.dataset.dir;
      Array.prototype.forEach.call($('dirSeg').children, function (b) {
        var on = b === btn;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      renderList();
    });
    $('btnResetFilter').addEventListener('click', function () {
      state.filters = { q: '', from: '', to: '', dir: 'all' };
      $('q').value = ''; $('from').value = ''; $('to').value = '';
      Array.prototype.forEach.call($('dirSeg').children, function (b) {
        b.classList.toggle('on', b.dataset.dir === 'all');
        b.setAttribute('aria-pressed', b.dataset.dir === 'all' ? 'true' : 'false');
      });
      renderList();
    });

    // 选择
    $('billList').addEventListener('change', function (e) {
      var row = e.target.closest('.bill');
      if (!row) return;
      var id = row.dataset.id;
      if (e.target.checked) state.selected[id] = true;
      else delete state.selected[id];
      updateSelBar();
    });
    $('btnSelectFiltered').addEventListener('click', function () {
      filteredBills().forEach(function (b) { state.selected[b.txnId] = true; });
      renderList(); updateSelBar();
    });
    $('btnInvertSel').addEventListener('click', function () {
      filteredBills().forEach(function (b) {
        if (state.selected[b.txnId]) delete state.selected[b.txnId];
        else state.selected[b.txnId] = true;
      });
      renderList(); updateSelBar();
    });
    $('btnClearSel').addEventListener('click', function () {
      state.selected = {};
      renderList(); updateSelBar();
    });

    // 弹层
    $('btnMake').addEventListener('click', openModal);
    $('btnCloseModal').addEventListener('click', closeModal);
    $('overlay').addEventListener('click', function (e) { if (e.target === $('overlay')) closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
    $('mkPeople').addEventListener('input', updatePreview);
    $('mkTpl').addEventListener('change', function () {
      var v = $('mkTpl').value;
      if (v === 'detail') $('mkTplText').value = TPL_DETAIL;
      if (v === 'oneline') $('mkTplText').value = TPL_ONELINE;
      updatePreview();
    });
    $('mkTplText').addEventListener('input', function () {
      // 手动改动后标记为自定义，避免下次切换覆盖
      var t = $('mkTplText').value;
      if (t !== TPL_DETAIL && t !== TPL_ONELINE) $('mkTpl').value = 'custom';
      updatePreview();
    });
    $('btnCopyRemark').addEventListener('click', function () {
      var r = $('mkPreview').dataset.remark || '';
      if (!r) return toast('请先选择账单');
      copyText(r, '收款备注已复制，去微信粘贴吧');
    });
    $('btnCopyDetail').addEventListener('click', function () {
      var msg = C.buildDetailMessage(selectedBills(), { people: currentPeople() });
      copyText(msg, '群明细已复制，发到群里即可');
    });
    $('btnCopyTotal').addEventListener('click', function () {
      copyText($('mkPreview').dataset.total || '0.00', '总金额已复制');
    });
    $('btnCopyAll').addEventListener('click', function () {
      var r = $('mkPreview').dataset.remark || '';
      if (!r) return toast('请先选择账单');
      copyText('总金额：¥' + ($('mkPreview').dataset.total || '0.00') + '\n备注：\n' + r, '金额与备注已复制');
    });

    // 列映射导入
    ['mapperHeaderRow', 'colTime', 'colAmount', 'colAmount2', 'colDir', 'colWho', 'colWhat', 'colNote', 'colId', 'dirMode'].forEach(function (id) {
      $(id).addEventListener('change', updateMapperPreview);
      if (id === 'mapperHeaderRow') $(id).addEventListener('input', updateMapperPreview);
    });
    $('mapperTpl').addEventListener('change', function () {
      var idx = $('mapperTpl').value;
      if (idx === '') { updateMapperPreview(); return; }
      var t = loadBankTpls()[+idx];
      if (t) applyBankTpl(t);
    });
    $('btnMapperImport').addEventListener('click', function () {
      if (!mapperCtx) return;
      var m = readMapperMapping();
      if (m.cols.time === '') return toast('请选择“交易时间”对应的列');
      if (m.cols.amount === '') return toast('请选择“金额”对应的列');
      var out;
      try { out = C.billsFromMappedRows(mapperCtx.rows, m); }
      catch (e) { return toast(e.message); }
      if (!out.bills.length) return toast('没有解析出账单，请检查列映射与表头行');
      if ($('mapperSaveTpl').checked) {
        var name = ($('mapperTplName').value || mapperCtx.fileName || '银行模板').trim();
        var header = mapperCtx.rows[m.headerRow] || [];
        var tpls = loadBankTpls().filter(function (t) { return t.name !== name; });
        tpls.push({ name: name, headerKey: header.join('\u0001'), headerRow: m.headerRow, dirMode: m.dirMode, cols: m.cols });
        saveBankTpls(tpls);
      }
      var label = mapperCtx.fileName || '银行账单';
      addBills(out.bills).then(function (res) {
        $('importResult').innerHTML =
          '<span class="ok">✓ 从 ' + esc(label) + ' 导入：新增 ' + res.added + ' 笔，跳过重复 ' + res.dup + ' 笔</span>' +
          (out.skipped.length ? '<span class="warn">，另有 ' + out.skipped.length + ' 行无法解析</span>' : '') +
          ($('mapperSaveTpl').checked ? '（模板：' + esc($('mapperTplName').value) + '）' : '');
        toast('已导入 ' + res.added + ' 笔');
      });
      closeMapper();
    });
    $('btnMapperCancel').addEventListener('click', closeMapper);
    $('btnCloseMapper').addEventListener('click', closeMapper);

    // 数据管理
    $('btnExport').addEventListener('click', function () {
      var data = { app: 'wxbc', version: 1, exportedAt: new Date().toISOString(), bills: state.bills };
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'wxbc-backup-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.json';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      toast('备份已导出');
    });
    $('btnClear').addEventListener('click', function () {
      if (!confirm('确定清空全部账单数据？此操作不可恢复（建议先导出备份）。')) return;
      idbClear().then(function () {
        state.bills = []; state.selected = {};
        $('importResult').innerHTML = '';
        renderAll();
        toast('已清空');
      });
    });
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    bind();
    // 回填记住的 zip 解压密码（仅存本机）
    try {
      var savedPwd = localStorage.getItem('wxbc_zippwd');
      if (savedPwd) { $('zipPwd').value = savedPwd; $('zipPwdRemember').checked = true; }
    } catch (e) { /* 忽略 */ }
    // 供自动化测试使用的内部入口（不参与正常流程）
    window.__wxbcDebug = { handleBytes: handleBytes, handleFiles: handleFiles };
    idbGetAll().then(function (rows) {
      state.bills = rows || [];
      sortBills();
      renderAll();
      updateStorageNote();
      if (dbOk && 'serviceWorker' in navigator &&
        (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
        navigator.serviceWorker.register('sw.js').catch(function () { /* 忽略 */ });
      }
    }).catch(function () {
      renderAll();
      updateStorageNote();
    });
  }

  init();
})();
