/* vector.js — 矢量边界图层解析器
 * 支持 MapInfo (TAB/DAT/MAP/ID) 和 Shapefile (SHP/SHX/DBF/PRJ)
 * 输出统一格式：{ name, polygons: [ { rings: [ [[lon,lat],...], ... ], props: {...} } ] }
 */

/* ---------- MapInfo .TAB 字段声明 ----------
 * .DAT 里 "Float" 列是 8 字节 IEEE double、"Integer" 列是 4 字节 int，
 * 全按文本读会得到一串乱码（经纬/纬度/方位角这种重灾区）。
 * .TAB 的 Definition Table 里写着每列的真实类型，按它解才是对的：
 *     Shape_Leng Float ;
 *     NUMBER     Integer Index 1 ;
 */
/* 从 .TAB 头解析 Charset，返回 TextDecoder 可用的编码名 */
function parseTabCharset(tabText) {
  if (!tabText) return null;
  var m = /Charset\s+"([^"]+)"/i.exec(String(tabText));
  if (!m) return null;
  var cs = m[1].toLowerCase();
  if (cs.indexOf('utf-8') >= 0 || cs.indexOf('utf8') >= 0) return 'utf-8';
  if (cs.indexOf('big5') >= 0 || cs.indexOf('traditional') >= 0) return 'big5';
  /* WindowsSimpChinese / gbk / gb2312 / ansi 等都按 gbk 解 */
  return 'gbk';
}

function parseTabFieldTypes(tabText) {
  var types = {};
  if (!tabText) return types;
  var lines = String(tabText).split(/\r?\n/);
  var inFields = false, left = 0;
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i].trim();
    if (!inFields) {
      var m0 = /^Fields\s+(\d+)/i.exec(ln);
      if (m0) { inFields = true; left = parseInt(m0[1], 10); }
      continue;
    }
    if (!ln) continue;
    if (/^begin_metadata/i.test(ln)) break;
    var m = /^(?:"([^"]+)"|(\S+))\s+(\w+)/.exec(ln);
    if (!m) continue;
    var nm = (m[1] || m[2] || '').trim();
    if (nm) types[nm] = (m[3] || '').toLowerCase();
    if (--left <= 0) break;
  }
  return types;
}

/* ---------- DBF/dBase III 解析（DAT 和 DBF 共用） ---------- */
/* fieldTypes 可选：{ 字段名: 'float'|'largeint'|'integer'|'smallint'|'logical' }，
 * 只有 MapInfo 的 .DAT 才需要（它把数值列按二进制写）；标准 .DBF 传 null 即可 */
function parseDbf(buf, encoding, fieldTypes) {
  var u8 = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
  var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  var nRec = dv.getUint32(4, true);
  var hLen = dv.getUint16(8, true);
  var rLen = dv.getUint16(10, true);
  var nFields = Math.floor((hLen - 33) / 32);
  var fields = [];
  var dec = null;
  try { dec = new TextDecoder(encoding || 'gbk'); } catch (e) { dec = new TextDecoder('utf-8'); }
  for (var i = 0; i < nFields; i++) {
    var off = 32 + i * 32;
    var nmBytes = [];
    for (var k = 0; k < 11; k++) {
      var c = u8[off + k];
      if (!c) break;
      nmBytes.push(c);
    }
    var nm = '';
    try { nm = dec.decode(new Uint8Array(nmBytes)).trim(); } catch (e) { nm = ''; }
    fields.push({ name: nm, type: String.fromCharCode(u8[off + 11]), len: u8[off + 16], off: 0 });
  }
  var foff = 1; // 跳过删除标记
  for (var fi = 0; fi < fields.length; fi++) { fields[fi].off = foff; foff += fields[fi].len; }
  /* 编码兜底识别：调用方按 gbk 假设时（无 .cpg 的 SHP 常见），抽样字符列原始字节试 UTF-8 严格解码，
     能完整解通说明文件其实是 UTF-8（GBK 字节流几乎必然在严格模式下报错），避免整表乱码 */
  if ((encoding || 'gbk') === 'gbk' && nRec > 0 && rLen > 0) {
    try {
      var sample = [];
      var maxRec = Math.min(nRec, 100);
      for (var sr = 0; sr < maxRec && sample.length < 262144; sr++) {
        var sb = hLen + sr * rLen;
        for (var sf = 0; sf < fields.length; sf++) {
          if (fields[sf].type !== 'C') continue;
          var so = sb + fields[sf].off;
          for (var sk = 0; sk < fields[sf].len; sk++) {
            var sc2 = u8[so + sk];
            if (sc2 >= 0x80) sample.push(sc2);
          }
        }
      }
      if (sample.length > 8) {
        new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(sample));
        dec = new TextDecoder('utf-8');
        /* 字段名也要用新编码重解一遍 */
        for (var ni2 = 0; ni2 < fields.length; ni2++) {
          var noff = 32 + ni2 * 32, nb = [];
          for (var nk = 0; nk < 11; nk++) { var nc = u8[noff + nk]; if (!nc) break; nb.push(nc); }
          try { fields[ni2].name = dec.decode(new Uint8Array(nb)).trim(); } catch (e2) {}
        }
      }
    } catch (e) { /* 严格解码失败：确实是 GBK，保持原解码器 */ }
  }
  var records = new Array(nRec);
  for (var r = 0; r < nRec; r++) {
    var base = hLen + r * rLen;
    var rec = {};
    for (var f = 0; f < fields.length; f++) {
      var fd = fields[f];
      var b0 = base + fd.off, e = b0 + fd.len;
      var ft = fieldTypes ? fieldTypes[fd.name] : null;
      /* MapInfo .DAT 的二进制数值列：按 .TAB 声明的类型直接取值 */
      if (ft === 'float' && fd.len === 8) { rec[fd.name] = dv.getFloat64(b0, true); continue; }
      if ((ft === 'largeint' || ft === 'bigint') && fd.len === 8) {
        try { rec[fd.name] = String(dv.getBigInt64(b0, true)); } catch (e) { rec[fd.name] = ''; }
        continue;
      }
      if (ft === 'integer' && fd.len === 4) { rec[fd.name] = dv.getInt32(b0, true); continue; }
      if (ft === 'smallint' && fd.len === 2) { rec[fd.name] = dv.getInt16(b0, true); continue; }
      if (ft === 'logical' && fd.len === 1) { rec[fd.name] = u8[b0] ? 'T' : 'F'; continue; }
      /* 文本列：定长字段右侧是空格 / NUL 填充，先把有效区间夹出来再解码；
         纯 ASCII（数字、编号）直接 fromCharCode，省掉 TextDecoder 的每次固定开销 */
      while (e > b0 && (u8[e - 1] === 0x20 || u8[e - 1] === 0)) e--;
      while (b0 < e && u8[b0] === 0x20) b0++;
      var s = '';
      if (e > b0) {
        var ascii = true;
        for (var bi = b0; bi < e; bi++) { if (u8[bi] >= 0x80) { ascii = false; break; } }
        if (ascii) {
          try { s = String.fromCharCode.apply(null, u8.subarray(b0, e)); } catch (er) { s = ''; }
        } else {
          try { s = dec.decode(u8.subarray(b0, e)); } catch (er2) { s = ''; }
          /* 有乱码时尝试多种编码，选乱码最少的 */
          if (s.indexOf('\uFFFD') >= 0) {
            var cands = ['gbk', 'gb18030', 'utf-8', 'big5'];
            var best = s, bestBad = 9999;
            /* 数当前乱码数 */
            var _bad = 0;
            for (var _bi2 = 0; _bi2 < s.length; _bi2++) if (s.charCodeAt(_bi2) === 0xFFFD) _bad++;
            bestBad = _bad;
            for (var _ci = 0; _ci < cands.length; _ci++) {
              if (cands[_ci] === encoding) continue;
              try {
                var _d2 = new TextDecoder(cands[_ci]);
                var _s2 = _d2.decode(u8.subarray(b0, e));
                var _b2 = 0;
                for (var _bj = 0; _bj < _s2.length; _bj++) if (_s2.charCodeAt(_bj) === 0xFFFD) _b2++;
                if (_b2 < bestBad) { bestBad = _b2; best = _s2; if (_b2 === 0) break; }
              } catch (_er3) {}
            }
            s = best;
          }
          /* 两种编码都有乱码：可能是二进制数字，按长度试读 */
          if (s.indexOf('\uFFFD') >= 0) {
            var _blen = e - b0;
            var _dv2 = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
            try {
              if (_blen === 8) { var _fv = _dv2.getFloat64(b0, true); if (isFinite(_fv)) s = String(_fv); }
              else if (_blen === 4) { var _iv = _dv2.getInt32(b0, true); s = String(_iv); }
              else if (_blen === 2) { var _sv2 = _dv2.getInt16(b0, true); s = String(_sv2); }
            } catch (er4) {}
          }
        }
      }
      rec[fd.name] = s.trim();
    }
    records[r] = rec;
  }
  return { fields: fields.map(function (f) { return f.name; }), records: records };
}

/* ---------- MapInfo .MAP 解析 ----------
 * “蜘蛛网”坏顶点的根因是坐标区的三处结构细节，改这段代码前请先看完：
 *
 * 1) 坐标区按“块”存放，块大小并不固定：.MAP 文件头 0x106 处那个 u16 就是块大小
 *    （实测现网图层里既有 512 也有 16384）。块头 8 字节 = u16 块类型 | u16 数据长度 | i32 下一块偏移。
 *
 * 2) 一个 REGION 的坐标流会跨块，越出当前块的数据区后必须按“块头里记的下一块偏移”跳过去，
 *    不能假设文件里紧挨着的下一个块就是它（实测确实存在“紧邻的下一块其实是对象块”“链往回跳”）。
 *    旧实现用 Math.floor(pos/512)*512 反推块位置，跨块时就把块头/对象数据当坐标读，
 *    于是出现个别顶点飞到 -60° 之类的离群值 —— 旧版在这里错得比想象的多。
 *
 * 3) 段（section）头：压缩 16 字节、不压缩 24 字节；段内点数据偏移 doff 以 24*nsec 为基准、
 *    按“每点 8 字节”计数（压缩点实际只占 4 字节），所以点下标 = (doff - 24*nsec) / 8。
 *    段与段在坐标流里连续存放，但段头顺序与数据顺序无关，必须按这个下标切片，不能按段头顺序直接切。
 *
 * 因此这里不做任何“过滤坏点/丢掉跨度大的多边形”的处理：解出来的就是文件里写的。
 */
function createMapReader(mapBuf) {
  var mapBytes = (mapBuf instanceof Uint8Array) ? mapBuf : new Uint8Array(mapBuf);
  var mapLen = mapBytes.byteLength;
  var dv = new DataView(mapBytes.buffer, mapBytes.byteOffset, mapBytes.byteLength);
  var i32 = function (o) { return dv.getInt32(o, true); };
  var i16 = function (o) { return dv.getInt16(o, true); };
  var f64 = function (o) { return dv.getFloat64(o, true); };

  if (mapLen < 0x200 || i32(0x100) !== 42424242) throw new Error('not a MapInfo .MAP file');

  var blkSize = dv.getUint16(0x106, true) || 512;   // 块大小（512 / 16384 …）
  var XScale = f64(0x170), YScale = f64(0x178);
  var XDispl = f64(0x180), YDispl = f64(0x188);
  var quadrant = dv.getUint8(0x161);
  if (!XScale) XScale = 1e6;
  if (!YScale) YScale = 1e6;
  var toLon = function (ix) {
    return (quadrant == 2 || quadrant == 3 || quadrant == 0) ? -(ix + XDispl) / XScale : (ix - XDispl) / XScale;
  };
  var toLat = function (iy) {
    return (quadrant == 3 || quadrant == 4 || quadrant == 0) ? -(iy + YDispl) / YScale : (iy - YDispl) / YScale;
  };

  /* 坐标块游标：按块头记录的链走；一个值被块边界切开时按字节拼装 */
  function CoordCursor(start) {
    this.pos = start;
    this.enter(Math.floor(start / blkSize) * blkSize);
    if (this.pos < this.dataStart) this.pos = this.dataStart;
  }
  CoordCursor.prototype.enter = function (bs) {
    if (bs < 0 || bs + 8 > mapLen) throw new Error('coord block out of range');
    this.blk = bs;
    this.dataStart = bs + 8;
    var dlen = dv.getUint16(bs + 2, true);
    this.dataEnd = Math.min(this.dataStart + dlen, mapLen);
    this.next = i32(bs + 4);
  };
  CoordCursor.prototype.advance = function () {
    if (!(this.next > 0) || this.next + 8 > mapLen) throw new Error('coord block chain end');
    this.enter(this.next);
    this.pos = this.dataStart;
  };
  // n = 2 或 4；signed 指定按有符号解释
  CoordCursor.prototype.read = function (n, signed) {
    if (this.pos + n <= this.dataEnd) {
      var p0 = this.pos;
      this.pos += n;
      if (n === 2) {
        var v2 = dv.getUint16(p0, true);
        return (signed && v2 >= 0x8000) ? v2 - 0x10000 : v2;
      }
      var v4 = dv.getUint32(p0, true);
      return (signed && v4 >= 0x80000000) ? v4 - 0x100000000 : v4;
    }
    var val = 0, got = 0;
    while (got < n) {
      if (this.pos >= this.dataEnd) this.advance();
      var take = Math.min(this.dataEnd - this.pos, n - got);
      for (var k = 0; k < take; k++) val += dv.getUint8(this.pos + k) * Math.pow(2, (got + k) * 8);
      this.pos += take;
      got += take;
    }
    if (n === 2) return (signed && val >= 0x8000) ? val - 0x10000 : val;
    return (signed && val >= 0x80000000) ? val - 0x100000000 : val;
  };

  // 读整条记录：整数坐标 + 各段 MBR（解析与自检共用这一段，保证两条路径不可能不一致）
  function readRegionDetail(objOff) {
    if (objOff <= 0 || objOff + 16 > mapLen) return null;
    var type = dv.getUint8(objOff);
    var compressed = (type === 0x0d);
    if (!compressed && type !== 0x0e) return null;   // 点/线/文本对象不在此处理
    var p = objOff + 5;
    var cptr = i32(p); p += 4;
    var csize = i32(p) & 0x7FFFFFFF; p += 4;
    var nsec = i16(p); p += 2;
    if (cptr <= 0 || cptr >= mapLen || csize <= 0 || nsec <= 0 || nsec > 65535) return null;
    var orgX = 0, orgY = 0, objMbr;
    if (compressed) {
      p += 4;                       // 标签指针
      orgX = i32(p); orgY = i32(p + 4); p += 8;
      objMbr = [i16(p) + orgX, i16(p + 2) + orgY, i16(p + 4) + orgX, i16(p + 6) + orgY];
      p += 8;                       // 对象 MBR（int16 相对量）
    } else {
      p += 8;                       // 标签指针
      objMbr = [i32(p), i32(p + 4), i32(p + 8), i32(p + 12)];
      p += 16;                      // 对象 MBR（int32 绝对值）
    }

    var cur = new CoordCursor(cptr);
    var secs = new Array(nsec);
    var maxIdx = 0, hdrBase = 24 * nsec;
    for (var s = 0; s < nsec; s++) {
      var nv = cur.read(2, false);
      cur.read(2, false);           // 段内洞数：点流里没有单独的洞环，整段按一条环处理
      var x1, y1, x2, y2;
      if (compressed) {
        x1 = cur.read(2, true) + orgX; y1 = cur.read(2, true) + orgY;
        x2 = cur.read(2, true) + orgX; y2 = cur.read(2, true) + orgY;
      } else {
        x1 = cur.read(4, true); y1 = cur.read(4, true);
        x2 = cur.read(4, true); y2 = cur.read(4, true);
      }
      var doff = cur.read(4, true);
      var voff = Math.round((doff - hdrBase) / 8);
      if (voff < 0) voff = 0;
      if (voff + nv > 4000000) return null;
      secs[s] = { nv: nv, voff: voff, mbr: [x1, y1, x2, y2] };
      if (voff + nv > maxIdx) maxIdx = voff + nv;
    }
    if (maxIdx <= 0) return null;

    var pts = new Array(maxIdx);
    if (compressed) {
      for (var k = 0; k < maxIdx; k++) pts[k] = [cur.read(2, true) + orgX, cur.read(2, true) + orgY];
    } else {
      for (var k2 = 0; k2 < maxIdx; k2++) pts[k2] = [cur.read(4, true), cur.read(4, true)];
    }
    return { compressed: compressed, objMbr: objMbr, secs: secs, pts: pts, maxIdx: maxIdx };
  }

  /* 环 + 经纬度包围盒。包围盒直接取各段头里的 MBR（它就是这些点的真实范围，
   * 已由 verifyRegion 逐段校验过），不必再把每个点算一遍 —— 十万面几百万点，
   * 逐点算墨卡托要好几秒，用段 MBR 只要 O(面数)。 */
  function readRegion(objOff) {
    var d = readRegionDetail(objOff);
    if (!d) return null;
    var rings = [];
    var ix1 = Infinity, iy1 = Infinity, ix2 = -Infinity, iy2 = -Infinity;
    for (var si = 0; si < d.secs.length; si++) {
      var sc = d.secs[si];
      if (sc.nv < 3) continue;                      // 少于 3 个点构不成环
      var end = sc.voff + sc.nv;
      if (end > d.maxIdx) end = d.maxIdx;
      if (end - sc.voff < 3) continue;
      var ring = new Array(end - sc.voff);
      for (var k = sc.voff, j = 0; k < end; k++, j++) ring[j] = [toLon(d.pts[k][0]), toLat(d.pts[k][1])];
      rings.push(ring);
      var m = sc.mbr;
      if (m[0] < ix1) ix1 = m[0];
      if (m[1] < iy1) iy1 = m[1];
      if (m[2] > ix2) ix2 = m[2];
      if (m[3] > iy2) iy2 = m[3];
    }
    if (!rings.length) return { rings: rings, bboxLL: null };
    /* toLon/toLat 在象限 2/3/4 下会取反，极值要对调后再排序 */
    var la = toLon(ix1), lb = toLon(ix2), ma = toLat(iy1), mb = toLat(iy2);
    var bboxLL = [
      Math.min(la, lb), Math.min(ma, mb),
      Math.max(la, lb), Math.max(ma, mb)
    ];
    return { rings: rings, bboxLL: bboxLL };
  }

  /* 自检：段头 MBR 是文件里独立存的一份真值，
   * 逐段比对“段头 MBR”与“解析出的点包围盒”，全等即说明该段每个顶点都解码正确。 */
  function verifyRegion(objOff) {
    var d = readRegionDetail(objOff);
    if (!d) return null;
    var bad = [], out = 0, om = d.objMbr;
    for (var si = 0; si < d.secs.length; si++) {
      var sc = d.secs[si], m = sc.mbr;
      var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      var end = Math.min(sc.voff + sc.nv, d.maxIdx);
      for (var k = sc.voff; k < end; k++) {
        var x = d.pts[k][0], y = d.pts[k][1];
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
        if (x < om[0] || x > om[2] || y < om[1] || y > om[3]) out++;
      }
      if (x1 !== m[0] || y1 !== m[1] || x2 !== m[2] || y2 !== m[3]) {
        bad.push({ sec: si, mbr: m, got: [x1, y1, x2, y2] });
      }
    }
    return { sections: d.secs.length, badSections: bad.length, outOfBBox: out, details: bad };
  }

  return { readRegion: readRegion, verifyRegion: verifyRegion, toLon: toLon, toLat: toLat, len: mapLen };
}

/* onProgress(done, total) 可选：按时间片回调，供界面显示进度
 * 让出主线程按“已经算了多久”判断，不是每 N 条一次：
 * 定时器本身有开销（浏览器里 4ms 起），十万条面按 200 条让出一次要 500 多次，
 * 光等定时器就够把导入时间拖成十几秒。 */
async function parseMapInfo(mapBuf, idBuf, onProgress) {
  var R = createMapReader(mapBuf);
  /* 没有 .ID 就定位不到任何对象，直接说清楚，而不是当成“无多边形” */
  if (!idBuf) throw new Error('缺少 .ID 索引文件（MapInfo 图层需要 .MAP + .ID，属性需要 .DAT）');
  var idBytes = (idBuf instanceof Uint8Array) ? idBuf : new Uint8Array(idBuf);
  if (idBytes.byteLength < 4) throw new Error('.ID 索引文件为空');
  var idDv = new DataView(idBytes.buffer, idBytes.byteOffset, idBytes.byteLength);
  var nId = Math.floor(idBytes.byteLength / 4);
  var polygons = [];
  var lastYield = Date.now();
  for (var rec = 1; rec <= nId; rec++) {
    var off = idDv.getInt32((rec - 1) * 4, true);
    if (off > 0) {
      try {
        var rr = R.readRegion(off);
        if (rr && rr.rings && rr.rings.length) polygons.push({ recNo: rec, rings: rr.rings, bboxLL: rr.bboxLL });
      } catch (e) { /* 单条记录异常不牵连整层 */ }
    }
    if ((rec & 63) === 0 && Date.now() - lastYield >= 12) {
      if (onProgress) onProgress(rec, nId);
      await new Promise(function (r) { setTimeout(r, 0); });
      lastYield = Date.now();
    }
  }
  if (onProgress) onProgress(nId, nId);
  return polygons;
}

/* 解析结果自检：返回每段 MBR 与解析点集包围盒的偏差统计。
 * 全部 badSections / outOfBBox 为 0，就说明这层每个顶点都对得上文件里记录的范围。 */
async function verifyMapInfo(mapBuf, idBuf) {
  var R = createMapReader(mapBuf);
  var idBytes = (idBuf instanceof Uint8Array) ? idBuf : new Uint8Array(idBuf);
  var idDv = new DataView(idBytes.buffer, idBytes.byteOffset, idBytes.byteLength);
  var nId = Math.floor(idBytes.byteLength / 4);
  var res = { records: 0, sections: 0, badSections: 0, outOfBBox: 0, details: [] };
  for (var r = 0; r < nId; r++) {
    var off = idDv.getInt32(r * 4, true);
    if (off <= 0) continue;
    var v = null;
    try { v = R.verifyRegion(off); } catch (e) { continue; }
    if (!v) continue;
    res.records++;
    res.sections += v.sections;
    res.badSections += v.badSections;
    res.outOfBBox += v.outOfBBox;
    if (v.badSections && res.details.length < 20) res.details.push({ rec: r + 1, off: off, bad: v.details });
    if (r % 200 === 0) await new Promise(function (rr) { setTimeout(rr, 0); });
  }
  return res;
}

/* ---------- Shapefile .SHP 解析 ---------- */
async function parseShp(shpBuf, onProgress) {
  var bytes = (shpBuf instanceof Uint8Array) ? shpBuf : new Uint8Array(shpBuf);
  var len = bytes.byteLength;
  var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (len < 100 || dv.getInt32(0, false) !== 9994) throw new Error('not a Shapefile .SHP file');
  // 头 100 字节：0-3 魔数 9994 (big-endian)，32-35 shapeType (little-endian)
  var shapeType = dv.getInt32(32, true);
  var polygons = [];
  var off = 100;
  var recNo = 0;
  var lastYield = Date.now();
  while (off + 8 <= len) {
    if ((recNo & 63) === 0 && Date.now() - lastYield >= 12) {
      if (onProgress) onProgress(off, len);
      await new Promise(function (r) { setTimeout(r, 0); });
      lastYield = Date.now();
    }
    var contentLen = dv.getInt32(off + 4, false) * 2; // big-endian，单位 16-bit word
    recNo++;
    var roff = off + 8;
    if (roff + 4 > len || contentLen <= 0) break;
    try {
      var st = dv.getInt32(roff, true);
      if (st === 5 || st === 15) { // Polygon / PolygonZ
        /* 记录头里带了这条记录的包围盒，直接拿来当 bbox，
           省掉 App 侧再遍历一遍所有顶点算范围（十万面百万点要好几百毫秒） */
        var bx1 = dv.getFloat64(roff + 4, true), by1 = dv.getFloat64(roff + 12, true);
        var bx2 = dv.getFloat64(roff + 20, true), by2 = dv.getFloat64(roff + 28, true);
        var rbb = [Math.min(bx1, bx2), Math.min(by1, by2), Math.max(bx1, bx2), Math.max(by1, by2)];
        if (!isFinite(rbb[0]) || !isFinite(rbb[2])) rbb = null;
        var p = roff + 4 + 32; // 跳过 shape type + bbox
        var numParts = dv.getInt32(p, true); p += 4;
        var numPoints = dv.getInt32(p, true); p += 4;
        if (numParts > 0 && numPoints > 0 && numParts <= numPoints &&
            p + numParts * 4 + numPoints * 16 <= len) {
          var parts = new Array(numParts);
          for (var i = 0; i < numParts; i++) { parts[i] = dv.getInt32(p, true); p += 4; }
          var pts = new Array(numPoints);
          for (var j = 0; j < numPoints; j++) {
            pts[j] = [dv.getFloat64(p, true), dv.getFloat64(p + 8, true)];
            p += 16;
          }
          var rings = [];
          for (var pi = 0; pi < numParts; pi++) {
            var start = parts[pi];
            var end = (pi + 1 < numParts) ? parts[pi + 1] : numPoints;
            if (start < 0 || end > numPoints || end <= start) continue;
            var ring = [];
            for (var ri = start; ri < end; ri++) ring.push(pts[ri]);
            if (ring.length >= 3) rings.push(ring);
          }
          if (rings.length) polygons.push({ recNo: recNo, rings: rings, bboxLL: rbb });
        }
      }
    } catch (e) { /* 单条记录坏掉不影响整层 */ }
    off = roff + contentLen;
  }
  return { polygons: polygons, shapeType: shapeType };
}

/* ---------- KML 解析 ---------- */
function parseKml(kmlText) {
  var polygons = [];
  var props = [];
  var parser = new DOMParser();
  var doc = parser.parseFromString(kmlText, 'text/xml');
  var pms = doc.getElementsByTagName('Placemark');
  for (var i = 0; i < pms.length; i++) {
    var pm = pms[i];
    var nameEl = pm.getElementsByTagName('name')[0];
    var nm = nameEl ? nameEl.textContent.trim() : '';
    // 属性：ExtendedData
    var pr = { name: nm };
    var sds = pm.getElementsByTagName('SimpleData');
    for (var si = 0; si < sds.length; si++) {
      var sd = sds[si];
      var k = sd.getAttribute('name');
      if (k) pr[k] = sd.textContent.trim();
    }
    // 属性：description 里的 HTML 表格
    var descEl = pm.getElementsByTagName('description')[0];
    if (descEl) {
      var dhtml = descEl.textContent || '';
      // 解析 <tr><td>key</td><td>value</td></tr>
      var trRe = /<tr[^>]*>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<\/tr>/gi;
      var m;
      while ((m = trRe.exec(dhtml)) !== null) {
        var dk = m[1].replace(/<[^>]+>/g, '').trim();
        var dv = m[2].replace(/<[^>]+>/g, '').trim();
        if (dk && !(dk in pr)) pr[dk] = dv;
      }
    }
    // 几何：Polygon / MultiGeometry
    var rings = [];
    var polys = pm.getElementsByTagName('Polygon');
    for (var pi = 0; pi < polys.length; pi++) {
      var coordEls = polys[pi].getElementsByTagName('coordinates');
      for (var ci = 0; ci < coordEls.length; ci++) {
        var txt = coordEls[ci].textContent.trim();
        var ring = [];
        var parts = txt.split(/\s+/);
        for (var vi = 0; vi < parts.length; vi++) {
          var c = parts[vi].split(',');
          if (c.length >= 2) {
            var lon = parseFloat(c[0]), lat = parseFloat(c[1]);
            if (isFinite(lon) && isFinite(lat)) ring.push([lon, lat]);
          }
        }
        if (ring.length >= 3) rings.push(ring);
      }
    }
    if (rings.length) {
      polygons.push({ recNo: i + 1, rings: rings });
      props.push(pr);
    }
  }
  var fields = props.length ? Object.keys(props[0]) : [];
  return { polygons: polygons, props: props, fields: fields };
}

/* ---------- MIF/MID 解析（文本格式） ---------- */
function parseMif(mifText, midText) {
  var polygons = [];
  var props = [];
  var fields = [];
  // 解析 MID 属性（CSV 风格）
  var midRows = [];
  if (midText) {
    var lines = midText.split(/\r?\n/);
    for (var li = 0; li < lines.length; li++) {
      var ln = lines[li].trim();
      if (!ln) continue;
      // 简单 CSV 解析（处理引号）
      var row = [], cur = '', inQ = false;
      for (var ci = 0; ci < ln.length; ci++) {
        var ch = ln[ci];
        if (ch === '"') inQ = !inQ;
        else if (ch === ',' && !inQ) { row.push(cur); cur = ''; }
        else cur += ch;
      }
      row.push(cur);
      midRows.push(row);
    }
  }
  // 解析 MIF 几何
  var mifLines = mifText.split(/\r?\n/);
  var columns = [];
  var inData = false;
  var curPoly = null, curRings = null, curRing = null, ptsLeft = 0;
  var featIdx = 0;
  for (var mi = 0; mi < mifLines.length; mi++) {
    var l = mifLines[mi].trim();
    if (!l) continue;
    var ul = l.toUpperCase();
    if (ul.indexOf('COLUMNS') === 0) {
      var nc = parseInt(l.split(/\s+/)[1], 10);
      for (var fi = 0; fi < nc && mi + 1 < mifLines.length; fi++) {
        mi++;
        var colLine = mifLines[mi].trim();
        var cname = colLine.split(/\s+/)[0];
        columns.push(cname);
      }
      fields = columns.slice();
      continue;
    }
    if (ul === 'DATA') { inData = true; continue; }
    if (!inData) continue;
    if (ul.indexOf('REGION') === 0) {
      var nsec = parseInt(l.split(/\s+/)[1] || '1', 10);
      curRings = []; curRing = null; ptsLeft = 0;
      curPoly = { nsec: nsec, rings: curRings };
      continue;
    }
    if (curPoly) {
      var parts = l.split(/\s+/);
      if (ptsLeft === 0 && parts.length === 1) {
        // 新环的点数
        ptsLeft = parseInt(parts[0], 10);
        curRing = [];
        curRings.push(curRing);
      } else if (parts.length >= 2) {
        var lon = parseFloat(parts[0]), lat = parseFloat(parts[1]);
        if (isFinite(lon) && isFinite(lat)) curRing.push([lon, lat]);
        ptsLeft--;
        if (ptsLeft <= 0 && curRings.length >= curPoly.nsec) {
          // 完成一个多边形
          var pr = {};
          if (featIdx < midRows.length) {
            for (var cfi = 0; cfi < columns.length && cfi < midRows[featIdx].length; cfi++) {
              pr[columns[cfi]] = midRows[featIdx][cfi];
            }
          }
          polygons.push({ recNo: featIdx + 1, rings: curRings });
          props.push(pr);
          featIdx++;
          curPoly = null;
        }
      }
    }
  }
  return { polygons: polygons, props: props, fields: fields };
}

/* ---------- 统一入口 ---------- */
// files: { tab, dat, map, id } 或 { shp, shx, dbf, prj, cpg }
// onProgress(done, total) 可选：解析进度回调（total 可能为 0，表示未知总量）
// 返回 { name, polygons: [{ rings, props }] }
async function parseVectorFiles(files, baseName, onProgress) {
  var polygons, props = null, propFields = [];
  if (files.mif) {
    var mr = parseMif(files.mif, files.mid);
    polygons = mr.polygons;
    props = mr.props;
    propFields = mr.fields;
  } else if (files.kml) {
    var kr = parseKml(files.kml);
    polygons = kr.polygons;
    props = kr.props;
    propFields = kr.fields;
  } else if (files.geojson) {
    // GeoJSON FeatureCollection
    var gj = JSON.parse(files.geojson);
    polygons = [];
    var feats = gj.features || [];
    for (var fi = 0; fi < feats.length; fi++) {
      var g = feats[fi].geometry;
      if (!g) continue;
      var rings = [];
      if (g.type === 'Polygon') {
        for (var ri = 0; ri < g.coordinates.length; ri++) rings.push(g.coordinates[ri]);
      } else if (g.type === 'MultiPolygon') {
        for (var pi = 0; pi < g.coordinates.length; pi++)
          for (var rj = 0; rj < g.coordinates[pi].length; rj++) rings.push(g.coordinates[pi][rj]);
      }
      if (rings.length) polygons.push({ recNo: fi + 1, rings: rings });
    }
    if (feats.length) {
      props = feats.map(function (f) { return f.properties || {}; });
      propFields = Object.keys(props[0] || {});
    }
  } else if (files.map) {
    // MapInfo
    polygons = await parseMapInfo(files.map, files.id, onProgress);
    if (files.dat) {
      /* 有 .TAB 就按它声明的字段类型解（Float/Integer 在 .DAT 里是二进制） */
      var ftypes = files.tab ? parseTabFieldTypes(files.tab) : null;
      var tabEnc = files.tab ? parseTabCharset(files.tab) : null;
      var dbf = parseDbf(files.dat, tabEnc || 'gbk', ftypes);
      props = dbf.records;
      propFields = dbf.fields;
    }
  } else if (files.shp) {
    // Shapefile
    var res = await parseShp(files.shp, onProgress);
    polygons = res.polygons;
    if (files.dbf) {
      var enc = 'gbk';
      if (files.cpg) {
        try {
          var cpgText = new TextDecoder('utf-8').decode(files.cpg).trim().toLowerCase();
          if (cpgText.indexOf('utf-8') >= 0 || cpgText.indexOf('utf8') >= 0) enc = 'utf-8';
        } catch (e) {}
      }
      var dbf2 = parseDbf(files.dbf, enc);
      props = dbf2.records;
      propFields = dbf2.fields;
    }
  } else {
    throw new Error('缺少 .MAP 或 .SHP 文件');
  }
  // 只做属性挂接：不丢弃、不裁剪任何顶点或要素
  var out = [];
  for (var i = 0; i < polygons.length; i++) {
    var pg = polygons[i];
    if (!pg.rings || !pg.rings.length) continue;
    var pr = (props && pg.recNo >= 1 && pg.recNo <= props.length) ? props[pg.recNo - 1] : {};
    out.push({ rings: pg.rings, props: pr, bboxLL: pg.bboxLL || null });
  }
  return { name: baseName, polygons: out, fields: propFields };
}
