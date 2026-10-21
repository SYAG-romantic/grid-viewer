'use strict';
/* ============================ 12. 图层列表 UI ============================ */

/* 图层列表按类型分组折叠状态（重渲染时保留） */
var layerGroupClosed = {};

function renderLayerList() {
  syncLegendFold();
  var box = document.getElementById('layerList');
  if (!layers.length) {
    box.innerHTML = '<div class="empty">还没有加载数据</div>';
    return;
  }
  /* 按类型分组：工参 / 栅格 / 边界 各一个小模块，组头可点击折叠 */
  var KIND_ORDER = [
    { kind: 'site', label: '工参', tagCls: 'site' },
    { kind: 'grid', label: '栅格', tagCls: 'grid' },
    { kind: 'vector', label: '边界', tagCls: 'vector' },
    { kind: 'other', label: '未识别', tagCls: 'site' }
  ];
  var groups = {};
  for (var gi = 0; gi < layers.length; gi++) {
    var gk = layers[gi].kind;
    if (gk !== 'site' && gk !== 'grid' && gk !== 'vector') gk = 'other';
    (groups[gk] = groups[gk] || []).push(layers[gi]);
  }
  var FIT_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5"/><path d="M15 4h5v5"/><path d="M20 15v5h-5"/><path d="M9 20H4v-5"/></svg>';
  var DEL_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 14h10l1-14"/></svg>';
  var html = '';
  for (var ki = 0; ki < KIND_ORDER.length; ki++) {
    var ko = KIND_ORDER[ki];
    var gLayers = groups[ko.kind];
    if (!gLayers || !gLayers.length) continue;
    var closed = !!layerGroupClosed[ko.kind];
    html += '<div class="lgroup' + (closed ? ' closed' : '') + '" data-kind="' + ko.kind + '">' +
      '<div class="lg-head" data-kind="' + ko.kind + '">' +
      '<span class="tag ' + ko.tagCls + '">' + ko.label + '</span>' +
      '<span class="lg-count">' + gLayers.length + ' 个图层</span>' +
      '<span class="lg-chev"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>' +
      '</div><div class="lg-body">';
    for (var i = 0; i < gLayers.length; i++) {
      var L = gLayers[i];
      var meta = L.ok
        ? (L.kind === 'vector'
            ? (L.polygons ? L.polygons.length.toLocaleString() : 0) + ' 个多边形'
            : L.ds.n.toLocaleString() + ' 行 · ' + L.ds.columns.length + ' 列')
        : (L.error || '无法解析');
      html += '<div class="layer' + (selected === L ? ' sel' : '') + '" data-id="' + L.id + '">' +
        '<div class="lt">' +
        '<input type="checkbox" ' + (L.visible ? 'checked' : '') + ' data-act="vis">' +
        '<span class="nm" data-act="sel" title="' + esc(L.name) + '">' + esc(shortName(L.name)) + '</span>' +
        '<span class="ops">' +
        '<button data-act="fit" class="icobtn" title="缩放到范围">' + FIT_SVG + '</button>' +
        '<button data-act="del" class="icobtn" title="移除">' + DEL_SVG + '</button>' +
        '</span>' +
        '</div>' +
        '<div class="meta">' + esc(meta) + '</div>' +
        '</div>';
    }
    html += '</div></div>';
  }
  box.innerHTML = html;

  Array.prototype.forEach.call(box.querySelectorAll('.lg-head'), function (hd) {
    hd.onclick = function () {
      var k = hd.getAttribute('data-kind');
      layerGroupClosed[k] = !layerGroupClosed[k];
      var g = hd.parentNode;
      if (g) g.classList.toggle('closed', !!layerGroupClosed[k]);
    };
  });

  Array.prototype.forEach.call(box.querySelectorAll('.layer'), function (el) {
    var id = el.getAttribute('data-id');
    var L = null;
    for (var j = 0; j < layers.length; j++) if (layers[j].id === id) L = layers[j];
    if (!L) return;
    el.querySelector('[data-act="vis"]').onchange = function (e) {
      L.visible = e.target.checked; scheduleDraw(); saveViewState();
      /* 统计联动：当前统计图层被取消勾选 → 统计按钮恢复「统计」（重新勾选不自动恢复，要在统计下拉里重选） */
      if (!L.visible && typeof ST !== 'undefined' && ST.layerId >= 0 && layers[ST.layerId] === L) {
        ST.layerId = -1; ST.selScene = -1;
        stSyncLayerCur();
      }
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
  if (L && L.kind === 'vector') { fitToBox(L.bbox, duration, false); return; }
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

/* 增强搜索：小区名 + CGI。
   名字/小写/CGI 三个数组在 makeLayer 时一次建好，这里逐行只做 indexOf，
   不再逐行 ds.value()（旧代码每行 splitRow 整行，33 万行要三四秒）。 */
/* 场景名称模糊搜索 */
/* 自适应取场景名称 */
function getSceneName(props) {
  if (!props) return '';
  var keys = Object.keys(props);
  var i, k, kl;
  /* 编号型的值（如 CJ0001454）不是名称，哪怕装在「唯一名称」这种字段里 */
  function isIdVal(v) {
    if (/^[A-Za-z]{1,5}\d{3,}$/.test(v)) return true;
    if (/^\d{6,}$/.test(v)) return true;
    if (/^[A-Z0-9\-_]+$/i.test(v) && v.length > 10 && /\d/.test(v)) return true;
    return false;
  }
  /* 有「唯一」类字段（如唯一名称）的图层以它为准：普通名称字段（村名等）会重名，统计/导出按名字认场景会串 */
  for (i = 0; i < keys.length; i++) {
    if (keys[i].indexOf('唯一') >= 0) {
      var v0 = String(props[keys[i]] || '').trim();
      if (v0) return v0;
    }
  }
  /* ArcGIS 的 OBJECTID 列：有些图层（如新疆图层）区域场景名称就存这一列，优先级高于普通名称字段 */
  for (i = 0; i < keys.length; i++) {
    if (/^objectid/i.test(keys[i])) {
      var vObj = String(props[keys[i]] || '').trim();
      if (vObj) return vObj;
    }
  }
  /* 第一遍：字段名像名称字段（含 name / 含「名称」/ 以「名」结尾如村名、场景名），且值不像编号 */
  for (i = 0; i < keys.length; i++) {
    k = keys[i]; kl = k.toLowerCase();
    if (kl.indexOf('name') >= 0 || k.indexOf('名称') >= 0 || /名$/.test(k)) {
      var v = String(props[k] || '').trim();
      if (v && v.indexOf('\uFFFD') < 0 && !isIdVal(v)) return v;
    }
  }
  /* 第二遍兜底：第一个像名称的字符串 */
  for (i = 0; i < keys.length; i++) {
    k = keys[i];
    var v2 = String(props[k] || '').trim();
    if (!v2 || v2.indexOf('\uFFFD') >= 0) continue;
    if (/^[\d\-\.]+$/.test(v2)) continue;
    if (/^[A-Z0-9\-]+$/i.test(v2) && v2.length > 10) continue;
    if (v2.length > 60) continue;
    if (isIdVal(v2)) continue;
    return v2;
  }
  return '';
}

function searchScenes(keyword, limit) {
  var kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return [];
  var _lim = limit || 20;
  var results = [];
  for (var li = 0; li < layers.length; li++) {
    var L = layers[li];
    if (!L.ok || L.kind !== 'vector' || !L.visible || !L.polygons) continue;
    for (var pi = 0; pi < L.polygons.length && results.length < _lim; pi++) {
      var props = L.polygons[pi].props || {};
      for (var pk in props) {
        var pv = String(props[pk] || '');
        if (pv.toLowerCase().indexOf(kw) >= 0) {
          /* 显示名必须是场景名字段的值（getSceneName），不能是恰好命中关键词的那个字段值 */
          results.push({ L: L, pg: L.polygons[pi], name: getSceneName(props) || pv });
          break;
        }
      }
    }
  }
  return results;
}

function searchCellsEx(keyword, limit, jtype) {
  var kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return [];
  var _lim = limit || 120;
  var jt = jtype || 'auto';
  var ratFilter = (typeof STATE !== 'undefined' && STATE.rat) ? STATE.rat : 'all';
  var results = [];
  for (var li = 0; li < layers.length; li++) {
    var L = layers[li];
    if (!L.ok || L.kind !== 'site') continue;
    /* 制式过滤：4G 只搜 4G 层，5G 只搜 5G 层 */
    if (ratFilter === '4G' && L.rat !== '4G') continue;
    if (ratFilter === '5G' && L.rat !== '5G') continue;
    var n = L.ds.n;
    var lcNames = L._lcNames;
    if (!lcNames) continue;   /* 索引没建好时跳过（与精确跳转一致） */
    var nameArr = L._nameArr;
    var cgiArr = L._cgiArr;
    var _layerCount = 0;
    var _perLayer = Math.ceil(_lim / 2);
    for (var i = 0; i < n; i++) {
      if (_layerCount >= _perLayer || results.length >= _lim) break;
      var nmLc = lcNames[i];
      var nm = nameArr ? nameArr[i] : '';
      if ((jt === 'auto' || jt === 'cell') && nmLc.indexOf(kw) >= 0) {
        results.push({ L: L, i: i, name: nm, cgi: cgiArr ? cgiArr[i] : '' }); _layerCount++;
        continue;
      }
      if ((jt === 'auto' || jt === 'cgi') && cgiArr) {
        var cg = cgiArr[i];
        if (cg && cg.toLowerCase().indexOf(kw) >= 0) {
          results.push({ L: L, i: i, name: nm, cgi: cg }); _layerCount++;
        }
      }
    }
  }
  return results.slice(0, _lim);
}
function showJumpResults(res, kw) {
  var box = document.getElementById('jumpResults');
  if (!box) return;
  if (!res.length) {
    box.style.display = 'none';
    box.innerHTML = '';
    /* auto 类型打字时不弹"未找到"，只在回车跳转失败时按具体类型提示 */
    return;
  }
  var html = '';
  for (var k = 0; k < res.length; k++) {
    var r = res[k];
    var _display = r.name || r.cgi || '';
    var _sub = r.name ? r.cgi : '';
    html += '<div class="cs-item" data-k="' + k + '" style="padding:7px 10px;cursor:pointer;border-bottom:1px solid var(--line);font-size:12.5px;">' +
      '<span style="color:var(--fg)">' + esc(_display) + '</span>' +
      (_sub ? '<span style="color:var(--fg3);font-size:11px;margin-left:8px;">' + esc(_sub) + '</span>' : '') +
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
        /* 场景：跳到多边形中心并高亮 */
        if (r.scene && r.pg) {
          var vb = r.pg._bbox;
          if (vb) {
            var cx = (vb[0] + vb[2]) / 2, cy = (vb[1] + vb[3]) / 2;
            STATE.hlPoly = { L: r.L, pg: r.pg }; var _rp = r.pg.props || {}; STATE.sceneName = getSceneName(_rp) || String(r.name || '');
            try {
              map.getView().animate({ center: [cx, cy], zoom: 14, duration: 400 });
            } catch (e) {}
            scheduleDraw();
          }
          box.style.display = 'none';
          return;
        }
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
    /* 有全部环（多部件/带洞场景）时跨环 even-odd，与导出统计同口径 */
    var ringsP = sel.rings || [sel.pts];
    var insideP = false;
    for (var ri = 0; ri < ringsP.length; ri++) {
      var pts = ringsP[ri];
      for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        var xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) insideP = !insideP;
      }
    }
    return insideP;
  }
  return false;
}
function exportSelection() {
  var sel = currentSel();
  if (!sel) { showErr('请先在地图上框选区域（矩形/圆形/多边形工具）'); return; }
  var rows4g = [], rows5g = [];
  /* 两遍：先收集各图层命中的行号，再按全部图层列的并集做表头逐行对齐——
     只取第一个图层的表头时，后面图层列集/列序不同会整体错位 */
  var hits = [];
  var unionCols = [], seenCol = {};
  var totalRows0 = 0;
  for (var li = 0; li < layers.length; li++) {
    var L = layers[li];
    if (!L.ok || !L.visible || L.kind !== 'site') continue;
    var ds = L.ds;
    var idxs = [];
    for (var i = 0; i < ds.n && totalRows0 < 50000; i++) {
      var x = L.mx[i], y = L.my[i];
      if (!isFinite(x) || !isFinite(y)) continue;
      if (!pointInSel(x, y, sel)) continue;
      idxs.push(i);
      totalRows0++;
    }
    if (idxs.length) {
      hits.push({ L: L, ds: ds, idxs: idxs, is5g: (L.rat === '5G') });
      for (var cj = 0; cj < ds.columns.length; cj++) {
        if (!seenCol[ds.columns[cj]]) { seenCol[ds.columns[cj]] = 1; unionCols.push(ds.columns[cj]); }
      }
    }
    if (totalRows0 >= 50000) break;
  }
  var header = ['图层'].concat(unionCols);
  for (var hi = 0; hi < hits.length; hi++) {
    var H = hits[hi];
    var colPos = H.ds.columns.map(function (cn) { return unionCols.indexOf(cn); });
    for (var ri2 = 0; ri2 < H.idxs.length; ri2++) {
      var cells = H.ds.cells(H.idxs[ri2]);
      var row = new Array(header.length);
      for (var fi2 = 0; fi2 < row.length; fi2++) row[fi2] = '';
      row[0] = H.L.name;
      for (var cj2 = 0; cj2 < cells.length && cj2 < colPos.length; cj2++) {
        row[1 + colPos[cj2]] = cells[cj2];
      }
      if (H.is5g) rows5g.push(row); else rows4g.push(row);
    }
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
/* 频段样式开关（顶部）：扇区颜色/半径/波束角按频段表（BAND_STYLE）切换 */
function syncBandBtn() {
  var b = document.getElementById('btnBand');
  if (b) b.classList.toggle('on', !!STATE.bandStyle);
}
function bindBandToggle() {
  var b = document.getElementById('btnBand');
  if (!b) return;
  syncBandBtn();
  b.addEventListener('click', function () {
    STATE.bandStyle = !STATE.bandStyle;
    syncBandBtn();
    for (var i = 0; i < layers.length; i++) {
      if (layers[i].kind === 'site' && layers[i].ok) { try { buildSiteColors(layers[i]); } catch (e) {} }
    }
    scheduleDraw();
    saveViewState();
  });
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
    STATE.rat = (rat === '*') ? 'all' : rat;   /* 记下当前制式，统计导出/计算要联动读它 */
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
  /* 统计模块的图层选择跟着同步：删掉选中的统计图层→恢复默认；删它之前的图层→下标前移 */
  if (typeof ST !== 'undefined') {
    if (i >= 0 && ST.layerId === i) { ST.layerId = -1; ST.selScene = -1; }
    else if (i >= 0 && ST.layerId > i) ST.layerId--;
    if (typeof stSyncLayerCur === 'function') stSyncLayerCur();
  }
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
      if (L.siteRbBuf) GLS.gl.deleteBuffer(L.siteRbBuf);
    } catch (e) {}
    L.sitePosBuf = null; L.siteCityBuf = null; L.siteRbBuf = null; L.siteGlOk = false;
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
var ACCEPT_RE = /\.(csv|txt|tsv|json|geojson|xlsx|xls|tab|dat|map|id|shp|shx|dbf|prj|cpg|kml|mif|mid)$/i;
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
  /* 全量替换语义：先删光旧清单的全部键再写新的。
     键按图层下标命名（ly0/ly1…），只删"消失的图层"不够——同一下标换了图层时，
     旧图层的 loff/txtn/num 子键会残留下来，恢复时被新图层无条件读走造成数据污染 */
  var oldMan0 = null;
  try { oldMan0 = await idbGuard(idbGet('manifest', IDB_CACHE), 30000, '读取旧缓存清单'); } catch (e0) { }
  if (oldMan0 && oldMan0.layers) {
    for (var oi0 = 0; oi0 < oldMan0.layers.length; oi0++) {
      var oe0 = oldMan0.layers[oi0];
      if (!oe0.keys) continue;
      for (var ki0 = 0; ki0 < oe0.keys.length; ki0++) { try { idbDel(oe0.keys[ki0], IDB_CACHE); } catch (e1) { } }
    }
  }
  for (var i = 0; i < layers.length; i++) {
    var L = layers[i];
    /* 边界层：序列化 polygons 存 JSON */
    if (L.kind === 'vector') {
      var ventry = { id: cacheLyId(i), name: L.name, kind: 'vector', ok: false, err: '', keys: [],
                     rows: L.polygons ? L.polygons.length : 0, cols: 0 };
      try {
        var vkey = cacheLyId(i) + '/vec';
        // 只存 rings 和 props，去掉 _bbox（恢复时重算）
        var vdata = L.polygons.map(function (pg) { return { rings: pg.rings, props: pg.props }; });
        await idbGuard(idbSet(vkey, JSON.stringify(vdata), IDB_CACHE), 120000, '写入边界层');
        ventry.keys = [vkey]; ventry.ok = true;
        ventry.mb = Math.round(JSON.stringify(vdata).length / 1048576);
      } catch (e) {
        ventry.err = (e && e.message) ? e.message : String(e);
      }
      manifest.layers.push(ventry);
      continue;
    }
    if (!L.ds) continue;
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
        mode: STATE.gridColorMode, city: STATE.cityFilter, band: !!STATE.bandStyle,
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
  if (typeof s.band === 'boolean' && s.band !== !!STATE.bandStyle) {
    STATE.bandStyle = s.band;
    if (typeof syncBandBtn === 'function') syncBandBtn();
    for (var bi2 = 0; bi2 < layers.length; bi2++) {
      if (layers[bi2].kind === 'site' && layers[bi2].ok) { try { buildSiteColors(layers[bi2]); } catch (e) {} }
    }
  }
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
/* ============================ 矢量边界图层上传 ============================ */
/* 按文件名分组建层（去扩展名、大小写不敏感）。
   与 loadFiles 保持一致的口径：同名图层替换而不是叠加、有进度条、失败逐条报；
   解析期间置 _vecLoading 防重入（连点两次会把同一层加两遍） */
var _vecLoading = false;
async function loadVectorFiles(fileList) {
  if (_vecLoading) { showErr('上一批边界文件还在解析，请稍候'); return; }
  var files = [];
  for (var i = 0; i < fileList.length; i++) files.push(fileList[i]);
  if (!files.length) return;
  _vecLoading = true;
  var failNames = [], lastOk = null;
  try {
    /* 分组 */
    var groups = {};
    var order = [];
    for (var g = 0; g < files.length; g++) {
      var f = files[g];
      var nm = f.name || '';
      var dot = nm.lastIndexOf('.');
      if (dot <= 0) { failNames.push(nm + '（没有扩展名）'); continue; }
      var base = nm.slice(0, dot).toLowerCase();
      var ext = nm.slice(dot + 1).toLowerCase();
      if (!groups[base]) { groups[base] = { baseName: nm.slice(0, dot), files: {} }; order.push(base); }
      groups[base].files[ext] = f;
    }
    for (var gi = 0; gi < order.length; gi++) {
      var grp = groups[order[gi]];
      var fmap = grp.files;
      var hasMapInfo = !!fmap.map;
      var hasShp = !!fmap.shp;
      var hasGeo = !!(fmap.geojson || fmap.json);
      var hasKml = !!fmap.kml;
      var hasMif = !!fmap.mif;
      if (!hasMapInfo && !hasShp && !hasGeo && !hasKml && !hasMif) {
        failNames.push(grp.baseName + '（缺 .map/.shp/.geojson/.kml/.mif）');
        continue;
      }
      busy('正在读取边界：' + grp.baseName);
      await yieldFrame();
      try {
        /* 只读用得上的扩展名。.tab 也要读：它声明了各字段的真实类型，
           缺了它 .DAT 里的 Float/Integer 列会被当成文本读成乱码 */
        var bufs = {};
        var need = ['map', 'id', 'dat', 'tab', 'shp', 'shx', 'dbf', 'prj', 'cpg', 'geojson', 'json', 'kml', 'mif', 'mid'];
        for (var ni = 0; ni < need.length; ni++) {
          var _k = need[ni];
          if (!fmap[_k]) continue;
          if (_k === 'geojson' || _k === 'json' || _k === 'kml') {
            bufs[_k] = await readFileAsText(fmap[_k], 'utf-8');
          } else if (_k === 'mif' || _k === 'mid' || _k === 'tab') {
            bufs[_k] = await readFileAsText(fmap[_k], 'gbk');
          } else {
            bufs[_k] = await readFileAsArrayBuffer(fmap[_k]);
          }
        }
        busyPhase('正在解析边界：' + grp.baseName);
        var busyEl = document.getElementById('busyS');
        var res = await parseVectorFiles(bufs, grp.baseName, function (done, total) {
          if (!busyEl) return;
          busyEl.textContent = total
            ? '已解析 ' + done.toLocaleString() + ' / ' + total.toLocaleString() + ' 个对象'
            : '已解析 ' + done.toLocaleString() + ' 个对象';
          document.getElementById('busyBar').style.width =
            (total ? Math.min(96, done / total * 100) : 50).toFixed(1) + '%';
        });
        if (!res || !res.polygons || !res.polygons.length) {
          failNames.push(grp.baseName + '（无多边形）');
          continue;
        }
        /* 同名图层替换：重复导入同一份边界 = 更新，而不是叠两层 */
        for (var d = layers.length - 1; d >= 0; d--) {
          if (layers[d].name === grp.baseName) removeLayer(layers[d]);
        }
        /* 墨卡托包围盒（供 fitLayer + 视野裁剪）。
           MapInfo 图层直接用解析时从段头 MBR 得到的经纬度包围盒，只转 4 个角；
           十万面几百万点逐点算墨卡托要好几年（实测 8s → 50ms 级别） */
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (var pi = 0; pi < res.polygons.length; pi++) {
          var pgI = res.polygons[pi];
          var pminX = Infinity, pminY = Infinity, pmaxX = -Infinity, pmaxY = -Infinity;
          if (pgI.bboxLL) {
            var bb = pgI.bboxLL;
            var ax = lonToMercX(bb[0]), bx = lonToMercX(bb[2]);
            var ay = latToMercY(bb[1]), by = latToMercY(bb[3]);
            if (isFinite(ax) && isFinite(bx) && isFinite(ay) && isFinite(by)) {
              pminX = Math.min(ax, bx); pmaxX = Math.max(ax, bx);
              pminY = Math.min(ay, by); pmaxY = Math.max(ay, by);
            }
          } else {
            var rings = pgI.rings;
            for (var ri = 0; ri < rings.length; ri++) {
              var ring = rings[ri];
              for (var vi = 0; vi < ring.length; vi++) {
                var mx = lonToMercX(ring[vi][0]), my = latToMercY(ring[vi][1]);
                if (!isFinite(mx) || !isFinite(my)) continue;
                if (mx < pminX) pminX = mx; if (mx > pmaxX) pmaxX = mx;
                if (my < pminY) pminY = my; if (my > pmaxY) pmaxY = my;
              }
            }
          }
          if (pminX <= pmaxX) {
            pgI._bbox = [pminX, pminY, pmaxX, pmaxY];
            if (pminX < minX) minX = pminX; if (pmaxX > maxX) maxX = pmaxX;
            if (pminY < minY) minY = pminY; if (pmaxY > maxY) maxY = pmaxY;
          }
        }
        /* 预计算墨卡托坐标环（分片让帧）：绘制每帧直接用，逐帧现算投影几万面必卡死 */
        busyPhase('正在准备绘制：' + grp.baseName);
        for (var pm = 0; pm < res.polygons.length; pm++) {
          var pgM = res.polygons[pm];
          if (!pgM._ringsMerc) {
            pgM._ringsMerc = pgM.rings.map(function (ringM) {
              return ringM.map(function (ptM) { return [lonToMercX(ptM[0]), latToMercY(ptM[1])]; });
            });
          }
          if (pm % 1200 === 1199) {
            var busyElM = document.getElementById('busyS');
            if (busyElM) busyElM.textContent = '已准备 ' + (pm + 1).toLocaleString() + ' / ' + res.polygons.length.toLocaleString() + ' 个多边形';
            await yieldFrame();
          }
        }
        var L = {
          id: 'L' + (layerSeq++),
          kind: 'vector',
          name: grp.baseName,
          polygons: res.polygons,
          fields: res.fields || [],
          visible: true,
          ok: true,
          bbox: (minX <= maxX) ? [minX, minY, maxX, maxY] : null
        };
        layers.push(L);
        selectLayer(L);
        lastOk = L;
      } catch (e) {
        failNames.push(grp.baseName + '（' + (e && e.message ? e.message : '解析失败') + '）');
      }
      await yieldFrame();
    }
    renderLayerList(); renderLegend(); saveViewState();
    /* 只定位到“最后一个真正加载成功的边界层”，不要拿 layers 末位凑数 */
    if (lastOk && map) fitLayer(lastOk);
    scheduleDraw();
    if (failNames.length) showErr('以下边界文件未导入：' + failNames.join('；'));
    /* 边界层导入后写入缓存，下次刷新自动恢复 */
    refreshSessionCache();
  } finally {
    _vecLoading = false;
    busyOff();
  }
}

function readFileAsText(f, encoding) {
  return new Promise(function (resolve, reject) {
    var r = new FileReader();
    r.onload = function () {
      var buf = r.result;
      // 文本文件：按指定编码解码（默认 utf-8，mif/mid 用 gbk）
      // 解码失败要报出来，不能静默给空串（否则上游只会看到“无多边形”）
      try {
        var dec = new TextDecoder(encoding || 'utf-8');
        resolve(dec.decode(buf));
      } catch (e) {
        reject(new Error('文本解码失败（' + (encoding || 'utf-8') + '）'));
      }
    };
    r.onerror = function () { reject(new Error('读取失败：' + (f && f.name ? f.name : ''))); };
    r.readAsArrayBuffer(f);
  });
}
function readFileAsArrayBuffer(file) {
  return new Promise(function (resolve, reject) {
    var rd = new FileReader();
    rd.onload = function () { resolve(rd.result); };
    rd.onerror = function () { reject(new Error('读取失败')); };
    rd.readAsArrayBuffer(file);
  });
}

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
          /* 边界层：从 JSON 恢复 */
          if (e.kind === 'vector') {
            var vjson = await idbGet(e.id + '/vec', IDB_CACHE);
            if (vjson) {
              var vdata = JSON.parse(vjson);
              // 重算 bbox
              for (var vi = 0; vi < vdata.length; vi++) {
                var pg = vdata[vi];
                var pminX = Infinity, pminY = Infinity, pmaxX = -Infinity, pmaxY = -Infinity;
                for (var vri = 0; vri < pg.rings.length; vri++) {
                  var ring = pg.rings[vri];
                  for (var vvi = 0; vvi < ring.length; vvi++) {
                    var mx = lonToMercX(ring[vvi][0]), my = latToMercY(ring[vvi][1]);
                    if (!isFinite(mx) || !isFinite(my)) continue;
                    if (mx < pminX) pminX = mx; if (mx > pmaxX) pmaxX = mx;
                    if (my < pminY) pminY = my; if (my > pmaxY) pmaxY = my;
                  }
                }
                if (pminX <= pmaxX) pg._bbox = [pminX, pminY, pmaxX, pmaxY];
              }
              var vminX = Infinity, vminY = Infinity, vmaxX = -Infinity, vmaxY = -Infinity;
              for (var vj = 0; vj < vdata.length; vj++) {
                var vb = vdata[vj]._bbox;
                if (vb) {
                  if (vb[0] < vminX) vminX = vb[0]; if (vb[2] > vmaxX) vmaxX = vb[2];
                  if (vb[1] < vminY) vminY = vb[1]; if (vb[3] > vmaxY) vmaxY = vb[3];
                }
              }
              var vL = {
                id: 'L' + (layerSeq++),
                kind: 'vector',
                name: e.name,
                polygons: vdata,
                fields: [],
                visible: true,
                ok: true,
                bbox: (vminX <= vmaxX) ? [vminX, vminY, vmaxX, vmaxY] : null
              };
              layers.push(vL);
              if (!selected) selectLayer(vL);
              restoredNames.push((e.name || '边界').slice(0, 16) + '（' + vdata.length.toLocaleString() + ' 个多边形）');
            } else {
              failed.push((e.name || '边界').slice(0, 16) + '（缓存数据丢失）');
            }
            continue;
          }
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
              /* 挂起期间 loadFiles 的缓存写入被跳过，这里补写，否则每次打开都要重走源恢复 */
              refreshSessionCache();
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
  if (sel.rings && sel.rings.length) {
    var ringsM = sel.rings;
    return function (x, y) {
      var ins = false;
      for (var ri = 0; ri < ringsM.length; ri++) {
        var pts = ringsM[ri];
        for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          var xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
          if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) ins = !ins;
        }
      }
      return ins;
    };
  }
  return makeMaskTest(sel.pts);
}

function currentSel() {
  if (STATE.selCircle) return { type: 'circle', c: STATE.selCircle.c, r: STATE.selCircle.r };
  if (STATE.polyDone && STATE.polyPts.length >= 3) {
    /* 场景选区拖动/缩放时用包围盒（快），停下后用多边形（准） */
    if (STATE.sceneSel && STATE._dragging) {
      var _bx0 = Infinity, _by0 = Infinity, _bx1 = -Infinity, _by1 = -Infinity;
      for (var _bi = 0; _bi < STATE.polyPts.length; _bi++) {
        var _bp = STATE.polyPts[_bi];
        if (_bp[0] < _bx0) _bx0 = _bp[0];
        if (_bp[0] > _bx1) _bx1 = _bp[0];
        if (_bp[1] < _by0) _by0 = _bp[1];
        if (_bp[1] > _by1) _by1 = _bp[1];
      }
      return { type: 'rect', b: [_bx0, _by0, _bx1, _by1] };
    }
    return { type: 'poly', pts: STATE.polyPts.map(function (p) { return [p[0], p[1]]; }), rings: (STATE.sceneSel && STATE.polyRings) ? STATE.polyRings : null };
  }
  if (STATE.selBox) return { type: 'rect', b: STATE.selBox.slice() };
  return null;
}
/* 统计用的完整选区（场景用多边形） */
function currentSelFull() {
  if (STATE.sceneSel && STATE.polyDone && STATE.polyPts.length >= 3) {
    return { type: 'poly', pts: STATE.polyPts.map(function (p) { return [p[0], p[1]]; }), rings: STATE.polyRings || null };
  }
  return currentSel();
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
  var poor = 0;   /* 质差栅格数：5G 栅格105覆盖率<80% 或平均SINR<-3；4G 栅格110覆盖率<80% */
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
        var _poor = false;
        if (cntAll && cntThr) {
          var _pa = cntAll[i], _pt = cntThr[i];
          if (isFinite(_pa) && isFinite(_pt) && _pa > 0 && _pt / _pa < 0.8) _poor = true;
        }
        if (!_poor && L.rat === '5G' && sinr) {
          var _ps = sinr[i];
          if (isFinite(_ps) && _ps < -3) _poor = true;
        }
        if (_poor) poor++;
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
    counts: counts, total: total, poor: poor, bandMode: selMode,
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
  h += '<tr><td class="k" title="5G：栅格105覆盖率<80% 或平均SINR<-3dB；4G：栅格110覆盖率<80%">质差栅格数</td><td class="num">' + (s.poor || 0).toLocaleString() + '</td></tr>';
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
  var _modeName = s.bandMode === 'sinr' ? 'SINR' : (s.bandMode === 'cov' ? '覆盖率' : 'RSRP');
  h += '<div class="k" style="margin:7px 0 3px;font-weight:700">' + _modeName + ' 档位分布</div><table class="dist">';
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
    if (STATE.sceneName) {
      title = STATE.sceneName;
    } else {
      title = '选区统计';
    }
    html = statTableHtml();
  } else if (STATE.measPts.length && STATE.measKind) {
    title = TOOLS[STATE.measKind].label;
    html = measureHtml();
  }
  if (!html) { p.classList.remove('show'); return; }
  var wasHidden = !p.classList.contains('show');
  var _tpT = document.getElementById('tpTitle');
  if (STATE.sceneName && STATE.selStats) {
    _tpT.innerHTML = esc(title) + '<div style="font-size:11px;font-weight:400;color:var(--fg3);margin-top:2px">选区统计</div>';
  } else {
    _tpT.textContent = title;
  }
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
  /* 场景搜索的选区不画虚线，只留红色边框；手动框选正常画；
     正在拖矩形/圆时要画拖动态（否则查完场景再框选看不见框） */
  if (typeof STATE !== 'undefined' && STATE.sceneSel && !STATE.selDrag && !STATE.selCircleDrag) return;
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
          /* 手动框选接管：清掉统计查中的场景选区（与圆/多边形工具同口径） */
          if (STATE.sceneSel) {
            STATE.sceneSel = false; STATE.polyPts = []; STATE.polyDone = false; STATE.selStats = null;
            ST.selScene = -1;
          }
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
        if (STATE.sceneSel) {
          STATE.sceneSel = false; STATE.polyPts = []; STATE.polyDone = false; STATE.selStats = null;
          ST.selScene = -1;
        }
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
    if (STATE.polyDone) { STATE.polyPts = []; STATE.polyDone = false; STATE.selStats = null; STATE.sceneSel = false; }
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

/* geojson/json 内容识别：含多边形几何 → 边界图层；否则按数据文件解析 */
async function geoJsonIsVector(f) {
  try {
    var txt = await f.text();
    return /"type"\s*:\s*"(Multi)?Polygon"/.test(txt);
  } catch (e) { return false; }
}

async function loadFiles(fileList) {
  rflog('loadFiles begin n=' + (fileList && fileList.length));
  /* 统一导入分发：数据与边界可混选，自动识别——
     tab/shp/kml/mif 等边界格式直接转边界解析；geojson/json 按内容（多边形→边界，点→数据） */
  var VEC_RE = /\.(tab|dat|map|id|shp|shx|dbf|prj|cpg|kml|mif|mid)$/i;
  var AMB_RE = /\.(geojson|json)$/i;
  var all = Array.prototype.slice.call(fileList || []);
  var files = [], vecFiles = [], ambFiles = [];
  for (var ai = 0; ai < all.length; ai++) {
    var af = all[ai];
    if (VEC_RE.test(af.name)) vecFiles.push(af);
    else if (AMB_RE.test(af.name)) ambFiles.push(af);
    else if (/\.(csv|txt|tsv|xlsx|xls)$/i.test(af.name)) files.push(af);
  }
  for (var aj = 0; aj < ambFiles.length; aj++) {
    if (await geoJsonIsVector(ambFiles[aj])) vecFiles.push(ambFiles[aj]);
    else files.push(ambFiles[aj]);
  }
  if (!files.length && !vecFiles.length) { showErr('没有可识别的文件（支持 csv/txt/xlsx 数据，tab/shp/kml/geojson 边界）'); return; }

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
  /* 同批选中的边界文件接着走边界解析（与数据文件互不干扰） */
  if (vecFiles.length) {
    try { await loadVectorFiles(vecFiles); }
    catch (e) { showErr('边界导入失败：' + (e && e.message ? e.message : e)); busyOff(); }
  }
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
  /* 搜索类型下拉 */
  if (typeof initJumpTypeDropdown === 'function') initJumpTypeDropdown();
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
    /* 从源更新 = 替换，但顺序是先恢复、成功后才清旧层：
       先清层再恢复，一旦授权被拒/取消，数据回不来且空清单会被写进缓存 */
    var oldLayers = layers.slice();
    var nBefore = layers.length;
    restoreSources().then(function () {
      if (layers.length <= nBefore) return;   /* 没加载到任何新图层（取消/无源）：保留现状 */
      for (var oi = 0; oi < oldLayers.length; oi++) {
        if (layers.indexOf(oldLayers[oi]) >= 0) removeLayer(oldLayers[oi]);
      }
      restoreSessionState();
    }).catch(function () { });
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
    var jtype = ($('jumpType') && $('jumpType').value) || 'auto';
    // 场景名称：搜边界层多边形属性
    if (jtype === 'scene') {
      var kw = v.toLowerCase();
      for (var vi = 0; vi < layers.length; vi++) {
        var vL = layers[vi];
        if (vL.kind !== 'vector' || !vL.visible || !vL.polygons) continue;
        for (var pi = 0; pi < vL.polygons.length; pi++) {
          var props = vL.polygons[pi].props || {};
          for (var pk in props) {
            if (String(props[pk]).toLowerCase().indexOf(kw) >= 0) {
              var vb = vL.polygons[pi]._bbox;
              if (vb) {
                var cx = (vb[0] + vb[2]) / 2, cy = (vb[1] + vb[3]) / 2;
                var _pg = vL.polygons[pi];
                STATE.hlPoly = { L: vL, pg: _pg };
                var _pprops = _pg.props || {};
                /* 优先用 name/NAME 字段，否则用匹配到的值 */
                var _sn = getSceneName(_pprops);
                if (!_sn) {
                  /* 找第一个像名称的字段（非纯数字、非ID） */
                  for (var _sk in _pprops) {
                    var _sv = String(_pprops[_sk] || '');
                    if (_sv && !/^[\d\-\.]+$/.test(_sv) && _sv.length < 50) { _sn = _sv; break; }
                  }
                }
                STATE.sceneName = String(_sn || props[pk] || '');
                map.getView().animate({ center: [cx, cy], zoom: 14, duration: 400 });
                scheduleDraw();
                return;
              }
            }
          }
        }
      }
      showErr('没有找到区域场景名称：' + v);
      return;
    }
    // 1. 尝试经纬度（auto 或 ll）
    var m = (jtype === 'auto' || jtype === 'll') ? v.match(/(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)/) : null;
    if (m) {
      var lon = parseFloat(m[1]), lat = parseFloat(m[2]);
      if (lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90) {
        setPin(lon, lat);
        map.getView().animate({
          center: [lonToMercX(lon), latToMercY(lat)],
          zoom: Math.max(map.getView().getZoom(), 17),
          duration: 320
        });
        hideJumpResults();
        return;
      }
    }
    // 2. 先查精确匹配（哈希表，毫秒级；未建好时跳过走模糊）
    var kwLow = v.toLowerCase();
    var _foundExact = false;
    var _ratF = (typeof STATE !== 'undefined' && STATE.rat) ? STATE.rat : 'all';
    for (var li = 0; li < layers.length; li++) {
      var L = layers[li];
      if (!L.ok || L.kind !== 'site' || !L._nameMap) continue;
      if (_ratF === '4G' && L.rat !== '4G') continue;
      if (_ratF === '5G' && L.rat !== '5G') continue;
      var _idx = L._nameMap[kwLow];
      if (_idx !== undefined) {
        var x0 = L.mx[_idx], y0 = L.my[_idx];
        if (isFinite(x0) && isFinite(y0)) {
          STATE.hlCell = { L: L, i: _idx };
          try {
            map.getView().animate({ center: [x0, y0], zoom: 17, duration: 400 });
          } catch (e) {}
          hideJumpResults();
          _foundExact = true;
          break;
        }
      }
    }
    if (_foundExact) return;
    // 3. 模糊搜索（带上用户选的搜索类型，别混入另一类匹配）
    var res = searchCellsEx(v, 20, jtype);
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
          map.getView().animate({ center: [x0, y0], zoom: 17, duration: 400 });
        } catch (e) {}
        hideJumpResults();
        return;
      }
    }
    if (!res.length) {
      /* auto 类型：再试场景 */
      var _jtTmp = ($('jumpType') && $('jumpType').value) || 'auto';
      if (_jtTmp === 'auto') {
        var _sres = searchScenes(v, 5);
        if (_sres.length) {
          var _spg = _sres[0].pg, _sL = _sres[0].L;
          var _sb = _spg._bbox;
          if (_sb) {
            var _cx = (_sb[0] + _sb[2]) / 2, _cy = (_sb[1] + _sb[3]) / 2;
            STATE.hlPoly = { L: _sL, pg: _spg }; var _sp = _spg.props || {}; STATE.sceneName = getSceneName(_sp) || String(_sres[0].name || '');
            try { map.getView().animate({ center: [_cx, _cy], zoom: 14, duration: 400 }); } catch (e) {}
            scheduleDraw();
            hideJumpResults();
            return;
          }
        }
      }
      /* 按类型+制式给具体提示 */
      var _jt2 = ($('jumpType') && $('jumpType').value) || 'auto';
      var _rat2 = (typeof STATE !== 'undefined' && STATE.rat) ? STATE.rat : 'all';
      var _ratTxt = _rat2 === '4G' ? '4G' : (_rat2 === '5G' ? '5G' : '');
      if (_jt2 === 'cell') showErr('没有找到' + _ratTxt + '小区名称：' + v);
      else if (_jt2 === 'cgi') showErr('没有找到' + _ratTxt + 'CGI：' + v);
      else if (_jt2 === 'scene') showErr('没有找到区域场景名称：' + v);
      else if (_jt2 === 'll') showErr('经纬度格式不对，示例：87.48,43.92');
      else showErr('没有找到匹配的小区/CGI/区域场景名称：' + v);
      hideJumpResults();
      return;
    }
    showJumpResults(res, v);
  }
  $('btnJump').onclick = doJump;
  $('jump').onkeydown = function (e) { if (e.key === 'Enter') doJump(); };
  /* 输入时防抖模糊搜索（不点搜索也出下拉） */
  var _jumpDeb = null;
  $('jump').oninput = function () {
    if (_jumpDeb) clearTimeout(_jumpDeb);
    var v = $('jump').value.trim();
    if (v.length < 2) { hideJumpResults(); return; }
    var jt = ($('jumpType') && $('jumpType').value) || 'auto';
    if (jt === 'll') { hideJumpResults(); return; }
    _jumpDeb = setTimeout(function () {
      var res;
      if (jt === 'scene') {
        res = searchScenes(v, 20).map(function (r) {
          return { scene: true, L: r.L, pg: r.pg, name: r.name };
        });
      } else if (jt === 'auto') {
        res = searchCellsEx(v, 15, jt);
        var sres = searchScenes(v, 5).map(function (r) {
          return { scene: true, L: r.L, pg: r.pg, name: r.name };
        });
        res = res.concat(sres);
      } else {
        res = searchCellsEx(v, 20, jt);
      }
      showJumpResults(res, v);
    }, 350);
  };
  /* 点击空白处关闭搜索结果下拉 */
  document.addEventListener('click', function (e) {
    var box = document.getElementById('jumpResults');
    if (!box || box.style.display === 'none') return;
    var t = e.target;
    if (t.closest && (t.closest('#jumpResults') || t.closest('#jump') || t.closest('#btnJump'))) return;
    box.style.display = 'none';
  });
  $('btnPinClear').onclick = function () {
    var hadHl = !!STATE.hlCell || !!STATE.hlPoly;
    var hadPin = !!STATE.pin;
    STATE.hlCell = null;
    STATE.hlPoly = null; STATE.sceneName = null; STATE.sceneSel = false;
    STATE.pin = null;
    var ji = $('jump');
    if (ji) ji.value = '';
    hideJumpResults();
    // 直接清 2D 覆盖层并重绘
    try {
      var _cv = document.getElementById('pts');
      if (_cv) {
        var _cx = _cv.getContext('2d');
        _cx.setTransform(1, 0, 0, 1, 0, 0);
        _cx.clearRect(0, 0, _cv.width, _cv.height);
      }
    } catch (e) {}
    if (!hadPin && !hadHl) showErr('当前地图上没有定位标记');
    // 强制完整重绘，确保高亮清除后图层正常显示
    try { drawAll(); } catch (e) {}
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
    var workerUrl = 'worker.js?v=1021c';

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
  bindBandToggle();
  bindLabelToggle();
  initStatsPanel();
  bindPopupResize('popup');
  bindPopupResize('tkPop');
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


/* ========== 场景指标统计（统计面板：选图层 → 搜场景查询/清除 → 导出） ========== */
var ST = { layerId: -1, selScene: -1, busy: false };

function stVectorLayerIdxs() {
  var out = [];
  for (var i = 0; i < layers.length; i++) {
    var L = layers[i];
    if (L.kind === 'vector' && L.ok && L.polygons && L.polygons.length) out.push(i);
  }
  return out;
}

function stCityName(props) {
  if (!props) return '';
  /* 与地市匹配同口径：CITYID 优先换名（查不到名不输出数字），
     否则认城市字段（F/CITY* 或中文「地州/地市/城市」） */
  var nameKey = null;
  for (var k in props) {
    if (/cityid/i.test(k)) {
      var cid = String(props[k] == null ? '' : props[k]).trim();
      if (cid && CITY_NAMES[cid]) return CITY_NAMES[cid];
    }
    if (nameKey === null) {
      var kl = k.toLowerCase();
      if (kl === 'f' || kl === 'city' || kl === 'cityname' || kl.indexOf('city') === 0 ||
          kl.indexOf('地州') >= 0 || kl.indexOf('地市') >= 0 || kl.indexOf('城市') >= 0) nameKey = k;
    }
  }
  if (nameKey) return String(props[nameKey] == null ? '' : props[nameKey]).trim();
  return '';
}

function stRangeStr(bb) {
  if (!bb) return '';
  var a = mercToLonLat(bb[0], bb[1]), b = mercToLonLat(bb[2], bb[3]);
  return a[0].toFixed(4) + ',' + a[1].toFixed(4) + ' ~ ' + b[0].toFixed(4) + ',' + b[1].toFixed(4);
}

function stPolyAreaKm2(ring) {
  if (!ring || ring.length < 3) return 0;
  var R = 6371000, area = 0, prev = null;
  for (var i = 0; i <= ring.length; i++) {
    var p = ring[i % ring.length];
    var ll = mercToLonLat(p[0], p[1]);
    if (prev) {
      var dLon = (ll[0] - prev[0]) * Math.PI / 180;
      area += dLon * (Math.sin(prev[1] * Math.PI / 180) + Math.sin(ll[1] * Math.PI / 180)) / 2;
    }
    prev = ll;
  }
  return Math.abs(area) * R * R / 1e6;
}

/* 跨全部环 even-odd：多部件场景每个外环都算、带洞场景洞内不算（与地图拾取 ptInPoly 同口径） */
function stInRing(x, y, rings) {
  var ins = false;
  for (var ri = 0; ri < rings.length; ri++) {
    var ring = rings[ri];
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) ins = !ins;
    }
  }
  return ins;
}

function initStatsPanel() {
  var q = document.getElementById('stQuery');
  if (!q || q._stInit) return;
  q._stInit = true;
  var search = document.getElementById('stSearch');
  q.onclick = function () { stDoQuery(); };
  if (search) search.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); stDoQuery(); } };
  document.getElementById('stClear').onclick = function () { stDoClear(false); };
  document.getElementById('stExport').onclick = function () {
    /* 统一导出分发：① 统计查中的场景 → 该场景栅格统计；② 地图上有手动框选 → 选区内小区清单；③ 都没有 → 统计图层全部场景栅格统计 */
    if (STATE.sceneSel && ST.selScene >= 0) { stExport(false); return; }
    if (currentSel()) { exportSelection(); return; }
    stExport(true);
  };
  initStLayerDropdown();
  document.addEventListener('click', function (e) {
    var list = document.getElementById('stList');
    if (list && list.style.display !== 'none' && !(e.target.closest && e.target.closest('#statsBox'))) list.style.display = 'none';
  });
}

function initStLayerDropdown() {
  var box = document.getElementById('stLayerBox');
  var btn = document.getElementById('stLayerBtn');
  if (!box || !btn) return;
  function close() { box.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }
  btn.onclick = function (e) {
    e.stopPropagation();
    stRefreshLayers();
    var open = box.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  document.addEventListener('click', function () { if (box.classList.contains('open')) close(); });
}

function stEnsureLayer() {
  if (ST.layerId >= 0 && layers[ST.layerId] && layers[ST.layerId].kind === 'vector') return true;
  var idxs = stVectorLayerIdxs();
  if (!idxs.length) return false;
  ST.layerId = idxs[0];
  stSyncLayerCur();
  return true;
}

function stSyncLayerCur() {
  var cur = document.getElementById('stLayerCur');
  var L = layers[ST.layerId];
  if (!L || L.kind !== 'vector') ST.layerId = -1;
  if (cur) cur.textContent = (ST.layerId >= 0 && layers[ST.layerId]) ? layers[ST.layerId].name : '统计';
}

function stShowStatus(html) {
  var list = document.getElementById('stList');
  if (!list) return;
  list.innerHTML = '<div class="st-empty" style="padding:9px 10px">' + html + '</div>';
  list.style.display = '';
}

function stInfoMsg() { /* 状态提示改走 stShowStatus（顶栏模块内） */ }

function stRefreshLayers() {
  var pop = document.getElementById('stLayerPop');
  if (!pop) return;
  var idxs = stVectorLayerIdxs();
  pop.innerHTML = '<div class="dsel-h">统计图层（边界图层）</div>';
  if (!idxs.length) {
    pop.innerHTML += '<div class="st-empty" style="padding:8px 10px">未加载边界图层</div>';
    ST.layerId = -1;
    stSyncLayerCur();
    return;
  }
  if (ST.layerId < 0 || !layers[ST.layerId] || layers[ST.layerId].kind !== 'vector') ST.layerId = -1;
  idxs.forEach(function (li) {
    var L = layers[li];
    var b = document.createElement('button');
    b.type = 'button';
    var nm = document.createElement('span');
    nm.className = 'st-nm';
    nm.textContent = L.name;
    nm.title = L.name;
    var ct = document.createElement('span');
    ct.className = 'st-ct';
    ct.textContent = L.polygons.length + ' 个场景';
    b.appendChild(nm);
    b.appendChild(ct);
    if (li === ST.layerId) b.classList.add('on');
    b.onclick = function (e) {
      e.stopPropagation();
      ST.layerId = li;
      stDoClear(false);
      stSyncLayerCur();
      document.getElementById('stLayerBox').classList.remove('open');
    };
    pop.appendChild(b);
  });
  stSyncLayerCur();
}

/* 在当前图层里按名称模糊找场景，返回 [idx] */
function stFindScenes(kw) {
  var L = layers[ST.layerId];
  if (!L || !L.polygons) return [];
  kw = (kw || '').trim().toLowerCase();
  var out = [];
  for (var i = 0; i < L.polygons.length; i++) {
    var nm = getSceneName(L.polygons[i].props || {}) || '';
    if (!kw || nm.toLowerCase().indexOf(kw) >= 0) out.push(i);
  }
  return out;
}

function stDoQuery() {
  if (!stEnsureLayer()) { showErr('先加载一个边界图层'); return; }
  var kw = document.getElementById('stSearch').value.trim();
  if (!kw) { showErr('先输入要查询的场景名称'); return; }
  var hits = stFindScenes(kw);
  var list = document.getElementById('stList');
  if (!hits.length) {
    list.style.display = 'none';
    showErr('没有找到场景：' + kw);
    return;
  }
  if (hits.length === 1) {
    list.style.display = 'none';
    stSelectScene(hits[0]);
    return;
  }
  /* 多个匹配：列出来点选 */
  var L = layers[ST.layerId];
  var html = '', MAX = 30;
  for (var i = 0; i < Math.min(hits.length, MAX); i++) {
    var pg = L.polygons[hits[i]];
    html += '<div class="st-item" data-i="' + hits[i] + '"><span class="st-city">'
      + esc(stCityName(pg.props || {})) + '</span>'
      + esc(getSceneName(pg.props || {}) || ('场景 ' + (hits[i] + 1))) + '</div>';
  }
  if (hits.length > MAX) html += '<div class="st-empty">共 ' + hits.length + ' 个匹配，仅显示前 ' + MAX + ' 个，请输入更完整的名称</div>';
  list.innerHTML = html;
  list.style.display = '';
  Array.prototype.forEach.call(list.querySelectorAll('.st-item'), function (el) {
    el.onclick = function () {
      list.style.display = 'none';
      stSelectScene(parseInt(el.getAttribute('data-i'), 10));
    };
  });
}

/* 选中单个场景：红色高亮 + 建选区出统计（原顶部搜场景的那套） */
function stSelectScene(si) {
  var L = layers[ST.layerId];
  if (!L || !L.polygons || !L.polygons[si]) return;
  var pg = L.polygons[si];
  if (!pg._ringsMerc) {
    pg._ringsMerc = pg.rings.map(function (ring) {
      return ring.map(function (pt) { return [lonToMercX(pt[0]), latToMercY(pt[1])]; });
    });
  }
  ST.selScene = si;
  STATE.hlPoly = { L: L, pg: pg };
  STATE.sceneName = getSceneName(pg.props || {}) || ('场景 ' + (si + 1));
  var bb = pg._bbox || polyBBoxMerc(pg);
  if (bb) {
    /* 按场景实际大小贴合缩放（固定 14 级对小场景太远）：外扩 18% + 60 米边距，最大 16.5 级 */
    var pw = (bb[2] - bb[0]) * 0.18 + 60, ph = (bb[3] - bb[1]) * 0.18 + 60;
    try { map.getView().fit([bb[0] - pw, bb[1] - ph, bb[2] + pw, bb[3] + ph], { duration: 400, maxZoom: 16.5 }); } catch (e) {}
  }
  if (pg._ringsMerc.length && pg._ringsMerc[0].length >= 3) {
    /* 不抽稀：面板统计必须和导出（完整环）口径一致，抽稀会把边界附近的点判错；
       多部件/带洞场景把全部环存进 polyRings，判定走 even-odd */
    STATE.polyPts = pg._ringsMerc[0];
    STATE.polyRings = pg._ringsMerc;
    STATE.polyDone = true;
    STATE.sceneSel = true;
    STATE.selBox = null;
    STATE.selCircle = null;
    try { applySelection(); } catch (e2) {}
  }
  scheduleDraw();
  stInfoMsg();
}

function stDoClear(keepInput) {
  ST.selScene = -1;
  if (!keepInput) {
    var inp = document.getElementById('stSearch');
    if (inp) inp.value = '';
  }
  var list = document.getElementById('stList');
  if (list) list.style.display = 'none';
  if (STATE.sceneSel || STATE.hlPoly) {
    STATE.hlPoly = null;
    STATE.sceneName = null;
    STATE.sceneSel = false;
    STATE.polyPts = [];
    STATE.polyDone = false;
    STATE.selStats = null;
    try { updateToolPanel(); } catch (e) {}
    scheduleDraw();
  }
}

/* 异步逐点归类到场景并累计指标；done(rowsByRat, err) */
/* 当前制式：优先工具栏记录的 STATE.rat；没有时（恢复的会话）从栅格图层可见性推导 */
function stRatWant() {
  var r = (typeof STATE !== 'undefined' && STATE.rat) ? STATE.rat : null;
  if (r === '4G' || r === '5G' || r === 'all') return r;
  var has4 = false, has5 = false;
  for (var i = 0; i < layers.length; i++) {
    var L = layers[i];
    if (L.kind === 'grid' && L.ok && L.visible) {
      if (L.rat === '5G') has5 = true; else if (L.rat === '4G') has4 = true;
    }
  }
  if (has4 && !has5) return '4G';
  if (has5 && !has4) return '5G';
  return 'all';
}

function stCompute(sceneIdxs, done) {
  var L = layers[ST.layerId];
  var ratWant = stRatWant();
  var grids = [];
  for (var gi = 0; gi < layers.length; gi++) {
    var g = layers[gi];
    if (!g.ok || g.kind !== 'grid' || !g.ds || !g.mx || !g.my) continue;
    if ((ratWant === '4G' || ratWant === '5G') && g.rat !== ratWant) continue;
    grids.push(g);
  }
  if (!L || !grids.length) { done(null, !grids.length ? '未加载栅格图层' : '未选择边界图层'); return; }

  var scenes = [];
  for (var si = 0; si < sceneIdxs.length; si++) {
    var pg = L.polygons[sceneIdxs[si]];
    if (!pg) continue;
    if (!pg._ringsMerc) {
      pg._ringsMerc = pg.rings.map(function (ring) {
        return ring.map(function (pt) { return [lonToMercX(pt[0]), latToMercY(pt[1])]; });
      });
    }
    if (!pg._ringsMerc || !pg._ringsMerc.length) continue;
    var bb = pg._bbox || polyBBoxMerc(pg);
    scenes.push({ idx: sceneIdxs[si], pg: pg, rings: pg._ringsMerc, bb: bb });
  }
  if (!scenes.length) { done(null, '所选场景无有效边界'); return; }

  var gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
  scenes.forEach(function (sc) {
    if (sc.bb[0] < gx0) gx0 = sc.bb[0]; if (sc.bb[2] > gx1) gx1 = sc.bb[2];
    if (sc.bb[1] < gy0) gy0 = sc.bb[1]; if (sc.bb[3] > gy1) gy1 = sc.bb[3];
  });
  var cell = Math.max(gx1 - gx0, gy1 - gy0) / 48 || 1000;
  var gidx = new Map();
  scenes.forEach(function (sc, pos) {
    var cx0 = Math.floor((sc.bb[0] - gx0) / cell), cx1 = Math.floor((sc.bb[2] - gx0) / cell);
    var cy0 = Math.floor((sc.bb[1] - gy0) / cell), cy1 = Math.floor((sc.bb[3] - gy0) / cell);
    for (var cx = cx0; cx <= cx1; cx++) for (var cy = cy0; cy <= cy1; cy++) {
      var k = cx * 128 + cy;
      var arr = gidx.get(k);
      if (arr) arr.push(pos); else gidx.set(k, [pos]);
    }
  });

  function newAcc() { return { total: 0, poor: 0, rsum: 0, rn: 0, ssum: 0, sn: 0, mrcnt: 0, mrpass: 0 }; }
  var acc = { '4G': scenes.map(newAcc), '5G': scenes.map(newAcc) };
  var work = grids.map(function (g) { return { g: g, i: 0, n: g.mx.length }; });
  var totalPts = 0;
  work.forEach(function (w) { totalPts += w.n; });
  var wi = 0;

  function step() {
    var t0 = Date.now();
    while (wi < work.length && Date.now() - t0 < 40) {
      var w = work[wi], g = w.g, mx = g.mx, my = g.my;
      var rsrp = g.ds.num[g.rsrpCol], sinr = g.ds.num[g.sinrCol];
      var cntAll = g.ds.num[g.cntCol];
      var cntThr = g.ds.num[(g.rat === '5G' ? g.cnt105Col : g.cnt110Col)];
      var accR = acc[g.rat === '5G' ? '5G' : '4G'];
      var end = Math.min(w.n, w.i + 60000);
      for (; w.i < end; w.i++) {
        var x = mx[w.i], y = my[w.i];
        if (x < gx0 || x > gx1 || y < gy0 || y > gy1) continue;
        var cand = gidx.get(Math.floor((x - gx0) / cell) * 128 + Math.floor((y - gy0) / cell));
        if (!cand) continue;
        for (var ci = 0; ci < cand.length; ci++) {
          var sc = scenes[cand[ci]];
          if (x < sc.bb[0] || x > sc.bb[2] || y < sc.bb[1] || y > sc.bb[3]) continue;
          if (!stInRing(x, y, sc.rings)) continue;
          var a = accR[cand[ci]];
          a.total++;
          if (rsrp) { var r = rsrp[w.i]; if (isFinite(r)) { a.rsum += r; a.rn++; } }
          if (sinr) { var s2 = sinr[w.i]; if (isFinite(s2)) { a.ssum += s2; a.sn++; } }
          if (cntAll && cntThr) {
            var av = cntAll[w.i], tv = cntThr[w.i];
            if (isFinite(av) && isFinite(tv)) { a.mrcnt += av; a.mrpass += tv; }
          }
          var _poor2 = false;
          if (cntAll && cntThr) {
            var _av2 = cntAll[w.i], _tv2 = cntThr[w.i];
            if (isFinite(_av2) && isFinite(_tv2) && _av2 > 0 && _tv2 / _av2 < 0.8) _poor2 = true;
          }
          if (!_poor2 && g.rat === '5G' && sinr) {
            var _sv3 = sinr[w.i];
            if (isFinite(_sv3) && _sv3 < -3) _poor2 = true;
          }
          if (_poor2) a.poor++;
          break;
        }
      }
      if (w.i >= w.n) wi++;
    }
    var donePts = 0;
    for (var _wi = 0; _wi < work.length; _wi++) donePts += (_wi < wi ? work[_wi].n : (_wi === wi ? work[_wi].i : 0));
    stShowStatus('计算中… ' + Math.min(99, Math.round(donePts / Math.max(1, totalPts) * 100)) + '%');
    if (wi < work.length) { setTimeout(step, 0); return; }
    function rowsFor(rat) {
      var rows = [];
      for (var i = 0; i < scenes.length; i++) {
        var sc = scenes[i], a = acc[rat][i];
        var props = sc.pg.props || {};
        var cov = a.mrcnt > 0 ? (a.mrpass / a.mrcnt * 100) : null;
        rows.push([
          stCityName(props),
          getSceneName(props) || ('场景 ' + (sc.idx + 1)),
          stRangeStr(sc.bb),
          Math.round(stPolyAreaKm2(sc.ring) * 100) / 100,
          a.total,
          a.poor,
          a.mrcnt > 0 ? a.mrcnt : 0,
          a.mrcnt > 0 ? Math.max(0, a.mrcnt - a.mrpass) : 0,
          a.rn ? Math.round(a.rsum / a.rn * 100) / 100 : '',
          a.sn ? Math.round(a.ssum / a.sn * 100) / 100 : '',
          cov == null ? '' : Math.round(cov * 100) / 100
        ]);
      }
      return rows;
    }
    var out = {};
    var has4 = grids.some(function (g) { return g.rat !== '5G'; });
    var has5 = grids.some(function (g) { return g.rat === '5G'; });
    if (has4) out['4G'] = rowsFor('4G');
    if (has5) out['5G'] = rowsFor('5G');
    done(out, null);
  }
  setTimeout(step, 0);
}

function stExport(all) {
  if (ST.busy) return;
  var L = layers[ST.layerId];
  if (!L) {
    if (!stEnsureLayer()) { showErr('先加载一个边界图层'); return; }
    L = layers[ST.layerId];
  }
  var idxs = [];
  var cityFilter = (typeof STATE !== 'undefined' && STATE.cityFilter) ? STATE.cityFilter : '*';
  if (all) {
    for (var i = 0; i < L.polygons.length; i++) idxs.push(i);
    if (cityFilter && cityFilter !== '*' && typeof vecCityMatcher === 'function') {
      var cityMatcher = vecCityMatcher(L.polygons, CITY_NAMES[cityFilter] || cityFilter, cityFilter);
      if (cityMatcher) {
        idxs = idxs.filter(function (ix) { return cityMatcher(L.polygons[ix].props || {}); });
        if (!idxs.length) { showErr('当前地市下该图层没有场景'); return; }
      }
    }
  }
  else {
    if (ST.selScene < 0) { showErr('先查询并选中一个场景，或清除后导出全部'); return; }
    idxs.push(ST.selScene);
  }
  ST.busy = true;
  var bq = document.getElementById('stQuery'), bc = document.getElementById('stClear'), be = document.getElementById('stExport');
  if (bq) bq.disabled = true; if (bc) bc.disabled = true; if (be) be.disabled = true;
  stCompute(idxs, function (res, err) {
    ST.busy = false;
    if (bq) bq.disabled = false; if (bc) bc.disabled = false; if (be) be.disabled = false;
    if (err || !res) { showErr(err || '统计失败'); stInfoMsg(); return; }
    var H4 = ['地市名', '区域场景名称', '范围', '面积(km²)', '栅格点数', '质差栅格数', '栅格采样点数', '弱覆盖采样点数', 'RSRP均值(dBm)', 'SINR均值(dB)', '覆盖率≥-110dBm(%)'];
    var H5 = H4.slice(); H5[10] = '覆盖率≥-105dBm(%)';
    var rats = [];
    if (res['4G']) rats.push('4G');
    if (res['5G']) rats.push('5G');
    if (!rats.length) { showErr('没有可导出的数据'); stInfoMsg(); return; }
    var total = res[rats[0]].length;
    var base = (L.name || '场景统计').replace(/[\\/:*?"<>|]/g, '_');
    if (all && cityFilter && cityFilter !== '*') base += '_' + (CITY_NAMES[cityFilter] || cityFilter);
    if (rats.length === 1) base += '_' + rats[0];
    try {
      if (total <= 1000000 && typeof XLSX !== 'undefined') {
        var wb = XLSX.utils.book_new();
        rats.forEach(function (rt) {
          XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([(rt === '5G' ? H5 : H4)].concat(res[rt])), rt);
        });
        XLSX.writeFile(wb, base + '_场景指标.xlsx');
      } else {
        rats.forEach(function (rt, ri) {
          setTimeout(function () { stDownloadCsv(base + '_' + rt + '.csv', rt === '5G' ? H5 : H4, res[rt]); }, ri * 400);
        });
      }
      stShowStatus('已导出 ' + total + ' 个场景');
      setTimeout(function () { var l = document.getElementById('stList'); if (l) l.style.display = 'none'; }, 2500);
    } catch (e) {
      showErr('导出失败：' + e.message);
      stInfoMsg();
    }
  });
}

function stDownloadCsv(name, header, rows) {
  var lines = [header.join(',')];
  function cell(v) {
    v = v == null ? '' : String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  for (var i = 0; i < rows.length; i++) lines.push(rows[i].map(cell).join(','));
  var blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
