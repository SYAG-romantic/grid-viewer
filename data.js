/* ==========================================================================
   图层查看
   依赖：OpenLayers 10（底图/交互）、SheetJS（可选，读 xlsx）
   设计：所有要素用自绘 Canvas 叠加层渲染，支持百万级点
   ========================================================================== */
'use strict';
var global = (typeof window !== 'undefined') ? window : globalThis; /* 全局垫片（原 IIFE 参数） */

/* ============================ 1. 常量 ============================ */

var BANDS = [
  { max: -110,     rgb: [255, 0, 0],    label: '(-150 到 -110]' },
  { max: -100,     rgb: [247, 165, 24], label: '(-110 到 -100]' },
  { max: -90,      rgb: [237, 240, 56], label: '(-100 到 -90]' },
  { max: -80,      rgb: [79, 243, 128], label: '(-90 到 -80]' },
  { max: -40,      rgb: [12, 172, 15],  label: '(-80 到 -40]' },
  { max: Infinity, rgb: [0, 42, 255],   label: '(-40 到 0]' }
];
var BAND_FILL = BANDS.map(function (b) { return 'rgb(' + b.rgb.join(',') + ')'; });

/* SINR 七档 / MR 覆盖率五档：档位与配色来自用户提供的图例截图（2026-10-15）。
   SINR 单位 dB、右闭区间，超出 (-50,50] 的值按最近端档归并；
   覆盖率单位 %、左闭右开区间，100 归最后一档（计算值 >100 时同样归末档） */
var SINR_BANDS = [
  { rgb: [255, 0, 0],    label: '(-50,-3]' },
  { rgb: [255, 165, 0],  label: '(-3,0]' },
  { rgb: [255, 255, 0],  label: '(0,3]' },
  { rgb: [0, 255, 255],  label: '(3,6]' },
  { rgb: [0, 0, 255],    label: '(6,9]' },
  { rgb: [0, 255, 0],    label: '(9,15]' },
  { rgb: [0, 128, 0],    label: '(15,50]' }
];
var COV_BANDS = [
  { rgb: [255, 0, 0],   label: '[0,70)' },
  { rgb: [255, 165, 0], label: '[70,80)' },
  { rgb: [255, 255, 0], label: '[80,90)' },
  { rgb: [0, 255, 0],   label: '[90,95)' },
  { rgb: [0, 128, 0],   label: '[95,100]' }
];
var SINR_FILL = SINR_BANDS.map(function (b) { return 'rgb(' + b.rgb.join(',') + ')'; });
var COV_FILL = COV_BANDS.map(function (b) { return 'rgb(' + b.rgb.join(',') + ')'; });
/* 栅格着色模式：rsrp（默认）/ sinr / cov（MR 覆盖率） */
var GRID_MODES = {
  rsrp: { bands: BANDS, fill: BAND_FILL },
  sinr: { bands: SINR_BANDS, fill: SINR_FILL },
  cov: { bands: COV_BANDS, fill: COV_FILL }
};
/* 栅格绘制不透明度：0.9 = 轻微透明（用户参考截图定的效果）——
   颜色基本与图例一致，只隐约透出底图。曾试过 1.0（完全实心）和 0.7（太透、色差明显） */
var GRID_ALPHA = 0.9;

var SITE_PALETTE = [
  [56, 132, 255], [255, 138, 0], [0, 200, 150], [220, 70, 160],
  [250, 210, 60], [140, 110, 255], [0, 190, 220], [255, 90, 90],
  [130, 200, 60], [180, 180, 190], [90, 220, 255], [240, 130, 220]
];
/* 点数超过此数的图层做缩放到范围时跳过动画（动画本身已用快速圆点，不卡；跳过纯为更快定位） */
var SITE_FAST_LIMIT = 60000;
/* 静止时画全扇区的上限：超过此数只画圆点。这个密度下扇区互相重叠成一坨，
   圆点反而更清楚，且能避开巨型 path fill 导致的数秒卡顿 */
var SITE_SECTOR_LIMIT = 8000;

var R_EARTH = 6378137;
var DEG = Math.PI / 180;

/* 字段别名表（小写比对） */
var ALIAS = {
  lon:   ['jingdu', 'lon', 'lng', 'longi', 'longitude', '经度', 'x', 'jd', '经度(x)', '经度x',
          '经纬'],   /* 「经纬」是某批工参的经度列名笔误 */
  lat:   ['weidu', 'lat', 'lati', 'latitude', '纬度', 'y', 'wd', '纬度(y)', '纬度y'],
  az:    ['azimuth', '方位角', '方向角', 'az', '天线方位角', '方位角(度)', 'angle'],
  name:  ['小区名', '小区名称', 'cellname', 'cell_name', '小区', '扇区', 'cell',
          'cellid', 'name', 'cgi', 'eci', 'ecgi'],
  band:  ['频段', 'band', '频点', '工作频段', '中心频率', '频率', 'freq', '频段信息'],
  tilt:  ['下倾角', 'downtilt', '电下倾', '机械下倾', '倾角', 'tilt'],
  hgt:   ['挂高', '天线挂高', 'height', '天线高度', 'altitude'],
  stype: ['基站类型', '站型'],   /* 宏站 / 室分 / 室外微站 等 */
  rsrp:  ['rsrpmean', 'rsrp', 'rsrp均值', '平均rsrp', 'rsrp(dbm)'],
  sinr:  ['sinrmean', 'sinr', 'sinr均值', '平均sinr', 'sinr(db)'],
  cnt:   ['mrcnt', '采样数', '采样点数', '样本数', 'count'],
  cnt105: ['mrcnt_105', 'mrcnt105', 'rsrp≥-105采样数', 'rsrp>=-105采样数'],
  cnt110: ['mrcnt_110', 'mrcnt110', 'rsrp≥-110采样数', 'rsrp>=-110采样数']
};

/* ============================ 2. 坐标转换 ============================ */

var GCJ_A = 6378245.0, GCJ_EE = 0.00669342162296594323;

function outOfChina(lon, lat) {
  return !(lon > 73.66 && lon < 135.05 && lat > 3.86 && lat < 53.55);
}
function gcjTLat(x, y) {
  var r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  r += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
  r += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
  return r;
}
function gcjTLon(x, y) {
  var r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  r += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
  r += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
  return r;
}
function wgs84ToGcj02(lon, lat) {
  if (outOfChina(lon, lat)) return [lon, lat];
  var dLat = gcjTLat(lon - 105, lat - 35);
  var dLon = gcjTLon(lon - 105, lat - 35);
  var radLat = lat * DEG;
  var magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  var sq = Math.sqrt(magic);
  dLat = (dLat * 180) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sq) * Math.PI);
  dLon = (dLon * 180) / (GCJ_A / sq * Math.cos(radLat) * Math.PI);
  return [lon + dLon, lat + dLat];
}
function gcj02ToWgs84(lon, lat) {
  if (outOfChina(lon, lat)) return [lon, lat];
  var wLon = lon, wLat = lat;
  for (var i = 0; i < 3; i++) {
    var g = wgs84ToGcj02(wLon, wLat);
    wLon += lon - g[0];
    wLat += lat - g[1];
  }
  return [wLon, wLat];
}
function lonToMercX(lon) { return lon * R_EARTH * DEG; }
function latToMercY(lat) {
  var s = Math.sin(lat * DEG);
  if (s > 0.999999) s = 0.999999;
  if (s < -0.999999) s = -0.999999;
  return R_EARTH * 0.5 * Math.log((1 + s) / (1 - s));
}
function mercXToLon(x) { return x / (R_EARTH * DEG); }
function mercYToLat(y) { return (2 * Math.atan(Math.exp(y / R_EARTH)) - Math.PI / 2) / DEG; }

/* ============================ 3. 快速数值扫描 ============================ */

function scanFloat(s, i0, end) {
  var i = i0, c, neg = false;
  if (i < end) {
    c = s.charCodeAt(i);
    if (c === 45) { neg = true; i++; } else if (c === 43) { i++; }
  }
  var v = 0, digits = 0;
  while (i < end) {
    c = s.charCodeAt(i) - 48;
    if (c < 0 || c > 9) break;
    v = v * 10 + c; i++; digits++;
  }
  if (i < end && s.charCodeAt(i) === 46) {
    i++;
    var f = 0, d = 1;
    while (i < end) {
      c = s.charCodeAt(i) - 48;
      if (c < 0 || c > 9) break;
      f = f * 10 + c; d *= 10; i++; digits++;
    }
    v += f / d;
  }
  if (i < end) {
    c = s.charCodeAt(i);
    if (c === 101 || c === 69) {
      var pe = parseFloat(s.slice(i0, end));
      return isNaN(pe) ? NaN : pe;
    }
  }
  if (digits === 0) {
    var t = s.slice(i0, end).replace(/[\s\r]+$/, '');
    if (t === '') return NaN;
    var pt = parseFloat(t);
    return isNaN(pt) ? NaN : pt;
  }
  return neg ? -v : v;
}

function splitRow(s, delim) {
  var d = delim || ',';
  var out = [], cur = '', i = 0, len = s.length, inQ = false;
  while (i < len) {
    var c = s.charAt(i);
    if (inQ) {
      if (c === '"') {
        if (s.charAt(i + 1) === '"') { cur += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      cur += c; i++;
    } else {
      if (c === '"') { inQ = true; i++; continue; }
      if (c === d) { out.push(cur); cur = ''; i++; continue; }
      cur += c; i++;
    }
  }
  out.push(cur);
  return out;
}

function detectDelim(line) {
  var best = ',', bestN = -1, cands = [',', '\t', ';'];
  for (var i = 0; i < cands.length; i++) {
    var n = line.split(cands[i]).length - 1;
    if (n > bestN) { bestN = n; best = cands[i]; }
  }
  if (bestN <= 0) return null;
  return best;
}

/* ============================ 4. 分块文本存储 ============================ */

function ChunkStore() { this.parts = []; this.bases = []; this.total = 0; }
ChunkStore.prototype.push = function (s) {
  this.bases.push(this.total); this.parts.push(s); this.total += s.length;
};
ChunkStore.prototype.at = function (pos) {
  var lo = 0, hi = this.bases.length - 1;
  while (lo < hi) {
    var mid = (lo + hi + 1) >> 1;
    if (this.bases[mid] <= pos) lo = mid; else hi = mid - 1;
  }
  return lo;
};
ChunkStore.prototype.range = function (a, b) {
  if (b <= a || a >= this.total) return '';
  if (b > this.total) b = this.total;
  var i = this.at(a), j = this.at(b - 1);
  if (i === j) return this.parts[i].slice(a - this.bases[i], b - this.bases[i]);
  var out = this.parts[i].slice(a - this.bases[i]);
  for (var k = i + 1; k < j; k++) out += this.parts[k];
  out += this.parts[j].slice(0, b - this.bases[j]);
  return out;
};

/* ============================ 5. 数据表 ============================ */

function Dataset(name) {
  this.name = name;
  this.columns = [];
  this.rows = [];
  this.n = 0;
  this.num = {};          // 列名 -> Float64Array
  this.numeric = [];      // bool
  this.lineOff = null;    // Uint32Array(n+1)
  this.store = null;
  this.delim = ',';
  this.cities = [];
  this.cityIdx = null;    // Int16Array
  this.extra = {};        // xlsx 单元格原文
}
Dataset.prototype.lineText = function (i) {
  var a = this.lineOff[i], b = this.lineOff[i + 1];
  return this.store.range(a, b).replace(/[\r\n]+$/, '');
};
Dataset.prototype.cells = function (i) {
  if (this.extra && this.extra[i]) return this.extra[i];
  return splitRow(this.lineText(i), this.delim);
};
Dataset.prototype.value = function (i, col) {
  var arr = this.num[col];
  if (arr) return arr[i];
  var c = this.columns.indexOf(col);
  var cells = this.cells(i);
  return c >= 0 && c < cells.length ? cells[c] : '';
};

/* 快速提取某一文本列整列（带缓存）。
   比逐行 value() 快约一个量级：只做 c+1 次 indexOf 扫描定位字段边界，
   不为每行构造全部 31 个字符串。工参的「频段」等文本列分色时用它，
   避免 15 万行逐行 splitRow 卡死 */
Dataset.prototype.columnText = function (col) {
  var c = this.columns.indexOf(col);
  if (c < 0) return null;
  if (!this._colCache) this._colCache = {};
  if (this._colCache[col]) return this._colCache[col];
  var out = new Array(this.n);
  var delim = this.delim, len, p, fi, k, start, end, s;
  for (var i = 0; i < this.n; i++) {
    s = this.store.range(this.lineOff[i], this.lineOff[i + 1]);
    len = s.length;
    p = 0;
    for (fi = 0; fi < c; fi++) {
      k = s.indexOf(delim, p);
      if (k < 0) { p = len; break; }
      p = k + 1;
    }
    start = p;
    end = s.indexOf(delim, p);
    if (end < 0) end = len;
    out[i] = s.slice(start, end).replace(/[\r\n]+$/, '').replace(/^"|"$/g, '').trim();
  }
  this._colCache[col] = out;
  return out;
};

/* ---- 建表：CSV/TXT 分块流式解析 ---- */
async function parseDelimited(src, name, onProgress) {
  var CHUNK = 4 << 20;
  var ds = new Dataset(name);

  /* --- 阶段 A：表头 + 样本，判断编码 / 分隔符 / 列类型 --- */
  var headLen = Math.min(src.size, 512 * 1024);
  var headBuf = await src.read(0, headLen);
  /* read() 可能返回 ArrayBuffer（浏览器 file.slice().arrayBuffer()）或 Buffer，
     统一转成 Uint8Array 才能按下标取字节 */
  var headU8 = (headBuf instanceof Uint8Array) ? headBuf : new Uint8Array(headBuf);
  /* 探测前先把末尾可能被 512KB 截断的多字节字符剔掉：
     否则截断产生的 U+FFFD 会被误判成"不是 UTF-8"，整个文件按 GBK 解码导致全表乱码 */
  var probeLen = headU8.length;
  while (probeLen > 0 && (headU8[probeLen - 1] & 0xC0) === 0x80) probeLen--;  /* 回退过连续字节 */
  if (probeLen > 0 && (headU8[probeLen - 1] & 0xC0) === 0xC0) probeLen--;     /* 回退过前导字节 */
  var probe = new TextDecoder('utf-8').decode(headU8.subarray(0, probeLen));
  var dec;
  if (probe.indexOf('\uFFFD') >= 0) {
    try { dec = new TextDecoder('gbk'); } catch (e) { dec = new TextDecoder('utf-8'); }
  } else {
    dec = new TextDecoder('utf-8');
  }
  var headText = dec.decode(headU8).replace(/^\uFEFF/, '');
  var nl = headText.indexOf('\n');
  if (nl < 0) nl = headText.length;
  var headerLine = headText.slice(0, nl).replace(/\r$/, '');
  var delim = detectDelim(headerLine);
  if (delim === null) delim = ',';
  ds.delim = delim;
  var columns = splitRow(headerLine, delim).map(function (s) { return s.trim().replace(/^"|"$/g, ''); });
  var nCols = columns.length;
  ds.columns = columns;

  /* 站型列（宏站/室分）是文本列，不进数值数组。
     为免后续 buildSiteColors 对每行重切 CSV（O(n·行宽) 卡死 15 万行工参），
     这里在解析阶段直接把它存成字符串数组，之后 O(1) 读 */
  var stypeName = pickColumn(columns, ALIAS.stype);
  ds.stypeIdx = stypeName ? columns.indexOf(stypeName) : -1;
  ds.stype = ds.stypeIdx >= 0 ? [] : null;

  var sampleLines = headText.slice(nl + 1).split('\n').slice(0, 300)
    .filter(function (l) { return l.replace(/\r$/, '').length > 0; });

  var numeric = new Array(nCols);
  for (var c = 0; c < nCols; c++) {
    var ok = 0, tot = 0;
    for (var r = 0; r < sampleLines.length; r++) {
      var f = splitRow(sampleLines[r].replace(/\r$/, ''), delim);
      if (c >= f.length) continue;
      tot++;
      var g = f[c].trim();
      if (g !== '' && isFinite(Number(g))) ok++;
    }
    numeric[c] = tot > 0 && ok / tot >= 0.6;
  }
  ds.numeric = numeric;

  /* --- 阶段 B：全量流式解析 --- */
  var grow = numeric.map(function (isN) {
    return isN ? { buf: new Float64Array(1024), len: 0 } : null;
  });
  var lineOffGrow = { buf: new Uint32Array(1025), len: 0 };

  var store = new ChunkStore();
  ds.store = store;
  var rowCount = 0;
  var headerDone = false;
  var lineStartGlobal = 0;
  var delimCharCode = delim.charCodeAt(0);
  var avgLine = Math.max(24, headerLine.length + 16);
  var totalChars = 0;
  var safeCap = 0;

  /* 保证 lineOff 与数值数组都能容纳 len+extra 行；上层按块批量预留在前，此处通常只是一次比较 */
  function ensureCap(extra) {
    var need = lineOffGrow.len + extra;
    if (need <= safeCap) return;
    var cap = safeCap;
    while (cap < need) cap = cap < 1024 ? 1024 : cap * 2;
    var nb = new Uint32Array(cap + 1);
    nb.set(lineOffGrow.buf.subarray(0, lineOffGrow.len));
    lineOffGrow.buf = nb;
    for (var i = 0; i < nCols; i++) {
      var g = grow[i];
      if (!g) continue;
      var nb2 = new Float64Array(cap);
      nb2.set(g.buf.subarray(0, lineOffGrow.len));
      g.buf = nb2;
    }
    safeCap = cap;
  }

  function emit(s, a, b, hasQ) {
    var rowLen = b - a;
    if (!headerDone) { headerDone = true; lineStartGlobal += rowLen; return; }
    ensureCap(1);
    lineOffGrow.buf[lineOffGrow.len++] = lineStartGlobal;
    var n = rowCount;
    var i = a, fi = 0, g;
    var sIdx = ds.stypeIdx;
    while (fi < nCols) {
      if (i > b) {
        for (; fi < nCols; fi++) { g = grow[fi]; if (g) g.buf[n] = NaN; else if (fi === sIdx) ds.stype[n] = ''; }
        break;
      }
      if (!hasQ || s.charCodeAt(i) !== 34) {
        var k = s.indexOf(delim, i);
        if (k === -1 || k > b) k = b;
        g = grow[fi];
        if (g) g.buf[n] = scanFloat(s, i, k);
        else if (fi === sIdx) ds.stype[n] = s.slice(i, k).trim();
        i = k + 1;
      } else {
        var j = i + 1;
        while (j < b) {
          if (s.charCodeAt(j) === 34) {
            if (s.charCodeAt(j + 1) === 34) { j += 2; continue; }
            break;
          }
          j++;
        }
        g = grow[fi];
        if (g) {
          var raw = s.slice(i + 1, j).replace(/\s+$/, '');
          g.buf[n] = raw === '' ? NaN : Number(raw);
        } else if (fi === sIdx) ds.stype[n] = s.slice(i + 1, j);
        j++;
        if (s.charCodeAt(j) === delimCharCode) j++;
        i = j;
      }
      fi++;
    }
    rowCount++;
    lineStartGlobal += rowLen;
  }

  var offset = 0;
  while (offset < src.size) {
    var end = Math.min(offset + CHUNK, src.size);
    var ab = await src.read(offset, end);
    var s = dec.decode(ab, { stream: end < src.size });
    var gb = store.total;
    store.push(s);
    totalChars += s.length;
    ensureCap(Math.ceil(s.length / avgLine) + 8);

    var hasQ = s.indexOf('"') !== -1;
    var localStart = 0, k2;
    while ((k2 = s.indexOf('\n', localStart)) !== -1) {
      if (lineStartGlobal >= gb) {
        emit(s, localStart, k2, hasQ);
      } else {
        var tx = store.range(lineStartGlobal, gb + k2);
        emit(tx, 0, tx.length, tx.indexOf('"') !== -1);
      }
      lineStartGlobal = gb + k2 + 1;
      localStart = k2 + 1;
    }
    avgLine = Math.max(16, Math.round(totalChars / Math.max(1, rowCount + 1)));
    offset = end;
    if (onProgress) onProgress(end / src.size, rowCount);
  }
  if (lineStartGlobal < store.total) {
    var tail = store.range(lineStartGlobal, store.total);
    if (tail.replace(/[\r\n\s]+/g, '') !== '') {
      emit(tail, 0, tail.length, tail.indexOf('"') !== -1);
    }
  }
  ensureCap(1);
  lineOffGrow.buf[lineOffGrow.len++] = lineStartGlobal;

  ds.n = rowCount;
  ds.lineOff = lineOffGrow.buf.subarray(0, rowCount + 1);
  for (var ci = 0; ci < nCols; ci++) {
    if (grow[ci]) ds.num[columns[ci]] = grow[ci].buf.subarray(0, rowCount);
  }
  return ds;
}

/* ---- 建表：xlsx ---- */
function parseXlsx(file, name) {
  return new Promise(function (resolve, reject) {
    if (typeof XLSX === 'undefined') {
      reject(new Error('SheetJS 未加载成功，无法读取 xlsx。请改用 CSV 导出。'));
      return;
    }
    var fr = new FileReader();
    fr.onerror = function () { reject(new Error('文件读取失败')); };
    fr.onload = function () {
      try {
        var wb = XLSX.read(new Uint8Array(fr.result), { type: 'array' });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
        if (!aoa.length) { reject(new Error('工作表为空')); return; }
        var columns = aoa[0].map(function (v) { return String(v).trim(); });
        var nCols = columns.length;
        var data = aoa.slice(1).filter(function (r) {
          return r.some(function (v) { return v !== '' && v !== null && v !== undefined; });
        });
        var ds = new Dataset(name);
        ds.columns = columns;
        ds.n = data.length;
        var numeric = new Array(nCols);
        var grow = new Array(nCols);
        for (var c = 0; c < nCols; c++) {
          var ok = 0, tot = 0;
          for (var r = 0; r < Math.min(data.length, 300); r++) {
            var v = data[r][c];
            if (v === '' || v === null || v === undefined) continue;
            tot++;
            if (isFinite(Number(v))) ok++;
          }
          var isN = tot > 0 && ok / tot >= 0.6;
          numeric[c] = isN;
          grow[c] = isN ? new Float64Array(ds.n) : null;
        }
        for (var r2 = 0; r2 < ds.n; r2++) {
          for (var c2 = 0; c2 < nCols; c2++) {
            if (grow[c2]) {
              var v2 = data[r2][c2];
              grow[c2][r2] = (v2 === '' || v2 === null || v2 === undefined) ? NaN : Number(v2);
            }
          }
        }
        ds.numeric = numeric;
        for (var c3 = 0; c3 < nCols; c3++) {
          if (grow[c3]) ds.num[columns[c3]] = grow[c3];
        }
        ds.extra = {};
        for (var r3 = 0; r3 < ds.n; r3++) {
          ds.extra[r3] = data[r3].map(function (v) {
            return v === null || v === undefined ? '' : String(v);
          });
        }
        /* 站型列（与 parseDelimited 一致）：室分识别依赖它 */
        var stypeNameX = pickColumn(columns, ALIAS.stype);
        var stypeIdxX = stypeNameX ? columns.indexOf(stypeNameX) : -1;
        ds.stypeIdx = stypeIdxX;
        ds.stype = null;
        if (stypeIdxX >= 0) {
          ds.stype = new Array(ds.n);
          for (var r4 = 0; r4 < ds.n; r4++) {
            var sv = data[r4][stypeIdxX];
            ds.stype[r4] = (sv === null || sv === undefined) ? '' : String(sv).trim();
          }
        }
        resolve(ds);
      } catch (e) { reject(e); }
    };
    fr.readAsArrayBuffer(file);
  });
}

/* ---- 类型判别 / 字段识别 ---- */
function pickColumn(columns, keys) {
  var low = columns.map(function (c) { return String(c).trim().toLowerCase(); });
  // 按 key 优先级：每个 key 先精确再模糊，避免低优先级精确抢占高优先级模糊
  for (var i = 0; i < keys.length; i++) {
    for (var j = 0; j < low.length; j++) {
      if (low[j] === keys[i]) return columns[j];
    }
    for (var j2 = 0; j2 < low.length; j2++) {
      if (low[j2].indexOf(keys[i]) >= 0) return columns[j2];
    }
  }
  return null;
}

/* 从文件名/列名判断制式：'5G' | '4G' | null。
   弱覆盖门限分制式：5G = -105，4G = -110，对应 cnt105Col / cnt110Col */
function detectRat(ds) {
  var name = String(ds.name || '').toLowerCase();
  var cols = ds.columns.map(function (c) { return String(c).toLowerCase(); }).join(' ');
  var hay = name + ' ' + cols;
  if (hay.indexOf('5g') >= 0 || hay.indexOf('5 g') >= 0) return '5G';
  if (hay.indexOf('4g') >= 0 || hay.indexOf('4 g') >= 0) return '4G';
  return null;
}

function classifyLayer(name, columns) {
  var lowName = String(name).toLowerCase();
  var colNames = columns.map(function (c) { return String(c).toLowerCase(); });
  var hasAz = !!pickColumn(columns, ALIAS.az);
  var hasRsrp = !!pickColumn(columns, ALIAS.rsrp);
  var hasLonLat = !!pickColumn(columns, ALIAS.lon) && !!pickColumn(columns, ALIAS.lat);

  if (/工参|小区|基站|site|cell/.test(lowName) && hasLonLat) return 'site';
  if (/栅格|众测|grid|rsrp/.test(lowName)) return 'grid';
  if (hasRsrp) return 'grid';
  if (hasAz) return 'site';
  if (hasLonLat) return 'site';
  return 'unknown';
}

/* ============================ 6. 图层 ============================ */

var layers = [];
var layerSeq = 1;
var selected = null;

function makeLayer(ds, kind, skipCity) {
  var L = {
    id: 'L' + (layerSeq++),
    name: ds.name,
    kind: kind,
    ds: ds,
    visible: true,
    ok: true,
    mx: null, my: null,
    lonCol: null, latCol: null,
    buckets: null,
    total: 0,
    cntCol: null, cnt105Col: null, cnt110Col: null, rat: null,
    azCol: null, bandCol: null, tiltCol: null, hgtCol: null, stypeCol: null,
    citySel: '*',
    filters: [],
    projected: false,
    crsFix: null,
    colorGroups: null,
    error: null
  };

  L.lonCol = pickColumn(ds.columns, ALIAS.lon);
  L.latCol = pickColumn(ds.columns, ALIAS.lat);

  if (kind === 'grid') {
    L.rsrpCol = pickColumn(ds.columns, ALIAS.rsrp);
    L.sinrCol = pickColumn(ds.columns, ALIAS.sinr);
    L.cntCol = pickColumn(ds.columns, ALIAS.cnt);
    L.cnt105Col = pickColumn(ds.columns, ALIAS.cnt105);
    L.cnt110Col = pickColumn(ds.columns, ALIAS.cnt110);
    L.rat = detectRat(ds);            /* '5G' | '4G' | null，决定弱覆盖门限字段 */
  } else if (kind === 'site') {
    L.azCol = pickColumn(ds.columns, ALIAS.az);
    L.nameCol = pickColumn(ds.columns, ALIAS.name);
    /* 同步建精确匹配索引（加载多1-2秒，换搜索毫秒级） */
    if (L.nameCol && ds.str && ds.str[L.nameCol]) {
      try {
        var _arr2 = ds.str[L.nameCol], _n2 = ds.n;
        var _map = {}, _lc2 = new Array(_n2);
        for (var _j = 0; _j < _n2; _j++) {
          var _nm2 = String(_arr2[_j] || '').toLowerCase();
          _lc2[_j] = _nm2;
          if (_nm2) _map[_nm2] = _j;
        }
        L._nameMap = _map;
        L._lcNames = _lc2;
      } catch (e) {}
    }
    L.bandCol = pickColumn(ds.columns, ALIAS.band);
    L.tiltCol = pickColumn(ds.columns, ALIAS.tilt);
    L.hgtCol = pickColumn(ds.columns, ALIAS.hgt);
    L.stypeCol = pickColumn(ds.columns, ALIAS.stype);   /* 宏站 / 室分 / 微站 */
    L.rat = detectRat(ds);                             /* '5G' | '4G'，用于颜色区分 */
  }

  if (!L.lonCol || !L.latCol) {
    L.ok = false;
    L.error = '未识别到经纬度字段';
  } else if (kind === 'grid' && !L.rsrpCol) {
    L.ok = false;
    L.error = '未识别到 RSRP 字段';
  }

  // 城市编码（用于筛选）：数值列按原逻辑；文本列（如工参的"地市"）按字符串分组
  var cityCol = pickColumn(ds.columns, ['cityid', 'city', '城市', '地市', '行政区']);
  if (cityCol && !skipCity) {
    var arr = ds.num[cityCol];
    var map = {}, list = [];
    var idx = new Int16Array(ds.n);
    if (arr) {
      for (var i = 0; i < ds.n; i++) {
        var k = String(Math.round(arr[i]));
        var v = map[k];
        if (v === undefined) { v = list.length; map[k] = v; list.push(k); }
        idx[i] = v;
      }
      L.cities = list; L.cityIdx = idx; L.cityCol = cityCol;
    } else {
      /* 文本城市列：优先用缓存的 str，否则逐行 value() 提取 */
      var sarr = (ds.str && ds.str[cityCol]) ? ds.str[cityCol] : null;
      for (var si = 0; si < ds.n; si++) {

        var sk = sarr ? String(sarr[si] || '').trim() : String(ds.value(si, cityCol) || '').trim();
        if (!sk) { idx[si] = -1; continue; }
        var sv = map[sk];
        if (sv === undefined) { sv = list.length; map[sk] = sv; list.push(sk); }
        idx[si] = sv;
      }
      if (list.length) { L.cities = list; L.cityIdx = idx; L.cityCol = cityCol; }
    }
  }
  return L;
}

/* Worker 异步构建城市索引 */
async function buildCityIdxAsync(L) {
  var _w = getSiteWorker();
  var ds = L.ds;
  var cityCol = pickColumn(ds.columns, ['cityid', 'city', '城市', '地市', '行政区']);
  if (!cityCol) return;
  if (_w) {
    try {
      var numCols = {}, strCols = {};
      if (ds.num[cityCol]) numCols[cityCol] = ds.num[cityCol];
      if (ds.str && ds.str[cityCol]) strCols[cityCol] = ds.str[cityCol];
      var _res = await workerCall('cityIndex', {
        n: ds.n, columns: ds.columns,
        numCols: numCols, strCols: strCols, cityCol: cityCol
      });
      if (_res && !_res.error && _res.idx) {
        L.cities = _res.list; L.cityIdx = _res.idx; L.cityCol = cityCol;
        return;
      }
    } catch (e) { console.warn('Worker cityIndex 失败，回退主线程', e); }
  }
  /* 回退：主线程同步构建（与 makeLayer 一致，含文本列分支） */
  var arr = ds.num[cityCol];
  var map = {}, list = [];
  var idx = new Int16Array(ds.n);
  if (arr) {
    for (var i = 0; i < ds.n; i++) {
      var k = String(Math.round(arr[i]));
      var v = map[k];
      if (v === undefined) { v = list.length; map[k] = v; list.push(k); }
      idx[i] = v;
    }
    L.cities = list; L.cityIdx = idx; L.cityCol = cityCol;
  } else {
    var sarr = (ds.str && ds.str[cityCol]) ? ds.str[cityCol] : null;
    for (var si = 0; si < ds.n; si++) {
      var sk = sarr ? String(sarr[si] || '').trim() : String(ds.value(si, cityCol) || '').trim();
      if (!sk) { idx[si] = -1; continue; }
      var sv = map[sk];
      if (sv === undefined) { sv = list.length; map[sk] = sv; list.push(sk); }
      idx[si] = sv;
    }
    if (list.length) { L.cities = list; L.cityIdx = idx; L.cityCol = cityCol; }
  }
}

/* Worker 异步投影（栅格大数据量时避免阻塞） */
async function projectLayerAsync(L) {
  var _w = getSiteWorker();
  var ds = L.ds, n = ds.n;
  var lon = ds.num[L.lonCol], lat = ds.num[L.latCol];
  if (!lon || !lat) { L.ok = false; L.error = '经纬度列不是数值'; return; }
  /* 大数据量（>50万）才走 Worker，小数据量主线程更快 */
  if (_w && n > 500000) {
    try {
      var _res = await workerCall('projectGrid', {
        data: { lon: lon, lat: lat, n: n }
      });
      if (_res && !_res.error && _res.mx) {
        L.mx = _res.mx; L.my = _res.my;
        L.projectRaw = { lon: lon, lat: lat };
        L.projected = true;
        L.crsFix = false;
        if (L.kind === 'grid') detectGridStep(L);
        if (L.kind === 'site') buildSiteColors(L);
        return;
      }
    } catch (e) { console.warn('Worker projectGrid 失败，回退主线程', e); }
  }
  projectLayer(L);
}

function projectLayer(L) {
  var ds = L.ds, n = ds.n;
  var lon = ds.num[L.lonCol], lat = ds.num[L.latCol];
  if (!lon || !lat) { L.ok = false; L.error = '经纬度列不是数值'; return; }
  var fix = (STATE.crsMode === 1);
  var mx = new Float32Array(n), my = new Float32Array(n);
  for (var i = 0; i < n; i++) {
    var x = lon[i], y = lat[i];
    if (!isFinite(x) || !isFinite(y)) { mx[i] = NaN; my[i] = NaN; continue; }
    if (fix) { var p = gcj02ToWgs84(x, y); x = p[0]; y = p[1]; }
    mx[i] = lonToMercX(x);
    my[i] = latToMercY(y);
  }
  L.mx = mx; L.my = my;
  L.projectRaw = { lon: lon, lat: lat };
  L.projected = true;
  L.crsFix = fix;
  if (L.kind === 'grid') detectGridStep(L);
  if (L.kind === 'site') buildSiteColors(L);
}

/* 每度经度对应的墨卡托米数 */
var DEG2MERC = 111319.4908;
/* 每度纬度对应的地面米数（子午线） */
var DEG2GROUND = 111132.0;

/* 从坐标自动反推栅格步长（度），用于「锁死真实尺寸」绘制。
   做法：取开头一段连续点（行优先导出时必然覆盖整行），
   收集去重后的经纬度值，取相邻最小间隔即为步长。 */
function detectGridStep(L) {
  var ds = L.ds;
  var lon = ds.num[L.lonCol], lat = ds.num[L.latCol];
  var n = ds.n;
  var N = Math.min(n, 200000);
  var sl = {}, sa = {}, i, x, y;

  for (i = 0; i < N; i++) {
    x = lon[i]; y = lat[i];
    if (isFinite(x)) sl[x.toFixed(6)] = 1;
    if (isFinite(y)) sa[y.toFixed(6)] = 1;
  }
  function minGap(o) {
    var a = Object.keys(o);
    if (a.length < 2) return 0;
    a.sort(function (x, y) { return Number(x) - Number(y); });
    var m = Infinity, prev = Number(a[0]);
    for (var k = 1; k < a.length; k++) {
      var cur = Number(a[k]);
      var d = cur - prev;
      if (d > 1e-9 && d < m) m = d;
      prev = cur;
    }
    return isFinite(m) ? m : 0;
  }

  var dl = minGap(sl), da = minGap(sa);
  var okk = dl > 1e-7 && dl < 0.01 && da > 1e-7 && da < 0.01;
  if (!okk) { dl = 0.0002; da = 0.00018; }
  L.dLon = dl;
  L.dLat = da;
  L.stepDetected = okk;

  /* 均值纬度下的真实地面尺寸 */
  var s = 0, c = 0;
  for (i = 0; i < N; i += Math.max(1, Math.floor(N / 2000))) {
    y = lat[i];
    if (isFinite(y)) { s += y; c++; }
  }
  var latMean = c ? (s / c) : 40;
  L.stepLatM = da * DEG2GROUND;
  L.stepLonM = dl * DEG2MERC * Math.cos(latMean * Math.PI / 180);
  L.latMean = latMean;
}

function buildSiteColors(L) {
  var ds = L.ds, n = ds.n;
  var mode = STATE.siteColor;
  var groups = {}, order = [];
  var bandArr = L.bandCol ? ds.num[L.bandCol] : null;
  /* 文本频段列（如 4G 的「频段」= FDD900/F1）一次性提取整列，别逐行 value() */
  var bandTextArr = (L.bandCol && !bandArr) ? ds.columnText(L.bandCol) : null;
  var stypeArr = L.ds.stype;   /* 解析时已存成字符串数组，O(1) 读 */
  /* 按制式配色：4G 橙、5G 蓝，室分与同制式宏站同色（靠形状区分：圆 vs 扇区） */
  var ratColor = (L.rat === '5G') ? 'rgba(52,152,219,0.7)' : 'rgba(231,76,60,0.7)';
  function isIndoor(i) {
    if (!stypeArr) return false;
    var v = stypeArr[i];
    return typeof v === 'string' && /室分|室内/.test(v);
  }

  function keyOf(i) {
    if (isIndoor(i)) return 'indoor';            /* 室分独立分组（画圆用） */
    if (mode === 'rat') return 'rat';
    if (mode === 'one') return 0;
    if (mode === 'az') {
      var a = L.azCol ? ds.num[L.azCol][i] : NaN;
      if (!isFinite(a)) return SITE_PALETTE.length - 1;
      return Math.floor(((a % 360) + 360) % 360 / 45) % 8;
    }
    if (!L.bandCol) return 0;
    var v;
    if (bandArr) v = 'F' + Math.round(bandArr[i]);
    else v = String((bandTextArr && bandTextArr[i]) || '');
    var h = 0;
    for (var k = 0; k < v.length; k++) h = (h * 31 + v.charCodeAt(k)) >>> 0;
    /* 按制式偏移色板：4G 用冷色段(0~5)，5G 用暖色段(6~11)，避免 4G/5G 撞色 */
    var half = Math.floor(SITE_PALETTE.length / 2);
    var base = (L.rat === '5G') ? half : 0;
    return base + (h % half);
  }

  for (var i = 0; i < n; i++) {
    var key = keyOf(i);
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push(i);
  }
  order.sort(function (a, b) { return a - b; });
  L.colorGroups = order.map(function (k) {
    var col;
    if (k === 'indoor' || mode === 'rat') col = ratColor;      /* 室分/制式模式：同制式一色 */
    else if (mode === 'one') col = 'rgba(56,132,255,0.55)';
    else col = 'rgba(' + SITE_PALETTE[k % SITE_PALETTE.length].join(',') + ',0.55)';
    return {
      key: k,
      indoor: (k === 'indoor'),
      color: col,
      idx: new Uint32Array(groups[k])
    };
  });
  /* 室内行标记（点击时按圆处理，不按扇区角度） */
  try {
    var _indoor = new Uint8Array(n);
    for (var _gi = 0; _gi < L.colorGroups.length; _gi++) {
      if (L.colorGroups[_gi].indoor) {
        var _idx = L.colorGroups[_gi].idx;
        for (var _k = 0; _k < _idx.length; _k++) _indoor[_idx[_k]] = 1;
      }
    }
    L.isIndoor = _indoor;
  } catch (e) { L.isIndoor = null; }
  /* 站点 WebGL 实例缓冲异步重建（失败则 siteGlOk=false，走 Canvas 回退） */
  try {
    buildSiteGL(L).catch(function () { L.siteGlOk = false; });
  } catch (e) { L.siteGlOk = false; }
}

/* ---- 筛选 / 分档 ---- */
function bandOf(v) {
  if (!isFinite(v)) return -1;
  if (v <= -110) return 0;
  if (v <= -100) return 1;
  if (v <= -90) return 2;
  if (v <= -80) return 3;
  if (v <= -40) return 4;
  return 5;
}

function bandOfSINR(v) {
  if (!isFinite(v)) return -1;
  if (v <= -3) return 0;    /* 含 ≤-50 的极端差值，图例下限外的归最差档 */
  if (v <= 0) return 1;
  if (v <= 3) return 2;
  if (v <= 6) return 3;
  if (v <= 9) return 4;
  if (v <= 15) return 5;
  return 6;                 /* >50（含超上限）归最好档 */
}

function bandOfCov(p) {
  if (!isFinite(p)) return -1;
  if (p < 70) return 0;
  if (p < 80) return 1;
  if (p < 90) return 2;
  if (p < 95) return 3;
  return 4;
}

function bandCountOf(mode) {
  return mode === 'sinr' ? 7 : mode === 'cov' ? 5 : 6;
}
/* 单点覆盖率：与 rebuildBuckets 同口径（5G 用 MRCnt_105，4G/未知用 MRCnt_110） */
function gridCovValue(L, i) {
  var ds = L.ds;
  var all = L.cntCol && ds.num[L.cntCol] ? ds.num[L.cntCol][i] : NaN;
  var thrCol = (L.rat === '5G') ? L.cnt105Col : L.cnt110Col;
  var thr = thrCol && ds.num[thrCol] ? ds.num[thrCol][i] : NaN;
  return (all > 0 && isFinite(thr)) ? thr * 100 / all : NaN;
}
/* 图层当前着色模式的档位定义 / 色板 */
function gridBands(L) {
  return GRID_MODES[L && L.bandMode ? L.bandMode : 'rsrp'].bands;
}
function gridFill(L) {
  return GRID_MODES[L && L.bandMode ? L.bandMode : 'rsrp'].fill;
}

function matchConds(L, i) {
  for (var f = 0; f < L.filters.length; f++) {
    var ft = L.filters[f];
    if (ft.colIdx === undefined) {
      ft.colIdx = L.ds.columns.indexOf(ft.field);
      ft.isNum = !!L.ds.num[ft.field];
    }
    var v;
    if (ft.isNum) v = L.ds.num[ft.field][i];
    else v = ft.colIdx >= 0 ? L.ds.cells(i)[ft.colIdx] : '';
    if (ft.op === 'between') {
      var nv = Number(v);
      if (!isFinite(nv)) return false;
      if (ft.v1 !== null && nv < ft.v1) return false;
      if (ft.v2 !== null && nv > ft.v2) return false;
    } else if (ft.op === 'eq') {
      if (String(v) !== ft.s) return false;
    } else if (ft.op === 'ne') {
      if (String(v) === ft.s) return false;
    } else if (ft.op === 'gt') {
      if (!(Number(v) > ft.v1)) return false;
    } else if (ft.op === 'lt') {
      if (!(Number(v) < ft.v1)) return false;
    } else if (ft.op === 'contains') {
      if (String(v).indexOf(ft.s) < 0) return false;
    }
  }
  return true;
}

function rebuildBuckets(L, skipGL) {
  var ds = L.ds, n = ds.n;
  var rsrp = ds.num[L.rsrpCol];
  var cityOk = (L.citySel !== '*' && L.cityIdx);
  var cityWant = cityOk ? parseInt(L.citySel, 10) : -1;

  /* 着色模式：全局选择，字段缺失的图层自动回退 RSRP */
  var mode = STATE.gridColorMode;
  var sinr = (mode === 'sinr') ? ds.num[L.sinrCol] : null;
  var cntAll = (mode === 'cov') ? ds.num[L.cntCol] : null;
  /* 覆盖率门限分制式：5G 用 cnt105，4G/未知用 cnt110 */
  var cntThr = (mode === 'cov') ? ds.num[(L.rat === '5G' ? L.cnt105Col : L.cnt110Col)] : null;
  if (mode === 'sinr' && !sinr) mode = 'rsrp';
  if (mode === 'cov' && (!cntAll || !cntThr)) mode = 'rsrp';
  L.bandMode = mode;
  L.bandCount = bandCountOf(mode);
  var bfn = mode === 'sinr' ? bandOfSINR : (mode === 'cov' ? bandOfCov : bandOf);
  var nb = L.bandCount;

  var counts = [], pos = [], bi;
  for (bi = 0; bi < nb; bi++) { counts.push(0); pos.push(0); }
  var sel = [];
  var i;
  var hasFilter = L.filters.length > 0;
  var bbuf = new Int8Array(n);   /* 每行档位缓存，避免第二遍重算 */

  for (i = 0; i < n; i++) {
    if (cityOk && L.cityIdx[i] !== cityWant) continue;
    if (hasFilter && !matchConds(L, i)) continue;
    var v;
    if (mode === 'sinr') v = sinr[i];
    else if (mode === 'cov') v = cntAll[i] > 0 ? cntThr[i] * 100 / cntAll[i] : NaN;
    else v = rsrp ? rsrp[i] : NaN;
    var b = bfn(v);
    bbuf[i] = b;
    if (b < 0) continue;
    sel.push(i);
    counts[b]++;
  }
  var bufs = [];
  for (var b2 = 0; b2 < nb; b2++) bufs.push(new Uint32Array(counts[b2]));
  for (var k = 0; k < sel.length; k++) {
    var b3 = bbuf[sel[k]];
    bufs[b3][pos[b3]++] = sel[k];
  }
  L.buckets = bufs;
  L.counts = counts;
  L.total = sel.length;
  /* 栅格：构建 WebGL 实例缓冲（失败则保持 L.glOk=false，走 Canvas 回退） */
  if (L.kind === 'grid' && !skipGL) { try { buildGridGL(L); } catch (e) { L.glOk = false; } }
}

/* ---- 图层包围盒 ---- */
function layerBox(L) {
  if (!L.mx) return null;
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  var n = L.ds.n;
  for (var i = 0; i < n; i++) {
    var x = L.mx[i], y = L.my[i];
    if (!isFinite(x) || !isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (minX > maxX) return null;
  return [minX, minY, maxX, maxY];
}

/* ============================ 7. 状态 ============================ */

var STATE = {
  tk: '',
  sub: 'random',
  keys: [],
  base: 'img',
  crsMode: 0,             /* 默认不纠偏：实测众测数据本身即与天地图一致 */
  beamW: 65,
  siteR: 34,
  siteColor: 'rat',
  gridColorMode: 'rsrp',   /* 栅格着色：rsrp | sinr | cov（字段缺失的图层自动回退 rsrp） */
  cityFilter: '*',         /* 顶部城市按钮：'*'=全疆，或 CityID 字符串 */
  pin: null,
  fastDraw: false,
  navigating: false,          /* 缩放/平移动画中：只画快速圆点，停稳后再画全扇区 */
  tool: '',                /* '' | 'measure' | 'select' | 'poly' */
  measPts: [], measCursor: null, measDone: false, measKind: '',
  lastResult: '',
  selBox: null, selDrag: null, selStats: null,
  polyPts: [], polyCursor: null, polyDone: false,
  selCircle: null, selCircleDrag: null,
  coordPick: null,
  busy: false
};

/* ---- 密钥持久化 ---- */
function lsGet(k, d) {
  try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; }
}
function lsSet(k, v) {
  try { localStorage.setItem(k, v); } catch (e) { }
}
function loadKeys() {
  var arr = [];
  try { arr = JSON.parse(lsGet('tdt_keys', '[]')) || []; } catch (e) { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  arr = arr.filter(function (x) { return typeof x === 'string' && x.trim(); });
  var legacy = lsGet('tdt_tk', '');
  if (legacy && arr.indexOf(legacy) < 0) arr.push(legacy);
  STATE.keys = arr;
  var act = lsGet('tdt_tk_active', '');
  STATE.tk = (act && arr.indexOf(act) >= 0) ? act : (arr.length ? arr[0] : '');
  /* 子域固定随机：天地图 t0~t7 负载均衡，浏览器对单域名并发有限制，
     随机挑子域就是最优解；手动固定仅排障时有用，没必要常驻 */
  STATE.sub = 'random';
}
function persistKeys() {
  lsSet('tdt_keys', JSON.stringify(STATE.keys));
  lsSet('tdt_tk_active', STATE.tk);
}
/* 密钥掩码：前 8 位 + ***** */
function maskKey(k) {
  if (!k) return '';
  return (k.length > 8 ? k.slice(0, 8) : k.slice(0, 3)) + '*****';
}

