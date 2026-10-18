'use strict';
/* ============================ 12. 图层列表 UI ============================ */

function renderLayerList() {
  syncLegendFold();
  var box = document.getElementById('layerList');
  if (!layers.length) {
    box.innerHTML = '<div class="empty">还没有加载数据</div>';
    return;
  }
  var html = '';
  for (var i = 0; i < layers.length; i++) {
    var L = layers[i];
    var tag = L.kind === 'grid' ? '<span class="tag grid">栅格</span>'
      : L.kind === 'site' ? '<span class="tag site">工参</span>'
        : '<span class="tag site">未识别</span>';
    var meta = L.ok
      ? L.ds.n.toLocaleString() + ' 行 · ' + L.ds.columns.length + ' 列'
      : (L.error || '无法解析');
    html += '<div class="layer' + (selected === L ? ' sel' : '') + '" data-id="' + L.id + '">' +
      '<div class="lt">' +
      '<input type="checkbox" ' + (L.visible ? 'checked' : '') + ' data-act="vis">' +
      '<span class="nm" data-act="sel" title="' + esc(L.name) + '">' + esc(shortName(L.name)) + '</span>' +
      tag +
      '</div>' +
      '<div class="meta">' + esc(meta) + '</div>' +
      '<div class="ops">' +
      '<button data-act="fit" class="icobtn" title="缩放到范围"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5"/><path d="M15 4h5v5"/><path d="M20 15v5h-5"/><path d="M9 20H4v-5"/></svg></button>' +
      '<button data-act="del" class="icobtn" title="移除"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 14h10l1-14"/></svg></button>' +
      '</div></div>';
  }
  box.innerHTML = html;

  Array.prototype.forEach.call(box.querySelectorAll('.layer'), function (el) {
    var id = el.getAttribute('data-id');
    var L = null;
    for (var j = 0; j < layers.length; j++) if (layers[j].id === id) L = layers[j];
    if (!L) return;
    el.querySelector('[data-act="vis"]').onchange = function (e) {
      L.visible = e.target.checked; scheduleDraw(); saveViewState();
    };
    el.querySelector('[data-act="sel"]').onclick = function () { selectLayer(L); };
    el.querySelector('[data-act="del"]').onclick = function () { removeLayer(L); };
    el.querySelector('[data-act="fit"]').onclick = function () { fitLayer(L); };
  });
}

function shortName(n) {
  return String(n).replace(/\.(csv|txt|tsv|json|geojson|xlsx|xls)$/i, '');
}

/* 把视图适配到一个墨卡托包围盒（fitLayer 主体，供顶部地市缩放复用）。
   heavy=数据量大时跳过动画（动画每帧都重绘会卡） */
function fitToBox(b, duration, heavy) {
  if (!b) return;
  var d = (duration === undefined) ? 350 : duration;
  if (d > 0 && heavy) d = 0;
  if (d > 0) {
    map.getView().fit(b, { padding: [60, 60, 60, 60], maxZoom: 17, duration: d });
    return;
  }
  /* OL 的 fit(duration:0) 不生效，这里改为直接定位 */
  var size = map.getSize();
  var v = map.getView();
  if (!size || !size[0]) { v.fit(b, { padding: [60, 60, 60, 60], maxZoom: 17 }); return; }
  var pad = 60;
  var w = Math.max(1, size[0] - pad * 2);
  var h = Math.max(1, size[1] - pad * 2);
  var res = Math.max((b[2] - b[0]) / w, (b[3] - b[1]) / h);
  /* 分辨率越小越放大：maxZoom 限制最密，minZoom 限制最疏 */
  res = Math.max(res, v.getResolutionForZoom(17));
  res = Math.min(res, v.getResolutionForZoom(1));
  v.setCenter([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]);
  v.setResolution(res);
}

function fitLayer(L, duration) {
  fitToBox(layerBox(L), duration, L.ds && L.ds.n > SITE_FAST_LIMIT);
}

/* 地市缩放：适配所有栅格图层（地市筛选后桶里只剩该地市的点）的合并包围盒。
   全疆（'*'）时桶=全部点，即回到整体范围。duration 可注入（自动化测试传 0）。 */
function fitCitySelection(duration) {
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  var heavy = false, any = false;
  for (var i = 0; i < layers.length; i++) {
    var L = layers[i];
    if (!L.visible || !L.ok || L.kind !== 'grid' || !L.buckets || !L.mx) continue;
    any = true;
    if (L.ds && L.ds.n > SITE_FAST_LIMIT) heavy = true;
    for (var b = 0; b < L.bandCount; b++) {
      var idx = L.buckets[b];
      for (var k = 0; k < idx.length; k++) {
        var x = L.mx[idx[k]], y = L.my[idx[k]];
        if (!isFinite(x) || !isFinite(y)) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!any || minX > maxX) return false;
  var box = [minX, minY, maxX, maxY];
  if (global.__viewer) global.__viewer.lastCityBox = box;
  fitToBox(box, duration, heavy);
  return true;
}

function selectLayer(L) {
  selected = L;
  renderLayerList();
  renderLegend();
}

/* 增强搜索：小区名 + CGI（用字符串数组直读，提速） */
function searchCellsEx(keyword) {
  var kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return [];
  var results = [];
  for (var li = 0; li < layers.length && results.length < 100; li++) {
    var L = layers[li];
    if (!L.ok || L.kind !== 'site') continue;
    var ds = L.ds, n = ds.n;
    var nameCol = L.nameCol;
    // 预取字符串数组，避免逐行 ds.value()
    var nameArr = (nameCol && ds.str && ds.str[nameCol]) ? ds.str[nameCol] : null;
    var cgiCol = L._cgiCol;
    if (cgiCol === undefined) {
      cgiCol = null;
      for (var ci = 0; ci < ds.columns.length; ci++) {
        var cn = String(ds.columns[ci] || '').toLowerCase();
        if (cn === 'cgi' || cn === 'ecgi') { cgiCol = ds.columns[ci]; break; }
      }
      L._cgiCol = cgiCol;
    }
    var cgiArr = (cgiCol && ds.str && ds.str[cgiCol]) ? ds.str[cgiCol] : null;
    for (var i = 0; i < n && results.length < 100; i++) {
      var nm = nameArr ? String(nameArr[i] || '') : (nameCol ? String(ds.value(i, nameCol) || '') : '');
      if (nm.toLowerCase().indexOf(kw) >= 0) {
        var cgi = cgiArr ? String(cgiArr[i] || '') : (cgiCol ? String(ds.value(i, cgiCol) || '') : '');
        results.push({ L: L, i: i, name: nm, cgi: cgi });
        continue;
      }
      if (cgiArr || cgiCol) {
        var cg = cgiArr ? String(cgiArr[i] || '') : String(ds.value(i, cgiCol) || '');
        if (cg && cg.toLowerCase().indexOf(kw) >= 0) {
          results.push({ L: L, i: i, name: nm, cgi: cg });
        }
      }
    }
  }
  return results;
}
function showJumpResults(res, kw) {
  var box = document.getElementById('jumpResults');
  if (!box) return;
  if (!res.length) {
    box.style.display = 'none';
    box.innerHTML = '';
    if (kw.trim()) showErr('未找到匹配的小区或CGI');
    return;
  }
  var html = '';
  for (var k = 0; k < res.length; k++) {
    var r = res[k];
    html += '<div class="cs-item" data-k="' + k + '" style="padding:7px 10px;cursor:pointer;border-bottom:1px solid var(--line);font-size:12.5px;">' +
      '<span style="color:var(--fg)">' + esc(r.name) + '</span>' +
      (r.cgi ? '<span style="color:var(--fg3);font-size:11px;margin-left:8px;">' + esc(r.cgi) + '</span>' : '') +
      '<span style="color:var(--fg3);font-size:11px;margin-left:8px;">' + esc(r.L.name) + '</span></div>';
  }
  box.innerHTML = html;
  box.style.display = 'block';
  // 暂存结果供点击用
  box._res = res;
  var items = box.querySelectorAll('.cs-item');
  for (var j = 0; j < items.length; j++) {
    (function (el) {
      el.onclick = function () {
        var r = box._res[parseInt(el.getAttribute('data-k'), 10)];
        if (!r) return;
        var x = r.L.mx[r.i], y = r.L.my[r.i];
        if (!isFinite(x) || !isFinite(y)) return;
        STATE.hlCell = { L: r.L, i: r.i };
        try {
          map.getView().animate({ center: [x, y], zoom: 16, duration: 400 });
        } catch (e) {}
        box.style.display = 'none';
      };
    })(items[j]);
  }
}
function hideJumpResults() {
  var box = document.getElementById('jumpResults');
  if (box) { box.style.display = 'none'; box.innerHTML = ''; }
}
/* 框选导出：把选区内的小区导出为 CSV */
function pointInSel(x, y, sel) {
  if (!sel) return false;
  if (sel.type === 'rect') {
    var b = sel.b;
    return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
  }
  if (sel.type === 'circle') {
    var dx = x - sel.c[0], dy = y - sel.c[1];
    return dx * dx + dy * dy <= sel.r * sel.r;
  }
  if (sel.type === 'poly') {
    var pts = sel.pts, inside = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  return false;
}
function exportSelection() {
  var sel = currentSel();
  if (!sel) { showErr('请先在地图上框选区域（矩形/圆形/多边形工具）'); return; }
  var rows4g = [], rows5g = [];
  var header = null;
  for (var li = 0; li < layers.length; li++) {
    var L = layers[li];
    if (!L.ok || !L.visible || L.kind !== 'site') continue;
    var ds = L.ds;
    if (!header) header = ['图层'].concat(ds.columns);
    var is5g = (L.rat === '5G');
    var total = rows4g.length + rows5g.length;
    for (var i = 0; i < ds.n && total < 50000; i++) {
      var x = L.mx[i], y = L.my[i];
      if (!isFinite(x) || !isFinite(y)) continue;
      if (!pointInSel(x, y, sel)) continue;
      var cells = ds.cells(i);
      var row = [L.name].concat(cells);
      if (is5g) rows5g.push(row); else rows4g.push(row);
      total++;
    }
    if (total >= 50000) break;
  }
  var totalRows = rows4g.length + rows5g.length;
  if (!totalRows) { showErr('选区内没有小区'); return; }
  // 导出 xlsx：4G 和 5G 分两个 sheet
  if (typeof XLSX === 'undefined') { showErr('xlsx 组件未加载，无法导出'); return; }
  var wb = XLSX.utils.book_new();
  if (rows4g.length) {
    var ws4 = XLSX.utils.aoa_to_sheet([header].concat(rows4g));
    XLSX.utils.book_append_sheet(wb, ws4, '4G');
  }
  if (rows5g.length) {
    var ws5 = XLSX.utils.aoa_to_sheet([header].concat(rows5g));
    XLSX.utils.book_append_sheet(wb, ws5, '5G');
  }
  XLSX.writeFile(wb, '框选小区_' + totalRows + '条.xlsx');
  showErr('已导出 ' + totalRows + ' 条小区（4G ' + rows4g.length + ' 条，5G ' + rows5g.length + ' 条）');
}
function bindExportSel() {
  var btn = document.getElementById('btnExportSel');
  if (btn) btn.onclick = exportSelection;
}
/* 4G/5G 快捷切换 */
/* 弹窗 8 方向拉伸 */
function bindPopupResize(popupId) {
  var el = document.getElementById(popupId);
  if (!el) return;
  /* 双击标题栏恢复默认大小 */
  var head = el.querySelector('.ph');
  if (head) {
    head.title = '双击恢复默认大小';
    head.addEventListener('dblclick', function (e) {
      if (e.target.closest('button')) return;
      el.style.width = '';
      el.style.height = '';
      el.style.maxHeight = '';
    });
  }
  var handles = el.querySelectorAll('.rsz');
  for (var hi = 0; hi < handles.length; hi++) {
    (function (h) {
      h.addEventListener('mousedown', function (e) {
        e.preventDefault(); e.stopPropagation();
        var dir = h.getAttribute('data-dir');
        var rect = el.getBoundingClientRect();
        var startX = e.clientX, startY = e.clientY;
        var startW = rect.width, startH = rect.height;
        var startL = rect.left, startT = rect.top;
        // popup 是 absolute 定位，取 offsetLeft/Top 更准
        var ol = el.offsetLeft, ot = el.offsetTop;
        el.style.maxHeight = 'none';
        function onMove(ev) {
          var dx = ev.clientX - startX, dy = ev.clientY - startY;
          var nw = startW, nh = startH, nl = ol, nt = ot;
          if (dir.indexOf('e') >= 0) nw = startW + dx;
          if (dir.indexOf('s') >= 0) nh = startH + dy;
          if (dir.indexOf('w') >= 0) { nw = startW - dx; nl = ol + dx; }
          if (dir.indexOf('n') >= 0) { nh = startH - dy; nt = ot + dy; }
          nw = Math.max(180, Math.min(nw, window.innerWidth * 0.9));
          nh = Math.max(120, Math.min(nh, window.innerHeight * 0.9));
          // 西/北方向拉伸时，如果撞到最小尺寸，位置也要钳住
          if (dir.indexOf('w') >= 0) nl = ol + (startW - nw);
          if (dir.indexOf('n') >= 0) nt = ot + (startH - nh);
          el.style.width = nw + 'px';
          el.style.height = nh + 'px';
          el.style.left = nl + 'px';
          el.style.top = nt + 'px';
          el.style.maxWidth = 'none';
        }
        function onUp() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    })(handles[hi]);
  }
}
function bindRatToggle() {
  var box = document.getElementById('ratBox');
  var btn = document.getElementById('ratBtn');
  var cur = document.getElementById('ratCur');
  if (!box || !btn) return;
  var RAT_NAME = { '*': '全部', '4G': '4G', '5G': '5G' };
  function close() {
    box.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  }
  function applyRat(rat) {
    for (var li = 0; li < layers.length; li++) {
      var L = layers[li];
      if (!L.rat) continue;
      L.visible = (rat === '*') || (L.rat === rat);
    }
    if (cur) cur.textContent = RAT_NAME[rat] || '全部';
    renderLayerList();
    scheduleDraw();
    scheduleLabels();
    saveViewState();
  }
  btn.onclick = function (e) {
    e.stopPropagation();
    var open = box.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  Array.prototype.forEach.call(box.querySelectorAll('#ratPop button'), function (b) {
    b.onclick = function (e) {
      e.stopPropagation();
      applyRat(b.getAttribute('data-rat'));
      close();
    };
  });
  document.addEventListener('click', function () {
    if (box.classList.contains('open')) close();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && box.classList.contains('open')) close();
  });
  if (cur) cur.textContent = '全部';
}

function removeLayer(L) {
  var i = layers.indexOf(L);
  if (i >= 0) layers.splice(i, 1);
  if (L && L.glPosBuf && GLR && GLR.gl) {
    try { GLR.gl.deleteBuffer(L.glPosBuf); GLR.gl.deleteBuffer(L.glBandBuf); } catch (e) {}
    L.glPosBuf = null; L.glOk = false;
  }
  if (L && L.sitePosBuf && GLS && GLS.gl) {
    try {
      GLS.gl.deleteBuffer(L.sitePosBuf);
      GLS.gl.deleteBuffer(L.siteColBuf);
      GLS.gl.deleteBuffer(L.siteAzkBuf);
      if (L.siteCityBuf) GLS.gl.deleteBuffer(L.siteCityBuf);
    } catch (e) {}
    L.sitePosBuf = null; L.siteCityBuf = null; L.siteGlOk = false;
  }
  if (selected === L) selected = layers.length ? layers[layers.length - 1] : null;
  renderLayerList(); renderLegend();
  /* 选区还开着时重算统计，避免引用已删图层的数据 */
  if (currentSel()) applySelection();
  saveViewState();
  refreshSessionCache();   /* 删层后同步缓存：全删空则清缓存 */
  scheduleDraw();
}

/* ---- 面板与当前图层联动 ---- */




function refreshActive() {
  var L = selected;
  if (!L) return;
  if (L.kind === 'grid') { rebuildBuckets(L); }
  renderLegend();
  scheduleDraw();
}

/* ============================ 12b. 数据源记忆（File System Access） ============================
   浏览器的安全边界：网页不能静默重读本地文件，刷新即失效。
   这里把用户选过的 FileSystemHandle 存进 IndexedDB，刷新后请用户点一次「允许」即可自动重读，
   不必再逐层找文件夹。 */

var IDB_NAME = (typeof global !== 'undefined' && global.__IDB_NAME) || 'raster-viewer', IDB_STORE = 'src', IDB_CACHE = 'cache';
var MAX_FILES = 40;
var CACHE_LIMIT = 1024 * 1024 * 1024;   /* 数据缓存总量上限 1GB，超出则不缓存（避免撑爆配额） */
var ACCEPT_RE = /\.(csv|txt|tsv|json|geojson|xlsx|xls)$/i;
var FSA_OK = (typeof window !== 'undefined') && !!window.showDirectoryPicker &&
  (typeof window.isSecureContext === 'undefined' || window.isSecureContext);
var srcEntries = [];
var cacheInfo = null;   /* {count, mb}：已从缓存自动恢复的数据信息，驱动恢复条显示 */
var cacheErr = null;    /* 最近一次缓存写入失败原因（恢复条可见，避免无声失败） */
var restorePhase = '';  /* '' | 'checking' | 'restoring'：恢复条过程态，卡顿时用户能看到在干什么 */

function idbOpen() {
  return new Promise(function (res, rej) {
    var r = indexedDB.open(IDB_NAME, 2);
    /* 旧版本连接（其他标签页）未关闭时升级会被阻塞：明确报错而不是无声挂起 */
    r.onblocked = function () { rej(new Error('数据库被其他标签页占用，请关闭本页面的其他标签页后刷新')); };
    r.onupgradeneeded = function () {
      var db = r.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      if (!db.objectStoreNames.contains(IDB_CACHE)) db.createObjectStore(IDB_CACHE);
    };
    r.onsuccess = function () {
      var db = r.result;
      db.onversionchange = function () { try { db.close(); } catch (e) { } };
      res(db);
    };
    r.onerror = function () { rej(r.error); };
  });
}
function idbSet(key, val, store) {
  return idbOpen().then(function (db) {
    return new Promise(function (res, rej) {
      var tx = db.transaction(store || IDB_STORE, 'readwrite');
      tx.objectStore(store || IDB_STORE).put(val, key);
      tx.oncomplete = function () { db.close(); res(); };
      tx.onerror = function () { db.close(); rej(tx.error); };
    });
  });
}
function idbGet(key, store) {
  return idbOpen().then(function (db) {
    return new Promise(function (res, rej) {
      var tx = db.transaction(store || IDB_STORE, 'readonly');
      var rq = tx.objectStore(store || IDB_STORE).get(key);
      rq.onsuccess = function () { db.close(); res(rq.result); };
      rq.onerror = function () { db.close(); rej(rq.error); };
    });
  });
}
function idbDel(key, store) {
  return idbOpen().then(function (db) {
    return new Promise(function (res) {
      var tx = db.transaction(store || IDB_STORE, 'readwrite');
      tx.objectStore(store || IDB_STORE).delete(key);
      tx.oncomplete = function () { db.close(); res(); };
      tx.onerror = function () { db.close(); res(); };
    });
  });
}

function updateRestoreBar() {
  var bar = document.getElementById('restoreBar');
  var nm = document.getElementById('srcName');
  var br = document.getElementById('btnRestore');
  var bf = document.getElementById('btnForget');
  var bc = document.getElementById('btnClearCache');
  var hint = document.getElementById('restoreHint');
  if (!bar || !nm) return;
  var hasSrc = srcEntries.length > 0;
  if (restorePhase) {
    /* 恢复过程态：让"卡住"变成"看得见的加载" */
    bar.style.display = '';
    nm.textContent = restorePhase === 'restoring' ? '正在恢复上次页面…' : '正在检查本地缓存…';
    if (br) br.style.display = 'none';
    if (bf) bf.style.display = 'none';
    if (bc) bc.style.display = 'none';
    if (hint) hint.textContent = '';
    return;
  }
  /* 恢复条常显：任何状态下都能看到缓存状态，失败/为空不再无声 */
  bar.style.display = '';
  if (cacheErr) {
    /* 缓存写入失败：明示原因，当前会话数据不受影响 */
    nm.textContent = '数据缓存未写入（' + cacheErr + '）——本次会话数据仍有效，刷新后需重新导入';
    if (br) br.style.display = hasSrc ? '' : 'none';
    if (bf) bf.style.display = hasSrc ? '' : 'none';
    if (bc) bc.style.display = 'none';
    if (hint) hint.textContent = '重新导入数据会再次尝试写缓存。';
  } else if (cacheInfo) {
    /* 缓存自动恢复态：显示缓存概况，「从源更新」仅在记住过数据源时出现 */
    nm.textContent = '已自动恢复上次数据（' + cacheInfo.count + ' 个文件 · ' + cacheInfo.mb + ' MB）';
    if (br) { br.style.display = hasSrc ? '' : 'none'; br.title = '从数据源重新读取文件，替换缓存与当前图层'; }
    if (bf) bf.style.display = hasSrc ? '' : 'none';
    if (bc) bc.style.display = '';
    if (hint) hint.textContent = '重新导入数据会自动更新缓存；「清除缓存」不影响当前页面里的数据。';
  } else if (hasSrc) {
    var names = srcEntries.map(function (e) { return e.name; });
    nm.textContent = '已记住数据源：' + ((names.length === 1) ? names[0] :
      (names[0] + ' 等 ' + names.length + ' 项'));
    if (br) br.style.display = '';
    if (bf) bf.style.display = '';
    if (bc) bc.style.display = 'none';
    if (hint) hint.textContent = '浏览器会弹出一次授权，点「允许」即可自动重新读取，无需再找文件夹。';
  } else {
    nm.textContent = '数据缓存：空（尚未写入或已被清除）';
    if (br) br.style.display = 'none';
    if (bf) bf.style.display = 'none';
    if (bc) bc.style.display = 'none';
    if (hint) hint.textContent = '导入数据后会自动写入缓存，下次打开无需重新导入。';
  }
}

/* 递归收集目录下的数据文件（深度≤3，总数封顶） */
async function collectDir(dir, out, depth) {
  var subs = [];
  for await (var ent of dir.values()) {
    if (out.length >= MAX_FILES) return;
    if (ent.kind === 'file') {
      if (!ACCEPT_RE.test(ent.name)) continue;
      try { out.push(await ent.getFile()); } catch (e) { }
    } else if (ent.kind === 'directory' && depth < 3) {
      subs.push(ent);
    }
  }
  for (var i = 0; i < subs.length; i++) await collectDir(subs[i], out, depth + 1);
}

async function filesFromEntries(entries) {
  var out = [];
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (e.kind === 'file') {
      try { out.push(await e.handle.getFile()); } catch (er) { }
    } else {
      await collectDir(e.handle, out, 0);
    }
  }
  out.sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
  return out;
}

/* 授权检查；prompt 状态必须由用户手势触发 requestPermission */
async function ensurePerm(handle) {
  if (!handle || !handle.queryPermission) return false;
  var p = await handle.queryPermission({ mode: 'read' });
  if (p === 'granted') return true;
  if (p === 'denied') return false;
  var r = await handle.requestPermission({ mode: 'read' });
  return r === 'granted';
}

async function loadFromEntries(entries, remember) {
  busy('正在读取文件…');
  try {
    var files = await filesFromEntries(entries);
    if (!files.length) {
      busyOff();
      showErr('该位置没有找到可读取的数据文件（支持 csv / txt / tsv / geojson / xlsx）');
      return;
    }
    if (files.length >= MAX_FILES) {
      showErr('文件较多，只加载了前 ' + MAX_FILES + ' 个：' + files.map(function (f) { return f.name; }).join('、'));
    }
    await loadFiles(files);          /* 内部自行管理 busy 与收尾 */
    if (remember) {
      srcEntries = entries;
      updateRestoreBar();                 /* 先更新界面，存储失败也不影响本次会话 */
      idbGuard(idbSet('sources', entries), 8000, '保存数据源记录').then(function () {
        showErr('数据已载入并写入本地缓存，下次打开将自动恢复，无需重新导入。');
      }).catch(function () {
        showErr('数据已载入，但浏览器存储不可用：本次会话内有效，刷新后需重新选择。');
      });
    }
  } catch (e) {
    busyOff();
    showErr('读取失败：' + (e && e.message ? e.message : e));
  }
}

async function restoreSources() {
  if (!srcEntries.length) return;
  for (var i = 0; i < srcEntries.length; i++) {
    var e = srcEntries[i];
    var p;
    try { p = await e.handle.queryPermission({ mode: 'read' }); } catch (er) { p = 'denied'; }
    if (p === 'granted') continue;
    if (p === 'denied') { showErr('对「' + e.name + '」的访问已被拒绝，请点「忘记」后重新选择。'); return; }
    var r;
    try { r = await e.handle.requestPermission({ mode: 'read' }); } catch (er2) { r = 'denied'; }
    if (r !== 'granted') { showErr('未获得「' + e.name + '」的访问授权。'); return; }
  }
  await loadFromEntries(srcEntries, false);
}

/* 超时保护：存储异常时不能让页面卡住，退化为「仅本次会话有效」 */
function idbGuard(p, ms, label) {
  return Promise.race([p, new Promise(function (_, rej) {
    setTimeout(function () { rej(new Error(label + ' 超时')); }, ms || 8000);
  })]);
}

/* ---- 会话缓存 v2：直接缓存解析后的数据集（TypedArray 结构化克隆），
   重开/刷新时零解析零构建，直接进图层。不再缓存文件字节。 ---- */

function rflog(m) { try { (global.__rfLog = global.__rfLog || []).push(m); } catch (e) { } }

/* 图层 → 可结构化克隆的快照（num 全量 + extra 文本 + 元信息） */
function dsSnapshot(L) {
  var ds = L.ds, num = {}, bytes = 0, k;
  for (k in ds.num) { num[k] = ds.num[k]; bytes += ds.num[k].byteLength || 0; }
  var str = null;
  if (ds.str) { str = {}; for (k in ds.str) { str[k] = ds.str[k]; bytes += (ds.str[k].length || 0) * 2; } }
  var extra = null, ecount = 0;
  if (ds.extra) { for (k in ds.extra) { if (ds.extra[k]) { ecount++; bytes += 48 * (ds.extra[k].length || 0); } } if (ecount) extra = ds.extra; }
  return { __ds: true, name: L.name, kind: L.kind,
           n: ds.n, columns: ds.columns, num: num, str: str, extra: extra, bytes: bytes };
}

/* 快照 → Dataset（num 直用；文本列走 str；cells/value 全兜底） */
function dsFromSnapshot(s) {
  var ds = new Dataset(s.name);
  ds.n = s.n; ds.columns = s.columns; ds.num = s.num || {};
  if (s.str) ds.str = s.str;
  if (s.extra) ds.extra = s.extra;
  ds.lineOff = null; ds.store = null;
  ds.lineText = function () { return ''; };
  ds.cells = function (i) {
    if (this.extra && this.extra[i]) return this.extra[i];
    var out = new Array(this.columns.length);
    for (var c = 0; c < this.columns.length; c++) {
      var col = this.columns[c], a = this.num[col];
      if (a) { out[c] = String(a[i]); continue; }
      out[c] = (this.str && this.str[col]) ? (this.str[col][i] || '') : '';
    }
    return out;
  };
  ds.value = function (i, col) {
    var a = this.num[col];
    if (a) return a[i];
    if (this.str && this.str[col]) return this.str[col][i] || '';
    var c = this.columns.indexOf(col);
    var cs = this.cells(i);
    return c >= 0 && c < cs.length ? cs[c] : '';
  };
  /* v36 新增的原型方法 columnText 直接读 this.store.range——
     恢复的数据集 store 为 null，工参图层分色（频段/站型列）时会在这里崩掉整个恢复流程。
     恢复对象上覆写：走 value（num → str）逐行取，一次一列并缓存 */
  ds.columnText = function (col) {
    var c = this.columns.indexOf(col);
    if (c < 0) return null;
    if (!this._colCache) this._colCache = {};
    if (this._colCache[col]) return this._colCache[col];
    var out = new Array(this.n);
    for (var i = 0; i < this.n; i++) out[i] = String(this.value(i, col) || '');
    this._colCache[col] = out;
    return out;
  };
  return ds;
}

/* 写缓存：num 快照（同步）+ 文本列抽取（分块异步，弹窗属性表需要） */
/* ---- v3 会话缓存：按图层分件存储。meta / 每个数值列 / 行偏移 / 文本块各自独立记录，
   单条记录最大几十 MB，写入稳；manifest 最后写入作为提交点。
   部分图层写入失败时降级恢复（能恢复多少恢复多少，失败的在提示里明示） ---- */

function cacheLyId(i) { return 'ly' + i; }

async function putLayerRecords(i, L) {
  var ds = L.ds, keys = [];
  var meta = { name: L.name, kind: L.kind, n: ds.n, columns: ds.columns,
               numeric: ds.numeric || null, delim: ds.delim || ',' };
  await idbGuard(idbSet(cacheLyId(i) + '/meta', meta, IDB_CACHE), 90000, '写入图层元信息');
  keys.push(cacheLyId(i) + '/meta');
  for (var c = 0; c < ds.columns.length; c++) {
    var col = ds.columns[c], arr = ds.num[col];
    if (!arr) continue;
    var k1 = cacheLyId(i) + '/num/' + c;
    await idbGuard(idbSet(k1, arr, IDB_CACHE), 180000, '写入数值列 ' + col);
    keys.push(k1);
  }
  if (ds.lineOff) {
    await idbGuard(idbSet(cacheLyId(i) + '/loff', ds.lineOff, IDB_CACHE), 120000, '写入行偏移');
    keys.push(cacheLyId(i) + '/loff');
  }
  if (ds.store && ds.store.parts && ds.store.parts.length) {
    var n = ds.store.parts.length;
    await idbGuard(idbSet(cacheLyId(i) + '/txtn', n, IDB_CACHE), 30000, '写入文本块数');
    keys.push(cacheLyId(i) + '/txtn');
    for (var p = 0; p < n; p++) {
      var k2 = cacheLyId(i) + '/txt/' + p;
      await idbGuard(idbSet(k2, ds.store.parts[p], IDB_CACHE), 180000, '写入文本块 ' + p);
      keys.push(k2);
    }
  }
  if (ds.extra) {
    await idbGuard(idbSet(cacheLyId(i) + '/extra', ds.extra, IDB_CACHE), 120000, '写入单元格文本');
    keys.push(cacheLyId(i) + '/extra');
  }
  return keys;
}

async function doPutCache() {
  var manifest = { ver: 3, layers: [], savedAt: Date.now() };
  var total = 0;
  for (var i = 0; i < layers.length; i++) {
    var L = layers[i];
    var entry = { id: cacheLyId(i), name: L.name, kind: L.kind, ok: false, err: '', keys: [],
                  rows: L.ds ? L.ds.n : 0, cols: (L.ds && L.ds.columns) ? L.ds.columns.length : 0 };
    try {
      var keys = await putLayerRecords(i, L);
      entry.keys = keys; entry.ok = true;
      var b = 0, k;
      if (L.ds) { for (k in L.ds.num) b += L.ds.num[k].byteLength || 0; if (L.ds.store) b += L.ds.store.total * 2; }
      entry.mb = Math.round(b / 1048576);
      total += b;
    } catch (e) {
      entry.err = (e && e.message) ? e.message : String(e);
      for (var ki = 0; ki < entry.keys.length; ki++) { try { idbDel(entry.keys[ki], IDB_CACHE); } catch (e2) { } }
    }
    manifest.layers.push(entry);
  }
  /* 清理上一份清单里、这一份已不含的图层的残留键（层数减少/图层删除后不留垃圾） */
  var oldMan = null;
  try { oldMan = await idbGuard(idbGet('manifest', IDB_CACHE), 30000, '读取旧缓存清单'); } catch (e) { }
  if (oldMan && oldMan.layers) {
    for (var oi = 0; oi < oldMan.layers.length; oi++) {
      var oe = oldMan.layers[oi];
      var still = manifest.layers.some(function (ne) { return ne.id === oe.id; });
      if (still || !oe.keys) continue;
      for (var ki = 0; ki < oe.keys.length; ki++) { try { idbDel(oe.keys[ki], IDB_CACHE); } catch (e2) { } }
    }
  }
  await idbGuard(idbSet('manifest', manifest, IDB_CACHE), 60000, '写入缓存清单');
  var okCnt = manifest.layers.filter(function (e) { return e.ok; }).length;
  cacheInfo = { count: okCnt, mb: Math.round(total / 1048576) };
  var fails = manifest.layers.filter(function (e) { return !e.ok; });
  if (fails.length) {
    cacheErr = '部分图层未写入：' + fails.map(function (e) { return (e.name || '图层').slice(0, 16) + '（' + e.err.slice(0, 60) + '）'; }).join('、');
    /* 附带配额诊断，定位是浏览器存储上限还是其他原因 */
    try {
      if (navigator.storage && navigator.storage.estimate) {
        var est = await navigator.storage.estimate();
        cacheErr += '；存储配额 ' + (est.quota / 1073741824).toFixed(1) + 'GB、已用 ' + ((est.usage || 0) / 1048576).toFixed(0) + 'MB';
      }
    } catch (e2) { }
  } else if (cacheErr) { cacheErr = null; }
  updateRestoreBar();
}

async function idbGetCache() {
  var man = null;
  try { man = await idbGuard(idbGet('manifest', IDB_CACHE), 60000, '读取缓存清单'); } catch (e) { man = null; }
  if (man && man.ver === 3 && man.layers) return { ver: 3, manifest: man };
  var last = null;
  try { last = await idbGuard(idbGet('last', IDB_CACHE), 60000, '读取数据缓存'); } catch (e) { last = null; }
  return last || null;
}
function idbDelCache() {
  /* v3：清空 = 写一份空 manifest（提交点语义），并顺手清掉旧清单引用的图层键 */
  return (async function () {
    var old = null;
    try { old = await idbGuard(idbGet('manifest', IDB_CACHE), 30000, '读取旧缓存清单'); } catch (e) { }
    if (old && old.layers) {
      for (var i = 0; i < old.layers.length; i++) {
        var ks = old.layers[i].keys || [];
        for (var k = 0; k < ks.length; k++) { try { idbDel(ks[k], IDB_CACHE); } catch (e2) { } }
      }
    }
    try { idbDel('last', IDB_CACHE); } catch (e3) { }
    await idbGuard(idbSet('manifest', { ver: 3, layers: [], savedAt: Date.now() }, IDB_CACHE), 30000, '写入空清单');
  })();
}

/* 会话缓存刷新：快照当前全部图层（多次导入自动合并，后导入不覆盖先导入）；
   图层删空时清掉缓存，避免下次恢复出已删除的图层 */
var _cacheChain = Promise.resolve();   /* 串行化缓存写入，避免并发 put 交错 */
var _rscTimer = null;
function refreshSessionCacheNow() {
  _cacheChain = _cacheChain.then(function () { return doPutCache(); }).catch(function (e) {
    cacheErr = (e && e.message) ? e.message : '写入失败';
    updateRestoreBar();
  });
}
function refreshSessionCache() {
  if (global.__NO_SESSION_CACHE) return;
  if (_vsSuspend > 0) return;   /* 会话恢复进行中：此刻的清层/建层不回写缓存，防止与恢复读竞争 */
  /* 防抖：连续删层/建层只触发一次全量重写 */
  if (_rscTimer) clearTimeout(_rscTimer);
  _rscTimer = setTimeout(function () {
    _rscTimer = null;
    refreshSessionCacheNow();
  }, 800);
}

/* ---- 会话状态：中心/缩放/指标/地市/图层勾选/面板开合，存 localStorage ---- */

var _vsTimer = null;
var _vsSuspend = 0;   /* >0 = 会话恢复进行中，挂起自动保存（计数式，支持嵌套）。
   必须覆盖整个恢复过程：loadFiles 里的 fitLayer 会触发 moveend 防抖保存，
   大文件解析远超 500ms，中间态会把待恢复的视图覆盖掉 */
function saveViewState(immediate) {
  if (!map || _vsSuspend > 0) return;
  if (_vsTimer) clearTimeout(_vsTimer);
  var write = function () {
    if (_vsSuspend > 0) return;   /* 定时器持有 write 直接引用，到点必须再查挂起，否则中间态穿透 */
    try {
      var v = map.getView();
      var s = {
        c: v.getCenter(), z: v.getZoom(),
        mode: STATE.gridColorMode, city: STATE.cityFilter,
        vis: layers.map(function (L) { return !!L.visible; }),
        panel: !document.getElementById('panel').classList.contains('hide')
      };
      rflog('vs write ' + (immediate ? 'imm' : 'deb') + ' c=' + JSON.stringify(s.c) + ' z=' + s.z);
      lsSet('viewstate', JSON.stringify(s));
    } catch (e) { }
  };
  if (immediate) write();
  else _vsTimer = setTimeout(write, 500);
}
function readViewState() {
  try { return JSON.parse(lsGet('viewstate', '')) || null; } catch (e) { return null; }
}
/* 恢复指标/地市/图层勾选（数据载入完成后调用）；snap 为一次性状态快照 */
function applyViewState(s) {
  if (!s) s = readViewState();
  if (!s) return;
  if (s.mode && s.mode !== STATE.gridColorMode) applyGridColorMode(s.mode);
  if (s.city) {
    STATE.cityFilter = s.city;
    for (var i = 0; i < layers.length; i++) {
      var L = layers[i];
      if (L.kind !== 'grid' || !L.ok) continue;
      setLayerCity(L, s.city === '*' ? null : s.city);
    }
  }
  if (s.vis && s.vis.length === layers.length) {
    for (var j = 0; j < layers.length; j++) layers[j].visible = !!s.vis[j];
  }
  renderLayerList();
  syncCityDropdown();
}
/* 恢复地图中心与缩放 */
function applyMapView(s) {
  if (!s) s = readViewState();
  if (!s || !s.c || !isFinite(s.z) || !map) return;
  var v = map.getView();
  v.setCenter(s.c);
  v.setZoom(Math.max(v.getMinZoom(), Math.min(v.getMaxZoom(), s.z)));
}
/* 挂起自动保存地跑完一个异步恢复流程，结束后按当前状态落一次盘 */
function withVsSuspend(p) {
  _vsSuspend++;
  return p.then(function (r) { _vsSuspend--; saveViewState(true); return r; },
                function (e) { _vsSuspend--; saveViewState(true); throw e; });
}

/* 一次性取快照 → 挂起自动保存 → 应用 → 恢复保存。
   中途清层/建层/fitLayer 触发的防抖保存不再有机会把中间态写进 viewstate */
function restoreSessionState() {
  var snap = readViewState();
  return withVsSuspend((function () {
    applyViewState(snap);
    applyMapView(snap);
    return Promise.resolve();
  })());
}

/* 清空当前全部图层（「从源更新」前调用，避免叠加重复图层） */
function clearAllLayers() {
  while (layers.length) removeLayer(layers[layers.length - 1]);
}

/* 从缓存记录恢复图层：数据集直接反序列化，零解析零构建，无进度弹窗。
   重活拆步 + yield：反序列化是浏览器内部一次性的（不可拆），建层/投影/分桶之间
   让页面喘气，恢复条得以刷新，避免长时间白屏冻结 */
async function restoreFromCache(cache) {
  /* v3 分件格式（{ver:3, manifest}）：按清单逐层读取分件重组，零解析零构建，
     单层失败只跳过该层并在提示里明示 */
  if (cache && cache.ver === 3 && cache.manifest) {
    var man = cache.manifest;
    var okLs = man.layers.filter(function (e) { return e.ok; });
    cacheInfo = { count: okLs.length, mb: man.layers.reduce(function (s, e) { return s + (e.mb || 0); }, 0) };
    rflog('restoreFromCache v3 n=' + man.layers.length);
    return withVsSuspend((async function () {
      var restoredNames = [], failed = [];
      for (var i = 0; i < man.layers.length; i++) {
        var e = man.layers[i];
        await yieldFrame();
        if (!e.ok) { failed.push((e.name || '图层').slice(0, 16)); continue; }
        try {
          var meta = await idbGet(e.id + '/meta', IDB_CACHE);
          var ds = new Dataset(meta.name);
          ds.n = meta.n; ds.columns = meta.columns;
          ds.numeric = meta.numeric || null; ds.delim = meta.delim || ',';
          var numPromises = [];
          for (var c = 0; c < meta.columns.length; c++) {
            (function (cc) {
              numPromises.push(idbGet(e.id + '/num/' + cc, IDB_CACHE).then(function (arr) {
                if (arr) ds.num[meta.columns[cc]] = arr;
              }));
            })(c);
          }
          await Promise.all(numPromises);
          var loff = await idbGet(e.id + '/loff', IDB_CACHE);
          if (loff) ds.lineOff = loff;
          var txtn = await idbGet(e.id + '/txtn', IDB_CACHE);
          if (txtn > 0) {
            ds.store = new ChunkStore();
            var txtParts = new Array(txtn);
            var txtPromises = [];
            for (var p = 0; p < txtn; p++) {
              (function (pp) {
                txtPromises.push(idbGet(e.id + '/txt/' + pp, IDB_CACHE).then(function (part) {
                  txtParts[pp] = part;
                }));
              })(p);
            }
            await Promise.all(txtPromises);
            for (var pp2 = 0; pp2 < txtn; pp2++) {
              if (txtParts[pp2] !== undefined && txtParts[pp2] !== null) ds.store.push(txtParts[pp2]);
            }
          }
          var extra = await idbGet(e.id + '/extra', IDB_CACHE);
          if (extra) ds.extra = extra;
          if (meta.kind === 'site') {
            var sn = pickColumn(ds.columns, ALIAS.stype);
            ds.stypeIdx = sn ? ds.columns.indexOf(sn) : -1;
            ds.stype = ds.stypeIdx >= 0 ? ds.columnText(sn) : null;
          }
          var L = makeLayer(ds, meta.kind, true);   /* 跳过同步城市索引，走 Worker */
          layers.push(L);
          if (!selected) selectLayer(L);
          if (L.ok) {
            await yieldFrame();
            await buildCityIdxAsync(L);   /* Worker 异步构建城市索引 */
            await yieldFrame();
            await projectLayerAsync(L);   /* Worker 异步投影（大数据量） */
            await yieldFrame();
            if (L.kind === 'grid') {
              if (STATE.cityFilter && STATE.cityFilter !== '*') setLayerCity(L, STATE.cityFilter);
              await yieldFrame();
              rebuildBuckets(L, true);
              await yieldFrame();
              try { await buildGridGLAsync(L); } catch (e2) { L.glOk = false; }
            }
            restoredNames.push((meta.name || '图层').slice(0, 16) + '（' + (meta.n || 0).toLocaleString() + ' 行 · ' + meta.columns.length + ' 列）');
          } else {
            failed.push((meta.name || '图层').slice(0, 16) + '（' + (L.error || '无法识别') + '）');
          }
        } catch (e3) {
          failed.push((e.name || '图层').slice(0, 16) + '（' + (e3.message || e3) + '）');
        }
      }
      await yieldFrame();
      renderLayerList();
      selectLayer(selected);
      scheduleDraw();
      restoreSessionState();
      updateRestoreBar();
      var msg = '已直接恢复上次页面：' + (restoredNames.length ? restoredNames.join('、') : '无可恢复图层');
      if (failed.length) msg += '；未恢复：' + failed.join('、') + '（重新导入该文件可补齐）';
      showErr(msg);
      rflog('restoreFromCache v3 done restored=' + restoredNames.length);
    })());
  }
  /* v1 旧格式兼容（{files:[{name,blob}]} 文件字节）：退回 loadFiles 重放一次，
     完成后 loadFiles 尾部会自动写 v2 快照，下次刷新即秒开 */
  if (cache && cache.files && cache.files.length && !cache.layers) {
    var oldFiles = cache.files.map(function (f) {
      try { return new File([f.blob], f.name); } catch (e) { return null; }
    }).filter(function (f) { return f; });
    if (!oldFiles.length) return Promise.reject(new Error('缓存为空'));
    rflog('restoreFromCache v1 replay n=' + oldFiles.length);
    cacheInfo = {
      count: oldFiles.length,
      mb: Math.round(cache.files.reduce(function (s, f) { return s + (f.blob && f.blob.size || 0); }, 0) / 1048576)
    };
    return withVsSuspend(loadFiles(oldFiles).then(function () {
      /* 旧版缓存的文件引用可能已失效（源文件被移动/临时副本被清理 → Blob 读出 0 字节），
         重放得到的全是空图层：识别出来，清掉并明确告诉用户重新导入 */
      var alive = layers.filter(function (L) { return L.ok && L.ds && L.ds.n > 0; });
      if (!alive.length) {
        clearAllLayers();
        throw new Error('旧版缓存的文件内容已失效（读到 0 字节），请重新导入一次数据即可重建缓存');
      }
      restoreSessionState();
      updateRestoreBar();
      showErr('已恢复上次数据（旧版缓存重放一次，本次起升级为秒开格式）。');
    })).then(function () {
      refreshSessionCache();   /* 挂起已解除：把重放结果升级写入 v3 快照 */
    });
  }
  if (!cache || !cache.layers || !cache.layers.length) return Promise.reject(new Error('缓存为空'));
  cacheInfo = { count: cache.layers.length, mb: Math.round((cache.bytes || 0) / 1048576) };
  rflog('restoreFromCache start n=' + cache.layers.length);
  return withVsSuspend((async function () {
    for (var i = 0; i < cache.layers.length; i++) {
      var s = cache.layers[i];
      await yieldFrame();
      var kind = s.kind || classifyLayer(s.name, s.columns);
      var L = makeLayer(dsFromSnapshot(s), kind);
      layers.push(L);
      if (!selected) selectLayer(L);
      if (L.ok) {
        await yieldFrame();
        projectLayer(L);
        await yieldFrame();
        if (L.kind === 'grid') {
          if (STATE.cityFilter && STATE.cityFilter !== '*') setLayerCity(L, STATE.cityFilter);
          rebuildBuckets(L, true);
          await yieldFrame();
          try { buildGridGL(L); } catch (e) { L.glOk = false; }
          await yieldFrame();
        }
      }
    }
    await yieldFrame();
    renderLayerList();
    selectLayer(selected);
    scheduleDraw();
    restoreSessionState();
    updateRestoreBar();
    /* 自检：恢复后统计缺失的文本列（旧版缓存没带 gridId 等），提示用户重导补齐 */
    var missText = 0;
    cache.layers.forEach(function (s) {
      (s.columns || []).forEach(function (col) {
        if (!(s.num && s.num[col]) && !(s.str && s.str[col])) missText++;
      });
    });
    showErr('已直接恢复上次页面：' + cache.layers.slice(0, 2).map(function (s) {
      return (s.name || '图层').slice(0, 16) + '（' + (s.n || 0).toLocaleString() + ' 行 · ' +
        (s.columns ? s.columns.length : 0) + ' 列）';
    }).join('、') + (cache.layers.length > 2 ? ' 等 ' + cache.layers.length + ' 个图层' : '') +
      '；接着上次继续即可。' + (missText > 0
        ? ' 注意：有 ' + missText + ' 个文本列（如 gridId）未随旧缓存保存，重新导入一次即可补齐。'
        : ''));
    rflog('restoreFromCache done');
  })());
}

async function initSourceRestore() {
  if (typeof indexedDB === 'undefined') return;
  if (global.__NO_SESSION_RESTORE) return;   /* 自动化测试钩子：跳过会话恢复 */
  /* 申请持久存储，降低大缓存被浏览器回收的概率 */
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () { });
  } catch (e) { }
  /* 数据源句柄照常读入（供「从源更新」用），失败不影响缓存恢复 */
  idbGuard(idbGet('sources'), 8000, '读取数据源记录').then(function (v) {
    if (v && v.length) { srcEntries = v; if (!restorePhase) updateRestoreBar(); }
  }).catch(function () { });

  /* 挂起从「检查缓存」就开始：boot 默认视图的 moveend 防抖保存（+500ms）落在
     大缓存读取（1~3s）窗口内，若不提前挂起会把待恢复的视图状态覆盖掉 */
  _vsSuspend++;
  restorePhase = 'checking';
  updateRestoreBar();
  /* 先恢复视图：localStorage 极小，瞬间可读。用户打开即见上次位置（底图），
     数据在后台恢复，不用干等 1~3s 读缓存 + 600ms 计算才"跳"过去 */
  try {
    var _snap = readViewState();
    if (_snap) {
      if (_snap.mode) STATE.gridColorMode = _snap.mode;
      if (_snap.city) STATE.cityFilter = _snap.city;
      applyMapView(_snap);
    }
  } catch (_e) {}
  await yieldFrame();

  try {
    var cache = await idbGetCache();
    var hasCache = !!(cache && ((cache.ver === 3 && cache.manifest && cache.manifest.layers && cache.manifest.layers.length) ||
      (cache.layers && cache.layers.length) || (cache.files && cache.files.length)));
    if (!hasCache) throw new Error('缓存为空');
    restorePhase = 'restoring';
    updateRestoreBar();
    await yieldFrame();
    await restoreFromCache(cache);   /* 内部嵌套挂起 */
    _vsSuspend--;
    restorePhase = '';
    updateRestoreBar();
    saveViewState(true);
  } catch (e) {
    _vsSuspend--;
    restorePhase = '';
    var msg = e && e.message ? e.message : String(e);
    if (msg.indexOf('缓存为空') >= 0) {
      /* 还没有缓存：退回数据源句柄恢复（同一会话刷新时授权通常仍在，可静默） */
      if (srcEntries.length) {
        updateRestoreBar();
        var h = srcEntries[0].handle;
        if (h && h.queryPermission) {
          try {
            var p = await h.queryPermission({ mode: 'read' });
            if (p === 'granted') {
              await withVsSuspend(restoreSources().then(function () { restoreSessionState(); }));
            }
          } catch (e2) { }
        }
        saveViewState(true);
      }
    } else {
      /* 读取/恢复失败：明示原因，不要无声失败 */
      showErr('自动恢复上次数据失败：' + msg + '。可重新导入数据，导入会重建缓存。');
      updateRestoreBar();
      saveViewState(true);
    }
  }
}

/* ============================ 12c. 测量 / 选择工具 ============================ */

var DEG2GROUND_M = 111132.0;

/* 子工具表：group 决定归属哪个按钮，multi 表示逐点点击、clicks 表示固定点数 */
var TOOLS = {
  line:    { group: 'measure', label: '测量线' },
  area:    { group: 'measure', label: '测量面积' },
  azimuth: { group: 'measure', label: '测量方位角', clicks: 2 },
  angle:   { group: 'measure', label: '测量角度', clicks: 3 },
  rect:    { group: 'select', label: '矩形框选', drag: 'rect' },
  poly:    { group: 'select', label: '按多边形选择' },
  free:    { group: 'select', label: '自由手绘选择', drag: 'free' },
  radius:  { group: 'select', label: '按半径选择', drag: 'radius' },
  coord:   { group: 'coord',  label: '经纬度拾取', clicks: 1 }
};
function toolGroup(id) { return (id && TOOLS[id]) ? TOOLS[id].group : ''; }

function mercToLonLat(x, y) {
  return [x / DEG2MERC, (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * 180 / Math.PI];
}

/* 球面距离（真实地面米） */
function groundDist(a, b) {
  var p1 = a[1] * Math.PI / 180, p2 = b[1] * Math.PI / 180;
  var dp = p2 - p1, dl = (b[0] - a[0]) * Math.PI / 180;
  var x = Math.sin(dp / 2), z = Math.sin(dl / 2);
  var s = x * x + Math.cos(p1) * Math.cos(p2) * z * z;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(s)));
}

/* 真方位角：正北为 0°，顺时针 0~360 */
function bearing(a, b) {
  var p1 = a[1] * Math.PI / 180, p2 = b[1] * Math.PI / 180;
  var dl = (b[0] - a[0]) * Math.PI / 180;
  var y = Math.sin(dl) * Math.cos(p2);
  var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/* 夹角：以 b 为顶点，a-b-c 的夹角（0~180°） */
function angleAt(a, b, c) {
  var k = Math.cos(b[1] * Math.PI / 180);
  var v1 = [(a[0] - b[0]) * k, a[1] - b[1]];
  var v2 = [(c[0] - b[0]) * k, c[1] - b[1]];
  var m1 = Math.hypot(v1[0], v1[1]), m2 = Math.hypot(v2[0], v2[1]);
  if (!m1 || !m2) return 0;
  var cs = (v1[0] * v2[0] + v1[1] * v2[1]) / (m1 * m2);
  return Math.acos(Math.max(-1, Math.min(1, cs))) * 180 / Math.PI;
}

/* 多边形面积：以平均纬度做局部等距近似 */
function polyArea(p) {
  var n = p.length;
  if (n < 3) return 0;
  var lat0 = 0, i;
  for (i = 0; i < n; i++) lat0 += p[i][1];
  lat0 /= n;
  var kx = Math.cos(lat0 * Math.PI / 180) * DEG2MERC;
  var s = 0;
  for (i = 0; i < n; i++) {
    var a = p[i], b = p[(i + 1) % n];
    s += (a[0] * kx) * (b[1] * DEG2GROUND_M) - (b[0] * kx) * (a[1] * DEG2GROUND_M);
  }
  return Math.abs(s) / 2;
}
function polyPerim(p) {
  var s = 0;
  for (var i = 1; i < p.length; i++) s += groundDist(p[i - 1], p[i]);
  if (p.length > 2) s += groundDist(p[p.length - 1], p[0]);
  return s;
}

function fmtLen(m) {
  if (m >= 1000) return (m / 1000).toFixed(3) + ' km';
  return m.toFixed(1) + ' m';
}
function fmtArea(m2) {
  if (m2 >= 1e6) return (m2 / 1e6).toFixed(3) + ' km²';
  if (m2 >= 1e4) return (m2 / 1e4).toFixed(2) + ' 公顷';
  return Math.round(m2) + ' m²';
}
function fmtAz(d) { return d.toFixed(1) + '°'; }
function compass(d) {
  var names = ['北', '东北偏北', '东北', '东北偏东', '东', '东南偏东', '东南', '东南偏南',
    '南', '西南偏南', '西南', '西南偏西', '西', '西北偏西', '西北', '西北偏北'];
  return names[Math.round(d / 22.5) % 16];
}

function mercAtEvent(e) {
  var r = map.getViewport().getBoundingClientRect();
  return map.getCoordinateFromPixel([e.clientX - r.left, e.clientY - r.top]);
}
function pixelAtEvent(e) {
  var r = map.getViewport().getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}
function normalizeBox(b) {
  if (b[2] < b[0]) { var s = b[0]; b[0] = b[2]; b[2] = s; }
  if (b[3] < b[1]) { var t = b[1]; b[1] = b[3]; b[3] = t; }
}

/* 多边形栅格化（扫描线填充）：顶点可能很多，逐点射线法太慢，
   先烧成掩膜，判定就是 O(1)。总格数封顶，保证大范围也不炸内存。 */
function makeMaskTest(pts) {
  var n = pts.length, i;
  if (n < 3) return null;
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (i = 0; i < n; i++) {
    if (pts[i][0] < minX) minX = pts[i][0];
    if (pts[i][0] > maxX) maxX = pts[i][0];
    if (pts[i][1] < minY) minY = pts[i][1];
    if (pts[i][1] > maxY) maxY = pts[i][1];
  }
  var w = maxX - minX, h = maxY - minY;
  if (!(w > 0) || !(h > 0)) return null;

  var MAXC = 8000000;
  var cell = Math.max(Math.sqrt((w * h) / MAXC), 1e-6);
  var cols = Math.max(1, Math.ceil(w / cell)), rows = Math.max(1, Math.ceil(h / cell));
  var mask = new Uint8Array(cols * rows);
  var xs = new Float64Array(n);
  var tmp = [];
  var j;
  for (var r = 0; r < rows; r++) {
    var y = minY + (r + 0.5) * cell, m = 0;
    for (i = 0, j = n - 1; i < n; j = i++) {
      var yi = pts[i][1], yj = pts[j][1];
      if ((yi > y) !== (yj > y)) {
        xs[m++] = pts[i][0] + (y - yi) * (pts[j][0] - pts[i][0]) / (yj - yi);
      }
    }
    if (m < 2) continue;
    tmp.length = 0;
    for (i = 0; i < m; i++) tmp.push(xs[i]);
    tmp.sort(function (a, b) { return a - b; });
    for (i = 0; i + 1 < m; i += 2) {
      var c0 = Math.max(0, Math.floor((tmp[i] - minX) / cell));
      var c1 = Math.min(cols - 1, Math.floor((tmp[i + 1] - minX) / cell));
      var base = r * cols;
      for (var c = c0; c <= c1; c++) mask[base + c] = 1;
    }
  }
  return function (x, y) {
    if (x < minX || x > maxX || y < minY || y > maxY) return false;
    var c = ((x - minX) / cell) | 0, rr = ((y - minY) / cell) | 0;
    if (c < 0 || rr < 0 || c >= cols || rr >= rows) return false;
    return mask[rr * cols + c] !== 0;
  };
}

/* 选区判定：矩形 / 多边形 / 圆 */
function makeSelTest(sel) {
  if (!sel) return null;
  if (sel.type === 'rect') {
    var b = sel.b;
    return function (x, y) { return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]; };
  }
  if (sel.type === 'circle') {
    var cx = sel.c[0], cy = sel.c[1], r2 = sel.r * sel.r;
    return function (x, y) { var dx = x - cx, dy = y - cy; return dx * dx + dy * dy <= r2; };
  }
  return makeMaskTest(sel.pts);
}

function currentSel() {
  if (STATE.selCircle) return { type: 'circle', c: STATE.selCircle.c, r: STATE.selCircle.r };
  if (STATE.polyDone && STATE.polyPts.length >= 3) {
    return { type: 'poly', pts: STATE.polyPts.map(function (p) { return [p[0], p[1]]; }) };
  }
  if (STATE.selBox) return { type: 'rect', b: STATE.selBox.slice() };
  return null;
}

/* 切换子工具。同组内换子工具要清掉上一项的绘制状态 */
function setTool(id) {
  var prev = STATE.tool;
  var g = toolGroup(id);
  if (prev === id) id = '';                       /* 再点一次取消 */
  if (prev && toolGroup(prev) === g && prev !== id) {
    STATE.measPts = []; STATE.measCursor = null; STATE.measDone = false;
    STATE.selBox = null; STATE.selDrag = null; STATE.selStats = null;
    STATE.polyPts = []; STATE.polyCursor = null; STATE.polyDone = false;
    STATE.selCircle = null; STATE.selCircleDrag = null;
    STATE.measKind = ''; STATE.lastResult = '';
  }
  STATE.tool = id;
  if (toolGroup(id) !== 'coord') STATE.coordPick = null;   /* 换组即清掉拾取标记 */
  if (toolGroup(id) !== 'measure') { STATE.measCursor = null; }
  if (toolGroup(id) !== 'select') { STATE.selDrag = null; STATE.selCircleDrag = null; }

  var wrap = document.getElementById('mapwrap');
  if (wrap) wrap.classList.toggle('toolmode', !!id);
  syncToolUI();
  updateToolPanel();
  scheduleDraw();
}

function clearTool() {
  STATE.tool = '';
  STATE.measPts = []; STATE.measCursor = null; STATE.measDone = false; STATE.measKind = '';
  STATE.selBox = null; STATE.selDrag = null; STATE.selStats = null;
  STATE.polyPts = []; STATE.polyCursor = null; STATE.polyDone = false;
  STATE.selCircle = null; STATE.selCircleDrag = null;
  STATE.coordPick = null;
  STATE.lastResult = '';
  var wrap = document.getElementById('mapwrap');
  if (wrap) wrap.classList.remove('toolmode');
  syncToolUI();
  updateToolPanel();
  scheduleDraw();
}

/* 完成即退出工具：结果留在图上，地图立刻可拖动 */
function exitTool() {
  STATE.tool = '';
  STATE.measCursor = null;
  STATE.polyCursor = null;
  STATE.selDrag = null;
  STATE.selCircleDrag = null;
  var wrap = document.getElementById('mapwrap');
  if (wrap) wrap.classList.remove('toolmode');
  syncToolUI();
  updateToolPanel();
  scheduleDraw();
}

function syncToolUI() {
  var cur = STATE.tool;
  document.getElementById('btnMeasure').classList.toggle('on', toolGroup(cur) === 'measure');
  document.getElementById('btnSelect').classList.toggle('on', toolGroup(cur) === 'select');
  var bc = document.getElementById('btnCoord');
  if (bc) bc.classList.toggle('on', cur === 'coord');
  document.getElementById('flyMeasure').classList.remove('open');
  Array.prototype.forEach.call(document.querySelectorAll('#flyMeasure button'), function (b) {
    b.classList.toggle('on', b.getAttribute('data-tool') === cur);
  });
  Array.prototype.forEach.call(document.querySelectorAll('#flySelect button'), function (b) {
    b.classList.toggle('on', b.getAttribute('data-tool') === cur);
  });
}

/* 双击会先产生两次单击，末尾会多出重合顶点，去掉 */
function dedupeTail(P) {
  var tol = 6 * (map ? map.getView().getResolution() : 1);
  while (P.length > 2) {
    var a = P[P.length - 1], b = P[P.length - 2];
    if (Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol) P.pop();
    else break;
  }
}

function finishMulti() {
  var P = STATE.measPts;
  if (STATE.measDone || P.length < 2) return;
  dedupeTail(P);
  STATE.measDone = true;
  STATE.lastResult = 'measure';
  exitTool();
}
function finishPoly() {
  var P = STATE.polyPts;
  if (STATE.polyDone || P.length < 3) return;
  dedupeTail(P);
  if (P.length < 3) return;
  STATE.polyDone = true;
  STATE.polyCursor = null;
  STATE.lastResult = 'select';
  applySelection();
  exitTool();
}

/* 选区统计：遍历各栅格图层的生效点数（与画面所见一致） */
function applySelection() {
  var sel = currentSel();
  var test = makeSelTest(sel);
  if (!test) { STATE.selStats = null; updateToolPanel(); return; }
  var counts = [0, 0, 0, 0, 0, 0, 0], total = 0, rsum = 0, rn = 0, ssum = 0, sn = 0;
  var mrcnt = 0, mrpass = 0, weakRat = null;   /* 弱覆盖：达标采样数 / 总采样数 */
  var selMode = 'rsrp';   /* 档位分布按第一个可见栅格图层的着色模式显示 */
  for (var li = 0; li < layers.length; li++) {
    var L = layers[li];
    if (!L.visible || !L.ok || L.kind !== 'grid' || !L.buckets) continue;
    selMode = L.bandMode || 'rsrp';
    var rsrp = L.ds.num[L.rsrpCol];
    var sinr = L.ds.num[L.sinrCol];
    /* 弱覆盖门限分制式：5G 用 cnt105，4G 用 cnt110 */
    var cntAll = L.ds.num[L.cntCol];
    var cntThr = L.ds.num[(L.rat === '5G' ? L.cnt105Col : L.cnt110Col)];
    for (var bi = 0; bi < L.bandCount; bi++) {
      var idx = L.buckets[bi];
      for (var k = 0; k < idx.length; k++) {
        var i = idx[k];
        if (!test(L.mx[i], L.my[i])) continue;
        counts[bi]++;
        total++;
        if (rsrp) { var r = rsrp[i]; if (isFinite(r)) { rsum += r; rn++; } }
        if (sinr) { var s = sinr[i]; if (isFinite(s)) { ssum += s; sn++; } }
        if (cntAll && cntThr) {
          var a = cntAll[i], t = cntThr[i];
          if (isFinite(a) && isFinite(t)) { mrcnt += a; mrpass += t; }
        }
      }
    }
  }
  if (mrcnt > 0) weakRat = { pass: mrpass, total: mrcnt, ratio: mrpass / mrcnt };
  /* 记录制式（用于弱覆盖门限的标签显示） */
  var selRat = null;
  for (var li2 = 0; li2 < layers.length; li2++) {
    var L2 = layers[li2];
    if (L2.visible && L2.ok && L2.kind === 'grid' && L2.rat) { selRat = L2.rat; break; }
  }
  STATE.lastResult = 'select';
  STATE.selStats = {
    counts: counts, total: total, bandMode: selMode,
    rsrpMean: rn ? rsum / rn : null,
    sinrMean: sn ? ssum / sn : null,
    /* 采样点口径：总数 = Σ MRCnt，弱覆盖 = 总数 − 达标数（MRCnt_105/110） */
    sampTotal: mrcnt > 0 ? mrcnt : null,
    sampWeak: mrcnt > 0 ? Math.max(0, mrcnt - mrpass) : null,
    weak: weakRat,
    rat: selRat,
    kind: sel.type,
    box: sel.type === 'rect' ? sel.b.slice() : null,
    poly: sel.type === 'poly' ? sel.pts : null,
    circle: sel.type === 'circle' ? { c: sel.c.slice(), r: sel.r } : null
  };
  updateToolPanel();
  scheduleDraw();
}


function measureHtml() {
  var t = STATE.measKind || STATE.tool, P = STATE.measPts || [];
  var need = TOOLS[t] && TOOLS[t].clicks;
  if (!P.length) {
    var tip = need === 2 ? '依次点击 2 个点，得到两点间的方位角与距离。'
      : need === 3 ? '依次点击 3 个点，第 2 个点为顶点，得到两点夹角。'
        : '在地图上点击添加顶点。双击或右键结束，Esc 取消。';
    return '<div class="k">' + tip + '</div>';
  }
  var ll = P.map(function (p) { return mercToLonLat(p[0], p[1]); });
  var h = '';

  if (t === 'azimuth') {
    if (ll.length < 2) return '<div class="k">已取 1 个点，再点起点方向上的另一点。</div>';
    h += '<table>';
    h += '<tr><td class="k">方位角</td><td class="num hl">' + fmtAz(bearing(ll[0], ll[1])) + '</td></tr>';
    h += '<tr><td class="k">方向</td><td class="num">' + compass(bearing(ll[0], ll[1])) + '</td></tr>';
    h += '<tr><td class="k">距离</td><td class="num">' + fmtLen(groundDist(ll[0], ll[1])) + '</td></tr>';
    h += '</table>';
    return h;
  }

  if (t === 'angle') {
    if (ll.length < 3) return '<div class="k">已取 ' + ll.length + ' 个点，还需要 ' + (3 - ll.length) + ' 个。</div>';
    var ang = angleAt(ll[0], ll[1], ll[2]);
    h += '<table>';
    h += '<tr><td class="k">夹角</td><td class="num hl">' + ang.toFixed(2) + '°</td></tr>';
    h += '<tr><td class="k">补角</td><td class="num">' + (360 - ang).toFixed(2) + '°</td></tr>';
    h += '<tr><td class="k">边长 A-B</td><td class="num">' + fmtLen(groundDist(ll[0], ll[1])) + '</td></tr>';
    h += '<tr><td class="k">边长 B-C</td><td class="num">' + fmtLen(groundDist(ll[1], ll[2])) + '</td></tr>';
    h += '</table>';
    return h;
  }

  /* 测量线 / 测量面积 */
  var segs = [], total = 0, i;
  for (i = 1; i < ll.length; i++) { var d = groundDist(ll[i - 1], ll[i]); segs.push(d); total += d; }
  h += '<table>';
  for (i = 0; i < segs.length; i++) {
    h += '<tr><td class="k">第 ' + (i + 1) + ' 段</td><td class="num">' + fmtLen(segs[i]) + '</td></tr>';
  }
  if (segs.length) {
    h += '<tr><td class="k">总长度</td><td class="num' + (t === 'area' ? '' : ' hl') + '">' + fmtLen(total) + '</td></tr>';
  }
  if (t === 'area') {
    if (ll.length >= 3) {
      h += '<tr><td class="k">面积</td><td class="num hl">' + fmtArea(polyArea(ll)) + '</td></tr>';
      h += '<tr><td class="k">周长</td><td class="num">' + fmtLen(polyPerim(ll)) + '</td></tr>';
    } else {
      h += '<tr><td class="k">面积</td><td class="num">至少 3 个顶点</td></tr>';
    }
  } else if (ll.length >= 3) {
    h += '<tr><td class="k">闭合面积</td><td class="num">' + fmtArea(polyArea(ll)) + '</td></tr>';
  }
  h += '</table>';
  h += '<div class="k" style="margin-top:6px">' + ll.length + ' 个顶点' +
    /* 只在"测量进行中"提示。完成后工具已自动退出、再点击地图不会继续，
       原来的"再点一下开始新的测量"是错的，会误导 */
    ((toolGroup(STATE.tool) === 'measure' && !STATE.measDone) ? '（进行中）' : '') + '</div>';
  return h;
}

/* 弱覆盖标签：按制式给出门限与达标采样占比 */
function weakLabel(w, rat) {
  var thr = (rat === '5G') ? -105 : -110;
  return {
    name: '覆盖率 ≥' + thr + ' dBm',
    ratio: (w.ratio * 100).toFixed(1) + '%',
    /* 采样明细放悬停提示，不占面板空间 */
    tip: w.pass.toLocaleString() + ' / ' + w.total.toLocaleString() + ' 采样达标'
  };
}

function statTableHtml() {
  var s = STATE.selStats;
  if (!s) return '';
  var h = '<table>';  if (s.kind === 'poly' && s.poly) {
    var ll = s.poly.map(function (p) { return mercToLonLat(p[0], p[1]); });
    h += '<tr><td class="k">顶点数</td><td class="num">' + ll.length + '</td></tr>';
    h += '<tr><td class="k">周长</td><td class="num">' + fmtLen(polyPerim(ll)) + '</td></tr>';
    h += '<tr><td class="k">面积</td><td class="num hl">' + fmtArea(polyArea(ll)) + '</td></tr>';
  } else if (s.kind === 'circle' && s.circle) {
    var c = mercToLonLat(s.circle.c[0], s.circle.c[1]);
    var gr = s.circle.r * Math.cos(c[1] * Math.PI / 180);
    h += '<tr><td class="k">圆心</td><td class="num">' + c[0].toFixed(5) + ', ' + c[1].toFixed(5) + '</td></tr>';
    h += '<tr><td class="k">半径</td><td class="num">' + fmtLen(gr) + '</td></tr>';
    h += '<tr><td class="k">面积</td><td class="num hl">' + fmtArea(Math.PI * gr * gr) + '</td></tr>';
  } else if (s.box) {
    var b = s.box;
    var midY = (b[1] + b[3]) / 2, midX = (b[0] + b[2]) / 2;
    var w = groundDist(mercToLonLat(b[0], midY), mercToLonLat(b[2], midY));
    var hgt = groundDist(mercToLonLat(midX, b[1]), mercToLonLat(midX, b[3]));
    h += '<tr><td class="k">范围</td><td class="num">' + fmtLen(w) + ' × ' + fmtLen(hgt) + '</td></tr>';
    h += '<tr><td class="k">面积</td><td class="num">' + fmtArea(w * hgt) + '</td></tr>';
  }
  h += '<tr><td class="k">栅格点数</td><td class="num hl">' + s.total.toLocaleString() + '</td></tr>';
  if (s.sampTotal !== null && s.sampTotal !== undefined) {
    h += '<tr><td class="k">栅格采样点数</td><td class="num">' + s.sampTotal.toLocaleString() + '</td></tr>';
    h += '<tr><td class="k" title="低于弱覆盖门限（' + (s.rat === '5G' ? 'RSRP≥-105' : 'RSRP≥-110') +
      ' dBm 不达标）的采样点">弱覆盖采样点数</td><td class="num">' + s.sampWeak.toLocaleString() + '</td></tr>';
  }
  if (s.rsrpMean !== null) {
    h += '<tr><td class="k">RSRP 均值</td><td class="num">' + s.rsrpMean.toFixed(2) + ' dBm</td></tr>';
  }
  if (s.sinrMean !== null) {
    h += '<tr><td class="k">SINR 均值</td><td class="num">' + s.sinrMean.toFixed(2) + ' dB</td></tr>';
  }
  if (s.weak) {
    var wlabel = weakLabel(s.weak, s.rat);
    h += '<tr><td class="k">' + wlabel.name + '</td><td class="num" title="' +
      wlabel.tip + '">' + wlabel.ratio + '</td></tr>';
  }
  h += '</table>';
  if (!s.total) return h + '<div class="k" style="margin-top:6px">该区域内没有栅格点。</div>';
  h += '<div class="k" style="margin:7px 0 3px">档位分布</div><table class="dist">';
  var gm = GRID_MODES[s.bandMode ? s.bandMode : 'rsrp'];
  for (var i = 0; i < gm.bands.length; i++) {
    h += '<tr><td class="sw"><i style="background:' + gm.fill[i] + '"></i></td>' +
      '<td class="band">' + gm.bands[i].label + '</td>' +
      '<td class="num">' + s.counts[i].toLocaleString() + '</td>' +
      '<td class="pct">' + (s.counts[i] * 100 / s.total).toFixed(1) + '%</td></tr>';
  }
  return h + '</table>';
}


/* 十进制度 → 度分秒 */
function fmtDMS(v, isLat) {
  var hemi = isLat ? (v >= 0 ? 'N' : 'S') : (v >= 0 ? 'E' : 'W');
  var x = Math.abs(v);
  var d = Math.floor(x);
  var mf = (x - d) * 60;
  var m = Math.floor(mf);
  /* 秒先四舍五入到 0.1，再逐级处理进位（否则会出现 29'60.0" 这种） */
  var s = Math.round((mf - m) * 60 * 10) / 10;
  if (s >= 60) { s -= 60; m += 1; }
  if (m >= 60) { m -= 60; d += 1; }
  return d + '°' + m + "'" + s.toFixed(1) + '"' + hemi;
}

/* 找光标附近最近的栅格点（用于拾取时顺带给出该处数据） */
function nearestGridPoint(merc, tolPx) {
  var tol = (tolPx || 12) * map.getView().getResolution();
  var b = [merc[0] - tol, merc[1] - tol, merc[0] + tol, merc[1] + tol];
  var best = null, bd = Infinity;
  for (var li = 0; li < layers.length; li++) {
    var L = layers[li];
    if (!L.visible || !L.ok || L.kind !== 'grid' || !L.buckets) continue;
    var rsrp = L.ds.num[L.rsrpCol];
    for (var bi = 0; bi < (L.bandCount || 6); bi++) {
      var idx = L.buckets[bi];
      for (var k = 0; k < idx.length; k++) {
        var i = idx[k];
        var x = L.mx[i], y = L.my[i];
        if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
        var d = (x - merc[0]) * (x - merc[0]) + (y - merc[1]) * (y - merc[1]);
        if (d < bd) { bd = d; best = { band: bi, i: i, L: L, rsrp: rsrp }; }
      }
    }
  }
  return best;
}

function coordHtml() {
  var cp = STATE.coordPick;
  if (!cp) {
    return '<div class="k">在地图上点击任意位置，即可读取该点的经纬度。<br>' +
      '若点击处有栅格数据，会一并给出最近的栅格值。</div>';
  }
  var h = '<table>';
  h += '<tr><td class="k">经度</td><td class="num hl">' + cp.lon.toFixed(6) + '</td></tr>';
  h += '<tr><td class="k">纬度</td><td class="num hl">' + cp.lat.toFixed(6) + '</td></tr>';
  h += '<tr><td class="k">度分秒</td><td class="num" style="font-size:11.5px">' +
    fmtDMS(cp.lon, false) + '<br>' + fmtDMS(cp.lat, true) + '</td></tr>';
  h += '</table>';
  if (cp.near) {
    var n = cp.near;
    h += '<div class="k" style="margin:7px 0 3px">该点最近的栅格</div><table>';
    /* n.band 是拾取时的档位索引，若之后切了指标档位数会变，越界就不显示档位行 */
    if (n.band < gridBands(n.L).length) {
      h += '<tr><td class="sw"><i style="background:' + gridFill(n.L)[n.band] + '"></i></td>' +
        '<td>' + gridBands(n.L)[n.band].label + '</td><td class="num">距 ' + fmtLen(n.dist) + '</td></tr>';
    } else {
      h += '<tr><td></td><td>距 ' + fmtLen(n.dist) + '</td></tr>';
    }
    if (n.band >= 0) {
      var nc = mercToLonLat(n.x, n.y);
      h += '<tr><td class="k">栅格中心</td><td class="num" style="font-size:11.5px">' +
        nc[0].toFixed(5) + ', ' + nc[1].toFixed(5) + '</td></tr>';
    }
    if (n.rsrpVal !== null) h += '<tr><td class="k">RSRP</td><td class="num">' + n.rsrpVal.toFixed(2) + ' dBm</td></tr>';
    h += '</table>';
  } else {
    h += '<div class="k" style="margin-top:6px">该点附近没有栅格数据。</div>';
  }
  h += '<div class="mini" style="margin-top:8px">' +
    '<button id="tpCopy" style="flex:1">复制经纬度</button></div>';
  return h;
}

function updateToolPanel() {
  var p = document.getElementById('toolPanel');
  if (!p) return;
  var t = STATE.tool, g = toolGroup(t);
  var title = '', html = '';
  if (g === 'measure') {
    title = TOOLS[t].label;
    html = measureHtml();
  } else if (g === 'select') {
    title = TOOLS[t].label;
    if (STATE.selStats) html = statTableHtml();
    else if (t === 'poly') html = '<div class="k">逐点点出多边形，双击或右键闭合。</div>';
    else if (t === 'free') html = '<div class="k">按住鼠标自由画一圈，松开即完成选择。</div>';
    else if (t === 'radius') html = '<div class="k">按下作为圆心，拖动确定半径，松开完成选择。</div>';
    else html = '<div class="k">按住鼠标拖出一个矩形。</div>';
  } else if (t === 'coord') {
    title = '经纬度拾取';
    html = coordHtml();
  } else if (STATE.lastResult === 'measure' && STATE.measPts.length && STATE.measKind) {
    title = TOOLS[STATE.measKind].label;
    html = measureHtml();
  } else if (STATE.selStats) {
    title = '选区统计';
    html = statTableHtml();
  } else if (STATE.measPts.length && STATE.measKind) {
    title = TOOLS[STATE.measKind].label;
    html = measureHtml();
  }
  if (!html) { p.classList.remove('show'); return; }
  var wasHidden = !p.classList.contains('show');
  document.getElementById('tpTitle').textContent = title;
  document.getElementById('tpBody').innerHTML = html;
  p.classList.add('show');
  if (wasHidden && p.__clamp) p.__clamp();
  var cab = document.getElementById('tpCopy');
  if (cab) cab.onclick = copyCoords;
}

/* ---------------- 绘制 ---------------- */

function drawMeasure(c, t, w, h) {
  var P = STATE.measPts || [];
  if (!P.length) return;
  var kind = STATE.measKind || STATE.tool;
  function toPx(p) { return [t[0] * p[0] + t[2] * p[1] + t[4], t[1] * p[0] + t[3] * p[1] + t[5]]; }
  var pts = P.map(toPx);
  var live = (!STATE.measDone && STATE.measCursor) ? toPx(STATE.measCursor) : null;
  var close = (kind === 'area' && pts.length >= 3);
  var line = pts.concat(live ? [live] : []);
  var ll = P.map(function (p) { return mercToLonLat(p[0], p[1]); });

  c.save();
  c.font = '12px "Microsoft YaHei","PingFang SC",sans-serif';
  c.textBaseline = 'middle';
  c.lineJoin = 'round';

  if (close) {
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (var q = 1; q < pts.length; q++) c.lineTo(pts[q][0], pts[q][1]);
    c.closePath();
    c.fillStyle = 'rgba(59,130,246,0.16)';
    c.fill();
  }

  c.lineWidth = 2;
  c.strokeStyle = 'rgba(59,130,246,0.95)';
  c.beginPath();
  c.moveTo(line[0][0], line[0][1]);
  for (var i = 1; i < line.length; i++) c.lineTo(line[i][0], line[i][1]);
  c.stroke();

  /* 顶点 */
  for (var j = 0; j < pts.length; j++) {
    c.beginPath();
    c.arc(pts[j][0], pts[j][1], 4, 0, Math.PI * 2);
    c.fillStyle = '#fff';
    c.fill();
    c.lineWidth = 2;
    c.strokeStyle = '#3b82f6';
    c.stroke();
  }

  function label(x, y, txt, accent) {
    var tw = c.measureText(txt).width + 12, bh = 19;
    var bx = x, by = y;
    if (bx + tw > w - 4) bx = w - tw - 4;
    if (bx < 4) bx = 4;
    if (by + bh > h - 4) by = h - bh - 4;
    if (by < 4) by = 4;
    roundRect(c, bx, by, tw, bh, 5);
    c.fillStyle = accent ? 'rgba(59,130,246,0.94)' : 'rgba(20,22,26,0.86)';
    c.fill();
    c.fillStyle = accent ? '#fff' : '#e6e8ec';
    c.fillText(txt, bx + 6, by + bh / 2 + 0.5);
  }

  if (kind === 'azimuth' && ll.length >= 2) {
    var az = bearing(ll[0], ll[1]);
    var mid = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
    label(mid[0] + 8, mid[1] - 24, fmtAz(az) + '　' + fmtLen(groundDist(ll[0], ll[1])), true);
    /* 指北箭头 */
    c.save();
    c.translate(pts[0][0], pts[0][1]);
    c.rotate(az * Math.PI / 180);
    c.strokeStyle = 'rgba(59,130,246,0.95)';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(0, 0); c.lineTo(0, -26);
    c.stroke();
    c.beginPath();
    c.moveTo(0, -34); c.lineTo(-5, -24); c.lineTo(5, -24);
    c.closePath();
    c.fillStyle = 'rgba(59,130,246,0.95)';
    c.fill();
    c.restore();
    label(pts[0][0] + 10, pts[0][1] + 8, '正北基准', false);
  } else if (kind === 'angle' && ll.length >= 3) {
    var a = angleAt(ll[0], ll[1], ll[2]);
    var B = pts[1];
    label(B[0] + 12, B[1] - 26, a.toFixed(2) + '°', true);
    var r1 = Math.hypot(pts[0][0] - B[0], pts[0][1] - B[1]);
    var r2 = Math.hypot(pts[2][0] - B[0], pts[2][1] - B[1]);
    var rr = Math.min(34, r1 * 0.42, r2 * 0.42);
    if (rr > 8) {
      var a1 = Math.atan2(pts[0][1] - B[1], pts[0][0] - B[0]);
      var a2 = Math.atan2(pts[2][1] - B[1], pts[2][0] - B[0]);
      c.beginPath();
      c.arc(B[0], B[1], rr, a1, a2, (a2 - a1 + Math.PI * 2) % (Math.PI * 2) > Math.PI);
      c.strokeStyle = 'rgba(59,130,246,0.8)';
      c.lineWidth = 1.4;
      c.stroke();
    }
    label(pts[1][0] - 12, pts[1][1] + 14, '顶点', false);
  } else {
    var total = 0;
    for (var k = 1; k < ll.length; k++) {
      var d = groundDist(ll[k - 1], ll[k]);
      total += d;
      var A = pts[k - 1], C = pts[k];
      if (Math.hypot(C[0] - A[0], C[1] - A[1]) < 46) continue;
      label((A[0] + C[0]) / 2 + 8, (A[1] + C[1]) / 2 - 20, fmtLen(d), false);
    }
    if (ll.length >= 2) {
      var txt = (kind === 'area' && ll.length >= 3)
        ? '总计 ' + fmtLen(total) + '　面积 ' + fmtArea(polyArea(ll))
        : '总计 ' + fmtLen(total);
      var last = pts[pts.length - 1];
      label(last[0] + 12, last[1] + 10, txt, true);
    }
  }
  c.restore();
}

function drawSelection(c, t, w, h) {
  c.save();
  c.setLineDash([6, 4]);
  c.lineWidth = 1.5;
  c.strokeStyle = 'rgba(59,130,246,0.95)';
  c.fillStyle = 'rgba(59,130,246,0.12)';

  /* 矩形 */
  var b = STATE.selDrag || STATE.selBox;
  if (b) {
    var x0 = t[0] * b[0] + t[2] * b[1] + t[4], y0 = t[1] * b[0] + t[3] * b[1] + t[5];
    var x1 = t[0] * b[2] + t[2] * b[3] + t[4], y1 = t[1] * b[2] + t[3] * b[3] + t[5];
    var L = Math.min(x0, x1), T = Math.min(y0, y1);
    var W = Math.abs(x1 - x0), H = Math.abs(y1 - y0);
    if (W >= 1 && H >= 1) {
      c.fillRect(L, T, W, H);
      c.strokeRect(L + 0.5, T + 0.5, W - 1, H - 1);
    }
  }

  /* 圆（按半径选择） */
  var sc = STATE.selCircleDrag || STATE.selCircle;
  if (sc) {
    var cx = t[0] * sc.c[0] + t[2] * sc.c[1] + t[4];
    var cy = t[1] * sc.c[0] + t[3] * sc.c[1] + t[5];
    var rp = sc.r * Math.abs(t[0]);
    if (rp > 1) {
      c.beginPath();
      c.arc(cx, cy, rp, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      c.setLineDash([]);
      /* 圆心十字 */
      c.beginPath();
      c.moveTo(cx - 6, cy); c.lineTo(cx + 6, cy);
      c.moveTo(cx, cy - 6); c.lineTo(cx, cy + 6);
      c.lineWidth = 1.6;
      c.stroke();
      /* 半径线 + 标注 */
      c.beginPath();
      c.moveTo(cx, cy);
      c.lineTo(cx + rp, cy);
      c.lineWidth = 1.2;
      c.stroke();
      var lat0 = mercToLonLat(sc.c[0], sc.c[1])[1];
      var txt = fmtLen(sc.r * Math.cos(lat0 * Math.PI / 180));
      c.font = '12px "Microsoft YaHei","PingFang SC",sans-serif';
      c.textBaseline = 'middle';
      var tw = c.measureText(txt).width + 12, bh = 19;
      var lx = cx + rp / 2 - tw / 2, ly = cy - bh - 5;
      if (lx < 4) lx = 4;
      if (lx + tw > w - 4) lx = w - tw - 4;
      if (ly < 4) ly = cy + 6;
      roundRect(c, lx, ly, tw, bh, 5);
      c.fillStyle = 'rgba(59,130,246,0.94)';
      c.fill();
      c.fillStyle = '#fff';
      c.fillText(txt, lx + 6, ly + bh / 2 + 0.5);
      c.setLineDash([6, 4]);
      c.strokeStyle = 'rgba(59,130,246,0.95)';
      c.fillStyle = 'rgba(59,130,246,0.12)';
      c.lineWidth = 1.5;
    }
  }

  /* 经纬度拾取标记 */
  if (STATE.coordPick) {
    var qx = t[0] * STATE.coordPick.x + t[2] * STATE.coordPick.y + t[4];
    var qy = t[1] * STATE.coordPick.x + t[3] * STATE.coordPick.y + t[5];
    c.setLineDash([]);
    c.lineWidth = 2;
    c.strokeStyle = '#f59e0b';
    c.beginPath();
    c.arc(qx, qy, 9, 0, Math.PI * 2);
    c.stroke();
    c.beginPath();
    c.moveTo(qx - 15, qy); c.lineTo(qx - 4, qy);
    c.moveTo(qx + 4, qy); c.lineTo(qx + 15, qy);
    c.moveTo(qx, qy - 15); c.lineTo(qx, qy - 4);
    c.moveTo(qx, qy + 4); c.lineTo(qx, qy + 15);
    c.lineWidth = 1.6;
    c.stroke();
  }

  /* 多边形 / 自由手绘 */
  var P = STATE.polyPts || [];
  if (P.length) {
    var pts = P.map(function (p) { return [t[0] * p[0] + t[2] * p[1] + t[4], t[1] * p[0] + t[3] * p[1] + t[5]]; });
    var live = (!STATE.polyDone && STATE.polyCursor)
      ? [t[0] * STATE.polyCursor[0] + t[2] * STATE.polyCursor[1] + t[4],
         t[1] * STATE.polyCursor[0] + t[3] * STATE.polyCursor[1] + t[5]] : null;
    var line = live ? pts.concat([live]) : pts;
    c.beginPath();
    c.moveTo(line[0][0], line[0][1]);
    for (var j = 1; j < line.length; j++) c.lineTo(line[j][0], line[j][1]);
    if (STATE.polyDone && pts.length >= 3) {
      c.closePath();
      c.fill();
    }
    c.stroke();
    if (pts.length <= 24) {
      c.setLineDash([]);
      for (var q = 0; q < pts.length; q++) {
        c.beginPath();
        c.arc(pts[q][0], pts[q][1], 3.5, 0, Math.PI * 2);
        c.fillStyle = '#fff';
        c.fill();
        c.lineWidth = 2;
        c.strokeStyle = '#3b82f6';
        c.stroke();
      }
    }
  }

  c.restore();
}

/* ---------------- 事件 ---------------- */

/* 工具模式要放行的 UI：工具条/面板、顶栏、图例、主题按钮，
   以及 OpenLayers 自带控件（缩放 +/- 等），否则工具激活时它们会失效 */
var TOOL_UI_SEL = '#toolStrip,#toolPanel,#topbar,#legend,#btnTheme,.ol-control';

function copyCoords() {
  var cp = STATE.coordPick;
  if (!cp) return;
  var txt = cp.lon.toFixed(6) + ',' + cp.lat.toFixed(6);
  function done() { showErr('已复制：' + txt); }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(done, function () { fallbackCopy(txt, done); });
  } else fallbackCopy(txt, done);
}
function fallbackCopy(txt, done) {
  var ta = document.createElement('textarea');
  ta.value = txt;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { showErr('复制失败，请手动选取：' + txt); }
  document.body.removeChild(ta);
}

/* 工具结果面板拖动 */
function initToolPanelDrag() {
  var p = document.getElementById('toolPanel');
  var wrap = document.getElementById('mapwrap');
  if (!p || !wrap) return;
  var head = p.querySelector('.tp-h');
  var cur = null;
  try { cur = JSON.parse(localStorage.getItem('tool_panel_pos') || 'null'); } catch (e) { }

  function clamp() {
    if (!p.offsetParent) return;                 /* 隐藏时不计算 */
    var W = wrap.clientWidth, H = wrap.clientHeight;
    var r = p.getBoundingClientRect();
    var l = p.offsetLeft, tt = p.offsetTop;
    l = Math.min(Math.max(l, 6), Math.max(6, W - r.width - 6));
    tt = Math.min(Math.max(tt, 6), Math.max(6, H - r.height - 6));
    p.style.left = l + 'px';
    p.style.top = tt + 'px';
    cur = { l: l, t: tt };
  }
  p.__clamp = function () { if (cur) clamp(); };

  if (cur) { p.style.left = cur.l + 'px'; p.style.top = cur.t + 'px'; }

  var drag = null;
  head.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    /* 标题栏里的按钮（✕ 等）照常工作：不 preventDefault、不抢指针捕获，
       否则 click 会被重定向到标题栏，按钮收不到点击 */
    if (e.target && e.target.closest && e.target.closest('button')) return;
    e.stopPropagation();
    e.preventDefault();
    drag = { x: e.clientX, y: e.clientY, l: p.offsetLeft, t: p.offsetTop, moved: false };
    try { head.setPointerCapture(e.pointerId); } catch (er) { }
  });
  head.addEventListener('pointermove', function (e) {
    if (!drag) return;
    e.stopPropagation();
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;
    p.style.left = (drag.l + dx) + 'px';
    p.style.top = (drag.t + dy) + 'px';
  });
  head.addEventListener('pointerup', function (e) {
    if (!drag) return;
    e.stopPropagation();
    var moved = drag.moved;
    drag = null;
    if (!moved) return;
    clamp();
    try { localStorage.setItem('tool_panel_pos', JSON.stringify(cur)); } catch (er) { }
  });
  global.addEventListener('resize', function () { if (cur) clamp(); });
}

function initTools() {
  var wrap = document.getElementById('mapwrap');
  if (!wrap) return;
  var down = null;
  var mid = null;          /* 中键拖动平移状态 */

  function onUI(e) { return e.target && e.target.closest && e.target.closest(TOOL_UI_SEL); }
  function merc(e) { return mercAtEvent(e); }
  function startPan(e) {
    var v = map.getView();
    mid = { x: e.clientX, y: e.clientY, c: v.getCenter().slice() };
    wrap.classList.add('panning');
    try { wrap.setPointerCapture(e.pointerId); } catch (er) { }
  }
  function endPan() {
    mid = null;
    wrap.classList.remove('panning');
  }


  wrap.addEventListener('mousedown', function (e) {
    if (e.button === 1 && !onUI(e)) e.preventDefault();
  }, { capture: true });

  /* 组按钮：点击开合子菜单 */
  function bindGroup(btnId, grpId) {
    document.getElementById(btnId).onclick = function (e) {
      e.stopPropagation();
      var g = document.getElementById(grpId);
      var open = !g.classList.contains('open');
      closeFlys();
      g.classList.toggle('open', open);
    };
  }
  function closeFlys() {
    Array.prototype.forEach.call(document.querySelectorAll('.tgroup'), function (g) {
      g.classList.remove('open');
    });
  }
  bindGroup('btnMeasure', 'grpMeasure');
  bindGroup('btnSelect', 'grpSelect');
  document.addEventListener('click', closeFlys);

  Array.prototype.forEach.call(document.querySelectorAll('#flyMeasure button,#flySelect button'), function (b) {
    b.onclick = function (e) {
      e.stopPropagation();
      closeFlys();
      setTool(b.getAttribute('data-tool'));
    };
  });

  document.getElementById('tpClose').onclick = function () { clearTool(); };
  document.getElementById('btnCoord').onclick = function () { setTool('coord'); };
  initToolPanelDrag();
  initPopupDrag();

  /* Dock 式悬停放大：只切 hot/near 两个类，缩放交给 CSS，
     不做逐帧距离计算，避免和地图重绘抢帧 */
  var tbtns = Array.prototype.slice.call(document.querySelectorAll('#toolStrip button.tbtn'));
  function hoverAt(i) {
    tbtns.forEach(function (b, k) {
      b.classList.toggle('hot', k === i);
      b.classList.toggle('near', i >= 0 && Math.abs(k - i) === 1);
    });
  }
  tbtns.forEach(function (b, i) {
    b.addEventListener('mouseenter', function () { hoverAt(i); });
  });
  /* 注意要挂在工具条上：挂 #mapwrap 的话，鼠标从按钮移进地图区不会触发 mouseleave，
     按钮会一直保持放大状态 */
  var stripEl = document.getElementById('toolStrip');
  if (stripEl) stripEl.addEventListener('mouseleave', function () { hoverAt(-1); });

  /* 独立图标按钮（开合/主题/缩放）统一悬停放大 —— 用 .hov 类，与工具条的类机制一致，
     而且 :hover 伪类不响应合成事件，类切换能被自动化测试验证 */
  document.addEventListener('mouseover', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('#btnFold,#btnTheme,.ol-control button') : null;
    if (b) b.classList.add('hov');
  }, true);
  document.addEventListener('mouseout', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('#btnFold,#btnTheme,.ol-control button') : null;
    if (b) b.classList.remove('hov');
  }, true);

  var CAP = { capture: true };

  wrap.addEventListener('pointerdown', function (e) {
    if (onUI(e)) return;
    /* 中键拖动平移：任何状态（含工具激活）都能平移视图 */
    if (e.button === 1) {
      e.stopPropagation();
      e.preventDefault();
      startPan(e);
      return;
    }
    if (!STATE.tool) return;
    e.stopPropagation();
    e.preventDefault();
    down = { x: e.clientX, y: e.clientY, moved: false, tool: STATE.tool };
    var p = merc(e);
    if (!p) return;
    if (STATE.tool === 'rect') STATE.selDrag = [p[0], p[1], p[0], p[1]];
    else if (STATE.tool === 'radius') STATE.selCircleDrag = { c: p, r: 0 };
    else if (STATE.tool === 'free') STATE.polyPts = [p];
    try { wrap.setPointerCapture(e.pointerId); } catch (er) { }
  }, CAP);

  wrap.addEventListener('pointermove', function (e) {
    if (mid) {
      e.stopPropagation();
      var v2 = map.getView(), res = v2.getResolution();
      v2.setCenter([mid.c[0] - (e.clientX - mid.x) * res,
                    mid.c[1] + (e.clientY - mid.y) * res]);
      return;
    }
    if (!STATE.tool) return;
    if (down && (Math.abs(e.clientX - down.x) > 3 || Math.abs(e.clientY - down.y) > 3)) down.moved = true;
    var t = STATE.tool;
    if (t === 'rect' || t === 'radius' || t === 'free') {
      if (!down || !down.moved) return;
      e.stopPropagation();
      var p = merc(e);
      if (!p) return;
      if (t === 'rect' && STATE.selDrag) { STATE.selDrag[2] = p[0]; STATE.selDrag[3] = p[1]; }
      else if (t === 'radius' && STATE.selCircleDrag) {
        var c0 = STATE.selCircleDrag.c;
        STATE.selCircleDrag.r = Math.hypot(p[0] - c0[0], p[1] - c0[1]);
      } else if (t === 'free') {
        var P = STATE.polyPts, last = P[P.length - 1];
        var tol = 3 * map.getView().getResolution();
        if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) > tol) P.push(p);
      }
      scheduleDraw();
      return;
    }
    if (down && !down.moved) return;
    if ((t === 'line' || t === 'area' || t === 'azimuth' || t === 'angle') &&
        !STATE.measDone && STATE.measPts.length) {
      var c1 = merc(e);
      if (c1) { STATE.measCursor = c1; scheduleDraw(); }
    } else if (t === 'poly' && !STATE.polyDone && STATE.polyPts.length) {
      var c2 = merc(e);
      if (c2) { STATE.polyCursor = c2; scheduleDraw(); }
    }
  }, CAP);

  wrap.addEventListener('pointerup', function (e) {
    if (mid) { endPan(); return; }
    if (!STATE.tool) return;
    var t = STATE.tool;
    var moved = down && down.moved;
    down = null;
    if (onUI(e)) return;
    e.stopPropagation();

    if (t === 'rect') {
      if (STATE.selDrag) {
        normalizeBox(STATE.selDrag);
        if (STATE.selDrag[2] - STATE.selDrag[0] > 0 && STATE.selDrag[3] - STATE.selDrag[1] > 0) {
          STATE.selBox = STATE.selDrag.slice();
          applySelection();
        }
      }
      STATE.selDrag = null;
      exitTool();
      return;
    }
    if (t === 'radius') {
      if (STATE.selCircleDrag && STATE.selCircleDrag.r > 0) {
        STATE.selCircle = { c: STATE.selCircleDrag.c.slice(), r: STATE.selCircleDrag.r };
        applySelection();
      }
      STATE.selCircleDrag = null;
      exitTool();
      return;
    }
    if (t === 'free') {
      if (STATE.polyPts.length >= 3) {
        STATE.polyDone = true; STATE.lastResult = 'select';
        applySelection(); exitTool();
      } else { STATE.polyPts = []; updateToolPanel(); scheduleDraw(); }
      return;
    }
    if (!moved) {
      var p = merc(e);
      if (p) onToolClick(t, e, p);
    }
  }, CAP);

  wrap.addEventListener('dblclick', function (e) {
    if (!STATE.tool || onUI(e)) return;
    e.stopPropagation();
    e.preventDefault();
    var g = toolGroup(STATE.tool);
    if (g === 'measure') finishMulti();
    else if (STATE.tool === 'poly') finishPoly();
  }, CAP);

  wrap.addEventListener('contextmenu', function (e) {
    if (!STATE.tool || onUI(e)) return;
    e.stopPropagation();
    e.preventDefault();
    var g = toolGroup(STATE.tool);
    if (g === 'measure') finishMulti();
    else if (STATE.tool === 'poly') finishPoly();
  }, CAP);

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (STATE.tool) clearTool();
    else if (STATE.selStats) {
      STATE.selBox = null; STATE.polyPts = []; STATE.selCircle = null;
      STATE.selStats = null;
      updateToolPanel(); scheduleDraw();
    }
  });
}

function onToolClick(t, e, p) {
  var def = TOOLS[t] || {};
  if (t === 'coord') {
    var ll = mercToLonLat(p[0], p[1]);
    var near = nearestGridPoint(p, 14);
    var val = null, dist = 0;
    if (near && near.rsrp) {
      var rv = near.rsrp[near.i];
      if (isFinite(rv)) val = rv;
    }
    if (near) {
      var nx = near.L.mx[near.i], ny = near.L.my[near.i];
      dist = Math.hypot(nx - p[0], ny - p[1]);
      var ln = mercToLonLat(nx, ny);
      near = { band: near.band, x: nx, y: ny, dist: dist, rsrpVal: val, lon: ln[0], lat: ln[1] };
    }
    STATE.coordPick = { x: p[0], y: p[1], lon: ll[0], lat: ll[1], near: near };
    updateToolPanel();
    scheduleDraw();
    return;                       /* 拾取工具连续可用，不自动退出 */
  }
  if (t === 'poly') {
    if (STATE.polyDone) { STATE.polyPts = []; STATE.polyDone = false; STATE.selStats = null; }
    STATE.polyPts.push(p);
    STATE.polyCursor = null;
    updateToolPanel();
    scheduleDraw();
    return;
  }
  /* 测量类 */
  if (STATE.measDone) { STATE.measPts = []; STATE.measDone = false; }
  if (!STATE.measPts.length) STATE.measKind = t;
  STATE.measPts.push(p);
  STATE.measCursor = null;
  if (def.clicks && STATE.measPts.length >= def.clicks) {
    /* 固定点数的工具，取够即出结果并退出 */
    STATE.measDone = true;
    STATE.lastResult = 'measure';
    exitTool();
    return;
  }
  updateToolPanel();
  scheduleDraw();
}
/* ============================ 13. 加载流程 ============================ */

function srcOfFile(file) {
  return {
    size: file.size,
    read: function (a, b) {
      return file.slice(a, b).arrayBuffer();
    }
  };
}

function busy(title) {
  document.getElementById('busyT').textContent = title;
  document.getElementById('busyBar').style.width = '0%';
  document.getElementById('busyS').textContent = '';
  document.getElementById('busy').classList.remove('hide');
}
function busySet(p, rows) {
  document.getElementById('busyBar').style.width = (p * 100).toFixed(1) + '%';
  document.getElementById('busyS').textContent = '已解析 ' + (rows || 0).toLocaleString() +
    ' 行 · ' + (p * 100).toFixed(0) + '%';
}
function busyOff() { document.getElementById('busy').classList.add('hide'); }
function busyPhase(t) { document.getElementById('busyT').textContent = t; }
/* 让出主线程，保证进度文字先画出来再干重活（rAF 保证已绘制，300ms 兜底防后台标签页 rAF 不触发） */
function yieldFrame() {
  return new Promise(function (res) {
    var done = false;
    function go() { if (!done) { done = true; res(); } }
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () { setTimeout(go, 0); });
    }
    setTimeout(go, 300);
  });
}

/* 报错弹窗：文本写进子节点（避免覆盖关闭按钮），8 秒自动消失，点 X 可立即关闭 */
function showErr(msg) {
  var el = document.getElementById('err');
  document.getElementById('errMsg').textContent = msg;
  el.style.display = 'flex';
  clearTimeout(showErr._t);
  showErr._t = setTimeout(function () { el.style.display = 'none'; }, 8000);
}
function hideErr() {
  clearTimeout(showErr._t);
  var el = document.getElementById('err');
  if (el) el.style.display = 'none';
}

async function loadFiles(fileList) {
  rflog('loadFiles begin n=' + (fileList && fileList.length));
  var files = Array.prototype.slice.call(fileList).filter(function (f) {
    return /\.(csv|txt|tsv|json|geojson|xlsx|xls)$/i.test(f.name);
  });
  if (!files.length) { showErr('没有可识别的数据文件（支持 csv/txt/geojson/xlsx）'); return; }

  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    /* 同名图层替换：自动恢复后再导入同一文件 = 更新而非叠加（防列表/数据翻倍） */
    for (var d = layers.length - 1; d >= 0; d--) {
      if (layers[d].name === f.name) removeLayer(layers[d]);
    }
    busy('正在解析：' + f.name + '（' + (f.size / 1048576).toFixed(1) + ' MB）');
    try {
      var ds;
      if (/\.(xlsx|xls)$/i.test(f.name)) {
        busySet(0.2, 0);
        ds = await parseXlsx(f, f.name);
      } else {
        /* 解析只占 0~80%，建图层 / 绘制另算进度，避免进度条停在"假 93%" */
        ds = await parseDelimited(srcOfFile(f), f.name, function (p, r) {
          busySet(p * 0.8, r);
        });
      }
      busyPhase('正在构建图层…');
      busySet(0.86, ds.n);
      await yieldFrame();
      var kind = classifyLayer(f.name, ds.columns);
      var L = makeLayer(ds, kind);
      layers.push(L);
      if (L.ok) {
        projectLayer(L);
        await yieldFrame();
        if (L.kind === 'grid') {
          /* 顶部城市按钮当前选中的地市对新载入图层同样生效 */
          if (STATE.cityFilter && STATE.cityFilter !== '*') setLayerCity(L, STATE.cityFilter);
          rebuildBuckets(L, true);
          await yieldFrame();
          try { buildGridGL(L); } catch (e) { L.glOk = false; }
          await yieldFrame();
        }
      }
      if (!selected) selectLayer(L);
      renderLayerList();
      busyPhase('正在绘制…');
      busySet(0.95, ds.n);
      await yieldFrame();
      if (L.ok) {
        /* 首次定位不用动画：动画期间每帧都要重绘几十万个扇区，直接卡死 */
        if (layers.length === 1 || !map.getView().getCenter()) fitLayer(L, 0);
      }
    } catch (e) {
      showErr('解析失败：' + f.name + ' — ' + (e && e.message ? e.message : e));
    }
    busyOff();
    await yieldFrame();
  }
  busyOff();
  renderLayerList();
  selectLayer(selected);
  scheduleDraw();
  rflog('loadFiles end');
  /* 解析后的数据集写入 IndexedDB 缓存（异步）：失败在恢复条上可见，不能无声吞掉。
     快照对象是「当前会话全部图层」——分多次导入时自动合并，后导入的不会覆盖先导入的。
     自动化测试页用 __NO_SESSION_CACHE 跳过，避免污染真实缓存 */
  refreshSessionCache();
}

/* ============================ 14. 事件绑定 ============================ */

function bindUI() {
  var $ = function (id) { return document.getElementById(id); };

  /* 密钥管理 */
  loadKeys();
  $('tkInput').value = '';

  /* 密钥设置弹窗开关（顶部状态按钮） */
  $('btnTk').onclick = function () {
    var pop = $('tkPop');
    pop.classList.toggle('show');
  };
  $('tkClose').onclick = function () { $('tkPop').classList.remove('show'); };

  $('tkEye').onclick = function () {
    var inp = $('tkInput');
    var show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    this.classList.toggle('on', show);
  };
  $('tkSave').onclick = function () {
    var v = $('tkInput').value.trim();
    if (!v) { showErr('请先输入天地图 key'); return; }
    if (STATE.keys.indexOf(v) < 0) STATE.keys.push(v);
    STATE.tk = v;
    $('tkInput').value = '';
    $('tkInput').type = 'password';
    $('tkEye').classList.remove('on');
    persistKeys();
    renderKeySelect();
    rebuildBase();
    setTdtStatus('已保存 ' + maskKey(v), 'ok');
  };
  $('tkInput').onkeydown = function (e) { if (e.key === 'Enter') $('tkSave').click(); };

  $('tkSel').onchange = function (e) {
    var i = parseInt(e.target.value, 10);
    if (!isNaN(i) && STATE.keys[i]) {
      STATE.tk = STATE.keys[i];
      persistKeys();
      rebuildBase();
    }
  };
  $('tkDel').onclick = function () {
    var i = STATE.keys.indexOf(STATE.tk);
    if (i < 0) { showErr('当前没有可删除的密钥'); return; }
    if (!global.confirm('确定删除密钥 ' + maskKey(STATE.tk) + ' ？')) return;
    STATE.keys.splice(i, 1);
    STATE.tk = STATE.keys.length ? STATE.keys[0] : '';
    persistKeys();
    renderKeySelect();
    rebuildBase();
  };



  renderKeySelect();

  /* 底图切换（自定义下拉，带展开过渡） */
  initBaseDropdown();
  /* 顶部城市筛选 + 栅格着色（与侧栏设置双向同步） */
  initCityDropdown();
  initColorModeDropdown();

  /* 测量 / 框选工具 */
  initTools();

  /* 数据加载 */
  $('btnDir').onclick = function () {
    if (!FSA_OK) { $('pickDir').click(); return; }
    window.showDirectoryPicker({ mode: 'read', id: 'raster-data' })
      .then(function (dir) {
        return loadFromEntries([{ kind: 'dir', handle: dir, name: dir.name }], true);
      })
      .catch(function (e) {
        if (e && e.name === 'AbortError') return;   /* 用户主动取消 */
        $('pickDir').click();                       /* 其他异常回退到传统选择 */
      });
  };
  $('btnFiles').onclick = function () {
    if (!FSA_OK || !window.showOpenFilePicker) { $('pickFiles').click(); return; }
    window.showOpenFilePicker({ multiple: true, id: 'raster-files' })
      .then(function (hs) {
        var ents = hs.map(function (h) { return { kind: 'file', handle: h, name: h.name }; });
        return loadFromEntries(ents, true);
      })
      .catch(function (e) {
        if (e && e.name === 'AbortError') return;
        $('pickFiles').click();
      });
  };
  $('pickDir').onchange = function (e) { loadFiles(e.target.files); e.target.value = ''; };
  $('pickFiles').onchange = function (e) { loadFiles(e.target.files); e.target.value = ''; };

  $('btnRestore').onclick = function () {
    /* 从源更新 = 替换：先清掉当前图层，避免与缓存恢复的图层叠加重复 */
    clearAllLayers();
    restoreSources().then(function () { restoreSessionState(); }).catch(function () { });
  };
  $('btnForget').onclick = function () {
    idbDel('sources').then(function () {
      srcEntries = [];
      updateRestoreBar();
      showErr('已清除记住的数据源。');
    }).catch(function () { });
  };
  $('btnClearCache').onclick = function () {
    idbDelCache().then(function () {
      cacheInfo = null;
      updateRestoreBar();
      showErr('已清除数据缓存：当前页面里的数据仍可用，刷新后需重新导入。');
    }).catch(function () { });
  };
  initSourceRestore();

  var wrap = $('mapwrap');
  wrap.addEventListener('dragover', function (e) { e.preventDefault(); });
  wrap.addEventListener('drop', function (e) {
    e.preventDefault();
    var dt = e.dataTransfer;
    var plainFiles = (dt && dt.files && dt.files.length) ? dt.files : null;
    /* 句柄必须在事件同步阶段抓取，异步之后就失效了 */
    var pending = [];
    if (dt && dt.items) {
      for (var i = 0; i < dt.items.length; i++) {
        var it = dt.items[i];
        if (it.kind !== 'file' || !it.getAsFileSystemHandle) continue;
        try {
          var pr = it.getAsFileSystemHandle();
          if (pr) pending.push(pr);
        } catch (er) { }
      }
    }
    if (pending.length) {
      Promise.all(pending).then(function (hs) {
        var ents = [];
        for (var k = 0; k < hs.length; k++) {
          var h = hs[k];
          if (!h) continue;
          ents.push({ kind: h.kind === 'directory' ? 'dir' : 'file', handle: h, name: h.name });
        }
        if (ents.length) return loadFromEntries(ents, true);
        if (plainFiles) loadFiles(plainFiles);
      }).catch(function () {
        if (plainFiles) loadFiles(plainFiles);
      });
      return;
    }
    if (plainFiles) loadFiles(plainFiles);
  });

  /* 显示设置（坐标纠偏/描边开关/聚合开关已移除：均为固定自动行为） */
  var _bw = $('beamW');
  if (_bw) _bw.oninput = function (e) {
    STATE.beamW = parseInt(e.target.value, 10);
    var _bwv = $('bwVal');
  if (_bwv) _bwv.textContent = STATE.beamW + '°';
    scheduleDraw();
  };
  var _sr = $('siteR');
  if (_sr) _sr.oninput = function (e) {
    STATE.siteR = parseInt(e.target.value, 10);
    var _srv = $('srVal');
  if (_srv) _srv.textContent = STATE.siteR + ' px';
    scheduleDraw();
  };
  var _sc = $('siteColor');
  if (_sc) _sc.onchange = function (e) {
    STATE.siteColor = e.target.value;
    for (var i = 0; i < layers.length; i++) {
      if (layers[i].kind === 'site' && layers[i].projected) buildSiteColors(layers[i]);
    }
    scheduleDraw();
  };
  /* 栅格着色模式：RSRP均值 / SINR均值 / 覆盖率（顶部「指标」下拉驱动；
     侧栏同名下拉已移除，gridColor 元素不存在时跳过接线） */
  var gridColorEl = $('gridColor');
  if (gridColorEl) gridColorEl.onchange = function (e) { applyGridColorMode(e.target.value); };
  applyGridColorMode(STATE.gridColorMode);
  var _bzl = $('btnZoomLayer');
  if (_bzl) _bzl.onclick = function () { if (selected) fitLayer(selected); };

  /* 地市筛选只保留顶部「地市」下拉（侧栏同名筛选已移除） */

  /* 统一搜索：经纬度 / 小区名 / CGI */
  function doJump() {
    var v = $('jump').value.trim();
    if (!v) return;
    // 1. 尝试经纬度
    var m = v.match(/(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)/);
    if (m) {
      var lon = parseFloat(m[1]), lat = parseFloat(m[2]);
      if (lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90) {
        setPin(lon, lat);
        map.getView().animate({
          center: [lonToMercX(lon), latToMercY(lat)],
          zoom: Math.max(map.getView().getZoom(), 16),
          duration: 320
        });
        hideJumpResults();
        return;
      }
    }
    // 2. 搜索小区名 / CGI
    var res = searchCellsEx(v);
    // 精确唯一命中直接飞，不用弹窗确认
    var kwLow = v.toLowerCase();
    var exact = [];
    for (var ei = 0; ei < res.length; ei++) {
      var rn = String(res[ei].name || '').toLowerCase();
      var rc = String(res[ei].cgi || '').toLowerCase();
      if (rn === kwLow || rc === kwLow) exact.push(res[ei]);
    }
    if (exact.length === 1) {
      var r0 = exact[0];
      var x0 = r0.L.mx[r0.i], y0 = r0.L.my[r0.i];
      if (isFinite(x0) && isFinite(y0)) {
        STATE.hlCell = { L: r0.L, i: r0.i };
        try {
          map.getView().animate({ center: [x0, y0], zoom: 16, duration: 400 });
        } catch (e) {}
        hideJumpResults();
        return;
      }
    }
    showJumpResults(res, v);
  }
  $('btnJump').onclick = doJump;
  $('jump').onkeydown = function (e) { if (e.key === 'Enter') doJump(); };
  $('btnPinClear').onclick = function () {
    var hadHl = !!STATE.hlCell;
    var hadPin = !!STATE.pin;
    STATE.hlCell = null;
    STATE.pin = null;
    // 直接清 2D 覆盖层并重绘，不依赖重型 drawAll
    try {
      var _cv = document.getElementById('pts');
      if (_cv) {
        var _cx = _cv.getContext('2d');
        _cx.setTransform(1, 0, 0, 1, 0, 0);
        _cx.clearRect(0, 0, _cv.width, _cv.height);
      }
    } catch (e) {}
    if (typeof drawAll === 'function') {
      try { drawAll(); } catch (e) {}
    }
    if (!hadPin && !hadHl) showErr('当前地图上没有定位标记');
    scheduleDraw();
  };
  /* 报错弹窗的关闭 X */
  $('errX').onclick = hideErr;
  /* 会话状态：移动/缩放地图、关页时保存，下次打开恢复 */
  map.on('moveend', function () { saveViewState(); });
  global.addEventListener('beforeunload', function () {
    saveViewState(true);
    /* 刷新待写入的防抖缓存 */
    if (_rscTimer) { clearTimeout(_rscTimer); _rscTimer = null; refreshSessionCacheNow(); }
  });

  /* 图例：拖动 / 缩放 / 折叠 / 重置 */
  initLegendBox();
  $('popClose').onclick = hidePopup;

  /* 面板开合：宽度过渡 + 逐帧同步地图尺寸，避免黑边与跳变 */
  var panelAnim = null;
  $('btnFold').onclick = function () {
    var p = $('panel'), btn = this;
    var collapsing = !p.classList.contains('hide');
    var reduce = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var dur = reduce ? 0 : 300;

    p.classList.toggle('hide', collapsing);
    document.getElementById('app').classList.toggle('panelopen', !collapsing);
    btn.classList.toggle('closed', collapsing);
    btn.title = collapsing ? '展开左侧面板' : '收起左侧面板';
    saveViewState();

    /* 布局正在变，弹窗的像素锚点已失效：直接关掉，避免残留/闪动 */
    hidePopup();

    /* 面板现在是"浮层"，收起靠 transform 左移，**地图容器尺寸完全不变**。
       所以这里不需要逐帧 updateSize，也不需要降采样——
       原来是"面板挤地图"，动画期间地图不断变宽，OL 要去取新区域的瓦片，
       瓦片到位前右侧会露出 --mapbg 的空白带（浅色白、深色黑）。
       现在地图始终满宽，瓦片早就加载好，问题从根上消失。 */
    if (panelAnim) { cancelAnimationFrame(panelAnim); panelAnim = null; }
    STATE.fastDraw = false;
  };

  /* 键盘 */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') hidePopup();
  });
}

/* ============================ 15. 屏幕自适应 ============================ */

function initResponsive() {
  var rt = null;

  function onViewportChange() {
    /* 拖动窗口时临时关掉面板宽度过渡，避免面板滞后于视口 */
    var p = document.getElementById('panel');
    if (p) {
      p.style.transition = 'none';
      clearTimeout(rt);
      rt = setTimeout(function () { p.style.transition = ''; }, 150);
    }
    if (map) {
      map.updateSize();          /* OL 靠 ResizeObserver 也会触发，这里保证即时 */
      scheduleDraw();
    }
  }
  global.addEventListener('resize', onViewportChange);
  global.addEventListener('orientationchange', onViewportChange);

  /* 外接显示器 / 跨屏拖动时，逻辑尺寸可能不变但 DPR 变了，
     需要按新 DPR 重建画布位图，否则点位会发虚 */
  var mq = null;
  function onDPR() {
    bindDPR();
    if (map) { map.updateSize(); scheduleDraw(); }
  }
  function bindDPR() {
    if (!global.matchMedia) return;
    if (mq) {
      if (mq.removeEventListener) mq.removeEventListener('change', onDPR);
      else if (mq.removeListener) mq.removeListener(onDPR);
    }
    mq = global.matchMedia('(resolution: ' + (global.devicePixelRatio || 1) + 'dppx)');
    if (mq.addEventListener) mq.addEventListener('change', onDPR);
    else if (mq.addListener) mq.addListener(onDPR);
  }
  bindDPR();
}

/* ============================ 16. 启动 ============================ */

/* 站点计算 Worker（城市索引、GL 数组构建，避免阻塞主线程） */
var siteWorker = null, siteWorkerSeq = 0, siteWorkerPending = {};
function getSiteWorker() {
  if (siteWorker) return siteWorker;
  try {
    // Worker 与主脚本同目录：rebuild 版固定为 worker.js
    var workerUrl = 'worker.js';

    siteWorker = new Worker(workerUrl);
    siteWorker.onmessage = function (e) {
      var msg = e.data;
      var cb = siteWorkerPending[msg.id];
      if (cb) { delete siteWorkerPending[msg.id]; cb(msg); }
    };
    siteWorker.onerror = function (e) {
      console.warn('siteWorker error', e);
      siteWorker = null;
    };
  } catch (e) {
    console.warn('Worker 不可用，回退主线程', e);
    siteWorker = null;
  }
  return siteWorker;
}
function workerCall(type, payload, transfer) {
  return new Promise(function (resolve) {
    var w = getSiteWorker();
    if (!w) { resolve({ error: 'no worker' }); return; }
    var id = ++siteWorkerSeq;
    var done = false;
    var timer = setTimeout(function () {
      if (!done) {
        done = true;
        delete siteWorkerPending[id];
        resolve({ error: 'worker timeout' });
      }
    }, 30000);   /* 30 秒超时，回退主线程 */
    siteWorkerPending[id] = function (msg) {
      if (!done) { done = true; clearTimeout(timer); resolve(msg); }
    };
    try {
      w.postMessage(Object.assign({ type: type, id: id }, payload), transfer || []);
    } catch (e) {
      if (!done) { done = true; clearTimeout(timer); delete siteWorkerPending[id]; resolve({ error: String(e) }); }
    }
  });
}

function boot() {
  initMap();
  bindUI();
  bindRatToggle();
  bindLabelToggle();
  bindPopupResize('popup');
  bindPopupResize('tkPop');
  bindExportSel();
  getSiteWorker();   /* 预热 Worker */
  initTheme();
  initResponsive();
  renderLayerList();
  renderLegend();
  rebuildBase();
  map.getView().setCenter([lonToMercX(87.6), latToMercY(43.8)]);
  map.getView().setZoom(6);

  if (!STATE.tk) {
    setTimeout(function () {
      var sec = document.getElementById('secTdt');
      if (sec) sec.open = true;
      showErr('还没有天地图密钥：在左侧「天地图密钥」里填入 key 后底图才会显示，数据图层不受影响。');
    }, 500);
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}

/* 调试/自动化测试钩子 */
if (typeof window !== 'undefined') {
  window.__viewer = {
    loadFiles: loadFiles,
    layers: layers,
    STATE: STATE,
    map: function () { return map; },
    selected: function () { return selected; },
    drawAll: drawAll,
    rebuildBuckets: rebuildBuckets,
    applySelection: applySelection,
    saveViewState: saveViewState,
    refreshSessionCache: refreshSessionCache,
    idbGetCache: idbGetCache,
    restoreFromCache: restoreFromCache,
    removeLayer: removeLayer,
    clearAllLayers: clearAllLayers,
    fitLayer: fitLayer,
    fitToBox: fitToBox,
    fitCitySelection: fitCitySelection,
    lastCityBox: null,   /* fitCitySelection 每次写入，供自动化断言盒子 */
    layerBox: layerBox,
    showPopup: showPopup,
    hidePopup: hidePopup,
    tdtUrl: tdtUrl,
    src: {
      ok: FSA_OK,
      idbSet: idbSet,
      idbGet: idbGet,
      idbDel: idbDel,
      bar: updateRestoreBar,
      entries: function () { return srcEntries; },
      setEntries: function (v) { srcEntries = v || []; }
    }
  };
}

/* 供 Node 端测试 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseDelimited: parseDelimited,
    splitRow: splitRow,
    scanFloat: scanFloat,
    bandOf: bandOf,
    bandOfSINR: bandOfSINR,
    bandOfCov: bandOfCov,
    bandCountOf: bandCountOf,
    GRID_MODES: GRID_MODES,
    STATE: STATE,
    rebuildBuckets: rebuildBuckets,
    gcj02ToWgs84: gcj02ToWgs84,
    wgs84ToGcj02: wgs84ToGcj02,
    classifyLayer: classifyLayer,
    ChunkStore: ChunkStore
  };
}

