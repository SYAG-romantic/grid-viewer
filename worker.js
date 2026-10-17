/* 图层Worker：处理恢复时的 CPU 密集型计算（城市索引、站点 GL 数组构建）
   主线程只负责 IDB 读取和 GPU 上传，计算放 Worker 避免阻塞 UI */

var ALIAS_CITY = ['cityid', 'city', '城市', '地市', '行政区'];

// 构建城市索引：返回 { list, idx }，idx 为 Int16Array
function buildCityIndex(n, columns, numCols, strCols, cityCol) {
  var list = [], map = {}, idx = new Int16Array(n);
  var numArr = numCols[cityCol];
  if (numArr) {
    for (var i = 0; i < n; i++) {
      var k = String(Math.round(numArr[i]));
      var v = map[k];
      if (v === undefined) { v = list.length; map[k] = v; list.push(k); }
      idx[i] = v;
    }
  } else {
    var sarr = strCols[cityCol];
    // 中文地市名映射（与主线程一致）
    var CITY_MAP = {
      '乌鲁木齐': '乌鲁木齐', '克拉玛依': '克拉玛依', '吐鲁番': '吐鲁番', '哈密': '哈密',
      '昌吉': '昌吉回族自治州', '博尔塔拉': '博尔塔拉蒙古自治州', '巴音郭楞': '巴音郭楞蒙古自治州',
      '阿克苏': '阿克苏地区', '克孜勒苏': '克孜勒苏柯尔克孜自治州', '喀什': '喀什地区',
      '和田': '和田地区', '伊犁': '伊犁哈萨克自治州', '塔城': '塔城地区', '阿勒泰': '阿勒泰地区'
    };
    for (var j = 0; j < n; j++) {
      var raw = sarr ? String(sarr[j] || '').trim() : '';
      var k2 = CITY_MAP[raw] || raw || '(空)';
      var v2 = map[k2];
      if (v2 === undefined) { v2 = list.length; map[k2] = v2; list.push(k2); }
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
      p++;
    }
  }

  return {
    pos: pos, col: col, azk: azk, cityA: cityA,
    count: p, refX: refX, refY: refY, alpha: alpha
  };
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
          pos: arrResult.pos, col: arrResult.col, azk: arrResult.azk, cityA: arrResult.cityA
        }, [arrResult.pos.buffer, arrResult.col.buffer, arrResult.azk.buffer, arrResult.cityA.buffer]);
      }
    }
  } catch (err) {
    self.postMessage({ type: msg.type, id: msg.id, error: String(err && err.message || err) });
  }
};
