/* ==========================================================================
   图层查看
   依赖：OpenLayers 10（底图/交互）、SheetJS（可选，读 xlsx）
   设计：所有要素用自绘 Canvas 叠加层渲染，支持百万级点
   ========================================================================== */
(function (global) {
'use strict';

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
  name:  ['小区名', '小区名称', 'cellname', 'cell_name', 'name', '站名', '基站名称',
          'cgi', 'eci', 'ecgi', '小区', '扇区', 'cell', 'cellid', '基站名'],
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

function splitRow(s) {
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
      if (c === ',') { out.push(cur); cur = ''; i++; continue; }
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
  return splitRow(this.lineText(i));
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
  var columns = splitRow(headerLine).map(function (s) { return s.trim().replace(/^"|"$/g, ''); });
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
      var f = splitRow(sampleLines[r].replace(/\r$/, ''));
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
        resolve(ds);
      } catch (e) { reject(e); }
    };
    fr.readAsArrayBuffer(file);
  });
}

/* ---- 类型判别 / 字段识别 ---- */
function pickColumn(columns, keys) {
  var low = columns.map(function (c) { return String(c).trim().toLowerCase(); });
  for (var i = 0; i < keys.length; i++) {
    for (var j = 0; j < low.length; j++) {
      if (low[j] === keys[i]) return columns[j];
    }
  }
  for (var i2 = 0; i2 < keys.length; i2++) {
    for (var j2 = 0; j2 < low.length; j2++) {
      if (low[j2].indexOf(keys[i2]) >= 0) return columns[j2];
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
  /* 回退：主线程同步构建 */
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
    a.sort();
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
  var ratColor = (L.rat === '5G') ? 'rgba(56,132,255,0.6)' : 'rgba(255,138,0,0.6)';
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
    }
  }
  if (v && v !== '*') zoomToCity();
  else if (v === '*') zoomToAll();
  /* 选区还开着时重算统计（地市变了点数就变了） */
  if (currentSel()) applySelection();
  renderLegend();
  renderStat();
  scheduleDraw();
  saveViewState();
}

/* 缩放到指定地市：汇总所有可见图层在该地市的数据范围 */
function zoomToCity() {
  var v = STATE.cityFilter;
  if (!v || v === '*' || !map) return;
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
    if (!L.visible || !L.ok || !L.mx || !L.my || !L.cityIdx) continue;
    /* 全疆：不过滤城市，直接算全部点范围 */
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
  if (!found) return;
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
  if (cur) cur.textContent = common === '*' ? '新疆' : common === 'mixed' ? '多值'
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
  for (var i = 0; i < layers.length; i++) {
    var L = layers[i];
    if (L.kind === 'grid' && L.ok && L.buckets) rebuildBuckets(L);
  }
  /* 选区还开着时重算统计（档位分布要跟新指标走） */
  if (currentSel()) applySelection();
  renderLegend();
  renderStat();
  scheduleDraw();
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
  map.on('movestart', function () { STATE.navigating = true; });
  map.on('moveend', function () {
    STATE.navigating = false;
    clearTimeout(map._navT);
    map._navT = setTimeout(scheduleDraw, 250);
  });

  map.on('pointermove', function (evt) {
    var c = evt.coordinate;
    document.getElementById('cLon').textContent = mercXToLon(c[0]).toFixed(6);
    document.getElementById('cLat').textContent = mercYToLat(c[1]).toFixed(6);
    document.getElementById('cZoom').textContent = map.getView().getZoom().toFixed(2);
  });
  map.getView().on('change:resolution', function () {
    document.getElementById('cZoom').textContent = map.getView().getZoom().toFixed(2);
  });

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
      if (glDrawGrid(L, t, w, h, box, dpr)) glUsed = true;
      else drawGrid(ctx, L, t, w, h, box);
    }
    else if (L.kind === 'site') {
      if (!siteGlUsed && !glsClearFrame(w, h, dpr)) { drawSites(ctx, L, t, w, h, box); continue; }
      if (glDrawSites(L, t, w, h, box, dpr)) siteGlUsed = true;
      else drawSites(ctx, L, t, w, h, box);
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
        if (L.glPosBuf) {
          try { gl.deleteBuffer(L.glPosBuf); gl.deleteBuffer(L.glBandBuf); } catch (e) {}
          L.glPosBuf = null; L.glBandBuf = null;
        }
        var pb = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, pb);
        gl.bufferData(gl.ARRAY_BUFFER, _res.pos, gl.STATIC_DRAW);
        var bb = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, bb);
        gl.bufferData(gl.ARRAY_BUFFER, _res.bnd, gl.STATIC_DRAW);
        L.glPosBuf = pb; L.glBandBuf = bb;
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
var SITE_FAN_SEG = 10;   /* 扇形弧段数 */

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
  var R, dotR;
  if (_res > 0 && isFinite(_res)) {
    /* 分辨率校准：getResolution 返回值与设备像素比有关，乘 dpr 修正（用户实测约 1.6） */
    var _dpr2 = (isFinite(dpr) && dpr > 0) ? dpr : 1;
    R = 80 / _res * _dpr2;
    dotR = 30 / _res * _dpr2;
    /* 钳位：太小看不见，太大卡死 */
    if (R < 2) R = 2; if (R > 500) R = 500;
    if (dotR < 2) dotR = 2; if (dotR > 200) dotR = 200;
  } else {
    R = STATE.siteR; dotR = Math.max(4, R * 0.35);
  }
  var half = STATE.beamW * Math.PI / 180 * 0.5;

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

function glDrawGrid(L, t, w, h, box, dpr) {
  if (!L.glOk) return false;
  if (!glClearFrame(w, h, dpr)) return false;
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

function drawSites(c, L, t, w, h, box) {
  var t0 = t[0], t1 = t[1], t2 = t[2], t3 = t[3], t4 = t[4], t5 = t[5];
  var b0 = box[0], b1 = box[1], b2 = box[2], b3 = box[3];
  var scSel = (L.citySel !== undefined && L.citySel !== '*' && L.citySel !== 'none') ? parseInt(L.citySel, 10) : -1;
  var scIdx = (scSel >= 0 && L.cityIdx) ? L.cityIdx : null;
  /* 80米实地：t0 是 CSS 像素/米（Canvas 2D 用 CSS 像素） */
  var _scale = Math.abs(t0) || 0;
  var R = (_scale > 0) ? 80 * _scale : STATE.siteR;
  if (R < 2) R = 2; if (R > 200) R = 200;
  var half = STATE.beamW * DEG * 0.5;
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
  var Rpx = 80 / (res || 1) * _dpr3;   /* 与视觉 dpr 校准一致 */
  var half = (STATE.beamW || 65) * Math.PI / 360;
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
    if (indoor || !isFinite(az)) {
      /* 室分/无方位角：按圆处理，直接命中 */
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
  if (best.rows && best.rows.length > 1) showMultiSectorPopup(best.L, best.rows, pixel);
  else showPopup(best.L, best.i, pixel);
}

/* 多扇区重叠弹窗：列出所有命中的小区供查看 */
function showMultiSectorPopup(L, rows, pixel) {
  var ds = L.ds;
  var title = '重叠扇区（' + rows.length + ' 个）';
  var keyCols = [];
  var want = ['小区名', '方位角', '频段', '工作频段', 'PCI', 'CELLID', '基站名'];
  for (var ci = 0; ci < ds.columns.length; ci++) {
    var cn = ds.columns[ci] || '';
    for (var wi = 0; wi < want.length; wi++) {
      if (cn.indexOf(want[wi]) >= 0) { keyCols.push(ci); break; }
    }
    if (keyCols.length >= 6) break;
  }
  if (!keyCols.length) keyCols = [0, 1, 2].filter(function (c) { return c < ds.columns.length; });
  var html = '<table><tr>';
  for (var k = 0; k < keyCols.length; k++) html += '<th>' + ds.columns[keyCols[k]] + '</th>';
  html += '</tr>';
  for (var r = 0; r < rows.length; r++) {
    var cells = ds.cells(rows[r]);
    html += '<tr>';
    for (var k2 = 0; k2 < keyCols.length; k2++) {
      var v = cells[keyCols[k2]];
      html += '<td>' + (v === undefined ? '' : String(v)) + '</td>';
    }
    html += '</tr>';
  }
  html += '</table>';
  document.getElementById('popTitle').textContent = title;
  document.getElementById('popTable').innerHTML = html;
  var subEl = document.getElementById('popSub');
  if (subEl) subEl.textContent = L.name;
  var _pf = document.getElementById('popFoot'); if (_pf) _pf.innerHTML = '';
  var el = document.getElementById('popup');
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
function fmt(v, d) { return isFinite(v) ? Number(v).toFixed(d) : '-'; }
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

function renderStat() {
  var box = document.getElementById('statBox');
  if (!box) return;   /* 「统计」区块已从面板移除（顶栏指标下拉 + 选区统计覆盖此需求） */
  var L = selected;
  if (!L || L.kind !== 'grid' || !L.counts) {
    box.innerHTML = '<div class="empty">尚未加载栅格图层</div>';
    return;
  }
  var total = 0, i;
  var gm = GRID_MODES[L.bandMode ? L.bandMode : 'rsrp'];
  var nb = L.bandCount || gm.bands.length;
  for (i = 0; i < nb; i++) total += L.counts[i];
  var html = '<div style="font-size:11.5px;color:var(--fg2);margin-bottom:6px">图层：' +
    esc(L.name) + '</div>';
  html += '<table class="stat">';
  for (i = 0; i < nb; i++) {
    html += '<tr><td class="sw"><i style="background:' + gm.fill[i] + '"></i></td>' +
      '<td>' + gm.bands[i].label + '</td>' +
      '<td class="num">' + L.counts[i].toLocaleString() + '</td>' +
      '<td class="pct">' + (total ? (L.counts[i] * 100 / total).toFixed(2) : '0.00') + '%</td></tr>';
  }
  html += '<tr><td></td><td>合计</td><td class="num">' + total.toLocaleString() +
    '</td><td class="pct">100%</td></tr>';
  html += '</table>';
  box.innerHTML = html;
}

/* ============================ 12. 图层列表 UI ============================ */

function renderLayerList() {
  syncLegendFold();
  updateStepInfo(selected);
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
  syncLayerPanel();
  renderLegend();
  renderStat();
  renderFilterFields();
}

/* 小区搜索：按名称/CellID 模糊匹配，返回匹配列表 */
function searchCells(keyword) {
  var kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return [];
  var results = [];
  for (var li = 0; li < layers.length; li++) {
    var L = layers[li];
    if (!L.ok || L.kind !== 'site' || !L.nameCol) continue;
    var ds = L.ds, n = ds.n;
    var col = L.nameCol;
    var sarr = (ds.str && ds.str[col]) ? ds.str[col] : null;
    for (var i = 0; i < n && results.length < 100; i++) {
      var nm = sarr ? String(sarr[i] || '') : String(ds.value(i, col) || '');
      if (nm.toLowerCase().indexOf(kw) >= 0) {
        results.push({ L: L, i: i, name: nm });
      }
    }
  }
  return results;
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
  var rows = [];
  var header = null;
  for (var li = 0; li < layers.length; li++) {
    var L = layers[li];
    if (!L.ok || !L.visible || L.kind !== 'site') continue;
    var ds = L.ds;
    if (!header) header = ['图层'].concat(ds.columns);
    for (var i = 0; i < ds.n; i++) {
      var x = L.mx[i], y = L.my[i];
      if (!isFinite(x) || !isFinite(y)) continue;
      if (!pointInSel(x, y, sel)) continue;
      var cells = ds.cells(i);
      rows.push([L.name].concat(cells));
      if (rows.length >= 50000) break;
    }
    if (rows.length >= 50000) break;
  }
  if (!rows.length) { showErr('选区内没有小区'); return; }
  var csv = header.map(function (h) { return '"' + String(h).replace(/"/g, '""') + '"'; }).join(',') + '\n';
  for (var r = 0; r < rows.length; r++) {
    csv += rows[r].map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(',') + '\n';
  }
  var blob = new Blob(["\ufeff" + csv], { type: 'text/csv;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '框选小区_' + rows.length + '条.csv';
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  showErr('已导出 ' + rows.length + ' 条小区');
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
      el.style.width = ''; el.style.height = '';
      el.style.maxWidth = ''; el.style.maxHeight = '';
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
function bindCellSearch() {
  var input = document.getElementById('cellSearchInput');
  var btn = document.getElementById('cellSearchBtn');
  var box = document.getElementById('cellSearchResults');
  if (!input || !btn || !box) return;
  function doSearch() {
    var kw = input.value;
    var res = searchCells(kw);
    if (!res.length) {
      box.style.display = 'none';
      box.innerHTML = '';
      if (kw.trim()) showErr('未找到匹配的小区');
      return;
    }
    var html = '';
    for (var k = 0; k < res.length; k++) {
      var r = res[k];
      html += '<div class="cs-item" data-k="' + k + '" style="padding:7px 10px;cursor:pointer;border-bottom:1px solid var(--line);font-size:12.5px;">' +
        '<span style="color:var(--fg)">' + esc(r.name) + '</span>' +
        '<span style="color:var(--fg3);font-size:11px;margin-left:8px;">' + esc(r.L.name) + '</span></div>';
    }
    box.innerHTML = html;
    box.style.display = 'block';
    var items = box.querySelectorAll('.cs-item');
    for (var j = 0; j < items.length; j++) {
      (function (el) {
        el.onclick = function () {
          var r = res[parseInt(el.getAttribute('data-k'), 10)];
          if (!r) return;
          var x = r.L.mx[r.i], y = r.L.my[r.i];
          if (!isFinite(x) || !isFinite(y)) return;
          try {
            map.getView().animate({ center: [x, y], zoom: 16, duration: 400 });
          } catch (e) {}
          box.style.display = 'none';
        };
      })(items[j]);
    }
  }
  btn.onclick = doSearch;
  input.onkeydown = function (e) { if (e.key === 'Enter') doSearch(); };
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
    } catch (e) {}
    L.sitePosBuf = null; L.siteGlOk = false;
  }
  if (selected === L) selected = layers.length ? layers[layers.length - 1] : null;
  renderLayerList(); syncLayerPanel(); renderLegend(); renderStat(); renderFilterFields();
  /* 选区还开着时重算统计，避免引用已删图层的数据 */
  if (currentSel()) applySelection();
  saveViewState();
  refreshSessionCache();   /* 删层后同步缓存：全删空则清缓存 */
  scheduleDraw();
}

/* ---- 面板与当前图层联动 ---- */
function syncLayerPanel() {
  var L = selected;
  document.getElementById('curLayerName').textContent = L ? '　' + shortName(L.name) : '';
  var isSite = L && L.kind === 'site';
  document.getElementById('gridOpts').style.display = isSite ? 'none' : '';
  document.getElementById('siteOpts').style.display = isSite ? '' : 'none';

  var citySel = document.getElementById('citySel');
  if (citySel) {
    if (L && L.kind === 'grid' && L.cities && L.cities.length) {
      /* 顶部选了该图层没有的地市 → L.citySel='none'（显示为空），下拉里补个说明项 */
      var h = '<option value="*">全部地市</option>';
      if (L.citySel === 'none') h = '<option value="none" selected>（所选地市无数据）</option>' + h;
      for (var i = 0; i < L.cities.length; i++) {
        h += '<option value="' + i + '"' + (String(L.citySel) === String(i) ? ' selected' : '') + '>' +
          L.cities[i] + '</option>';
      }
      citySel.innerHTML = h;
      citySel.disabled = false;
    } else {
      citySel.innerHTML = '<option value="*">无城市字段</option>';
      citySel.disabled = true;
    }
  }
  var cityInfo = document.getElementById('cityInfo');
  if (cityInfo) {
    cityInfo.textContent = (L && L.kind === 'grid' && L.cities && L.cities.length)
      ? '共 ' + L.cities.length + ' 个' : '';
  }

  var condStr = L && L.filters.length ? '（' + L.filters.length + ' 条生效）' : '';
  var filterInfo = document.getElementById('filterInfo');
  if (filterInfo) filterInfo.textContent = condStr;
}

function renderConds() {
  var box = document.getElementById('conds');
  if (!box) return;   /* 按字段筛选区块已从面板移除，保留逻辑供旧状态兜底 */
  var L = selected;
  if (!L || !L.filters.length) {
    box.innerHTML = '<div style="font-size:11.5px;color:var(--fg3)">暂无筛选条件</div>';
    return;
  }
  var html = '';
  for (var i = 0; i < L.filters.length; i++) {
    var f = L.filters[i];
    var opTxt = { between: '区间', eq: '=', ne: '≠', gt: '>', lt: '<', contains: '包含' }[f.op];
    var val = f.op === 'between'
      ? ((f.v1 === null ? '' : f.v1) + ' ~ ' + (f.v2 === null ? '' : f.v2))
      : f.s;
    html += '<div class="cond"><span class="c1">' + esc(f.field) + '</span>' +
      '<span class="c2">' + opTxt + '</span><span class="c3">' + esc(val) + '</span>' +
      '<button data-i="' + i + '">×</button></div>';
  }
  box.innerHTML = html;
  Array.prototype.forEach.call(box.querySelectorAll('button'), function (b) {
    b.onclick = function () {
      var i = parseInt(b.getAttribute('data-i'), 10);
      L.filters.splice(i, 1);
      renderConds();
      refreshActive();
      syncLayerPanel();
    };
  });
}

function renderFilterFields() {
  var sel = document.getElementById('fField');
  if (!sel) return;   /* 区块已移除 */
  var L = selected;
  if (!L) { sel.innerHTML = ''; return; }
  var h = '';
  for (var i = 0; i < L.ds.columns.length; i++) {
    h += '<option>' + esc(L.ds.columns[i]) + '</option>';
  }
  sel.innerHTML = h;
}

function updateStepInfo(L) {
  var el = document.getElementById('stepInfo');
  if (!el) return;
  if (!L || L.kind !== 'grid' || !L.dLat) { el.textContent = '—'; return; }
  el.textContent = '纬向 ' + L.stepLatM.toFixed(1) + ' m × 经向 ' + L.stepLonM.toFixed(1) + ' m' +
    (L.stepDetected ? '' : '（默认值）');
}

function refreshActive() {
  var L = selected;
  updateStepInfo(L);
  if (!L) return;
  if (L.kind === 'grid') { rebuildBuckets(L); }
  renderLegend();
  renderStat();
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
function refreshSessionCache() {
  if (global.__NO_SESSION_CACHE) return;
  if (_vsSuspend > 0) return;   /* 会话恢复进行中：此刻的清层/建层不回写缓存，防止与恢复读竞争 */
  _cacheChain = _cacheChain.then(function () { return doPutCache(); }).catch(function (e) {
    cacheErr = (e && e.message) ? e.message : '写入失败';
    updateRestoreBar();
  });
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
  $('beamW').oninput = function (e) {
    STATE.beamW = parseInt(e.target.value, 10);
    $('bwVal').textContent = STATE.beamW + '°';
    scheduleDraw();
  };
  $('siteR').oninput = function (e) {
    STATE.siteR = parseInt(e.target.value, 10);
    $('srVal').textContent = STATE.siteR + ' px';
    scheduleDraw();
  };
  $('siteColor').onchange = function (e) {
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
  $('btnZoomLayer').onclick = function () { if (selected) fitLayer(selected); };

  /* 地市筛选只保留顶部「地市」下拉（侧栏同名筛选已移除） */

  /* 定位 + 地图标记 */
  function doJump() {
    var v = $('jump').value.trim();
    var m = v.match(/(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)/);
    if (!m) { showErr('请输入「经度,纬度」，例如 87.4807,43.9161'); return; }
    var lon = parseFloat(m[1]), lat = parseFloat(m[2]);
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      showErr('经纬度超出有效范围（经度 -180~180，纬度 -90~90）');
      return;
    }
    setPin(lon, lat);
    map.getView().animate({
      center: [lonToMercX(lon), latToMercY(lat)],
      zoom: Math.max(map.getView().getZoom(), 16),
      duration: 320
    });
  }
  $('btnJump').onclick = doJump;
  $('jump').onkeydown = function (e) { if (e.key === 'Enter') doJump(); };
  $('btnPinClear').onclick = function () {
    if (!STATE.pin) { showErr('当前地图上没有定位标记'); return; }
    STATE.pin = null;
    scheduleDraw();
  };
  /* 报错弹窗的关闭 X */
  $('errX').onclick = hideErr;
  /* 会话状态：移动/缩放地图、关页时保存，下次打开恢复 */
  map.on('moveend', function () { saveViewState(); });
  global.addEventListener('beforeunload', function () { saveViewState(true); });

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
    // Worker 文件与主 JS 同版本（图层工具-vN.js 对应 图层Worker-vN.js）
    var workerUrl = 'worker.js';
    try {
      var _src = (document.currentScript && document.currentScript.src) || '';
      var _m = _src.match(/图层工具-(v\d+)\.js/);
      if (_m) workerUrl = '图层Worker-' + _m[1] + '.js';
    } catch (e2) {}

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
  bindCellSearch();
  bindRatToggle();
  bindPopupResize('popup');
  bindPopupResize('tkPop');
  bindExportSel();
  getSiteWorker();   /* 预热 Worker */
  initTheme();
  initResponsive();
  renderLayerList();
  renderConds();
  renderLegend();
  renderStat();
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

})(typeof window !== 'undefined' ? window : globalThis);
