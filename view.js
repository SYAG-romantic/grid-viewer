'use strict';
/* ============================ 8. 地图 ============================ */

var map, cv, ctx, baseSource = null, baseLayer = null, overlayLayers = {};
var lodBuf = null;

function tdtUrl(layer, tk, sub) {
  var host = (!sub || sub === 'random') ? 't{0-7}' : sub;
  return 'https://' + host + '.tianditu.gov.cn/' + layer + '_w/wmts' +
    '?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
    '&LAYER=' + layer + '&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles' +
    '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=' + encodeURIComponent(tk || '');
}

/* ---- 底图下拉 ---- */
function syncBaseDropdown() {
  var cur = document.getElementById('baseCur');
  if (cur) cur.textContent = BASE_NAME[STATE.base] || '';
  var box = document.getElementById('baseBox');
  if (!box) return;
  Array.prototype.forEach.call(box.querySelectorAll('.dsel-pop button'), function (b) {
    b.classList.toggle('on', b.getAttribute('data-v') === STATE.base);
  });
}

/* ---- 搜索类型下拉 ---- */
function initJumpTypeDropdown() {
  var box = document.getElementById('jumpTypeBox');
  var btn = document.getElementById('jumpTypeBtn');
  if (!box || !btn) return;
  var cur = document.getElementById('jumpTypeCur');
  var hidden = document.getElementById('jumpType');
  function close() {
    box.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  }
  btn.onclick = function (e) {
    e.stopPropagation();
    var open = box.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  Array.prototype.forEach.call(box.querySelectorAll('.dsel-pop button'), function (b) {
    b.onclick = function (e) {
      e.stopPropagation();
      var v = b.getAttribute('data-v');
      if (hidden) hidden.value = v;
      if (cur) cur.textContent = b.textContent.trim();
      Array.prototype.forEach.call(box.querySelectorAll('.dsel-pop button'), function (x) {
        x.classList.toggle('on', x === b);
      });
      close();
    };
  });
  document.addEventListener('click', function () {
    if (box.classList.contains('open')) close();
  });
}

function initBaseDropdown() {
  var box = document.getElementById('baseBox');
  var btn = document.getElementById('baseBtn');
  if (!box || !btn) return;

  function close() {
    box.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  }
  btn.onclick = function (e) {
    e.stopPropagation();
    var open = box.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  Array.prototype.forEach.call(box.querySelectorAll('.dsel-pop button'), function (b) {
    b.onclick = function (e) {
      e.stopPropagation();
      STATE.base = b.getAttribute('data-v');
      syncBaseDropdown();
      close();
      rebuildBase();
    };
  });
  document.addEventListener('click', function () {
    if (box.classList.contains('open')) close();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && box.classList.contains('open')) close();
  });
  syncBaseDropdown();
}

/* ---- 顶部「城市」下拉：CityID → 地市名，选单城只显示该地市，新疆=全疆 ----
   注意：侧栏城市下拉的 value 是图层内城市列表的索引（L.cities 下标），
   顶部按钮用的是 CityID，经 setLayerCity 换算后写 L.citySel */
var CITY_NAMES = {
  '6501': '乌鲁木齐', '6502': '克拉玛依', '6521': '吐鲁番', '6522': '哈密',
  '6523': '昌吉', '6527': '博州', '6528': '巴州', '6529': '阿克苏',
  '6530': '克州', '6531': '喀什', '6532': '和田', '6540': '伊犁',
  '6542': '塔城', '6543': '阿勒泰', '6590': '奎屯', '6591': '石河子'
};

/* 把城市选择写到单个图层：CityID → 该图层城市列表的索引。
   图层没有城市字段时不动；有字段但不含该城市 → 'none'（显示为空，
   与"只显示该地市数据"的语义一致），不能用 '*'（那会显示全部） */
function setLayerCity(L, cityId) {
  if (!L.cities || !L.cityIdx) return false;   /* 无城市列：不参与城市筛选 */
  if (!cityId) { L.citySel = '*'; return true; }
  var k = L.cities.indexOf(String(cityId));
  /* 站点存的是中文名（如"博州"），下拉给的是数字 ID（如"6527"）：经映射表换算 */
  if (k < 0 && typeof CITY_NAMES !== 'undefined' && CITY_NAMES[cityId]) {
    k = L.cities.indexOf(CITY_NAMES[cityId]);
  }
  L.citySel = k >= 0 ? String(k) : 'none';
  return true;
}

function applyToolbarCity() {
  var v = STATE.cityFilter || '*';
  for (var i = 0; i < layers.length; i++) {
    var L = layers[i];
    if (!L.ok) continue;
    if (L.kind === 'grid') {
      if (setLayerCity(L, v === '*' ? null : v)) rebuildBuckets(L);
    } else if (L.kind === 'site') {
      /* 地市筛选走 shader u_citySel，不重建缓冲（快） */
      setLayerCity(L, v === '*' ? null : v);
    } else if (L.kind === 'vector') {
      /* 边界层：存 citySel（名称）和 cityCode（代码），绘制时按属性过滤 */
      L.citySel = (v === '*') ? '*' : (CITY_NAMES[v] || v);
      L.cityCode = (v === '*') ? '*' : v;
    }
  }
  if (v && v !== '*') zoomToCity();
  else if (v === '*') zoomToAll();
  /* 选区还开着时重算统计（地市变了点数就变了） */
  if (currentSel()) applySelection();
  renderLegend();
  scheduleDraw();
  saveViewState();
}

/* 缩放到指定地市：汇总所有可见图层在该地市的数据范围 */
function zoomToCity() {
  var v = STATE.cityFilter;
  if (!v || !map) return;
  if (v === '*') { try { zoomToAll(); } catch (e) {} return; }
  var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  var found = false;
  for (var i = 0; i < layers.length; i++) {
    var L = layers[i];
    if (!L.visible || !L.ok || !L.mx || !L.my || !L.cityIdx) continue;
    var cs = (L.citySel !== undefined && L.citySel !== '*' && L.citySel !== 'none') ? parseInt(L.citySel, 10) : -1;
    if (cs < 0) continue;
    if (!L._cityBounds) L._cityBounds = {};
    var b = L._cityBounds[cs];
    if (!b) {
      var bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      var mx = L.mx, my = L.my, cidx = L.cityIdx, n = L.ds.n;
      for (var k = 0; k < n; k++) {
        if (cidx[k] !== cs) continue;
        var x = mx[k], y = my[k];
        if (!isFinite(x) || !isFinite(y)) continue;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
        if (y < by0) by0 = y; if (y > by1) by1 = y;
      }
      if (!isFinite(bx0)) continue;
      b = [bx0, by0, bx1, by1];
      L._cityBounds[cs] = b;
    }
    found = true;
    if (b[0] < x0) x0 = b[0]; if (b[2] > x1) x1 = b[2];
    if (b[1] < y0) y0 = b[1]; if (b[3] > y1) y1 = b[3];
  }
  /* 边界层：按地市过滤多边形算范围（与绘制同口径，认 CITYID 与中文地州/地市/城市字段） */
  var cityName = CITY_NAMES[v] || v;
  for (var vi = 0; vi < layers.length; vi++) {
    var vL = layers[vi];
    if (!vL.visible || !vL.ok || vL.kind !== 'vector' || !vL.polygons) continue;
    var zMatcher = vecCityMatcher(vL.polygons, cityName, v);
    if (!zMatcher) continue;
    for (var pi = 0; pi < vL.polygons.length; pi++) {
      var pg = vL.polygons[pi];
      if (!zMatcher(pg.props || {})) continue;
      var bb = pg._bbox;
      if (bb) {
        found = true;
        if (bb[0] < x0) x0 = bb[0]; if (bb[2] > x1) x1 = bb[2];
        if (bb[1] < y0) y0 = bb[1]; if (bb[3] > y1) y1 = bb[3];
      }
    }
  }
  if (!found) return;
  var pad = Math.max(x1 - x0, y1 - y0) * 0.08 + 1000;
  try {
    map.getView().fit([x0 - pad, y0 - pad, x1 + pad, y1 + pad], { duration: 400, maxZoom: 12 });
  } catch (e) {}
}
/* 新疆（全疆）：缩放到全部数据范围 */
function zoomToAll() {
  var v = STATE.cityFilter;
  if (!v || v !== '*' || !map) return;
  var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  var found = false;
  for (var i = 0; i < layers.length; i++) {
    var L = layers[i];
    if (!L.visible || !L.ok || !L.mx || !L.my) continue;
    /* 全疆：不过滤城市，直接算全部点范围（无城市列的图层也参与） */
    var cs = -1;
    if (!L._cityBounds) L._cityBounds = {};
    var b = L._cityBounds[cs];
    if (!b) {
      var bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      var mx = L.mx, my = L.my, n = L.ds.n;
      for (var k = 0; k < n; k++) {
        var x = mx[k], y = my[k];
        if (!isFinite(x) || !isFinite(y)) continue;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
        if (y < by0) by0 = y; if (y > by1) by1 = y;
      }
      if (!isFinite(bx0)) continue;
      b = [bx0, by0, bx1, by1];
      L._cityBounds[cs] = b;
    }
    found = true;
    if (b[0] < x0) x0 = b[0]; if (b[2] > x1) x1 = b[2];
    if (b[1] < y0) y0 = b[1]; if (b[3] > y1) y1 = b[3];
  }
  if (!found) {
    try { map.getView().fit([8100000, 4000000, 10700000, 6200000], { duration: 400 }); } catch (e) {}
    return;
  }
  var pad = Math.max(x1 - x0, y1 - y0) * 0.08 + 1000;
  try {
    map.getView().fit([x0 - pad, y0 - pad, x1 + pad, y1 + pad], { duration: 400, maxZoom: 12 });
  } catch (e) {}
}

/* 城市名 → 数字 ID 反查（工参层的城市列表存中文名，与栅格层的 ID 对齐用） */
var _cityName2Id = null;
function cityNameToId(name) {
  if (!_cityName2Id) {
    _cityName2Id = {};
    if (typeof CITY_NAMES !== 'undefined') {
      for (var id in CITY_NAMES) _cityName2Id[CITY_NAMES[id]] = id;
    }
  }
  return _cityName2Id[name] || null;
}

/* 顶部按钮上的文字：各图层当前城市一致 → 显示该地市名；不一致 → 多值。
   比较统一折算到数字 ID 空间（工参层城市列表是中文名，直接比会永远"多值"）；
   某层没有所选地市数据（citySel='none'）→ 不参与投票，不污染标签 */
function syncCityDropdown() {
  var cur = document.getElementById('cityCur');
  var box = document.getElementById('cityBox');
  var common = null;
  for (var i = 0; i < layers.length; i++) {
    var L = layers[i];
    if (!L.ok || !L.cities) continue;
    var raw;
    if (L.citySel === '*') raw = '*';
    else if (L.citySel === 'none') continue;
    else {
      var cv = L.cities[parseInt(L.citySel, 10)] || '';
      raw = (typeof CITY_NAMES !== 'undefined' && CITY_NAMES[cv]) ? cv : (cityNameToId(cv) || cv);
    }
    if (common === null) common = raw;
    else if (common !== raw) { common = 'mixed'; break; }
  }
  if (common === null || common === 'none') common = STATE.cityFilter || '*';
  if (cur) cur.textContent = common === '*' ? '全部地市' : common === 'mixed' ? '多值'
    : (CITY_NAMES[common] || common);
  if (box) {
    Array.prototype.forEach.call(box.querySelectorAll('.dsel-pop button'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-v') === common);
    });
  }
  /* 侧栏下拉同步到选中图层 */
  var sel = document.getElementById('citySel');
  if (sel && selected && selected.cities) {
    sel.value = selected.citySel;
  }
}

function initCityDropdown() {
  var box = document.getElementById('cityBox');
  var btn = document.getElementById('cityBtn');
  if (!box || !btn) return;

  function close() {
    box.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  }
  btn.onclick = function (e) {
    e.stopPropagation();
    var open = box.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  Array.prototype.forEach.call(box.querySelectorAll('.dsel-pop button'), function (b) {
    b.onclick = function (e) {
      e.stopPropagation();
      STATE.cityFilter = b.getAttribute('data-v');
      applyToolbarCity();
      syncCityDropdown();
      close();
    };
  });
  document.addEventListener('click', function () {
    if (box.classList.contains('open')) close();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && box.classList.contains('open')) close();
  });
  syncCityDropdown();
}

/* ---- 顶部「着色」下拉：与侧栏「栅格着色」共用同一 applyGridColorMode ---- */
var GMODE_NAME = { rsrp: 'RSRP均值', sinr: 'SINR均值', cov: '覆盖率' };

/* 切换栅格着色模式：含字段支持检查（缺字段回退 RSRP 并提示），
   重建所有栅格图层的分桶，并同步侧栏下拉与顶部按钮两处 UI */
function applyGridColorMode(mode) {
  /* 字段支持检查：以选中图层（或第一个栅格图层）为准，缺字段则回退并提示 */
  var chk = (selected && selected.kind === 'grid') ? selected : null;
  if (!chk) {
    for (var i0 = 0; i0 < layers.length; i0++) {
      if (layers[i0].kind === 'grid' && layers[i0].ok) { chk = layers[i0]; break; }
    }
  }
  if (mode === 'sinr' && chk && !(chk.sinrCol && chk.ds.num[chk.sinrCol])) {
    showErr('当前栅格数据没有 SINR 字段（需要 SINRMean 列），无法按 SINR 着色。');
    mode = STATE.gridColorMode;
  } else if (mode === 'cov' && chk) {
    var thrCol = chk.rat === '5G' ? chk.cnt105Col : chk.cnt110Col;
    if (!(chk.cntCol && chk.ds.num[chk.cntCol]) || !(thrCol && chk.ds.num[thrCol])) {
      showErr('当前栅格数据缺少 MRCnt / MRCnt_' + (chk.rat === '5G' ? '105' : '110') +
        ' 字段，无法计算 MR 覆盖率。');
      mode = STATE.gridColorMode;
    }
  }
  STATE.gridColorMode = mode;
  var _gridLs = [];
  for (var i = 0; i < layers.length; i++) {
    var L = layers[i];
    if (L.kind === 'grid' && L.ok && L.buckets) {
      rebuildBuckets(L, true);  /* 跳过同步 GL 构建，避免卡顿 */
      _gridLs.push(L);
    }
  }
  /* WebGL 缓冲异步重建 */
  (function (_ls) {
    var _idx = 0;
    function _next() {
      if (_idx >= _ls.length) { scheduleDraw(); return; }
      var _L = _ls[_idx++];
      buildGridGLAsync(_L).then(_next, _next);
    }
    _next();
  })(_gridLs);
  /* 选区还开着时重算统计（档位分布要跟新指标走） */
  if (currentSel()) applySelection();
  renderLegend();
  /* 重绘等异步 GL 重建完成后统一触发，避免中间黑闪 */
  saveViewState();
  /* 两端 UI 同步：侧栏下拉 + 顶部按钮 */
  var sidebar = document.getElementById('gridColor');
  if (sidebar) sidebar.value = mode;
  var gmCur = document.getElementById('gmodeCur');
  if (gmCur) gmCur.textContent = GMODE_NAME[mode] || 'RSRP';
  var gmBox = document.getElementById('gmodeBox');
  if (gmBox) {
    Array.prototype.forEach.call(gmBox.querySelectorAll('.dsel-pop button'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-v') === mode);
    });
  }
}

function initColorModeDropdown() {
  var box = document.getElementById('gmodeBox');
  var btn = document.getElementById('gmodeBtn');
  if (!box || !btn) return;

  function close() {
    box.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  }
  btn.onclick = function (e) {
    e.stopPropagation();
    var open = box.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  Array.prototype.forEach.call(box.querySelectorAll('.dsel-pop button'), function (b) {
    b.onclick = function (e) {
      e.stopPropagation();
      applyGridColorMode(b.getAttribute('data-v'));
      close();
    };
  });
  document.addEventListener('click', function () {
    if (box.classList.contains('open')) close();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && box.classList.contains('open')) close();
  });
  var cur = document.getElementById('gmodeCur');
  if (cur) cur.textContent = GMODE_NAME[STATE.gridColorMode] || 'RSRP';
}

function initMap() {
  map = new ol.Map({
    target: 'map',
    layers: [],
    view: new ol.View({
      center: [0, 0],
      zoom: 4,
      minZoom: 3,
      maxZoom: 19,
      constrainResolution: false
    })
  });
  cv = document.getElementById('pts');
  ctx = cv.getContext('2d');

  map.on('postrender', scheduleDraw);

  /* 缩放/平移动画过程中只画快速圆点：动画每帧都重绘，画全扇区会把动画卡成 PPT。
     停稳 250ms 后再补画一次全扇区，避免连续缩放时每停一下就卡一次 */
  map.on('movestart', function () { STATE.navigating = true; STATE._dragging = true; });
  map.on('moveend', function () {
    STATE._dragging = false;
    STATE.navigating = false;
    clearTimeout(map._navT);
    map._navT = setTimeout(scheduleDraw, 250);
  });

  /* 实时经纬度显示已移除（v114） */

  map.on('singleclick', function (evt) {
    pickAt(evt.pixel);
  });

  /* 去掉 OL 自带的多余控件：
     - attribution：点击会展开「© 天地图」，该位置改放主题切换按钮
     - rotate：「指北/旋转复位」按钮，默认停在**右上角**，本应用不旋转地图用不到；
       它靠 ol-hidden 类隐藏，而该类带 .25s 过渡，一旦被重新触发就会闪出一个
       跟随主题配色的方块（浅色白、深色黑）
     注意：判断依据用**元素类名**而不是 c.getClassName()——
     OL 10 的控件对象没有这个方法，用它判断会静默失效（这段代码以前就没生效过，
     一直是靠 CSS 兜住的） */
  map.getControls().forEach(function (c) {
    var el = c && c.element;
    var cn = (el && el.className) ? String(el.className) : '';
    if (cn.indexOf('ol-attribution') >= 0 || cn.indexOf('ol-rotate') >= 0) {
      map.removeControl(c);
    }
  });
}

/* ---- 深色 / 浅色主题 ---- */
function applyTheme(mode) {
  var light = (mode === 'light');
  document.documentElement.classList.toggle('light', light);
  var btn = document.getElementById('btnTheme');
  if (btn) {
    /* 图标=当前模式，提示文字写清楚点击后的动作 */
    var tip = light ? '当前：浅色模式 · 点击切换到深色' : '当前：深色模式 · 点击切换到浅色';
    btn.title = tip;
    btn.setAttribute('aria-label', tip);
  }
  if (map) scheduleDraw();
}

function initTheme() {
  var saved = lsGet('theme', '');
  if (saved !== 'light' && saved !== 'dark') {
    saved = (global.matchMedia && global.matchMedia('(prefers-color-scheme: light)').matches)
      ? 'light' : 'dark';
  }
  applyTheme(saved);
  var btn = document.getElementById('btnTheme');
  if (btn) {
    btn.onclick = function () {
      var next = document.documentElement.classList.contains('light') ? 'dark' : 'light';
      lsSet('theme', next);
      applyTheme(next);
    };
  }
}

/* 可用底图（天地图图层名） */
var BASE_LAYERS = [
  { id: 'img', name: '影像底图' },
  { id: 'vec', name: '矢量底图' },
  { id: 'ter', name: '地形晕染' },
  { id: 'none', name: '无底图' }
];
/* 底图与其配套注记：注记随底图一起加载，不再单独勾选 */
var BASE_ANNO = { img: 'cia', vec: 'cva', ter: 'cta', none: null };
var BASE_NAME = { img: '影像', vec: '矢量', ter: '地形', none: '无底图' };

function makeTileSource(layer, tk) {
  var src = new ol.source.XYZ({
    url: tdtUrl(layer, tk, STATE.sub),
    crossOrigin: 'anonymous',
    maxZoom: 18,
    attributions: '© 天地图'
  });
  src.on('tileloadend', function () { setTdtStatus('底图正常', 'ok'); });
  src.on('tileloaderror', function () {
    setTdtStatus('密钥无效或未开通该服务', 'warn');
    showErr('天地图瓦片加载失败：请检查密钥（tk）是否有效、是否已开通对应服务。');
  });
  return src;
}

function rebuildBase() {
  var tk = STATE.tk;
  if (baseLayer) { map.removeLayer(baseLayer); baseLayer = null; }
  Object.keys(overlayLayers).forEach(function (k) {
    map.removeLayer(overlayLayers[k]);
  });
  overlayLayers = {};
  map.getLayers().clear();
  updateTdtStatus();

  if (!tk) { scheduleDraw(); return; }

  if (STATE.base !== 'none') {
    baseSource = makeTileSource(STATE.base, tk);
    baseLayer = new ol.layer.Tile({ source: baseSource, zIndex: 1 });
    map.addLayer(baseLayer);

    var anno = BASE_ANNO[STATE.base];
    if (anno) {
      var anoSrc = makeTileSource(anno, tk);
      var anoLay = new ol.layer.Tile({ source: anoSrc, zIndex: 2 });
      overlayLayers[anno] = anoLay;
      map.addLayer(anoLay);
    }
  }
  scheduleDraw();
}

function setTdtStatus(text, kind) {
  var st = document.getElementById('tkStat');           /* 弹窗头部状态 */
  if (st) { st.textContent = text; st.className = 'tk-stat' + (kind ? ' ' + kind : ''); }
  clearTimeout(setTdtStatus._t);
  if (kind === 'ok') {
    setTdtStatus._t = setTimeout(updateTdtStatus, 4000);
  }
}

function updateTdtStatus() {
  var st = document.getElementById('tkStat');
  if (!st) return;
  if (!STATE.tk) {
    st.textContent = '未配置密钥';
    st.className = 'tk-stat warn';
    return;
  }
  st.textContent = maskKey(STATE.tk);
  st.className = 'tk-stat ok';
}

/* ---- 密钥下拉与输入联动 ---- */
function renderKeySelect() {
  var sel = document.getElementById('tkSel');
  if (!STATE.keys.length) {
    sel.innerHTML = '<option value="">（还没有保存的密钥）</option>';
    sel.disabled = true;
  } else {
    var h = '';
    for (var i = 0; i < STATE.keys.length; i++) {
      h += '<option value="' + i + '"' +
        (STATE.keys[i] === STATE.tk ? ' selected' : '') + '>' + esc(maskKey(STATE.keys[i])) + '</option>';
    }
    sel.innerHTML = h;
    sel.disabled = false;
  }
  updateTdtStatus();
}

/* ============================ 9. 渲染 ============================ */

var drawPending = false;

function scheduleDraw() {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(function () { drawPending = false; drawAll(); });
}

function transformOf(map, size) {
  var p0 = map.getPixelFromCoordinate([0, 0]);
  var p1 = map.getPixelFromCoordinate([1, 0]);
  var p2 = map.getPixelFromCoordinate([0, 1]);
  if (!p0 || !p1 || !p2) return null;
  return [p1[0] - p0[0], p1[1] - p0[1], p2[0] - p0[0], p2[1] - p0[1], p0[0], p0[1]];
}

function drawAll() {
  if (!map) return;
  var size = map.getSize();
  if (!size || !size[0]) return;
  var w = size[0], h = size[1];
  var dpr = Math.min(global.devicePixelRatio || 1, 2);
  /* 4K / 多屏拼接时限制画布总像素，避免显存与逐帧重绘压力 */
  while (dpr > 1 && w * dpr * (h * dpr) > 16000000) dpr -= 0.25;
  var cw = Math.round(w * dpr), chh = Math.round(h * dpr);
  if (cv.width !== cw || cv.height !== chh) {
    cv.width = cw; cv.height = chh;
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cw, chh);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  var t = transformOf(map, size);
  if (!t) return;
  var view = map.getView();
  var res = view.getResolution();
  var ext = view.calculateExtent(size);
  var pad = 10 * res;
  var box = [ext[0] - pad, ext[1] - pad, ext[2] + pad, ext[3] + pad];

  var glUsed = false;
  var siteGlUsed = false;
  for (var i = 0; i < layers.length; i++) {
    var L = layers[i];
    if (!L.visible || !L.ok) continue;
    if (L.kind === 'grid') {
      /* WebGL 优先（千万级也不卡），不可用时回退 Canvas */
      if (glDrawGrid(L, t, w, h, box, dpr, !glUsed)) glUsed = true;
      else drawGrid(ctx, L, t, w, h, box);
    }
    else if (L.kind === 'site') {
      if (!siteGlUsed && !glsClearFrame(w, h, dpr)) { drawSites(ctx, L, t, w, h, box); continue; }
      if (glDrawSites(L, t, w, h, box, dpr)) siteGlUsed = true;
      else drawSites(ctx, L, t, w, h, box);
    }
    else if (L.kind === 'vector') {
      drawVector(ctx, L, t, w, h, box);
    }
  }
  /* 本帧没有任何可见栅格层走 WebGL 时补一次清屏：
     #glpts 是共享画布，不清的话取消勾选/移除图层后上一帧的采样点会残留 */
  if (GLR && GLR.ok && !glUsed) glClearFrame(w, h, dpr);
  /* 站点画布同理：无可见站点层走 WebGL 时清掉残留 */
  if (GLS && GLS.ok && !siteGlUsed) glsClearFrame(w, h, dpr);

  if (STATE.selBox || STATE.selDrag || STATE.selCircle || STATE.selCircleDrag ||
      STATE.coordPick || (STATE.polyPts && STATE.polyPts.length)) drawSelection(ctx, t, w, h);
  if (STATE.measPts && STATE.measPts.length) drawMeasure(ctx, t, w, h);
  if (STATE.pin) drawPin(ctx, t, w, h);
  if (STATE.hlCell) drawHlCell(ctx, t, w, h);
}

/* 搜索命中小区红框：持久显示，点清除才消失 */
function drawHlCell(c, t, w, h) {
  var hl = STATE.hlCell;
  var L = hl.L, i = hl.i;
  if (!L || !L.ok) { STATE.hlCell = null; return; }
  var x = L.mx[i], y = L.my[i];
  if (!isFinite(x) || !isFinite(y)) return;
  var px = t[0] * x + t[2] * y + t[4];
  var py = t[1] * x + t[3] * y + t[5];
  // 判断是否室分
  var stypeArr = L.ds.stype;
  var sv = stypeArr ? stypeArr[i] : '';
  var isIndoor = typeof sv === 'string' && /室分|室内/.test(sv);
  var is5g = (L.rat === '5G');
  // 实地半径转像素
  var res = 0;
  try { res = map.getView().getResolution() || 0; } catch (e) {}
  var dpr = 1;
  try { dpr = window.devicePixelRatio || 1; } catch (e) {}
  var mR = isIndoor ? (is5g ? 25 : 30) : (is5g ? 60 : 80);
  var rp = (res > 0) ? mR / res * dpr : 40;
  if (px < -rp - 20 || py < -rp - 20 || px > w + rp + 20 || py > h + rp + 20) return;
  c.strokeStyle = '#e74c3c';
  c.lineWidth = 2.5;
  c.beginPath();
  if (isIndoor) {
    c.arc(px, py, rp, 0, Math.PI * 2);
  } else {
    var azArr = L.azCol ? L.ds.num[L.azCol] : null;
    var az = azArr ? azArr[i] : 0;
    var beam = is5g ? 45 : 35;
    // 方位角 0=北顺时针，转 canvas 弧度（0=东逆时针为正？canvas 用 0=东顺时针）
    // 统一：azDeg 北起顺时针 → canvas 角 = azDeg*PI/180 - PI/2
    var a0 = (az - beam / 2) * Math.PI / 180 - Math.PI / 2;
    var a1 = (az + beam / 2) * Math.PI / 180 - Math.PI / 2;
    c.moveTo(px, py);
    c.arc(px, py, rp, a0, a1);
    c.closePath();
  }
  c.stroke();
}


/* 定位标记 */
function drawPin(c, t, w, h) {
  var p = STATE.pin;
  var px = t[0] * p.mx + t[2] * p.my + t[4];
  var py = t[1] * p.mx + t[3] * p.my + t[5];
  if (px < -260 || py < -260 || px > w + 260 || py > h + 260) return;

  c.beginPath();
  c.arc(px, py, 11, 0, Math.PI * 2);
  c.fillStyle = 'rgba(59,130,246,0.22)';
  c.fill();
  c.beginPath();
  c.arc(px, py, 5, 0, Math.PI * 2);
  c.fillStyle = '#3b82f6';
  c.fill();
  c.lineWidth = 1.8;
  c.strokeStyle = '#ffffff';
  c.stroke();

  c.strokeStyle = 'rgba(59,130,246,0.95)';
  c.lineWidth = 1.2;
  c.beginPath();
  c.moveTo(px - 18, py); c.lineTo(px - 8, py);
  c.moveTo(px + 8, py); c.lineTo(px + 18, py);
  c.moveTo(px, py - 18); c.lineTo(px, py - 8);
  c.moveTo(px, py + 8); c.lineTo(px, py + 18);
  c.stroke();

  var txt = p.lon.toFixed(6) + ', ' + p.lat.toFixed(6);
  c.font = '12px "Microsoft YaHei","PingFang SC",sans-serif';
  c.textBaseline = 'middle';
  var tw = c.measureText(txt).width;
  var bw = tw + 16, bh = 24;
  var bx = px + 16, by = py + 12;
  if (bx + bw > w - 6) bx = px - 16 - bw;
  if (by + bh > h - 6) by = py - 12 - bh;
  roundRect(c, bx, by, bw, bh, 6);
  c.fillStyle = 'rgba(20,22,26,0.94)';
  c.fill();
  c.strokeStyle = 'rgba(59,130,246,0.75)';
  c.lineWidth = 1;
  c.stroke();
  c.fillStyle = '#e6e8ec';
  c.fillText(txt, bx + 8, by + bh / 2 + 0.5);
}

function roundRect(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/* 逐点绘制格子。selTest 存在时按 inside 只画选中/未选中的那一批。
   无描边时每档合成一个 path 一次 fill：原来每格一次 fillRect，几十万次 canvas 调用是主要耗时；
   合并后只有 6 次 fill。格子本身不重叠（栅格），近看与逐个 fillRect 像素一致；
   远看亚像素格子不再重复叠加，颜色反而更干净 */
function paintCells(c, L, t, w, h, box, cw, ch, selTest, inside) {
  var mx = L.mx, my = L.my;
  var t0 = t[0], t1 = t[1], t2 = t[2], t3 = t[3], t4 = t[4], t5 = t[5];
  var b0 = box[0], b1 = box[1], b2 = box[2], b3 = box[3];
  var hw = cw * 0.5, hh = ch * 0.5;
  var bandsFill = gridFill(L);
  for (var b = 0; b < L.bandCount; b++) {
    var idx = L.buckets[b];
    if (!idx.length) continue;
    c.fillStyle = bandsFill[b];
    c.beginPath();
    for (var k = 0; k < idx.length; k++) {
      var i = idx[k];
      var x = mx[i], y = my[i];
      if (x < b0 || x > b2 || y < b1 || y > b3) continue;
      if (selTest && (selTest(x, y) !== inside)) continue;
      var px = t0 * x + t2 * y + t4;
      var py = t1 * x + t3 * y + t5;
      if (px < -cw || py < -ch || px > w + cw || py > h + ch) continue;
        c.rect(px - hw, py - hh, cw, ch);
    }
    c.fill();
  }
}

function drawGrid(c, L, t, w, h, box) {
  var mx = L.mx, my = L.my;
  var t0 = t[0], t1 = t[1], t2 = t[2], t3 = t[3], t4 = t[4], t5 = t[5];
  var b0 = box[0], b1 = box[1], b2 = box[2], b3 = box[3];

  /* 锁死真实尺寸：格子宽高 = 栅格步长在当前缩放下的像素跨度。
     经向用墨卡托 x 直接换算；纬向需按当前纬度做 1/cos 补偿。 */
  var yc = (b1 + b3) * 0.5;
  var latRad = 2 * Math.atan(Math.exp(yc / 6378137)) - Math.PI / 2;
  var cosLat = Math.cos(latRad);
  if (!(cosLat > 0.05)) cosLat = 0.05;
  var cw = Math.max(0.8, (L.dLon || 0.0002) * DEG2MERC * Math.abs(t0));
  var ch = Math.max(0.8, (L.dLat || 0.00018) * DEG2MERC / cosLat * Math.abs(t3));
  /* 全自动聚合，无需手动开关：格子在屏幕上不足 2px（缩得太远、单个格子已不可辨）
     时按屏幕网格聚合绘制；放大到格子清晰时自动恢复全细节绘制。
     缩放动画中点很多时也聚合，保证动画不卡。
     有选区时保持逐点绘制，以保留选区压暗效果 */
  var agg = !currentSel() && ((cw < 2 && ch < 2) || (STATE.navigating && L.total > 80000));
  if (global.__viewer) global.__viewer.lastCell = { cw: cw, ch: ch, agg: agg };

  /* 半透明叠加：让底图透出来，便于对照地物（30% 透明 = 不透明度 0.7） */
  var alpha0 = c.globalAlpha;

  if (!agg) {
    var st = makeSelTest(currentSel());
    if (st) {
      /* 有选区时：选区外压暗、选区内正常，便于看清选中了哪些点 */
      c.globalAlpha = GRID_ALPHA * 0.22;
      paintCells(c, L, t, w, h, box, cw, ch, st, false);
      c.globalAlpha = GRID_ALPHA;
      paintCells(c, L, t, w, h, box, cw, ch, st, true);
    } else {
      c.globalAlpha = GRID_ALPHA;
      paintCells(c, L, t, w, h, box, cw, ch, null, false);
    }
    c.globalAlpha = alpha0;
    return;
  }

  /* 低缩放：此时 20m 已不足 1 像素，按屏幕网格聚合、取每格最差档 */
  var cell = 2;
  var cols = Math.ceil(w / cell) + 2, rows = Math.ceil(h / cell) + 2;
  var need = cols * rows;
  if (!lodBuf || lodBuf.length < need) lodBuf = new Int8Array(need);
  var buf = lodBuf;
  buf.fill(-1, 0, need);

  var nb = L.bandCount;
  for (var b2i = 0; b2i < nb; b2i++) {
    var idx2 = L.buckets[b2i];
    if (!idx2.length) continue;
    /* 面板动画期间隔点采样，点数极多时也能保住帧率 */
    var stride = STATE.fastDraw ? 4 : 1;
    for (var k2 = 0; k2 < idx2.length; k2 += stride) {
      var i2 = idx2[k2];
      var x2 = mx[i2], y2 = my[i2];
      if (x2 < b0 || x2 > b2 || y2 < b1 || y2 > b3) continue;
      var px2 = t0 * x2 + t2 * y2 + t4;
      var py2 = t1 * x2 + t3 * y2 + t5;
      if (px2 < 0 || py2 < 0 || px2 >= w || py2 >= h) continue;
      var cx = (px2 / cell) | 0, cy = (py2 / cell) | 0;
      var o = cy * cols + cx;
      if (buf[o] < 0 || b2i < buf[o]) buf[o] = b2i;
    }
  }
  var byBand = [];
  for (var bb2 = 0; bb2 < nb; bb2++) byBand.push([]);
  for (var o2 = 0; o2 < need; o2++) {
    var bb = buf[o2];
    if (bb >= 0) byBand[bb].push(o2);
  }
  c.globalAlpha = GRID_ALPHA;
  var aggFill = gridFill(L);
  for (var b4 = 0; b4 < nb; b4++) {
    var arr = byBand[b4];
    if (!arr.length) continue;
    c.fillStyle = aggFill[b4];
    for (var q = 0; q < arr.length; q++) {
      var oo = arr[q];
      var gx = (oo % cols) * cell;
      var gy = ((oo / cols) | 0) * cell;
      c.fillRect(gx, gy, cell, cell);
    }
  }
  c.globalAlpha = alpha0;
}

/* ============================ 9b. 栅格 WebGL 绘制 ============================
   千万级点数时 Canvas2D 逐点绘制撑不住（批量 path 也有上限）。
   WebGL 方案：每个点 = 1 个实例（中心墨卡托坐标 + 档位），4 顶点 quad 由着色器
   按当前屏幕像素尺寸展开，全层一次 drawArraysInstanced 画完。
   CPU 每帧只传几个 uniform，点数再多也是毫秒级。
   不支持 WebGL2 时自动回退到 Canvas 绘制（drawGrid 原逻辑保留）。 */

var GLR = null;   /* {cv, gl, prog, loc, cornerBuf, ok} */

/* 档位颜色展平，供 uniform3fv：按图层着色模式缓存（shader 数组声明为 7 组，
   档位不足的模式尾部补 0） */
var GRID_RGB_CACHE = {};
function gridBandRgb(L) {
  var m = (L && L.bandMode) ? L.bandMode : 'rsrp';
  if (!GRID_RGB_CACHE[m]) {
    var bands = GRID_MODES[m].bands, out = [];
    for (var i = 0; i < bands.length; i++) {
      out.push(bands[i].rgb[0] / 255, bands[i].rgb[1] / 255, bands[i].rgb[2] / 255);
    }
    while (out.length < 7 * 3) out.push(0, 0, 0);
    GRID_RGB_CACHE[m] = new Float32Array(out);
  }
  return GRID_RGB_CACHE[m];
}

function glrCompile(gl, type, src) {
  var sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { gl.deleteShader(sh); return null; }
  return sh;
}

function glrInit() {
  if (GLR) return GLR.ok;
  GLR = { ok: false };
  try {
    var cv = document.createElement('canvas');
    cv.id = 'glpts';
    cv.style.position = 'absolute';
    cv.style.left = '0'; cv.style.top = '0';
    cv.style.width = '100%'; cv.style.height = '100%';
    cv.style.pointerEvents = 'none';
    cv.style.zIndex = '1';
    var wrap = document.getElementById('mapwrap');
    wrap.insertBefore(cv, document.getElementById('pts'));
    var gl = cv.getContext('webgl2', {
      antialias: false, alpha: true, depth: false,
      stencil: false, powerPreference: 'high-performance'
    });
    if (!gl) return false;

    var vsrc =
      '#version 300 es\n' +
      'in vec2 a_pos;\n' +     /* 实例：墨卡托中心 */
      'in float a_band;\n' +   /* 实例：档位 0..5 */
      'in vec2 a_corner;\n' +  /* quad 角点 -1..1 */
      'uniform vec4 u_t0;\n' + /* t0,t1,t2,t3 */
      'uniform vec2 u_t1;\n' + /* t4,t5 */
      'uniform vec2 u_size;\n' +/* CSS 像素画布尺寸 */
      'uniform vec2 u_half;\n' +/* 格子半尺寸，CSS px */
      'uniform float u_alpha;\n' +
      'uniform vec3 u_colors[7];\n' +
      'uniform vec4 u_sel;\n' + /* rect: minx,miny,maxx,maxy；circle: cx,cy,r,0 */
      'uniform int u_selType;\n' + /* 0 无 1 矩形 2 圆（多边形选区不支持压暗） */
      'out vec4 v_color;\n' +
      'void main() {\n' +
      '  float px = u_t0.x * a_pos.x + u_t0.z * a_pos.y + u_t1.x + a_corner.x * u_half.x;\n' +
      '  float py = u_t0.y * a_pos.x + u_t0.w * a_pos.y + u_t1.y + a_corner.y * u_half.y;\n' +
      '  gl_Position = vec4(px / (u_size.x * 0.5) - 1.0, 1.0 - py / (u_size.y * 0.5), 0.0, 1.0);\n' +
      '  float dim = 1.0;\n' +
      '  if (u_selType == 1) {\n' +
      '    if (a_pos.x < u_sel.x || a_pos.x > u_sel.z || a_pos.y < u_sel.y || a_pos.y > u_sel.w) dim = 0.22;\n' +
      '  } else if (u_selType == 2) {\n' +
      '    vec2 d = a_pos - u_sel.xy;\n' +
      '    if (dot(d, d) > u_sel.z * u_sel.z) dim = 0.22;\n' +
      '  }\n' +
      '  v_color = vec4(u_colors[int(a_band + 0.5)], u_alpha * dim);\n' +
      '}\n';
    var fsrc =
      '#version 300 es\n' +
      'precision mediump float;\n' +
      'in vec4 v_color;\n' +
      'out vec4 o_color;\n' +
      'void main() { o_color = v_color; }\n';

    var vs = glrCompile(gl, gl.VERTEX_SHADER, vsrc);
    var fs = glrCompile(gl, gl.FRAGMENT_SHADER, fsrc);
    if (!vs || !fs) return false;
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;

    var loc = {};
    var unames = ['u_t0', 'u_t1', 'u_size', 'u_half', 'u_alpha', 'u_colors', 'u_sel', 'u_selType'];
    for (var ui = 0; ui < unames.length; ui++) loc[unames[ui]] = gl.getUniformLocation(prog, unames[ui]);
    loc.a_pos = gl.getAttribLocation(prog, 'a_pos');
    loc.a_band = gl.getAttribLocation(prog, 'a_band');
    loc.a_corner = gl.getAttribLocation(prog, 'a_corner');

    var cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    gl.enable(gl.BLEND);
    /* RGB 预乘（配合默认 premultipliedAlpha:true 的页面合成），alpha 直通不平方：
       否则 a_out = a²，实际透明度会比 Canvas 路径多透 9% 的底图（色差来源之一） */
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    cv.addEventListener('webglcontextlost', function (e) {
      e.preventDefault();
      GLR.ok = false;
    });

    GLR.cv = cv; GLR.gl = gl; GLR.prog = prog; GLR.loc = loc;
    GLR.cornerBuf = cornerBuf; GLR.ok = true;
    return true;
  } catch (e) {
    return false;
  }
}

/* 为栅格图层构建 WebGL 实例缓冲（中心坐标 + 档位），在 rebuildBuckets 末尾调用。
   每实例 12 字节（x,y,band），1000 万点约 120MB 显存。 */
function buildGridGL(L) {
  L.glOk = false;
  L.glCount = 0;
  if (!glrInit()) return;
  var gl = GLR.gl;
  var total = 0, b, k;
  var nb = L.bandCount || 6;
  for (b = 0; b < nb; b++) total += L.buckets[b].length;
  /* 参考点：取图层质心，实例坐标存"相对偏移"。
     墨卡托坐标上千万米，float32 在此量级只有约 1 米精度，20 米格子的
     顶点抖动可达 5%，相邻格子重叠/留缝形成条纹；减去参考点后偏移量小，
     float32 精度足够，大数运算留在 CPU 用 float64 做 */
  var sx = 0, sy = 0, sc = 0, mx = L.mx, my = L.my;
  for (b = 0; b < nb; b++) {
    var idx0 = L.buckets[b];
    for (k = 0; k < idx0.length; k += 97) { sx += mx[idx0[k]]; sy += my[idx0[k]]; sc++; }
  }
  var refX = sc ? sx / sc : 0, refY = sc ? sy / sc : 0;
  L.glRefX = refX; L.glRefY = refY;
  var pos = new Float32Array(total * 2);
  var bnd = new Float32Array(total);
  var p = 0;
  for (b = 0; b < nb; b++) {
    var idx = L.buckets[b];
    for (k = 0; k < idx.length; k++) {
      var i = idx[k];
      pos[p * 2] = mx[i] - refX;
      pos[p * 2 + 1] = my[i] - refY;
      bnd[p] = b;
      p++;
    }
  }
  if (L.glPosBuf) {
    gl.deleteBuffer(L.glPosBuf);
    gl.deleteBuffer(L.glBandBuf);
    L.glPosBuf = null;
  }
  var pb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, pb);
  gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
  var bb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, bb);
  gl.bufferData(gl.ARRAY_BUFFER, bnd, gl.STATIC_DRAW);
  L.glPosBuf = pb; L.glBandBuf = bb;
  L.glCount = total;
  L.glOk = true;
}

/* buildGridGL 的 Worker 异步版：数组构建放 Worker，主线程只做 GPU 上传 */
async function buildGridGLAsync(L) {
  var _w = getSiteWorker();
  if (_w && L.buckets && L.mx && L.my) {
    try {
      var _res = await workerCall('gridArrays', {
        data: { mx: L.mx, my: L.my, buckets: L.buckets }
      });
      if (_res && !_res.error && _res.count > 0) {
        if (!glrInit()) return;
        var gl = GLR.gl;
        /* 先建新缓冲，再删旧的，避免中间黑屏 */
        var pb = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, pb);
        gl.bufferData(gl.ARRAY_BUFFER, _res.pos, gl.STATIC_DRAW);
        var bb = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, bb);
        gl.bufferData(gl.ARRAY_BUFFER, _res.bnd, gl.STATIC_DRAW);
        var _oldPb = L.glPosBuf, _oldBb = L.glBandBuf;
        L.glPosBuf = pb; L.glBandBuf = bb;
        if (_oldPb) {
          try { gl.deleteBuffer(_oldPb); gl.deleteBuffer(_oldBb); } catch (e) {}
        }
        L.glRefX = _res.refX; L.glRefY = _res.refY;
        L.glCount = _res.count;
        L.glOk = true;
        return;
      }
    } catch (e3) {
      console.warn('Worker buildGridGL 失败，回退主线程', e3);
    }
  }
  /* 回退主线程同步版 */
  buildGridGL(L);
}

/* 每帧清空一次 WebGL 画布（含按需重设尺寸）。
   glDrawGrid 画层时调用；所有栅格层都隐藏/移除后由 drawAll 补调一次，
   否则上一帧画上去的采样点会残留在地图上取消不掉（bug：勾选取消后点仍在） */
function glClearFrame(w, h, dpr) {
  if (!glrInit()) return false;
  var gl = GLR.gl, cv = GLR.cv;
  var cw = Math.round(w * dpr), chh = Math.round(h * dpr);
  if (cv.width !== cw || cv.height !== chh) { cv.width = cw; cv.height = chh; }
  gl.viewport(0, 0, cw, chh);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  return true;
}

/* ============================ 站点 WebGL（工参） ============================
   实例化三角扇：一个站点 = 一个实例，一次 draw call 画全层。
   扇区/室分圆点/无方位角小点 都用同一个扇形几何，shader 按类型展开。 */

var GLS = null;   /* {cv, gl, progFan, locFan, fanBuf, fanN, progPt, locPt, ok} */
var SITE_FAN_SEG = 24;   /* 扇形弧段数：室分圆 24 边更圆滑 */

function glsInit() {
  if (GLS) return GLS.ok;
  GLS = { ok: false };
  try {
    var cv = document.createElement('canvas');
    cv.id = 'glsites';
    cv.style.position = 'absolute';
    cv.style.left = '0'; cv.style.top = '0';
    cv.style.width = '100%'; cv.style.height = '100%';
    cv.style.pointerEvents = 'none';
    cv.style.zIndex = '2';   /* 站点画在栅格上层 */
    var wrap = document.getElementById('mapwrap');
    wrap.appendChild(cv);
    var gl = cv.getContext('webgl2', {
      antialias: false, alpha: true, depth: false,
      stencil: false, powerPreference: 'high-performance'
    });
    if (!gl) return false;

    /* 扇形 vertex：a_t=-1 中心，a_t=0..1 弧参数 */
    var vsFan =
      '#version 300 es\n' +
      'in vec2 a_pos;\n' +
      'in vec3 a_col;\n' +
      'in vec2 a_azk;\n' +
      'in float a_city;\n' +
      'in float a_t;\n' +
      'uniform vec4 u_t0;\n' +
      'uniform vec2 u_t1;\n' +
      'uniform vec2 u_size;\n' +
      'uniform float u_R;\n' +
      'uniform float u_half;\n' +
      'uniform float u_dotR;\n' +
      'uniform float u_citySel;\n' +
      'uniform float u_sub;\n' +
      'out vec3 v_col;\n' +
      'void main() {\n' +
      '  if (u_sub > 1.5 && mod(float(gl_InstanceID), u_sub) > 0.5) {\n' +
      '    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); v_col = vec3(0.0); return;\n' +
      '  }\n' +
      '  if (u_citySel > -0.5 && abs(a_city - u_citySel) > 0.5) {\n' +
      '    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); v_col = vec3(0.0); return;\n' +
      '  }\n' +
      '  vec2 sp = vec2(u_t0.x*a_pos.x + u_t0.z*a_pos.y + u_t1.x,\n' +
      '                u_t0.y*a_pos.x + u_t0.w*a_pos.y + u_t1.y);\n' +
      '  vec2 off = vec2(0.0);\n' +
      '  if (a_t > -0.5) {\n' +
      '    float ang, rad;\n' +
      '    if (a_azk.y < 0.5) {\n' +
      '      ang = a_azk.x - u_half - 1.5707963 + a_t*u_half*2.0;\n' +
      '      rad = u_R;\n' +
      '    } else if (a_azk.y < 1.5) {\n' +
      '      ang = a_t*6.2831853;\n' +
      '      rad = u_dotR;\n' +
      '    } else {\n' +
      '      ang = a_t*6.2831853;\n' +
      '      rad = 1.5;\n' +
      '    }\n' +
      '    off = vec2(cos(ang), sin(ang))*rad;\n' +
      '  }\n' +
      '  vec2 px = sp + off;\n' +
      '  vec2 ndc = vec2(px.x/u_size.x*2.0-1.0, 1.0-px.y/u_size.y*2.0);\n' +
      '  gl_Position = vec4(ndc, 0.0, 1.0);\n' +
      '  v_col = a_col;\n' +
      '}\n';
    var fsFan =
      '#version 300 es\n' +
      'precision mediump float;\n' +
      'in vec3 v_col;\n' +
      'uniform float u_alpha;\n' +
      'out vec4 o_col;\n' +
      'void main() { o_col = vec4(v_col, u_alpha); }\n';
    var vs = glrCompile(gl, gl.VERTEX_SHADER, vsFan);
    var fs = glrCompile(gl, gl.FRAGMENT_SHADER, fsFan);
    if (!vs || !fs) return false;
    var progFan = gl.createProgram();
    gl.attachShader(progFan, vs); gl.attachShader(progFan, fs);
    gl.linkProgram(progFan);
    if (!gl.getProgramParameter(progFan, gl.LINK_STATUS)) return false;

    /* 扇形几何：中心 + (SEG+1) 个弧点 */
    var SEG = SITE_FAN_SEG;
    var tArr = new Float32Array(SEG + 2);
    tArr[0] = -1;
    for (var i = 0; i <= SEG; i++) tArr[i + 1] = i / SEG;
    var fanBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, fanBuf);
    gl.bufferData(gl.ARRAY_BUFFER, tArr, gl.STATIC_DRAW);

    /* 站址中心点：gl.POINTS 白色圆点 */
    var vsPt =
      '#version 300 es\n' +
      'in vec2 a_pos;\n' +
      'uniform vec4 u_t0;\n' +
      'uniform vec2 u_t1;\n' +
      'uniform vec2 u_size;\n' +
      'uniform float u_ptSize;\n' +
      'void main() {\n' +
      '  vec2 sp = vec2(u_t0.x*a_pos.x + u_t0.z*a_pos.y + u_t1.x,\n' +
      '                u_t0.y*a_pos.x + u_t0.w*a_pos.y + u_t1.y);\n' +
      '  vec2 ndc = vec2(sp.x/u_size.x*2.0-1.0, 1.0-sp.y/u_size.y*2.0);\n' +
      '  gl_Position = vec4(ndc, 0.0, 1.0);\n' +
      '  gl_PointSize = u_ptSize;\n' +
      '}\n';
    var fsPt =
      '#version 300 es\n' +
      'precision mediump float;\n' +
      'out vec4 o_col;\n' +
      'void main() {\n' +
      '  vec2 pc = gl_PointCoord - vec2(0.5);\n' +
      '  float d = length(pc) * 2.0;\n' +
      '  if (d > 1.0) discard;\n' +
      '  vec3 col = vec3(1.0);\n' +
      '  if (d > 0.72) col = vec3(0.1);   /* 描边 */\n' +
      '  o_col = vec4(col, 1.0);\n' +
      '}\n';
    var vs2 = glrCompile(gl, gl.VERTEX_SHADER, vsPt);
    var fs2 = glrCompile(gl, gl.FRAGMENT_SHADER, fsPt);
    if (!vs2 || !fs2) return false;
    var progPt = gl.createProgram();
    gl.attachShader(progPt, vs2); gl.attachShader(progPt, fs2);
    gl.linkProgram(progPt);
    if (!gl.getProgramParameter(progPt, gl.LINK_STATUS)) return false;

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    GLS = {
      ok: true, cv: cv, gl: gl,
      progFan: progFan, fanBuf: fanBuf, fanN: SEG + 2,
      locFan: {
        a_pos: gl.getAttribLocation(progFan, 'a_pos'),
        a_col: gl.getAttribLocation(progFan, 'a_col'),
        a_azk: gl.getAttribLocation(progFan, 'a_azk'),
        a_city: gl.getAttribLocation(progFan, 'a_city'),
        a_t: gl.getAttribLocation(progFan, 'a_t'),
        u_t0: gl.getUniformLocation(progFan, 'u_t0'),
        u_t1: gl.getUniformLocation(progFan, 'u_t1'),
        u_size: gl.getUniformLocation(progFan, 'u_size'),
        u_R: gl.getUniformLocation(progFan, 'u_R'),
        u_half: gl.getUniformLocation(progFan, 'u_half'),
        u_dotR: gl.getUniformLocation(progFan, 'u_dotR'),
        u_alpha: gl.getUniformLocation(progFan, 'u_alpha'),
        u_citySel: gl.getUniformLocation(progFan, 'u_citySel'),
        u_sub: gl.getUniformLocation(progFan, 'u_sub')
      },
      progPt: progPt,
      locPt: {
        a_pos: gl.getAttribLocation(progPt, 'a_pos'),
        u_t0: gl.getUniformLocation(progPt, 'u_t0'),
        u_t1: gl.getUniformLocation(progPt, 'u_t1'),
        u_size: gl.getUniformLocation(progPt, 'u_size'),
        u_ptSize: gl.getUniformLocation(progPt, 'u_ptSize')
      }
    };
    return true;
  } catch (e) { return false; }
}

/* 'rgba(r,g,b,a)' -> [r,g,b,a] 0..1 */
function parseRgba(str) {
  var m = /rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/i.exec(str || '');
  if (!m) return [0.2, 0.5, 1.0, 0.6];
  return [m[1] / 255, m[2] / 255, m[3] / 255, m[4] === undefined ? 1 : parseFloat(m[4])];
}

/* 构建站点 WebGL 实例缓冲：从 colorGroups 展平（异步分块，不堵主线程） */
async function buildSiteGL(L) {

  L.siteGlOk = false;
  L.siteGlCount = 0;
  if (!glsInit()) return;
  var groups = L.colorGroups || [];
  var mx = L.mx, my = L.my;
  if (!mx || !my) return;

  /* Worker 路径：把数组填充放 Worker，避免阻塞主线程 */
  var _w = getSiteWorker();
  if (_w && groups.length) {
    try {
      var _azArr = L.azCol ? L.ds.num[L.azCol] : null;
      // groups 精简（只传需要的）
      var _groups = groups.map(function (g) {
        var _rgba = parseRgba(g.color);
        return { color: _rgba, indoor: !!g.indoor, idx: g.idx };
      });
      var _res = await workerCall('siteArrays', {
        data: {
          mx: mx, my: my, n: L.ds.n,
          groups: _groups,
          azArr: _azArr,
          cityIdx: L.cityIdx || null
        }
      });
      if (_res && !_res.error && _res.count > 0) {
        var gl = GLS.gl;
        // 清理旧缓冲
        if (L.sitePosBuf) {
          try { gl.deleteBuffer(L.sitePosBuf); gl.deleteBuffer(L.siteColBuf); gl.deleteBuffer(L.siteAzkBuf); } catch (e) {}
          L.sitePosBuf = null; L.siteColBuf = null; L.siteAzkBuf = null;
          if (L.siteCityBuf) { try { gl.deleteBuffer(L.siteCityBuf); } catch (e2) {} L.siteCityBuf = null; }
        }
        var pb = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, pb);
        gl.bufferData(gl.ARRAY_BUFFER, _res.pos, gl.STATIC_DRAW);
        var cb = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, cb);
        gl.bufferData(gl.ARRAY_BUFFER, _res.col, gl.STATIC_DRAW);
        var ab = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, ab);
        gl.bufferData(gl.ARRAY_BUFFER, _res.azk, gl.STATIC_DRAW);
        var cib = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, cib);
        gl.bufferData(gl.ARRAY_BUFFER, _res.cityA, gl.STATIC_DRAW);
        L.sitePosBuf = pb; L.siteColBuf = cb; L.siteAzkBuf = ab; L.siteCityBuf = cib;
        L.siteRefX = _res.refX; L.siteRefY = _res.refY;
        L.siteAlpha = _res.alpha;
        L.siteGlCount = _res.count;
        L.siteGlOk = true;
        return;
      }
    } catch (e3) {
      console.warn('Worker buildSiteGL 失败，回退主线程', e3);
    }
  }
  /* 主线程回退（原有逻辑） */
  var azArr = L.azCol ? L.ds.num[L.azCol] : null;
  var DEG = Math.PI / 180;

  /* 先数有效点 */
  var total = 0, gi, k, i;
  for (gi = 0; gi < groups.length; gi++) {
    var idx0 = groups[gi].idx;
    for (k = 0; k < idx0.length; k++) {
      i = idx0[k];
      if (isFinite(mx[i]) && isFinite(my[i])) total++;
    }
  }
  if (!total) return;

  /* 参考点：质心（与栅格同理，float32 精度） */
  var sx = 0, sy = 0, sc = 0;
  for (gi = 0; gi < groups.length; gi++) {
    var idx1 = groups[gi].idx;
    for (k = 0; k < idx1.length; k += 97) {
      i = idx1[k];
      if (!isFinite(mx[i]) || !isFinite(my[i])) continue;
      sx += mx[i]; sy += my[i]; sc++;
    }
  }
  var refX = sc ? sx / sc : 0, refY = sc ? sy / sc : 0;
  L.siteRefX = refX; L.siteRefY = refY;

  var pos = new Float32Array(total * 2);
  var col = new Float32Array(total * 3);
  var azk = new Float32Array(total * 2);
  var cityA = new Float32Array(total);
  var alpha = 0.6;
  var p = 0;
  var cityIdxAll = L.cityIdx || null;
  /* 注：4° 错开已移除（性能：每次重建建 35 万哈希键太慢），重叠扇区靠点击列表区分 */
  /* 地市筛选走 shader（u_citySel），此处不跳过，保证缓冲一次构建 */
  for (gi = 0; gi < groups.length; gi++) {
    var g = groups[gi];
    var rgba = parseRgba(g.color);
    if (gi === 0) alpha = rgba[3];
    var isIndoor = !!g.indoor;
    var idx = g.idx;
    for (k = 0; k < idx.length; k++) {
      if ((p & 0xFFFF) === 0) await yieldFrame();   /* 每 6.5 万个让一帧，初始构建一次 */
      i = idx[k];
      var x = mx[i], y = my[i];
      if (!isFinite(x) || !isFinite(y)) continue;
      pos[p * 2] = x - refX;
      pos[p * 2 + 1] = y - refY;
      cityA[p] = cityIdxAll ? cityIdxAll[i] : -1;
      col[p * 3] = rgba[0]; col[p * 3 + 1] = rgba[1]; col[p * 3 + 2] = rgba[2];
      var kind, azr = 0;
      if (isIndoor) {
        kind = 1;
      } else {
        var az = azArr ? azArr[i] : NaN;
        if (isFinite(az)) {
          kind = 0;
          azr = az * DEG;
        }
        else kind = 2;
      }
      azk[p * 2] = azr; azk[p * 2 + 1] = kind;
      p++;
    }
  }
  L.siteAlpha = alpha;

  var gl = GLS.gl;
  if (L.sitePosBuf) {
    try { gl.deleteBuffer(L.sitePosBuf); gl.deleteBuffer(L.siteColBuf); gl.deleteBuffer(L.siteAzkBuf); } catch (e) {}
    L.sitePosBuf = null; L.siteColBuf = null; L.siteAzkBuf = null;
    if (L.siteCityBuf) { try { gl.deleteBuffer(L.siteCityBuf); } catch (e) {} L.siteCityBuf = null; }
  }
  var pb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, pb);
  gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
  var cb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, cb);
  gl.bufferData(gl.ARRAY_BUFFER, col, gl.STATIC_DRAW);
  var ab = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, ab);
  gl.bufferData(gl.ARRAY_BUFFER, azk, gl.STATIC_DRAW);
  var cib = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, cib);
  gl.bufferData(gl.ARRAY_BUFFER, cityA, gl.STATIC_DRAW);
  L.sitePosBuf = pb; L.siteColBuf = cb; L.siteAzkBuf = ab; L.siteCityBuf = cib;
  L.siteGlCount = p;
  L.siteGlOk = true;
}

function glsClearFrame(w, h, dpr) {
  if (!glsInit()) return false;
  var gl = GLS.gl, cv = GLS.cv;
  var cw = Math.round(w * dpr), chh = Math.round(h * dpr);
  if (cv.width !== cw || cv.height !== chh) { cv.width = cw; cv.height = chh; }
  gl.viewport(0, 0, cw, chh);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  return true;
}

/* 绑定实例属性的 helper */
function glsBindInst(gl, loc, buf, size, prog) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(loc, 1);
}

function glDrawSites(L, t, w, h, box, dpr) {
  if (!L.siteGlOk || !glsInit()) return false;
  var gl = GLS.gl;

  /* 实地尺寸：宏站 80 米，室分 30 米。直接用 view 分辨率（米/像素） */
  var _res = 0;
  try { _res = map.getView().getResolution() || 0; } catch (e) {}
  /* 4G/5G 分规格：4G 80米/35°，5G 60米/45°，室分按比例 */
  var _is5g = (L.rat === '5G');
  var _sectorM = _is5g ? 60 : 80;
  var _dotM = _is5g ? 25 : 30;
  var _beamW = _is5g ? 45 : 35;
  var R, dotR;
  if (_res > 0 && isFinite(_res)) {
    /* 分辨率校准：getResolution 返回值与设备像素比有关，乘 dpr 修正（用户实测约 1.6） */
    var _dpr2 = (isFinite(dpr) && dpr > 0) ? dpr : 1;
    R = _sectorM / _res * _dpr2;
    dotR = _dotM / _res * _dpr2;
    /* 钳位：太小看不见，太大卡死 */
    if (R < 2) R = 2; if (R > 500) R = 500;
    if (dotR < 2) dotR = 2; if (dotR > 200) dotR = 200;
  } else {
    R = STATE.siteR; dotR = Math.max(4, R * 0.35);
  }
  var half = _beamW * Math.PI / 180 * 0.5;

  /* 参考点偏移进平移量：实例存 (x-refX)，u_t1 = t0*refX + t2*refY + t4（与栅格一致） */
  var t4 = (t[0] * L.siteRefX + t[2] * L.siteRefY + t[4]);
  var t5 = (t[1] * L.siteRefX + t[3] * L.siteRefY + t[5]);

  /* ---- 第一遍：扇区/圆点 ---- */
  var loc = GLS.locFan;
  gl.useProgram(GLS.progFan);
  gl.uniform4f(loc.u_t0, t[0], t[1], t[2], t[3]);
  gl.uniform2f(loc.u_t1, t4, t5);
  gl.uniform2f(loc.u_size, w, h);
  gl.uniform1f(loc.u_R, R);
  gl.uniform1f(loc.u_half, half);
  gl.uniform1f(loc.u_dotR, dotR);
  gl.uniform1f(loc.u_alpha, L.siteAlpha || 0.6);
  var _cs = (L.citySel !== undefined && L.citySel !== '*' && L.citySel !== 'none') ? parseFloat(L.citySel) : -1;
  if (loc.u_citySel) gl.uniform1f(loc.u_citySel, _cs);
  /* 自适应抽稀：扇区 < 6px 时抽稀，远看只画骨架 */
  var _sub = 1;
  if (R < 6) _sub = Math.min(32, Math.ceil(12 / Math.max(0.5, R)));
  if (loc.u_sub) gl.uniform1f(loc.u_sub, _sub);

  glsBindInst(gl, loc.a_pos, L.sitePosBuf, 2);
  glsBindInst(gl, loc.a_col, L.siteColBuf, 3);
  glsBindInst(gl, loc.a_azk, L.siteAzkBuf, 2);
  if (loc.a_city >= 0 && L.siteCityBuf) glsBindInst(gl, loc.a_city, L.siteCityBuf, 1);
  /* 扇形几何（非实例） */
  gl.bindBuffer(gl.ARRAY_BUFFER, GLS.fanBuf);
  gl.enableVertexAttribArray(loc.a_t);
  gl.vertexAttribPointer(loc.a_t, 1, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(loc.a_t, 0);

  gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, GLS.fanN, L.siteGlCount);

  /* 清理 divisor，避免影响后续 */
  gl.vertexAttribDivisor(loc.a_pos, 0);
  gl.vertexAttribDivisor(loc.a_col, 0);
  if (loc.a_city >= 0) gl.vertexAttribDivisor(loc.a_city, 0);
  gl.vertexAttribDivisor(loc.a_azk, 0);
  return true;
}

function glDrawGrid(L, t, w, h, box, dpr, clear) {
  if (!L.glOk) return false;
  /* 多边形选区 WebGL 不支持压暗，走 Canvas（Canvas 的 makeSelTest 支持多边形） */
  var _sel = (typeof currentSel === 'function') ? currentSel() : null;
  if (_sel && _sel.type === 'poly') return false;
  /* 多栅格层共存时只清一次屏，否则后画的层会擦掉先画的层 */
  if (clear && !glClearFrame(w, h, dpr)) return false;
  var gl = GLR.gl, loc = GLR.loc;
  if (!L.glCount) return true;

  /* 格子屏幕半尺寸（与 drawGrid 同一公式；GPU 光栅化亚像素是准的，不做 0.8 钳制） */
  var yc = (box[1] + box[3]) * 0.5;
  var latRad = 2 * Math.atan(Math.exp(yc / 6378137)) - Math.PI / 2;
  var cosLat = Math.cos(latRad);
  if (!(cosLat > 0.05)) cosLat = 0.05;
  var cellW = Math.max(0.8, (L.dLon || 0.0002) * DEG2MERC * Math.abs(t[0]));
  var cellH = Math.max(0.8, (L.dLat || 0.00018) * DEG2MERC / cosLat * Math.abs(t[3]));

  gl.useProgram(GLR.prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, GLR.cornerBuf);
  gl.enableVertexAttribArray(loc.a_corner);
  gl.vertexAttribPointer(loc.a_corner, 2, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(loc.a_corner, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, L.glPosBuf);
  gl.enableVertexAttribArray(loc.a_pos);
  gl.vertexAttribPointer(loc.a_pos, 2, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(loc.a_pos, 1);
  gl.bindBuffer(gl.ARRAY_BUFFER, L.glBandBuf);
  gl.enableVertexAttribArray(loc.a_band);
  gl.vertexAttribPointer(loc.a_band, 1, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(loc.a_band, 1);

  gl.uniform4f(loc.u_t0, t[0], t[1], t[2], t[3]);
  /* 实例坐标已减参考点，平移量在 CPU 用 float64 把参考点加回去 */
  var rX = L.glRefX || 0, rY = L.glRefY || 0;
  gl.uniform2f(loc.u_t1, t[0] * rX + t[2] * rY + t[4], t[1] * rX + t[3] * rY + t[5]);
  gl.uniform2f(loc.u_size, w, h);
  gl.uniform2f(loc.u_half, cellW * 0.5, cellH * 0.5);
  gl.uniform1f(loc.u_alpha, GRID_ALPHA);
  gl.uniform3fv(loc.u_colors, gridBandRgb(L));
  /* 选区压暗：矩形/圆形在着色器里判，拖拽选区零重建成本；多边形选区不支持压暗 */
  var sel = currentSel(), st = 0, sx = 0, sy = 0, sz = 0, sw = 0;
  /* 选区判交在着色器里用实例坐标做，实例坐标已减参考点，选区同步偏移 */
  var rX2 = L.glRefX || 0, rY2 = L.glRefY || 0;
  if (sel && sel.type === 'rect' && sel.b) {
    st = 1;
    sx = Math.min(sel.b[0], sel.b[2]) - rX2; sy = Math.min(sel.b[1], sel.b[3]) - rY2;
    sz = Math.max(sel.b[0], sel.b[2]) - rX2; sw = Math.max(sel.b[1], sel.b[3]) - rY2;
  } else if (sel && sel.type === 'circle' && sel.c) {
    st = 2; sx = sel.c[0] - rX2; sy = sel.c[1] - rY2; sz = sel.r;
  }
  gl.uniform4f(loc.u_sel, sx, sy, sz, sw);
  gl.uniform1i(loc.u_selType, st);

  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, L.glCount);
  return true;
}

/* 面的墨卡托包围盒（loadVectorFiles 会预先算好放进 _bbox；
 * 合成/恢复出来的图层没有就现算一次并缓存，保证裁剪和 LOD 始终有效） */
function polyBBoxMerc(pg) {
  var rings = pg.rings || [];
  var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (var i = 0; i < rings.length; i++) {
    var ring = rings[i];
    for (var k = 0; k < ring.length; k++) {
      var x = lonToMercX(ring[k][0]), y = latToMercY(ring[k][1]);
      if (!isFinite(x) || !isFinite(y)) continue;
      if (x < x1) x1 = x; if (x > x2) x2 = x;
      if (y < y1) y1 = y; if (y > y2) y2 = y;
    }
  }
  pg._bbox = (x1 <= x2) ? [x1, y1, x2, y2] : null;
  return pg._bbox;
}

/* 矢量边界图层：多边形描边（视野外裁剪 + 亚像素面塌点）
 * 三个坑：
 * 1) 每个环都必须以 moveTo 起笔。环首点若是非法值（NaN/Inf），旧写法直接 continue，
 *    接下来的 lineTo 会从上一个环的落笔处连过来 —— 画出来就是横穿全图的一条长线，
 *    和 TAB 解析出来的蜘蛛网长得一模一样，但锅在绘制端。
 * 2) 整个面在当前缩放下不足约 1px 时，不再逐顶点描边，塌成一个点：
 *    十万级的 POI/工参小面每帧全量描一遍，缩到全省视野时一帧要 8 秒，直接卡死；
 *    塌点只看 bbox，两次 canvas 调用，密度观感还在。
 * 3) 描边样式要 save/restore，别把 lineWidth/lineJoin 漏给后面的图层。 */
/* 边界图层地市匹配器：先从样本属性里一次性认出地市字段，再返回判定函数。
   有 CITYID 只认代码精确匹配；否则认城市字段（F / CITY* / 中文「地州」「地市」「城市」），
   值与地市名相等或以其开头。认不出字段返回 null（该图层不参与地市过滤）。 */
function vecCityMatcher(polys, cityName, cityCode) {
  var mode = 0, key = null;
  var lim = Math.min(polys.length, 50);
  for (var i = 0; i < lim && !key; i++) {
    var p = polys[i].props || {};
    for (var k in p) { if (/cityid/i.test(k)) { mode = 1; key = k; break; } }
  }
  if (!key) {
    for (var j = 0; j < lim && !key; j++) {
      var p2 = polys[j].props || {};
      for (var k2 in p2) {
        var kl = k2.toLowerCase();
        if (kl === 'f' || kl === 'city' || kl === 'cityname' || kl.indexOf('city') === 0 ||
            kl.indexOf('地州') >= 0 || kl.indexOf('地市') >= 0 || kl.indexOf('城市') >= 0) { mode = 2; key = k2; break; }
      }
    }
  }
  if (!key) return null;
  if (mode === 1) {
    return function (props) {
      return !!(cityCode && cityCode !== '*' && String((props || {})[key] || '') === String(cityCode));
    };
  }
  return function (props) {
    var pv = String((props || {})[key] || '');
    return pv === cityName || (cityName && pv.indexOf(cityName) === 0);
  };
}

/* 把离屏缓存按当前视图变换贴到主画布（平移 + 缩放） */
function vecBlit(c, vc, t) {
  var kx = t[0] / vc.t0, ky = t[3] / vc.t3;
  var dx = t[4] - kx * vc.tc4, dy = t[5] - ky * vc.tc5;
  c.save();
  c.translate(dx, dy);
  c.scale(kx, ky);
  c.drawImage(vc.cv, 0, 0, vc.wCss, vc.hCss);
  c.restore();
}
function vecIntersects(vc, box) {
  return !(box[2] < vc.ext[0] || box[0] > vc.ext[2] || box[3] < vc.ext[1] || box[1] > vc.ext[3]);
}
/* 渲染准备：地市匹配器 + 抽稀参数。settled=true 表示画缓存用的清晰版（不做拖动降级） */
function vecRenderInit(L, t, box, settled) {
  var polys = L.polygons;
  var cityF = L.citySel;
  var cityC = L.cityCode;
  var cityOn = cityF && cityF !== '*';
  var cityMatcher = null;
  if (cityOn) {
    cityMatcher = vecCityMatcher(polys, cityF, cityC);
    var anyMatch = false;
    if (cityMatcher) {
      for (var _pi = 0; _pi < polys.length; _pi++) {
        if (cityMatcher(polys[_pi].props || {})) { anyMatch = true; break; }
      }
    }
    if (!anyMatch) { cityOn = false; cityMatcher = null; }
  }
  var dragging = !settled && (typeof STATE !== 'undefined') && (STATE._dragging || STATE.navigating);
  return {
    pi: 0, cityOn: cityOn, cityMatcher: cityMatcher,
    scale: Math.abs(t[0]) || 0,
    dotLim: dragging ? 18 : 1,
    thinPx: dragging ? 2.0 : 0.75,
    miter: dragging
  };
}
/* 从 st.pi 起续画一片（自带 beginPath/stroke，可跨帧续画），画完返回 true */
function vecRenderChunk(c, L, t, box, st, budgetMs) {
  var polys = L.polygons;
  var t0 = t[0], t1 = t[1], t2 = t[2], t3 = t[3], t4 = t[4], t5 = t[5];
  var b0 = box[0], b1 = box[1], b2 = box[2], b3 = box[3];
  var scale = st.scale, dotLim = st.dotLim, thinPx = st.thinPx;
  var cityOn = st.cityOn, cityMatcher = st.cityMatcher;
  var startT = performance.now();
  c.save();
  c.strokeStyle = '#c86bff';
  c.lineWidth = 2.5;
  c.lineJoin = st.miter ? 'miter' : 'round';
  c.lineCap = 'round';
  c.beginPath();
  var dotPath = null;
  var pi = st.pi;
  for (; pi < polys.length; pi++) {
    if (pi > st.pi && (pi & 255) === 0 && performance.now() - startT > budgetMs) break;
    var pg = polys[pi];
    if (cityOn && !cityMatcher(pg.props || {})) continue;
    var pb = pg._bbox;
    if (pb === undefined) pb = polyBBoxMerc(pg);
    if (pb) {
      if (pb[2] < b0 || pb[0] > b2 || pb[3] < b1 || pb[1] > b3) continue;
      if (scale > 0 && (pb[2] - pb[0]) * scale < dotLim && (pb[3] - pb[1]) * scale < dotLim) {
        var cxm = (pb[0] + pb[2]) * 0.5, cym = (pb[1] + pb[3]) * 0.5;
        var cpx = t0 * cxm + t2 * cym + t4;
        var cpy = t1 * cxm + t3 * cym + t5;
        if (!dotPath) dotPath = new Path2D();
        dotPath.rect(cpx - 1.25, cpy - 1.25, 2.5, 2.5);
        continue;
      }
    }
    /* 用预计算的墨卡托环绘制：逐帧把经纬度现算成墨卡托，几万个多边形直接卡死 */
    var rings = pg._ringsMerc;
    if (!rings) {
      rings = pg._ringsMerc = pg.rings.map(function (ring0) {
        return ring0.map(function (pt) { return [lonToMercX(pt[0]), latToMercY(pt[1])]; });
      });
    }
    for (var ri = 0; ri < rings.length; ri++) {
      var ring = rings[ri];
      var n = ring.length;
      if (n < 2) continue;
      var started = false, lpx = 0, lpy = 0;
      for (var vi = 0; vi < n; vi++) {
        var pt = ring[vi];
        var mxv = pt[0], myv = pt[1];
        if (!isFinite(mxv) || !isFinite(myv)) { started = false; continue; }
        var px = t0 * mxv + t2 * myv + t4;
        var py = t1 * mxv + t3 * myv + t5;
        if (!started) { c.moveTo(px, py); started = true; lpx = px; lpy = py; }
        else {
          /* 屏幕抽稀：离上一个落点不足 thinPx 的顶点跳过，低缩放下顶点数骤降 */
          var dx = px - lpx, dy = py - lpy;
          if (dx < thinPx && dx > -thinPx && dy < thinPx && dy > -thinPx) continue;
          c.lineTo(px, py); lpx = px; lpy = py;
        }
      }
      if (started) c.closePath();
    }
  }
  st.pi = pi;
  c.stroke();
  if (dotPath) { c.fillStyle = '#c86bff'; c.fill(dotPath); }
  c.restore();
  return pi >= polys.length;
}
function renderVectorInto(c, L, t, w, h, box) {
  var st = vecRenderInit(L, t, box, false);
  while (!vecRenderChunk(c, L, t, box, st, 1e9)) { /* 一次画完 */ }
}

function drawVector(c, L, t, w, h, box) {
  var polys = L.polygons;
  if (!polys || !polys.length) return;
  /* 小图层直接绘制；大图层（几万多边形）走离屏缓存 + 分片渲染：
     拖动/缩放中只贴缓存图，停稳后分片把新图画完（每帧约 28ms），不再整屏卡一下 */
  if (polys.length < 1500) {
    renderVectorInto(c, L, t, w, h, box);
    drawVectorHighlight(c, L, t, box);
    return;
  }
  var dpr = Math.min(global.devicePixelRatio || 1, 2);
  while (dpr > 1 && w * dpr * (h * dpr) > 16000000) dpr -= 0.25;
  var dragging = (typeof STATE !== 'undefined') && (STATE._dragging || STATE.navigating);
  var rotated = Math.abs(t[1]) > 1e-9 || Math.abs(t[2]) > 1e-9;
  if (rotated) {
    renderVectorInto(c, L, t, w, h, box);
    drawVectorHighlight(c, L, t, box);
    return;
  }
  var vc = L._vcache;
  var vcOk = vc && vc.citySel === L.citySel && vc.cityCode === L.cityCode && vc.dpr === dpr;
  /* —— 有进行中的分片任务 —— */
  var job = L._vcJob;
  if (job && !(job.citySel === L.citySel && job.cityCode === L.cityCode && job.dpr === dpr)) {
    L._vcJob = null; job = null;
  }
  if (job) {
    var jobView = Math.abs(t[0] - job.t0) < 1e-9 &&
      box[0] >= job.ext[0] && box[1] >= job.ext[1] && box[2] <= job.ext[2] && box[3] <= job.ext[3];
    if (!dragging && jobView) {
      var done = vecRenderChunk(job.c2, L, job.tc, job.ext, job.st, 28);
      if (done) {
        L._vcache = { cv: job.cv2, wCss: job.wCss, hCss: job.hCss, ext: job.ext,
                      t0: job.t0, t3: job.t3, tc4: job.tc4, tc5: job.tc5,
                      dpr: dpr, citySel: L.citySel, cityCode: L.cityCode };
        L._vcJob = null;
        vecBlit(c, L._vcache, t);
      } else {
        /* 画完四分之一前先贴旧缓存（画面完整），之后贴渐进的新图 */
        if (vcOk && job.st.pi < polys.length * 0.25 && vecIntersects(vc, box)) vecBlit(c, vc, t);
        else vecBlit(c, { cv: job.cv2, wCss: job.wCss, hCss: job.hCss, t0: job.t0, t3: job.t3, tc4: job.tc4, tc5: job.tc5 }, t);
        scheduleDraw();
      }
      drawVectorHighlight(c, L, t, box);
      return;
    }
    if (dragging) {
      if (vcOk && vecIntersects(vc, box)) vecBlit(c, vc, t);
      else vecBlit(c, { cv: job.cv2, wCss: job.wCss, hCss: job.hCss, t0: job.t0, t3: job.t3, tc4: job.tc4, tc5: job.tc5 }, t);
      drawVectorHighlight(c, L, t, box);
      return;
    }
    L._vcJob = null; job = null;   /* 停稳但视野已离开任务范围：弃任务，下面新建 */
  }
  /* —— 缓存可直接用 —— */
  if (vcOk) {
    var sameScale = Math.abs(t[0] - vc.t0) < 1e-9 && Math.abs(t[3] - vc.t3) < 1e-9;
    var covered = box[0] >= vc.ext[0] && box[1] >= vc.ext[1] && box[2] <= vc.ext[2] && box[3] <= vc.ext[3];
    if ((sameScale && covered) || (dragging && vecIntersects(vc, box))) {
      vecBlit(c, vc, t);
      drawVectorHighlight(c, L, t, box);
      return;
    }
    if (dragging && !vecIntersects(vc, box)) {
      renderVectorInto(c, L, t, w, h, box);
      drawVectorHighlight(c, L, t, box);
      return;
    }
  } else if (dragging) {
    renderVectorInto(c, L, t, w, h, box);
    drawVectorHighlight(c, L, t, box);
    return;
  }
  /* —— 新建分片任务：渲染范围 = 当前视野外扩一圈 —— */
  var padFrac = 0.4;
  while (padFrac > 0 && (w * (1 + 2 * padFrac)) * dpr * ((h * (1 + 2 * padFrac)) * dpr) > 30000000) padFrac -= 0.1;
  var bw = box[2] - box[0], bh = box[3] - box[1];
  var ext = [box[0] - bw * padFrac, box[1] - bh * padFrac, box[2] + bw * padFrac, box[3] + bh * padFrac];
  var scale = Math.abs(t[0]);
  var wCss = Math.max(2, Math.round((ext[2] - ext[0]) * scale));
  var hCss = Math.max(2, Math.round((ext[3] - ext[1]) * scale));
  var cv2 = document.createElement('canvas');
  cv2.width = Math.round(wCss * dpr); cv2.height = Math.round(hCss * dpr);
  var c2 = cv2.getContext('2d');
  c2.setTransform(dpr, 0, 0, dpr, 0, 0);
  var tlx = t[0] * ext[0] + t[2] * ext[3] + t[4];
  var tly = t[1] * ext[0] + t[3] * ext[3] + t[5];
  var tc = [t[0], t[1], t[2], t[3], t[4] - tlx, t[5] - tly];
  var nJob = { cv2: cv2, c2: c2, tc: tc, ext: ext, wCss: wCss, hCss: hCss,
               t0: t[0], t3: t[3], tc4: tc[4], tc5: tc[5],
               dpr: dpr, citySel: L.citySel, cityCode: L.cityCode,
               st: vecRenderInit(L, tc, ext, true) };
  L._vcJob = nJob;
  if (vecRenderChunk(c2, L, tc, ext, nJob.st, 28)) {
    L._vcache = { cv: cv2, wCss: wCss, hCss: hCss, ext: ext, t0: t[0], t3: t[3], tc4: tc[4], tc5: tc[5],
                  dpr: dpr, citySel: L.citySel, cityCode: L.cityCode };
    L._vcJob = null;
    vecBlit(c, L._vcache, t);
  } else {
    if (vcOk && vecIntersects(vc, box)) vecBlit(c, vc, t);
    else vecBlit(c, { cv: cv2, wCss: wCss, hCss: hCss, t0: t[0], t3: t[3], tc4: tc[4], tc5: tc[5] }, t);
    scheduleDraw();
  }
  drawVectorHighlight(c, L, t, box);
}

function drawVectorHighlight(c, L, t, box) {
  var t0 = t[0], t1 = t[1], t2 = t[2], t3 = t[3], t4 = t[4], t5 = t[5];
  var b0 = box[0], b1 = box[1], b2 = box[2], b3 = box[3];
  /* 搜索高亮：深红色边框（拖动时跳过，moveend 再画） */
  if (typeof STATE !== 'undefined' && STATE.hlPoly && STATE.hlPoly.L === L && !STATE._dragging) {
    var hpg = STATE.hlPoly.pg;
    var hbb = hpg._bbox;
    if (hbb && !(hbb[2] < b0 || hbb[0] > b2 || hbb[3] < b1 || hbb[1] > b3)) {
      c.save();
      c.strokeStyle = '#8b0000';
      c.lineWidth = 3;
      c.beginPath();
      var hrings = hpg._ringsMerc;
      if (!hrings) {
        hrings = hpg.rings.map(function (ring) {
          return ring.map(function (pt) { return [lonToMercX(pt[0]), latToMercY(pt[1])]; });
        });
      }
      for (var hri = 0; hri < hrings.length; hri++) {
        var hring = hrings[hri];
        for (var hvi = 0; hvi < hring.length; hvi++) {
          var hpx = t0 * hring[hvi][0] + t2 * hring[hvi][1] + t4;
          var hpy = t1 * hring[hvi][0] + t3 * hring[hvi][1] + t5;
          if (hvi === 0) c.moveTo(hpx, hpy);
          else c.lineTo(hpx, hpy);
        }
        c.closePath();
      }
      c.stroke();
      c.restore();
    }
  }
}

function drawSites(c, L, t, w, h, box) {
  var t0 = t[0], t1 = t[1], t2 = t[2], t3 = t[3], t4 = t[4], t5 = t[5];
  var b0 = box[0], b1 = box[1], b2 = box[2], b3 = box[3];
  var scSel = (L.citySel !== undefined && L.citySel !== '*' && L.citySel !== 'none') ? parseInt(L.citySel, 10) : -1;
  var scIdx = (scSel >= 0 && L.cityIdx) ? L.cityIdx : null;
  /* 实地尺寸分制式（与 WebGL 一致）：4G 80米/35°，5G 60米/45° */
  var _is5gCv = (L.rat === '5G');
  var _scale = Math.abs(t0) || 0;
  var R = (_scale > 0) ? (_is5gCv ? 60 : 80) * _scale : STATE.siteR;
  if (R < 2) R = 2; if (R > 200) R = 200;
  var half = (_is5gCv ? 45 : 35) * DEG * 0.5;
  var azArr = L.azCol ? L.ds.num[L.azCol] : null;
  var mx = L.mx, my = L.my;
  var groups = L.colorGroups || [];
  var gi, g, k, i, x, y, px, py, idx;

  /* 先数可见点：纯算术循环，比一次 canvas 调用便宜两个量级 */
  var vis = 0;
  for (gi = 0; gi < groups.length; gi++) {
    idx = groups[gi].idx;
    for (k = 0; k < idx.length; k++) {
      i = idx[k];
      if (scIdx && scIdx[i] !== scSel) continue;
      x = mx[i]; y = my[i];
      if (!isFinite(x) || !isFinite(y)) continue;
      if (x < b0 || x > b2 || y < b1 || y > b3) continue;
      px = t0 * x + t2 * y + t4;
      py = t1 * x + t3 * y + t5;
      if (px < -R || py < -R || px > w + R || py > h + R) continue;
      if (++vis > SITE_FAST_LIMIT) break;
    }
    if (vis > SITE_FAST_LIMIT) break;
  }

  /* 缩放/平移动画过程中也走快速通道：动画每帧都重绘，画全扇区会把动画卡成 PPT。
     6000 点以下全扇区本来就够快，不必降级 */
  var navigating = STATE.navigating && vis > 6000;
  /* 自动聚合：站点屏幕密度过高时（平均每点 < 3px），按 3px 网格聚合，
     每格只画一个点，参考栅格的聚合逻辑 */
  var aggCell = 0;
  if (vis > 20000) {
    var approxPxPerSite = (w * h) / vis;
    if (approxPxPerSite < 9) aggCell = 3;
  }
  if (vis > SITE_SECTOR_LIMIT || navigating) {
    /* 快速通道：只画圆点、不画扇区不描边，一次成形。
       圆点半径随可见点数渐变（点越少圆点越大，阈值处约 0.8R，远处收到 0.22R），
       缩放时站点大小连续变化，不会在阈值处忽大忽小 */
    var _t = Math.max(0, Math.min(1, (vis - SITE_SECTOR_LIMIT) / 120000));
    var fr = Math.max(2.5, R * (0.8 - 0.58 * _t));
    /* 聚合模式：3px 网格去重，每格只画一个点 */
    var aggSeen = aggCell > 0 ? new Uint8Array(Math.ceil(w / aggCell) * Math.ceil(h / aggCell)) : null;
    var aggGW = aggCell > 0 ? Math.ceil(w / aggCell) : 0;
    for (gi = 0; gi < groups.length; gi++) {
      g = groups[gi];
      c.fillStyle = g.color;
      c.beginPath();
      idx = g.idx;
      for (k = 0; k < idx.length; k++) {
        i = idx[k];
        if (scIdx && scIdx[i] !== scSel) continue;
        x = mx[i]; y = my[i];
        if (!isFinite(x) || !isFinite(y)) continue;
        if (x < b0 || x > b2 || y < b1 || y > b3) continue;
        px = t0 * x + t2 * y + t4;
        py = t1 * x + t3 * y + t5;
        if (px < -fr || py < -fr || px > w + fr || py > h + fr) continue;
        if (aggSeen) {
          var acx = (px / aggCell) | 0, acy = (py / aggCell) | 0;
          var akey = acy * aggGW + acx;
          if (aggSeen[akey]) continue;
          aggSeen[akey] = 1;
        }
        c.moveTo(px + fr, py);
        c.arc(px, py, fr, 0, Math.PI * 2);
      }
      c.fill();
    }
    return;
  }

  /* 全扇区模式只在可见点 <= 8000 时进入（见 SITE_SECTOR_LIMIT），这个密度下描边和站址圆点都看得见，保留完整画法 */

  for (gi = 0; gi < groups.length; gi++) {
    g = groups[gi];
    c.fillStyle = g.color;
    c.strokeStyle = 'rgba(0,0,0,0.5)';
    c.lineWidth = 0.6;
    idx = g.idx;
    c.beginPath();
    for (k = 0; k < idx.length; k++) {
      i = idx[k];
      if (scIdx && scIdx[i] !== scSel) continue;
      x = mx[i]; y = my[i];
      if (!isFinite(x) || !isFinite(y)) continue;
      if (x < b0 || x > b2 || y < b1 || y > b3) continue;
      px = t0 * x + t2 * y + t4;
      py = t1 * x + t3 * y + t5;
      if (px < -R || py < -R || px > w + R || py > h + R) continue;
      if (g.indoor) {
        /* 室分：无方向性，画明显圆点 */
        var cr = Math.max(4, R * 0.35);
        c.moveTo(px + cr, py);
        c.arc(px, py, cr, 0, Math.PI * 2);
        c.closePath();
        continue;
      }
      var az = azArr ? azArr[i] : NaN;
      if (isFinite(az)) {
        var a0 = az * DEG - half - Math.PI / 2;
        var a1 = az * DEG + half - Math.PI / 2;
        c.moveTo(px, py);
        c.arc(px, py, R, a0, a1);
        c.closePath();
      } else {
        c.moveTo(px + 1, py);
        c.arc(px, py, 1, 0, Math.PI * 2);
      }
    }
    c.fill();
    c.stroke();
  }

}

/* ============================ 10. 拾取 / 弹窗 ============================ */

/* 站点扇形命中：返回被点击扇区对应的行号数组（可能多个重叠），无命中返回空数组。
   扇区为 80 米半径、STATE.beamW 波束的扇形，方位角 0=北顺时针 */
function pickSiteSector(L, pixel, t, res) {
  if (!L.mx || !L.my) return [];
  var _dpr3 = Math.min(window.devicePixelRatio || 1, 2);
  /* 按制式分规格（与 glDrawSites 一致）：4G 80米/35°，5G 60米/45° */
  var _is5g = (L.rat === '5G');
  var _sectorM = _is5g ? 60 : 80;
  var _beamW = _is5g ? 45 : 35;
  var _indoorM = _is5g ? 25 : 30;
  var Rpx = _sectorM / (res || 1) * _dpr3;
  var RpxIndoor = _indoorM / (res || 1) * _dpr3;
  var half = _beamW * Math.PI / 360;
  var azArr = L.azCol ? L.ds.num[L.azCol] : null;
  var n = L.ds.n, mx = L.mx, my = L.my;
  var hits = [];
  for (var i = 0; i < n; i++) {
    var x = mx[i], y = my[i];
    if (!isFinite(x) || !isFinite(y)) continue;
    var sx = t[0] * x + t[2] * y + t[4];
    var sy = t[1] * x + t[3] * y + t[5];
    var dx = pixel[0] - sx, dy = pixel[1] - sy;
    var d2 = dx * dx + dy * dy;
    if (d2 > Rpx * Rpx) continue;
    var az = azArr ? azArr[i] : NaN;
    var indoor = L.isIndoor && L.isIndoor[i];
    if (indoor) {
      /* 室分：按圆处理，半径 4G 30米 / 5G 25米 */
      if (d2 <= RpxIndoor * RpxIndoor) hits.push({ i: i, d2: d2 });
      continue;
    }
    if (!isFinite(az)) {
      /* 无方位角：按圆处理 */
      hits.push({ i: i, d2: d2 });
      continue;
    }
    var clickAng = Math.atan2(dx, -dy);
    var azRad = az * Math.PI / 180;
    var diff = clickAng - azRad;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    if (Math.abs(diff) <= half) hits.push({ i: i, d2: d2 });
  }
  hits.sort(function (a, b) { return a.d2 - b.d2; });
  return hits.map(function (h) { return h.i; });
}

/* 点是否在多边形内（射线法），坐标系需一致 */
function ptInPoly(px, py, rings) {
  var inside = false;
  for (var ri = 0; ri < rings.length; ri++) {
    var ring = rings[ri];
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1];
      var xj = ring[j][0], yj = ring[j][1];
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
  }
  return inside;
}

function pickAt(pixel) {
  var t = transformOf(map, map.getSize());
  if (!t) return;
  var res = map.getView().getResolution();
  var tol = 9;
  var best = null, bestD = tol * tol;

  function consider(L, i) {
    var x = L.mx[i], y = L.my[i];
    if (!isFinite(x) || !isFinite(y)) return;
    var px = t[0] * x + t[2] * y + t[4];
    var py = t[1] * x + t[3] * y + t[5];
    var dx = px - pixel[0], dy = py - pixel[1];
    var d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = { L: L, i: i }; }
  }

  for (var li = layers.length - 1; li >= 0; li--) {
    var L = layers[li];
    if (!L.visible || !L.ok) continue;
    if (L.kind === 'grid' && L.buckets) {
      for (var b = 0; b < (L.bandCount || 6); b++) {
        var idx = L.buckets[b];
        for (var k = 0; k < idx.length; k++) consider(L, idx[k]);
      }
    } else if (L.kind === 'vector' && L.polygons) {
      var coord = map.getCoordinateFromPixel(pixel);
      if (coord) {
        var mxx = coord[0], myy = coord[1];
        for (var pi = 0; pi < L.polygons.length; pi++) {
          var pg = L.polygons[pi];
          var bb = pg._bbox;
          if (bb && (mxx < bb[0] || mxx > bb[2] || myy < bb[1] || myy > bb[3])) continue;
          if (!pg._ringsMerc) {
            pg._ringsMerc = pg.rings.map(function (ring) {
              return ring.map(function (pt) { return [lonToMercX(pt[0]), latToMercY(pt[1])]; });
            });
          }
          if (ptInPoly(mxx, myy, pg._ringsMerc)) { best = { L: L, poly: pg }; break; }
        }
        if (best && best.poly) break;
      }
    } else if (L.kind === 'site') {
      /* 先试扇形命中：点击落在 80 米扇区内则选中该扇区（可能多个重叠） */
      var secHits = pickSiteSector(L, pixel, t, res);
      if (secHits.length === 1) { best = { L: L, i: secHits[0], sector: true }; break; }
      if (secHits.length > 1) { best = { L: L, i: secHits[0], rows: secHits, sector: true }; break; }
      /* 否则回退到最近中心点（9px） */
      for (var k2 = 0; k2 < L.ds.n; k2++) consider(L, k2);
    }
    if (best && best.L === L) break;
  }

  if (!best) { hidePopup(); return; }
  if (best.poly) { showVectorPopup(best.L, best.poly, pixel); return; }
  if (best.rows && best.rows.length > 1) showMultiSectorPopup(best.L, best.rows, pixel);
  else showPopup(best.L, best.i, pixel);
}

/* 多扇区重叠弹窗：每个扇区一个键值小节，上下堆叠 */
function showMultiSectorPopup(L, rows, pixel) {
  var ds = L.ds;
  var title = '重叠扇区（' + rows.length + ' 个）';
  var html = '';
  for (var r = 0; r < rows.length; r++) {
    var cells = ds.cells(rows[r]);
    // 取小区名做小节标题
    var secName = '';
    for (var ci = 0; ci < ds.columns.length; ci++) {
      var cn = ds.columns[ci] || '';
      if (cn.indexOf('小区名') >= 0 && cells[ci]) { secName = String(cells[ci]); break; }
    }
    if (!secName) secName = '扇区 ' + (r + 1);
    html += '<div class="msec"><table><tr><td colspan="2" class="msec-h">' + esc(secName) + '</td></tr>';
    for (var c = 0; c < ds.columns.length; c++) {
      var colName = ds.columns[c] || '';
      var v = cells[c];
      if (v === undefined || v === '' || v === null) continue;
      html += '<tr><td>' + esc(colName) + '</td><td>' + esc(String(v)) + '</td></tr>';
    }
    html += '</table></div>';
  }
  document.getElementById('popTitle').textContent = title;
  document.getElementById('popTable').innerHTML = html;
  var subEl = document.getElementById('popSub');
  if (subEl) subEl.textContent = L.name;
  var _pf = document.getElementById('popFoot'); if (_pf) _pf.innerHTML = '';
  var el = document.getElementById('popup');
  el.style.maxWidth = 'min(860px,92vw)';
  /* 拉伸后的尺寸换显示器时按当前视口钳住 */
  if (el.style.width) {
    var pw = parseFloat(el.style.width);
    if (pw > window.innerWidth * 0.9) el.style.width = Math.floor(window.innerWidth * 0.9) + 'px';
  }
  if (el.style.height) {
    var ph2 = parseFloat(el.style.height);
    if (ph2 > window.innerHeight * 0.85) el.style.height = Math.floor(window.innerHeight * 0.85) + 'px';
  }
  el.classList.add('show');
  var wrap = document.getElementById('mapwrap');
  var W = wrap.clientWidth, H = wrap.clientHeight;
  var pw = el.offsetWidth, ph = el.offsetHeight;
  var x = (pixel ? pixel[0] : W / 2) + 14;
  var y = (pixel ? pixel[1] : H / 2) - 12;
  if (x + pw > W - 8) x = (pixel ? pixel[0] : W / 2) - pw - 14;
  if (x < 8) x = 8;
  if (y + ph > H - 8) y = H - ph - 8;
  if (y < 8) y = 8;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
}

/* 弹窗拖动：记住手动拖出的偏移，后续点选沿用，避免每次又弹回鼠标边 */
var popOffset = { x: 0, y: 0 };
var popAnchor = { x: 0, y: 0 };

function clampPopup() {
  var el = document.getElementById('popup');
  var wrap = document.getElementById('mapwrap');
  if (!el || !wrap || !el.offsetParent) return;
  var W = wrap.clientWidth, H = wrap.clientHeight;
  var r = el.getBoundingClientRect();
  var l = el.offsetLeft, t = el.offsetTop;
  l = Math.min(Math.max(l, 6), Math.max(6, W - r.width - 6));
  t = Math.min(Math.max(t, 6), Math.max(6, H - r.height - 6));
  el.style.left = l + 'px';
  el.style.top = t + 'px';
}

function initPopupDrag() {
  var el = document.getElementById('popup');
  if (!el) return;
  var head = el.querySelector('.ph');
  if (!head) return;
  var drag = null;
  head.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    /* 头部里的按钮（✕）照常工作：不拦、不抢指针捕获 */
    if (e.target && e.target.closest && e.target.closest('button')) return;
    e.stopPropagation();
    e.preventDefault();
    drag = { x: e.clientX, y: e.clientY, l: el.offsetLeft, t: el.offsetTop, moved: false };
    try { head.setPointerCapture(e.pointerId); } catch (er) { }
  });
  head.addEventListener('pointermove', function (e) {
    if (!drag) return;
    e.stopPropagation();
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;
    el.style.left = (drag.l + dx) + 'px';
    el.style.top = (drag.t + dy) + 'px';
  });
  head.addEventListener('pointerup', function (e) {
    if (!drag) return;
    e.stopPropagation();
    var moved = drag.moved;
    drag = null;
    if (!moved) return;
    clampPopup();
    /* 记下相对"本次锚点"的偏移；夹取后再算，保证与显示位置一致 */
    popOffset.x = el.offsetLeft - popAnchor.x;
    popOffset.y = el.offsetTop - popAnchor.y;
  });
  global.addEventListener('resize', function () { if (popOffset.x || popOffset.y) clampPopup(); });
}

/* 采样点弹窗（点栅格）：头部数值 + 下方小色条都跟随当前着色模式。
   RSRP 6 档 / SINR 7 档 / 覆盖率 5 档，当前值所在档位高亮描边 */
/* 边界多边形弹窗：显示属性表 */
function showVectorPopup(L, pg, pixel) {
  var props = pg.props || {};
  /* 标题自适应取名称 */
  var title = getSceneName(props) || L.name;
  if (!title) {
    title = L.name;
    for (var k in props) {
      var vv = String(props[k] || '').trim();
      if (vv && vv.indexOf('\uFFFD') < 0) { title = vv; break; }
    }
  } else {
    title = String(title);
  }
  var html = '';
  for (var k2 in props) {
    var v2 = String(props[k2] == null ? '' : props[k2]).trim();
    html += '<tr><td>' + esc(k2) + '</td><td>' + esc(v2) + '</td></tr>';
  }
  if (!html) html = '<tr><td colspan="2">无属性</td></tr>';
  document.getElementById('popTitle').textContent = title;
  document.getElementById('popTable').innerHTML = html;
  var subEl = document.getElementById('popSub');
  if (subEl) subEl.textContent = L.name;
  var el = document.getElementById('popup');
  el.style.maxWidth = '';
  el.classList.add('show');
  var wrap = document.getElementById('mapwrap');
  var W = wrap.clientWidth, H = wrap.clientHeight;
  var pw = el.offsetWidth, ph = el.offsetHeight;
  var x = (pixel ? pixel[0] : W / 2) + 14;
  var y = (pixel ? pixel[1] : H / 2) - 12;
  if (x + pw > W - 8) x = (pixel ? pixel[0] : W / 2) - pw - 14;
  if (x < 8) x = 8;
  if (y + ph > H - 8) y = H - ph - 8;
  if (y < 8) y = 8;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
}

function showPopup(L, i, pixel) {
  var ds = L.ds;
  var cells = ds.cells(i);
  var title = ds.name;
  if (L.kind === 'site' && L.nameCol) {
    var nv = ds.value(i, L.nameCol);
    if (nv) title = String(nv);
  } else if (L.kind === 'grid') {
    /* 标题跟随着色模式：RSRP / SINR / 覆盖率 */
    var gmode = L.bandMode || 'rsrp';
    if (gmode === 'sinr' && L.sinrCol && ds.num[L.sinrCol]) {
      var sv = ds.num[L.sinrCol][i];
      title = isFinite(sv) ? ('SINR ' + sv.toFixed(2) + ' dB') : ds.name;
    } else if (gmode === 'cov') {
      var cv = gridCovValue(L, i);
      title = isFinite(cv) ? ('\u8986\u76d6\u7387 ' + cv.toFixed(1) + '%') : ds.name;
    } else if (L.rsrpCol && ds.num[L.rsrpCol]) {
      var rv = ds.num[L.rsrpCol][i];
      title = isFinite(rv) ? ('RSRP ' + rv.toFixed(2) + ' dBm') : ds.name;
    }
  }

  var html = '';
  var hlCols = L.kind === 'grid'
    ? [L.rsrpCol, L.sinrCol, L.cntCol]
    : [L.azCol, L.bandCol, L.tiltCol, L.hgtCol];

  for (var c = 0; c < ds.columns.length; c++) {
    var v = cells[c];
    if (v === undefined) v = '';
    v = String(v).trim();
    var isHl = hlCols.indexOf(ds.columns[c]) >= 0;
    var extra = '';
    if (L.kind === 'grid' && v !== '' && isFinite(Number(v))) {
      /* 色块跟随着色模式：RSRP行/SINR行显示对应档位色，覆盖率模式不显示色块 */
      var gmode2 = L.bandMode || 'rsrp';
      var bb = -1, bfill = null;
      if (gmode2 === 'sinr' && ds.columns[c] === L.sinrCol) {
        bb = bandOfSINR(Number(v));
        if (bb >= 0 && bb < SINR_FILL.length) bfill = SINR_FILL[bb];
      } else if (gmode2 === 'rsrp' && ds.columns[c] === L.rsrpCol) {
        bb = bandOf(Number(v));
        if (bb >= 0 && bb < BAND_FILL.length) bfill = BAND_FILL[bb];
      }
      if (bfill) {
        extra = '<span class="sw" style="' +
          'background:' + bfill + ';vertical-align:-1px"></span>';
      }
    }
    html += '<tr><td>' + esc(ds.columns[c]) + '</td><td class="' +
      (isHl ? 'hl' : '') + '">' + esc(v) + extra + '</td></tr>';
  }
  document.getElementById('popTitle').textContent = title;
  document.getElementById('popTable').innerHTML = html;

  var lon = ds.num[L.lonCol] ? ds.num[L.lonCol][i] : NaN;
  var lat = ds.num[L.latCol] ? ds.num[L.latCol][i] : NaN;
  var subEl = document.getElementById('popSub');
  if (subEl) subEl.textContent = L.name;
  /* 底部经纬度已去掉，表格内已有 */

  var el = document.getElementById('popup');
  el.style.maxWidth = '';
  /* 拉伸后的尺寸换显示器时按当前视口钳住 */
  if (el.style.width) {
    var pw = parseFloat(el.style.width);
    if (pw > window.innerWidth * 0.9) el.style.width = Math.floor(window.innerWidth * 0.9) + 'px';
  }
  if (el.style.height) {
    var ph2 = parseFloat(el.style.height);
    if (ph2 > window.innerHeight * 0.85) el.style.height = Math.floor(window.innerHeight * 0.85) + 'px';
  }
  el.classList.add('show');

  /* 定位到点击处，越界自动翻转 */
  var wrap = document.getElementById('mapwrap');
  var W = wrap.clientWidth, H = wrap.clientHeight;
  var pw = el.offsetWidth, ph = el.offsetHeight;
  var x = (pixel ? pixel[0] : W / 2) + 14;
  var y = (pixel ? pixel[1] : H / 2) - 12;
  if (x + pw > W - 8) x = (pixel ? pixel[0] : W / 2) - pw - 14;
  if (x < 8) x = 8;
  if (y + ph > H - 8) y = H - ph - 8;
  if (y < 8) y = 8;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  popAnchor = { x: x, y: y };
  /* 沿用上次手动拖出的偏移 */
  if (popOffset.x || popOffset.y) {
    el.style.left = (x + popOffset.x) + 'px';
    el.style.top = (y + popOffset.y) + 'px';
    clampPopup();
    popOffset.x = el.offsetLeft - x;
    popOffset.y = el.offsetTop - y;
  }
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, function (m) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m];
  });
}
function hidePopup() { document.getElementById('popup').classList.remove('show'); }

/* ============================ 11. 图例 / 统计 ============================ */

/* ---- 经纬度定位标记 ---- */
function setPin(lon, lat) {
  STATE.pin = { lon: lon, lat: lat, mx: lonToMercX(lon), my: latToMercY(lat) };
  var el = document.getElementById('jump');
  if (el) el.value = lon.toFixed(6) + ',' + lat.toFixed(6);
  scheduleDraw();
}

/* ---- 图例拖动 / 缩放 ---- */
var legendBox = { l: null, t: null, w: null, h: null };

/* 图例内容随尺寸等比缩放：以默认宽度 172px 为基准算系数 */
function applyLegendScale() {
  var el = document.getElementById('legend');
  if (!el) return;
  var w = el.getBoundingClientRect().width;
  if (!w) return;
  var k = w / 172;
  if (k < 0.85) k = 0.85;
  if (k > 2.4) k = 2.4;
  el.style.setProperty('--ls', k.toFixed(3));
}

function initLegendBox() {
  var el = document.getElementById('legend');
  var head = document.getElementById('legendHead');
  var wrap = document.getElementById('mapwrap');
  if (!el || !head || !wrap) return;

  /* 八向缩放手柄：边=单轴，角=双轴，按住 Shift 等比 */
  var DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
  var CURSOR = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
                 ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
  var handleEls = {};
  DIRS.forEach(function (d) {
    var h = document.createElement('div');
    h.className = 'lz lz-' + d;
    h.title = '拖动调整大小（按住 Shift 等比缩放）';
    el.appendChild(h);
    handleEls[d] = h;
  });

  var MINW = 148, MINH = 62, EDGE = 4;
  /* 键名带版本：默认尺寸调整后丢弃旧的保存值，避免沿用旧宽度。
     v3：默认宽度改为随屏幕自适应（7.8vw），丢弃 v2 的固定 172px 存档 */
  var BOX_KEY = 'legend_box_v3';

  try {
    var saved = JSON.parse(lsGet(BOX_KEY, 'null'));
    if (saved && typeof saved === 'object') {
      if (typeof saved.l === 'number') legendBox.l = saved.l;
      if (typeof saved.t === 'number') legendBox.t = saved.t;
      if (typeof saved.w === 'number') legendBox.w = saved.w;
      if (typeof saved.h === 'number') legendBox.h = saved.h;
    }
  } catch (e) { }

  function unfoldedHeight() {
    return (legendBox.h !== null && !el.classList.contains('fold')) ? legendBox.h + 'px' : '';
  }
  function applyBox() {
    if (legendBox.l !== null) { el.style.left = legendBox.l + 'px'; el.style.right = 'auto'; }
    if (legendBox.t !== null) { el.style.top = legendBox.t + 'px'; el.style.bottom = 'auto'; }
    if (legendBox.w !== null) el.style.width = legendBox.w + 'px';
    el.style.height = unfoldedHeight();
    applyLegendScale();
  }
  function saveBox() { lsSet(BOX_KEY, JSON.stringify(legendBox)); }

  /* 丢弃保存的位置与尺寸，回到 CSS 默认的右下角锚定（随窗口自适应） */
  function resetLegendBox() {
    legendBox = { l: null, t: null, w: null, h: null };
    el.style.left = ''; el.style.top = '';
    el.style.right = ''; el.style.bottom = '';
    el.style.width = ''; el.style.height = '';
    applyLegendScale();
    saveBox();
  }

  function clampToMap() {
    var W = wrap.clientWidth, H = wrap.clientHeight;
    if (!W || !H) return;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    if (legendBox.l === null) return;      /* 仍是 CSS 右下角锚定，天然在图内 */

    var o = wrap.getBoundingClientRect();
    var l = r.left - o.left, t = r.top - o.top;

    /* 保存的位置在当前窗口下几乎看不见 → 直接丢回右下角默认锚定 */
    if (l + r.width < 60 || l > W - 60 || t + r.height < 24 || t > H - 24) {
      resetLegendBox();
      return;
    }

    /* 先限尺寸，再限位置，保证整体落在图内 */
    var w = r.width, h = r.height;
    if (!el.classList.contains('fold')) {
      if (w > W - EDGE * 2) {
        w = Math.max(MINW, W - EDGE * 2);
        legendBox.w = w;
        el.style.width = w + 'px';
      }
      if (h > H - EDGE * 2) {
        h = Math.max(MINH, H - EDGE * 2);
        legendBox.h = h;
        el.style.height = h + 'px';
      }
    }
    var maxX = Math.max(EDGE, W - w);
    var maxY = Math.max(EDGE, H - h);
    var nl = Math.max(EDGE, Math.min(l, maxX));
    var nt = Math.max(EDGE, Math.min(t, maxY));
    if (nl !== l) { legendBox.l = nl; el.style.left = nl + 'px'; }
    if (nt !== t) { legendBox.t = nt; el.style.top = nt + 'px'; }
    applyLegendScale();
  }

  applyBox();
  clampToMap();          /* 载入即校正，避免上次保存的位置把图例顶到视野外 */
  /* 首帧后再校正一次，等布局稳定（面板宽度/滚动条就位） */
  requestAnimationFrame(function () {
    requestAnimationFrame(function () { clampToMap(); saveBox(); });
  });

  var drag = null, moved = false;

  /* 首次真正移动时才把 right/bottom 锚定换成 left/top 绝对定位 */
  function pinToAbsolute() {
    if (drag.pinned) return;
    var r = el.getBoundingClientRect(), o = wrap.getBoundingClientRect();
    var l = r.left - o.left, t = r.top - o.top;
    el.style.left = l + 'px';
    el.style.top = t + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    if (drag.mode === 'resize') {
      el.style.width = r.width + 'px';
      el.style.height = r.height + 'px';
      legendBox.w = r.width;
      legendBox.h = r.height;
    }
    legendBox.l = l;
    legendBox.t = t;
    drag.l0 = l;
    drag.t0 = t;
    drag.pinned = true;
  }

  function startDrag(e, mode, dir) {
    if (e.button !== undefined && e.button !== 0) return;
    var r = el.getBoundingClientRect(), o = wrap.getBoundingClientRect();
    drag = {
      mode: mode, dir: dir || '',
      folded: el.classList.contains('fold'),
      pinned: false,
      x0: e.clientX, y0: e.clientY,
      lastX: e.clientX, lastY: e.clientY,
      l0: r.left - o.left, t0: r.top - o.top,
      w0: r.width, h0: r.height
    };
    moved = false;
    document.body.style.cursor = (mode === 'move') ? 'move' : CURSOR[dir];
    if (e.target.setPointerCapture && e.pointerId !== undefined) {
      try { e.target.setPointerCapture(e.pointerId); } catch (er) { }
    }
    e.preventDefault();
  }

  head.addEventListener('pointerdown', function (e) {
    if (e.target.closest && e.target.closest('#legendReset')) return;
    startDrag(e, 'move');
  });
  DIRS.forEach(function (d) {
    handleEls[d].addEventListener('pointerdown', function (e) {
      startDrag(e, 'resize', d);
      e.stopPropagation();
    });
  });

  document.addEventListener('pointermove', function (e) {
    if (!drag) return;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    var dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      moved = true;
      pinToAbsolute();                 /* 只有真的拖动时才固定位置 */
    }
    if (!moved) return;

    var W = wrap.clientWidth, H = wrap.clientHeight;

    if (drag.mode === 'move') {
      /* 只有真正拖动了才展开；单击不展开，否则会"展开又折叠"地闪一下 */
      if (drag.folded) {
        drag.folded = false;
        var hBefore = el.getBoundingClientRect().height;
        el.classList.remove('fold');
        el.style.height = (legendBox.h !== null) ? legendBox.h + 'px' : '';
        var hAfter = el.getBoundingClientRect().height;
        drag.t0 -= (hAfter - hBefore);      /* 展开时让下边界不动，避免跳动 */
      }
      /* 横向至少留 90px 在图内；纵向保持整块在图内 */
      var minX = 90 - el.offsetWidth, maxX = W - 90;
      var maxY = Math.max(EDGE, H - el.offsetHeight);
      var nl = Math.max(minX, Math.min(drag.l0 + dx, Math.max(minX, maxX)));
      var nt = Math.max(EDGE, Math.min(drag.t0 + dy, maxY));
      el.style.left = nl + 'px';
      el.style.top = nt + 'px';
      legendBox.l = nl;
      legendBox.t = nt;
      return;
    }

    var d = drag.dir;
    var hasE = d.indexOf('e') >= 0, hasW = d.indexOf('w') >= 0;
    var hasS = d.indexOf('s') >= 0, hasN = d.indexOf('n') >= 0;
    var w0 = drag.w0, h0 = drag.h0;
    var wantW = w0 + (hasE ? dx : 0) - (hasW ? dx : 0);
    var wantH = h0 + (hasS ? dy : 0) - (hasN ? dy : 0);

    if (e.shiftKey) {
      var sx = (hasE || hasW) ? wantW / w0 : null;
      var sy = (hasS || hasN) ? wantH / h0 : null;
      var s = (sx !== null && sy !== null) ? Math.max(sx, sy) : (sx !== null ? sx : sy);
      if (isFinite(s) && s > 0) { wantW = w0 * s; wantH = h0 * s; }
    }

    wantW = Math.max(MINW, wantW);
    wantH = Math.max(MINH, wantH);

    var l = hasW ? drag.l0 + (w0 - wantW) : drag.l0;
    var t = hasN ? drag.t0 + (h0 - wantH) : drag.t0;

    if (hasW && l < EDGE) { l = EDGE; wantW = drag.l0 + w0 - EDGE; }
    if (hasN && t < EDGE) { t = EDGE; wantH = drag.t0 + h0 - EDGE; }
    if (l + wantW > W - EDGE) wantW = W - EDGE - l;
    if (t + wantH > H - EDGE) wantH = H - EDGE - t;
    wantW = Math.max(MINW, wantW);
    wantH = Math.max(MINH, wantH);

    el.style.width = Math.round(wantW) + 'px';
    el.style.height = Math.round(wantH) + 'px';
    el.style.left = Math.round(l) + 'px';
    el.style.top = Math.round(t) + 'px';
    legendBox.w = Math.round(wantW);
    legendBox.h = Math.round(wantH);
    applyLegendScale();
    legendBox.l = Math.round(l);
    legendBox.t = Math.round(t);
  });

  document.addEventListener('pointerup', function () {
    if (!drag) return;
    var wasDrag = moved, mode = drag.mode;
    drag = null;
    document.body.style.cursor = '';
    if (wasDrag) {
      clampToMap();
      saveBox();
    } else if (mode === 'move') {
      /* 没拖动 = 点击标题栏 → 折叠 / 展开（不改动锚定方式） */
      el.classList.toggle('fold');
      el.style.height = unfoldedHeight();
    }
  });

  document.getElementById('legendReset').onclick = function (e) {
    e.stopPropagation();
    resetLegendBox();      /* 回到右下角默认锚定 + 自适应尺寸 */
    clampToMap();
  };

  global.addEventListener('resize', function () { clampToMap(); saveBox(); });
}


/* ---- 图例开合：无数据时折叠、有数据时展开 ----
   只在「有数据 / 没数据」这个状态真正切换时才干预，
   避免用户手动折叠后又被强行展开。 */
var legendHadData = null;

function syncLegendFold() {
  var el = document.getElementById('legend');
  if (!el) return;
  var hasData = layers.length > 0;
  if (legendHadData === hasData) return;
  legendHadData = hasData;
  el.classList.toggle('fold', !hasData);
  el.style.height = (legendBox.h !== null && hasData) ? legendBox.h + 'px' : '';
}

function renderLegend() {
  var body = document.getElementById('legendBody');
  var sub = document.getElementById('legendSub');
  var title = document.getElementById('legendTitle');
  var L = selected;

  var html = '';
  if (L && L.kind === 'vector') {
    /* 边界图层：以前落到下面的公共分支，选中的是边界却在显示 RSRP 档位图例 */
    title.textContent = '边界';
    html += '<div class="li"><i style="background:#c86bff;border-radius:0"></i><span>多边形边界（描边）</span></div>';
    body.innerHTML = html;
    sub.textContent = L.polygons ? (L.polygons.length.toLocaleString() + ' 个多边形') : '';
    return;
  }
  if (L && L.kind === 'site') {
    /* 工参图层：显示制式色 + 形状说明（圆=室分，扇区=宏站） */
    title.textContent = '工参';
    var ratColor = 'rgba(56,132,255,0.6)';
    for (var gi = 0; gi < (L.colorGroups || []).length; gi++) {
      var g = L.colorGroups[gi];
      if (g.key === 'rat' || !g.indoor) { ratColor = g.color; break; }
    }
    var ratName = (L.rat === '5G') ? '5G' : (L.rat === '4G') ? '4G' : '扇区';
    html += '<div class="li"><i style="background:' + ratColor + ';border-radius:0;' +
      'clip-path:polygon(50% 100%,0 0,100% 0)"></i><span>' + ratName + ' 宏站扇区</span></div>';
    html += '<div class="li"><i style="background:' + ratColor + ';border-radius:50%"></i>' +
      '<span>室分（圆点）</span></div>';
    body.innerHTML = html;
    sub.textContent = '';
    return;
  }

  /* 纯图例：档位跟随图层当前着色模式；没有任何栅格数据时标题就叫「图例」 */
  var gridLayer = (selected && selected.kind === 'grid' && selected.ok) ? selected : null;
  if (!gridLayer) {
    for (var g0 = 0; g0 < layers.length; g0++) {
      if (layers[g0].kind === 'grid' && layers[g0].ok) { gridLayer = layers[g0]; break; }
    }
  }
  var mode = gridLayer ? (gridLayer.bandMode || 'rsrp') : STATE.gridColorMode;
  var gm = GRID_MODES[mode];
  title.textContent = gridLayer ? (GMODE_NAME[mode] || 'RSRP均值') : '图例';
  for (var b = 0; b < gm.bands.length; b++) {
    html += '<div class="li"><i style="background:' + gm.fill[b] + '"></i>' +
      '<span>' + gm.bands[b].label + '</span></div>';
  }
  body.innerHTML = html;

  sub.textContent = '';
}


/* ============================ 小区注记 ============================ */
/* 小区名注记（QGIS 风格）：zoom>=15 时显示可见扇区的小区名 */
/* 自适应取场景名称：找字段名含 name/名称 的，找不到用第一个像名称的字符串 */
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
  /* 第一遍：字段名像名称字段（含 name / 含「名称」/ 以「名」结尾如村名、场景名），且值不像编号 */
  for (i = 0; i < keys.length; i++) {
    k = keys[i]; kl = k.toLowerCase();
    if (kl.indexOf('name') >= 0 || k.indexOf('名称') >= 0 || /名$/.test(k)) {
      var v = String(props[k] || '').trim();
      if (v && v.indexOf('\\uFFFD') < 0 && !isIdVal(v)) return v;
    }
  }
  /* 第二遍兜底：第一个像名称的字符串 */
  for (i = 0; i < keys.length; i++) {
    k = keys[i];
    var v2 = String(props[k] || '').trim();
    if (!v2 || v2.indexOf('\\uFFFD') >= 0) continue;
    if (/^[\d\-\.]+$/.test(v2)) continue;
    if (/^[A-Z0-9\-]+$/i.test(v2) && v2.length > 10) continue;
    if (v2.length > 60) continue;
    if (isIdVal(v2)) continue;
    return v2;
  }
  return '';
}

var LABEL_4G = false;
var LABEL_5G = false;
var LABEL_SCENE = false;
var LABEL_MIN_ZOOM = 14;
var LABEL_MAX = 3000;
function drawLabels() {
  var cv = document.getElementById('labelCanvas');
  if (!cv) return;
  var wrap = document.getElementById('mapwrap');
  var W = wrap.clientWidth, H = wrap.clientHeight;
  if (cv.width !== W) cv.width = W;
  if (cv.height !== H) cv.height = H;
  var ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  if ((!LABEL_4G && !LABEL_5G && !LABEL_SCENE) || !map) return;
  var zoom = map.getView().getZoom();
  if (zoom < LABEL_MIN_ZOOM) return;
  var extent = map.getView().calculateExtent(map.getSize());
  // extent 是墨卡托坐标 [minx, miny, maxx, maxy]
  ctx.font = '11px -apple-system,"PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif';
  ctx.textBaseline = 'middle';
  var drawn = 0;
  var placed = [];
  var res = map.getView().getResolution() || 1; // 米/像素
  for (var li = 0; li < layers.length && drawn < LABEL_MAX; li++) {
    var L = layers[li];
    if (!L.visible || !L.ok) continue;
    /* 场景名称：边界层多边形 */
    if (L.kind === 'vector' && LABEL_SCENE && L.polygons) {
      for (var vpi = 0; vpi < L.polygons.length && drawn < LABEL_MAX; vpi++) {
        var vpg = L.polygons[vpi];
        var vbb = vpg._bbox;
        if (!vbb) continue;
        var vcx = (vbb[0] + vbb[2]) / 2, vcy = (vbb[1] + vbb[3]) / 2;
        if (vcx < extent[0] || vcx > extent[2] || vcy < extent[1] || vcy > extent[3]) continue;
        /* 确保中心点在多边形内部（凹多边形 bbox 中心可能在外） */
        if (!vpg._ringsMerc) {
          vpg._ringsMerc = vpg.rings.map(function (ring) {
            return ring.map(function (pt) { return [lonToMercX(pt[0]), latToMercY(pt[1])]; });
          });
        }
        if (!ptInPoly(vcx, vcy, vpg._ringsMerc)) {
          /* 中心在外：试 bbox 的 1/4 分位点 */
          var found = false;
          var cand = [
            [vbb[0] + (vbb[2]-vbb[0])*0.25, vbb[1] + (vbb[3]-vbb[1])*0.25],
            [vbb[0] + (vbb[2]-vbb[0])*0.75, vbb[1] + (vbb[3]-vbb[1])*0.25],
            [vbb[0] + (vbb[2]-vbb[0])*0.25, vbb[1] + (vbb[3]-vbb[1])*0.75],
            [vbb[0] + (vbb[2]-vbb[0])*0.75, vbb[1] + (vbb[3]-vbb[1])*0.75],
            [vbb[0] + (vbb[2]-vbb[0])*0.5, vbb[1] + (vbb[3]-vbb[1])*0.25],
            [vbb[0] + (vbb[2]-vbb[0])*0.5, vbb[1] + (vbb[3]-vbb[1])*0.75]
          ];
          for (var ci = 0; ci < cand.length; ci++) {
            if (ptInPoly(cand[ci][0], cand[ci][1], vpg._ringsMerc)) {
              vcx = cand[ci][0]; vcy = cand[ci][1]; found = true; break;
            }
          }
          if (!found) continue;
        }
        var vprops = vpg.props || {};
        var vnm = getSceneName(vprops);
        vnm = String(vnm || '').trim();
        if (!vnm) continue;
        var vpx = map.getPixelFromCoordinate([vcx, vcy]);
        if (!vpx) continue;
        ctx.font = '14px -apple-system,"PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif';
        ctx.textAlign = 'center';
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 2.5;
        ctx.strokeText(vnm, vpx[0], vpx[1]);
        ctx.fillStyle = '#8e44ad';
        ctx.fillText(vnm, vpx[0], vpx[1]);
        ctx.font = '11px -apple-system,"PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif';
        drawn++;
      }
      continue;
    }
    if (L.kind !== 'site' || !L.mx || !L.my || !L.nameCol) continue;
    /* 4G/5G 注记开关 */
    if (L.rat === '4G' && !LABEL_4G) continue;
    if (L.rat === '5G' && !LABEL_5G) continue;
    if (L.rat !== '4G' && L.rat !== '5G') {
      if (!LABEL_4G && !LABEL_5G) continue;
    }
    var mx = L.mx, my = L.my, n = L.ds.n;
    var nameCol = L.nameCol;
    var azArr = L.azCol ? L.ds.num[L.azCol] : null;
    var stypeArr = L.ds.stype;
    /* 预取名字数组，避免内层逐行 ds.value() 的函数调用开销 */
    var _sarr = (L.ds.str && L.ds.str[nameCol]) ? L.ds.str[nameCol] : null;
    for (var i = 0; i < n && drawn < LABEL_MAX; i++) {
      var x = mx[i], y = my[i];
      if (x < extent[0] || x > extent[2] || y < extent[1] || y > extent[3]) continue;
      var nm = _sarr ? _sarr[i] : L.ds.value(i, nameCol);
      if (!nm) continue;
      nm = String(nm);
      // 贴边：室分圆边 30/25 米；宏站扇区边缘 80/60 米
      var _sv = stypeArr ? stypeArr[i] : '';
      var _isIndoor = typeof _sv === 'string' && /室分|室内/.test(_sv);
      var _is5gLb = (L.rat === '5G');
      var _dist = _isIndoor ? (_is5gLb ? 25 : 30) : (_is5gLb ? 60 : 80);
      var az = azArr ? azArr[i] : 0;
      var rad = (az || 0) * Math.PI / 180;
      var lx = x + Math.sin(rad) * _dist;
      var ly = y + Math.cos(rad) * _dist;
      var px = map.getPixelFromCoordinate([lx, ly]);
      if (!px) continue;
      // 按方位角决定对齐：东向左对齐（向右延伸），西向右对齐（向左延伸），南北居中
      var sinAz = Math.sin(rad);
      var align = 'center';
      if (sinAz > 0.35) align = 'left';
      else if (sinAz < -0.35) align = 'right';
      ctx.textAlign = align;
      var tw0 = ctx.measureText(nm).width;
      var bx0 = align === 'left' ? px[0] : (align === 'right' ? px[0] - tw0 : px[0] - tw0 / 2);
      var by0 = px[1] - 8;
      var overlap = false, overlapDiffRat = false;
      for (var k = 0; k < placed.length; k++) {
        var pb = placed[k];
        if (bx0 < pb[0] + pb[2] && bx0 + tw0 > pb[0] && by0 < pb[1] + pb[3] && by0 + 16 > pb[1]) {
          overlap = true;
          // 不同制式（4G/5G）同位置则错开而非跳过
          if (pb[4] && pb[4] !== L.rat) overlapDiffRat = true;
          break;
        }
      }
      var fpx = px[0], fpy = px[1], falign = align;
      if (overlap && !overlapDiffRat) continue; // 同制式重叠跳过
      if (overlapDiffRat) fpy += 18; // 不同制式下移 18px 错开
      var tw2 = ctx.measureText(nm).width;
      // 错开后重新计算包围盒
      if (overlapDiffRat) {
        var fbx2 = falign === 'left' ? fpx : (falign === 'right' ? fpx - tw2 : fpx - tw2 / 2);
        placed.push([fbx2, fpy - 8, tw2, 16, L.rat]);
      } else {
        var fbx = falign === 'left' ? fpx : (falign === 'right' ? fpx - tw2 : fpx - tw2 / 2);
        placed.push([fbx, fpy - 8, tw2, 16, L.rat]);
      }
      ctx.textAlign = falign;
      // 4G 柔和红，5G 柔和蓝
      var is5g = L.rat === '5G';
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = 'rgba(255,255,255,.95)';
      ctx.lineJoin = 'round';
      ctx.strokeText(nm, fpx, fpy);
      ctx.fillStyle = is5g ? '#2471a3' : '#b03a2e';
      ctx.fillText(nm, fpx, fpy);
      drawn++;
    }
  }
}
var _labelTimer = null;
function scheduleLabels() {
  if (_labelTimer) clearTimeout(_labelTimer);
  _labelTimer = setTimeout(drawLabels, 200);
}
/* 注记下拉：4G/5G/场景多选，单击切换 */
function initLabelDropdown() {
  var box = document.getElementById('labelBox');
  var btn = document.getElementById('btnLabel');
  if (!box || !btn) return;
  function syncBtn() {
    var on = LABEL_4G || LABEL_5G || LABEL_SCENE;
    btn.classList.toggle('on', on);
  }
  function close() {
    box.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  }
  btn.onclick = function (e) {
    e.stopPropagation();
    var open = box.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  Array.prototype.forEach.call(box.querySelectorAll('.dsel-pop button'), function (b) {
    b.onclick = function (e) {
      e.stopPropagation();
      var v = b.getAttribute('data-v');
      if (v === '4g') LABEL_4G = !LABEL_4G;
      else if (v === '5g') LABEL_5G = !LABEL_5G;
      else if (v === 'scene') LABEL_SCENE = !LABEL_SCENE;
      b.classList.toggle('on',
        (v === '4g' && LABEL_4G) || (v === '5g' && LABEL_5G) || (v === 'scene' && LABEL_SCENE));
      syncBtn();
      drawLabels();
    };
    b.ondblclick = function (e) {
      e.stopPropagation();
      var v = b.getAttribute('data-v');
      if (v === '4g') LABEL_4G = false;
      else if (v === '5g') LABEL_5G = false;
      else if (v === 'scene') LABEL_SCENE = false;
      b.classList.remove('on');
      syncBtn();
      drawLabels();
    };
  });
  document.addEventListener('click', function () {
    if (box.classList.contains('open')) close();
  });
  if (map) {
    map.on('moveend', scheduleLabels);
    map.on('movestart', function () {
      if (!LABEL_4G && !LABEL_5G && !LABEL_SCENE) return;
      var cv = document.getElementById('labelCanvas');
      if (cv) cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
      if (typeof _labelTimer !== 'undefined' && _labelTimer) clearTimeout(_labelTimer);
    });
  }
}
/* 兼容旧调用 */
function bindLabelToggle() { initLabelDropdown(); }
