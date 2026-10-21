/* 图层Worker：处理恢复时的 CPU 密集型计算（城市索引、站点 GL 数组构建）
   主线程只负责 IDB 读取和 GPU 上传，计算放 Worker 避免阻塞 UI */

var ALIAS_CITY = ['cityid', 'city', '城市', '地市', '行政区'];

// 构建城市索引：返回 { list, idx }，idx 为 Int16Array
function buildCityIndex(n, columns, numCols, strCols, cityCol) {
  var list = [], map = {}, idx = new Int16Array(n);
  var numArr = numCols[cityCol];
  if (numArr) {
    for (var i = 0; i < n; i++) {
      /* 与主线程口径一致：空值（NaN）记 -1，不把 'NaN' 当成一个城市 */
      if (!isFinite(numArr[i])) { idx[i] = -1; continue; }
      var k = String(Math.round(numArr[i]));
      var v = map[k];
      if (v === undefined) { v = list.length; map[k] = v; list.push(k); }
      idx[i] = v;
    }
  } else {
    var sarr = strCols[cityCol];
    /* 与主线程口径一致：保留原值（简称），不做全称映射；空值记 -1 不进列表 */
    for (var j = 0; j < n; j++) {
      var raw = sarr ? String(sarr[j] || '').trim() : '';
      if (!raw) { idx[j] = -1; continue; }
      var v2 = map[raw];
      if (v2 === undefined) { v2 = list.length; map[raw] = v2; list.push(raw); }
      idx[j] = v2;
    }
  }
  return { list: list, idx: idx };
}

// 构建站点 GL 数组：返回 { pos, col, azk, cityA, count, refX, refY, alpha }
function buildSiteArrays(data) {
  var mx = data.mx, my = data.my, n = data.n;
  var groups = data.groups; // [{ color: [r,g,b,a], indoor: bool, idx: [...] }]
  var azArr = data.azArr;
  var cityIdx = data.cityIdx;
  var DEG = Math.PI / 180;

  // 数有效点
  var total = 0;
  for (var gi = 0; gi < groups.length; gi++) {
    var idx0 = groups[gi].idx;
    for (var k = 0; k < idx0.length; k++) {
      var i = idx0[k];
      if (isFinite(mx[i]) && isFinite(my[i])) total++;
    }
  }
  if (!total) return null;

  // 参考点
  var sx = 0, sy = 0, sc = 0;
  for (var gj = 0; gj < groups.length; gj++) {
    var idx1 = groups[gj].idx;
    for (var kk = 0; kk < idx1.length; kk += 97) {
      var ii = idx1[kk];
      if (!isFinite(mx[ii]) || !isFinite(my[ii])) continue;
      sx += mx[ii]; sy += my[ii]; sc++;
    }
  }
  var refX = sc ? sx / sc : 0, refY = sc ? sy / sc : 0;

  var pos = new Float32Array(total * 2);
  var col = new Float32Array(total * 3);
  var azk = new Float32Array(total * 2);
  var rb = new Float32Array(total * 2);   /* 每实例（半径米, 半波束角弧度）：频段样式用，0=用制式 uniform */
  var cityA = new Float32Array(total);
  var p = 0, alpha = 0.6;

  for (var g = 0; g < groups.length; g++) {
    var grp = groups[g];
    var rgba = grp.color;
    if (g === 0) alpha = rgba[3];
    var isIndoor = !!grp.indoor;
    var gidx = grp.idx;
    for (var m = 0; m < gidx.length; m++) {
      var pi = gidx[m];
      var x = mx[pi], y = my[pi];
      if (!isFinite(x) || !isFinite(y)) continue;
      pos[p * 2] = x - refX;
      pos[p * 2 + 1] = y - refY;
      cityA[p] = cityIdx ? cityIdx[pi] : -1;
      col[p * 3] = rgba[0]; col[p * 3 + 1] = rgba[1]; col[p * 3 + 2] = rgba[2];
      var kind, azr = 0;
      if (isIndoor) {
        kind = 1;
      } else {
        var az = azArr ? azArr[pi] : NaN;
        if (isFinite(az)) { kind = 0; azr = az * DEG; }
        else kind = 2;
      }
      azk[p * 2] = azr; azk[p * 2 + 1] = kind;
      rb[p * 2] = grp.rM || 0;
      rb[p * 2 + 1] = grp.beam ? grp.beam * DEG * 0.5 : 0;
      p++;
    }
  }

  return {
    pos: pos, col: col, azk: azk, cityA: cityA, rb: rb,
    count: p, refX: refX, refY: refY, alpha: alpha
  };
}

// 墨卡托投影（与主线程一致）
var R_EARTH = 6378137, DEG = Math.PI / 180;
function lonToMercX(lon) { return lon * R_EARTH * DEG; }
function latToMercY(lat) {
  var s = Math.sin(lat * DEG);
  if (s > 0.999999) s = 0.999999;
  if (s < -0.999999) s = -0.999999;
  return R_EARTH * 0.5 * Math.log((1 + s) / (1 - s));
}

// 栅格坐标投影：lon/lat → mx/my（Float32Array）
function projectGrid(data) {
  var lon = data.lon, lat = data.lat, n = data.n;
  var mx = new Float32Array(n), my = new Float32Array(n);
  for (var i = 0; i < n; i++) {
    var x = lon[i], y = lat[i];
    if (!isFinite(x) || !isFinite(y)) { mx[i] = NaN; my[i] = NaN; continue; }
    mx[i] = lonToMercX(x);
    my[i] = latToMercY(y);
  }
  return { mx: mx, my: my };
}

// 构建栅格 GL 数组：返回 { pos, bnd, count, refX, refY }
function buildGridArrays(data) {
  var mx = data.mx, my = data.my;
  var buckets = data.buckets; // array of arrays
  var nb = buckets.length;
  var total = 0;
  for (var b = 0; b < nb; b++) total += buckets[b].length;
  if (!total) return null;

  // 参考点
  var sx = 0, sy = 0, sc = 0;
  for (var b2 = 0; b2 < nb; b2++) {
    var idx0 = buckets[b2];
    for (var k = 0; k < idx0.length; k += 97) {
      var ii = idx0[k];
      if (!isFinite(mx[ii]) || !isFinite(my[ii])) continue;
      sx += mx[ii]; sy += my[ii]; sc++;
    }
  }
  var refX = sc ? sx / sc : 0, refY = sc ? sy / sc : 0;

  var pos = new Float32Array(total * 2);
  var bnd = new Float32Array(total);
  var p = 0;
  for (var b3 = 0; b3 < nb; b3++) {
    var idx = buckets[b3];
    for (var m = 0; m < idx.length; m++) {
      var i = idx[m];
      pos[p * 2] = mx[i] - refX;
      pos[p * 2 + 1] = my[i] - refY;
      bnd[p] = b3;
      p++;
    }
  }
  return { pos: pos, bnd: bnd, count: p, refX: refX, refY: refY };
}

self.onmessage = function (e) {
  var msg = e.data;
  try {
    if (msg.type === 'cityIndex') {
      var result = buildCityIndex(msg.n, msg.columns, msg.numCols, msg.strCols, msg.cityCol);
      self.postMessage({
        type: 'cityIndex',
        id: msg.id,
        list: result.list,
        idx: result.idx
      }, [result.idx.buffer]);
    } else if (msg.type === 'siteArrays') {
      var arrResult = buildSiteArrays(msg.data);
      if (!arrResult) {
        self.postMessage({ type: 'siteArrays', id: msg.id, error: 'no data' });
      } else {
        self.postMessage({
          type: 'siteArrays',
          id: msg.id,
          count: arrResult.count,
          refX: arrResult.refX, refY: arrResult.refY, alpha: arrResult.alpha,
          pos: arrResult.pos, col: arrResult.col, azk: arrResult.azk, cityA: arrResult.cityA, rb: arrResult.rb
        }, [arrResult.pos.buffer, arrResult.col.buffer, arrResult.azk.buffer, arrResult.cityA.buffer, arrResult.rb.buffer]);
      }
    } else if (msg.type === 'projectGrid') {
      var projResult = projectGrid(msg.data);
      self.postMessage({
        type: 'projectGrid',
        id: msg.id,
        mx: projResult.mx, my: projResult.my
      }, [projResult.mx.buffer, projResult.my.buffer]);
    } else if (msg.type === 'gridArrays') {
      var gridResult = buildGridArrays(msg.data);
      if (!gridResult) {
        self.postMessage({ type: 'gridArrays', id: msg.id, error: 'no data' });
      } else {
        self.postMessage({
          type: 'gridArrays',
          id: msg.id,
          count: gridResult.count,
          refX: gridResult.refX, refY: gridResult.refY,
          pos: gridResult.pos, bnd: gridResult.bnd
        }, [gridResult.pos.buffer, gridResult.bnd.buffer]);
      }
    }
  } catch (err) {
    self.postMessage({ type: msg.type, id: msg.id, error: String(err && err.message || err) });
  }
};
