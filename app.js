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
    filters: { q: '', from: '', to: '', dir: 'all' }
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
      box.innerHTML = '<div class="empty">' +
        (state.bills.length ? '没有符合筛选条件的账单' : '还没有账单：先导入微信账单 CSV，或点上方「载入示例账单」试用') +
        '</div>';
      return;
    }
    var html = [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      var src = b.counterparty || b.product || b.kind || '（无商户信息）';
      var sub = [b.product, b.kind, b.payMethod, b.status].filter(function (x) { return x && x !== '/'; }).join(' · ');
      var amtCls = b.dir === 'income' ? 'income' : (b.dir === 'neutral' ? 'neutral' : 'expense');
      var amtSign = b.dir === 'income' ? '+' : (b.dir === 'neutral' ? '' : '-');
      html.push(
        '<label class="bill" data-id="' + esc(b.txnId) + '">' +
        '<input type="checkbox" ' + (state.selected[b.txnId] ? 'checked' : '') + ' aria-label="选择该笔">' +
        '<span class="b-main"><span class="b-src">' + esc(src) + '</span>' +
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

  function renderAll() { renderList(); updateSelBar(); }

  /* ---------------- 导入 ---------------- */
  function handleFile(file) {
    file.arrayBuffer()
      .then(function (buf) { return handleBytes(buf, file.name); })
      .catch(function (e) { failImport(e && e.message ? e.message : '文件读取失败'); });
  }

  /* 按文件内容自动分流：zip / json 备份 / csv */
  function handleBytes(buf, fileName) {
    var u8 = new Uint8Array(buf);
    if (u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4b) return handleZip(u8, fileName);
    var headText = '';
    try { headText = new TextDecoder('utf-8').decode(u8.subarray(0, 1)).trim(); } catch (e) { /* ignore */ }
    if (headText === '{' || headText === '[') { restoreBackup(u8); return Promise.resolve(); }
    return importCsvBytes(u8, fileName);
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
    });
  }

  function importCsvBytes(bytes, fileName) {
    var out;
    try { out = C.parseWeChatBill(bytes); }
    catch (e) { failImport(e && e.message ? e.message : 'CSV 解析失败'); return Promise.resolve(); }
    return importParsed(out, fileName, out.encoding);
  }

  /* 微信发来的 zip：浏览器内直接解压（ZipCrypto），无需手动解压 */
  function getZipPassword() {
    var fromInput = $('zipPwd').value.trim();
    if (fromInput) return fromInput;
    try { return localStorage.getItem('wxbc_zippwd') || ''; } catch (e) { return ''; }
  }

  function handleZip(u8, fileName) {
    var pwd = getZipPassword();
    return ZipReader.readZip(u8, pwd || undefined).then(function (zip) {
      // xlsx 本质上也是 zip 包，先按内容识别
      var isXlsx = zip.entries.some(function (e) { return /^xl\/workbook\.xml$/i.test(e.name); });
      if (isXlsx) {
        try {
          if ($('zipPwdRemember').checked && pwd) localStorage.setItem('wxbc_zippwd', pwd);
        } catch (e) { /* 忽略 */ }
        var out = C.billsFromRows(XlsxReader.readXlsxEntries(zip.entries).rows);
        return importParsed(out, fileName + '（Excel）', 'xlsx');
      }
      var csvs = zip.entries.filter(function (e) { return /\.csv$/i.test(e.name) && e.data && e.data.length; });
      if (!csvs.length) throw new Error('压缩包里既没有微信账单 CSV，也不是有效的 xlsx');
      var pick = csvs.sort(function (a, b) { return b.data.length - a.data.length; })[0];
      try {
        if ($('zipPwdRemember').checked && pwd) localStorage.setItem('wxbc_zippwd', pwd);
      } catch (e) { /* 忽略 */ }
      return importCsvBytes(pick.data, fileName + ' 中的 ' + pick.name);
    }).catch(function (e) {
      if (e && (e.code === 'need-password' || e.code === 'bad-password')) {
        $('importResult').innerHTML = '<span class="warn">✗ ' + esc(e.message) + ' 解压密码在微信「下载账单」页面会直接展示。</span>';
        $('zipPwd').focus();
        toast(e.code === 'bad-password' ? '密码不对，请检查' : '请填写解压密码');
        return;
      }
      failImport(e && e.message ? e.message : 'zip 解压失败');
    });
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
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) { handleFile(fileInput.files[0]); fileInput.value = ''; }
    });

    $('btnDemo').addEventListener('click', function () {
      addBills(demoBills()).then(function (res) {
        $('importResult').innerHTML = '<span class="ok">✓ 已载入示例账单 ' + res.added + ' 笔（都是假数据，可随时清空）</span>';
        toast('示例账单已载入');
      });
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
    window.__wxbcDebug = { handleBytes: handleBytes };
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
