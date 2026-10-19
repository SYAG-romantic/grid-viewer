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
function parseMapInfo(mapBuf, idBuf) {
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

  function readRegion(objOff) {
    var type = dv.getUint8(objOff);
    var compressed = (type === 0x0d || type === 0x2e || type === 0x2f);
    var p = objOff + 5;
    var cptr = i32(p); p += 4;
    var csize = i32(p); p += 4;
    csize &= 0x7FFFFFFF;
    var nsec, secSize;
    if (type >= 0x2e) { nsec = i32(p); p += 4 + 33; secSize = 28; }
    else { nsec = i16(p); p += 2; secSize = 24; }
    var orgX = 0, orgY = 0;
    if (compressed) {
      p += 4;
      orgX = i32(p); orgY = i32(p + 4); p += 8;
      p += 8;
    } else {
      p += 8 + 16;
    }
    p += 2; // penId, brushId

    var cdata = (cptr % 512 === 0) ? cptr + 8 : cptr;
    var hdrSize = secSize * nsec;
    var secs = [];
    var maxV = 0;
    for (var s = 0; s < nsec; s++) {
      var b = cdata + s * secSize;
      var nv = (type >= 0x2e) ? i32(b) : i16(b);
      var doff = i32(b + secSize - 4);
      var voff = Math.floor((doff - hdrSize) / (compressed ? 4 : 8));
      if (nv > 0 && voff >= 0) {
        secs.push({ nv: nv, voff: voff });
        if (voff + nv > maxV) maxV = voff + nv;
      }
    }
    var totalV = maxV;
    var vbase = cdata + hdrSize;
    var xs = new Int32Array(totalV), ys = new Int32Array(totalV);
    for (var k = 0; k < totalV; k++) {
      if (compressed) {
        xs[k] = dv.getInt16(vbase + k * 4, true) + orgX;
        ys[k] = dv.getInt16(vbase + k * 4 + 2, true) + orgY;
      } else {
        xs[k] = i32(vbase + k * 8);
        ys[k] = i32(vbase + k * 8 + 4);
      }
    }
    var rings = [];
    for (var si = 0; si < secs.length; si++) {
      var sc = secs[si];
      var ring = [];
      for (var vi = 0; vi < sc.nv; vi++) {
        var idx = sc.voff + vi;
        if (idx < 0 || idx >= totalV) continue;
        var lon = toLon(xs[idx]), lat = toLat(ys[idx]);
        if (lon < -180 || lon > 180 || lat < -90 || lat > 90) continue;
        ring.push([lon, lat]);
      }
      if (ring.length >= 3) rings.push(ring);
    }
    return rings;
  }

  var polygons = [];
  if (idDv && nId > 0) {
    for (var rec = 1; rec <= nId; rec++) {
      var off = idDv.getInt32((rec - 1) * 4, true);
      if (!off) continue;
      var t = dv.getUint8(off);
      if (t === 0x0d || t === 0x2e || t === 0x2f) {
        try {
          var rings = readRegion(off);
          if (rings.length) polygons.push({ recNo: rec, rings: rings });
        } catch (e) {}
      }
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

/* ---------- 统一入口 ---------- */
// files: { tab, dat, map, id } 或 { shp, shx, dbf, prj, cpg }
// 返回 { name, polygons: [{ rings, props }] }
function parseVectorFiles(files, baseName) {
  var polygons, props = null, propFields = [];
  if (files.kml) {
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
    polygons = parseMapInfo(files.map, files.id);
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
  // 合并属性
  var out = new Array(polygons.length);
  for (var i = 0; i < polygons.length; i++) {
    var pg = polygons[i];
    var pr = (props && pg.recNo >= 1 && pg.recNo <= props.length) ? props[pg.recNo - 1] : {};
    out[i] = { rings: pg.rings, props: pr };
  }
  return { name: baseName, polygons: out, fields: propFields };
}
