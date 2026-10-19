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

/* ---------- MapInfo .MAP 解析 ---------- */
async function parseMapInfo(mapBuf, idBuf) {
  var dv = new DataView(mapBuf);
  var i32 = function (o) { return dv.getInt32(o, true); };
  var i16 = function (o) { return dv.getInt16(o, true); };
  var f64 = function (o) { return dv.getFloat64(o, true); };

  if (i32(0x100) !== 42424242) throw new Error('not a MapInfo .MAP file');
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

  var idDv = idBuf ? new DataView(idBuf) : null;
  var nId = idBuf ? Math.floor(idBuf.byteLength / 4) : 0;

  /* 坐标块游标：处理 512 字节块边界 */
  function CoordCursor(buf, start) {
    this.buf = buf; this.pos = start;
    this.dv = new DataView(buf);
  }
  CoordCursor.prototype.ensure = function () {
    var bs = 512;
    var blockStart = Math.floor(this.pos / bs) * bs;
    if (blockStart + 8 > this.buf.byteLength) return;
    if (this.dv.getUint16(blockStart, true) !== 3) return;
    var dataStart = blockStart + 8;
    var dataLen = this.dv.getUint16(blockStart + 2, true);
    var dataEnd = dataStart + dataLen;
    if (this.pos < dataStart) { this.pos = dataStart; return; }
    if (this.pos < dataEnd) return;
    var next = this.dv.getInt32(blockStart + 4, true);
    if (next <= 0 || next + 8 > this.buf.byteLength) throw new Error('coord block chain end');
    this.pos = next + 8;
  };
  CoordCursor.prototype.u16 = function () { this.ensure(); var v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; };
  CoordCursor.prototype.i16 = function () { this.ensure(); var v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; };
  CoordCursor.prototype.i32 = function () { this.ensure(); var v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; };

  function readMapIntCoord(cur, compressed, orgX, orgY) {
    var x, y;
    if (compressed) { x = cur.i16() + orgX; y = cur.i16() + orgY; }
    else { x = cur.i32(); y = cur.i32(); }
    return [x, y];
  }

  function readRegion(objOff) {
    var type = dv.getUint8(objOff);
    var compressed = (type === 0x0d);
    if (!compressed && type !== 0x0e) return [];
    var p = objOff + 5;
    var cptr = i32(p); p += 4;
    var csize = i32(p) & 0x7FFFFFFF; p += 4;
    var nsec = i16(p); p += 2;
    if (cptr <= 0 || csize <= 0 || nsec <= 0 || nsec > 10000) return [];
    var orgX = 0, orgY = 0;
    if (compressed) {
      p += 4; // label
      orgX = i32(p); orgY = i32(p + 4); p += 8;
      p += 8; // MBR
    } else {
      p += 8 + 16;
    }
    p += 2; // pen, brush

    var cur = new CoordCursor(mapBuf, cptr);
    var secSize = 24;
    var totalHdr = secSize * nsec;
    var secs = [];
    var totalV = 0;
    for (var s = 0; s < nsec; s++) {
      var nv = cur.u16();
      cur.u16(); // numHoles
      readMapIntCoord(cur, compressed, orgX, orgY); // xmin,ymin
      readMapIntCoord(cur, compressed, orgX, orgY); // xmax,ymax
      var doff = cur.i32();
      if (nv < 4 || doff < totalHdr) return [];
      var voff = Math.floor((doff - totalHdr) / 8);
      secs.push({ nv: nv, voff: voff });
      totalV += nv;
      if (totalV > 1000000) return [];
    }
    var coords = [];
    for (var k = 0; k < totalV; k++) {
      var xy = readMapIntCoord(cur, compressed, orgX, orgY);
      coords.push([toLon(xy[0]), toLat(xy[1])]);
    }
    var rings = [];
    for (var si = 0; si < secs.length; si++) {
      var sc = secs[si];
      var ring = coords.slice(sc.voff, sc.voff + sc.nv);
      // 过滤非法点
      var fring = [];
      for (var vi = 0; vi < ring.length; vi++) {
        var lon = ring[vi][0], lat = ring[vi][1];
        if (isFinite(lon) && isFinite(lat) && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90) {
          fring.push(ring[vi]);
        }
      }
      if (fring.length >= 3) rings.push(fring);
    }
    return rings;
  }

  var polygons = [];
  if (idDv && nId > 0) {
    for (var rec = 1; rec <= nId; rec++) {
      var off = idDv.getInt32((rec - 1) * 4, true);
      if (!off) continue;
      var t = dv.getUint8(off);
      if (t === 0x0d || t === 0x0e || t === 0x2e || t === 0x2f) {
        try {
          var rings = readRegion(off);
          if (rings.length) polygons.push({ recNo: rec, rings: rings });
        } catch (e) {}
      }
      if (rec % 50 === 0) await new Promise(function (r) { setTimeout(r, 0); });
    }
  }
  return polygons;
}

/* ---------- Shapefile .SHP 解析 ---------- */
function parseShp(shpBuf) {
  var dv = new DataView(shpBuf);
  // 头 100 字节：0-3 魔数 9994 (big-endian)，32-35 shapeType (little-endian)
  var shapeType = dv.getInt32(32, true);
  var polygons = [];
  var off = 100;
  var recNo = 0;
  while (off + 8 <= shpBuf.byteLength) {
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
        for (var ri = start; ri < end; ri++) {
          var _pt = pts[ri];
          if (_pt[0] < -180 || _pt[0] > 180 || _pt[1] < -90 || _pt[1] > 90) continue;
          ring.push(_pt);
        }
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
            if (isFinite(lon) && isFinite(lat) && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90) {
              ring.push([lon, lat]);
            }
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
    var res = parseShp(files.shp);
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
  // 合并属性 + 离群点过滤（去掉偏离主体的坏点，保留多边形主体）
  var out = [];
  for (var i = 0; i < polygons.length; i++) {
    var pg = polygons[i];
    // 收集所有点算中位数
    var lons = [], lats = [];
    for (var ri = 0; ri < pg.rings.length; ri++) {
      var ring = pg.rings[ri];
      for (var vi = 0; vi < ring.length; vi++) {
        lons.push(ring[vi][0]); lats.push(ring[vi][1]);
      }
    }
    if (!lons.length) continue;
    lons.sort(function (a, b) { return a - b; });
    lats.sort(function (a, b) { return a - b; });
    var medLon = lons[Math.floor(lons.length / 2)];
    var medLat = lats[Math.floor(lats.length / 2)];
    // 过滤偏离中位数超过 10 度的点
    var cleanRings = [];
    for (var rj = 0; rj < pg.rings.length; rj++) {
      var oring = pg.rings[rj];
      var cring = [];
      for (var vk = 0; vk < oring.length; vk++) {
        var lo = oring[vk][0], la = oring[vk][1];
        if (Math.abs(lo - medLon) <= 10 && Math.abs(la - medLat) <= 10) {
          cring.push(oring[vk]);
        }
      }
      if (cring.length >= 3) cleanRings.push(cring);
    }
    if (!cleanRings.length) continue;
    var pr = (props && pg.recNo >= 1 && pg.recNo <= props.length) ? props[pg.recNo - 1] : {};
    out.push({ rings: cleanRings, props: pr });
  }
  return { name: baseName, polygons: out, fields: propFields };
}
