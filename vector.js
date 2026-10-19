/* vector.js — 矢量边界图层解析器
 * 支持 MapInfo (TAB/DAT/MAP/ID) 和 Shapefile (SHP/SHX/DBF/PRJ)
 * 输出统一格式：{ name, polygons: [ { rings: [ [[lon,lat],...], ... ], props: {...} } ] }
 */

/* ---------- DBF/dBase III 解析（DAT 和 DBF 共用） ---------- */
function parseDbf(buf, encoding) {
  var dv = new DataView(buf);
  var u8 = new Uint8Array(buf);
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
  var records = new Array(nRec);
  for (var r = 0; r < nRec; r++) {
    var base = hLen + r * rLen;
    var rec = {};
    for (var f = 0; f < fields.length; f++) {
      var fd = fields[f];
      var raw = u8.subarray(base + fd.off, base + fd.off + fd.len);
      var s = '';
      try { s = dec.decode(raw).trim(); } catch (e) { s = ''; }
      rec[fd.name] = s;
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

  function readRegion(objOff) {
    var d = readRegionDetail(objOff);
    if (!d) return null;
    var rings = [];
    for (var si = 0; si < d.secs.length; si++) {
      var sc = d.secs[si];
      if (sc.nv < 3) continue;                      // 少于 3 个点构不成环
      var end = sc.voff + sc.nv;
      if (end > d.maxIdx) end = d.maxIdx;
      if (end - sc.voff < 3) continue;
      var ring = new Array(end - sc.voff);
      for (var k = sc.voff, j = 0; k < end; k++, j++) ring[j] = [toLon(d.pts[k][0]), toLat(d.pts[k][1])];
      rings.push(ring);
    }
    return rings;
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

async function parseMapInfo(mapBuf, idBuf) {
  var R = createMapReader(mapBuf);
  var idBytes = idBuf ? ((idBuf instanceof Uint8Array) ? idBuf : new Uint8Array(idBuf)) : null;
  if (!idBytes) return [];
  var idDv = new DataView(idBytes.buffer, idBytes.byteOffset, idBytes.byteLength);
  var nId = Math.floor(idBytes.byteLength / 4);
  var polygons = [];
  for (var rec = 1; rec <= nId; rec++) {
    var off = idDv.getInt32((rec - 1) * 4, true);
    if (off > 0) {
      try {
        var rings = R.readRegion(off);
        if (rings && rings.length) polygons.push({ recNo: rec, rings: rings });
      } catch (e) { /* 单条记录异常不牵连整层 */ }
    }
    if (rec % 200 === 0) await new Promise(function (r) { setTimeout(r, 0); });
  }
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
async function parseShp(shpBuf) {
  var dv = new DataView(shpBuf);
  // 头 100 字节：0-3 魔数 9994 (big-endian)，32-35 shapeType (little-endian)
  var shapeType = dv.getInt32(32, true);
  var polygons = [];
  var off = 100;
  var recNo = 0;
  while (off + 8 <= shpBuf.byteLength) {
    if (recNo % 100 === 0) await new Promise(function (r) { setTimeout(r, 0); });
    var contentLen = dv.getInt32(off + 4, false) * 2; // big-endian，单位 16-bit word
    recNo++;
    var roff = off + 8;
    if (roff + 4 > shpBuf.byteLength) break;
    var st = dv.getInt32(roff, true);
    if (st === 5 || st === 15) { // Polygon / PolygonZ
      var p = roff + 4 + 32; // 跳过 shape type + bbox
      var numParts = dv.getInt32(p, true); p += 4;
      var numPoints = dv.getInt32(p, true); p += 4;
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
        var ring = [];
        for (var ri = start; ri < end; ri++) ring.push(pts[ri]);
        if (ring.length >= 3) rings.push(ring);
      }
      if (rings.length) polygons.push({ recNo: recNo, rings: rings });
    }
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
// 返回 { name, polygons: [{ rings, props }] }
async function parseVectorFiles(files, baseName) {
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
    polygons = await parseMapInfo(files.map, files.id);
    if (files.dat) {
      var dbf = parseDbf(files.dat, 'gbk');
      props = dbf.records;
      propFields = dbf.fields;
    }
  } else if (files.shp) {
    // Shapefile
    var res = await parseShp(files.shp);
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
    out.push({ rings: pg.rings, props: pr });
  }
  return { name: baseName, polygons: out, fields: propFields };
}
