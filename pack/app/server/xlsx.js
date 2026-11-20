/**
 * 极简 XLSX 生成器（零依赖）
 *
 * 只用 Node 内置 zlib 拼装 OOXML 包，产出真正的 .xlsx（Excel / WPS / Numbers 均可打开）。
 * 支持：多工作表、表头样式、冻结首行、自动筛选、列宽、金额数字格式、数值单元格。
 *
 * 用法：
 *   const buf = xlsx.build([
 *     { name: '商铺台账', columns: [{ h: '名称', w: 22 }, { h: '面积', w: 12, t: 'num' }], rows: [['A铺', 88.5]] }
 *   ], { creator: '物业工程管理' });
 */
"use strict";

const zlib = require("zlib");

/* ---------------- CRC32 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/* ---------------- ZIP 容器 ---------------- */
// 固定时间戳 2026-01-01 00:00，避免不同机器产出不同字节
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const src = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, "utf8");
    const comp = zlib.deflateRawSync(src, { level: 9 });
    const crc = crc32(src);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    lh.writeUInt16LE(8, 8); // deflate
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(src.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);

    locals.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(src.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + comp.length;
  }

  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localBuf, centralBuf, eocd]);
}

/* ---------------- XML 工具 ---------------- */
function xmlEsc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // 去掉 XML 1.0 不允许的控制字符
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

function colName(i) {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function sheetNameSafe(name, used) {
  let n = String(name || "Sheet").replace(/[\\/?*\[\]:]/g, "·").slice(0, 31) || "Sheet";
  let base = n;
  let i = 2;
  while (used.has(n)) {
    const suffix = `(${i++})`;
    n = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(n);
  return n;
}

const HEADER_CELL = 1; // cellXfs 索引：表头
const BODY_TEXT = 0;
const BODY_MONEY = 2;

/* ---------------- 工作表 ---------------- */
function sheetXml(sheet, isFirst) {
  const cols = sheet.columns || [];
  const rows = sheet.rows || [];
  const colCount = Math.max(cols.length, ...rows.map((r) => r.length), 1);

  // 表头行
  const headerCells = [];
  for (let c = 0; c < colCount; c++) {
    const col = cols[c] || {};
    const ref = colName(c) + "1";
    headerCells.push(
      `<c r="${ref}" s="${HEADER_CELL}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(col.h || "")}</t></is></c>`
    );
  }

  const body = [];
  rows.forEach((row, ri) => {
    const r = ri + 2;
    const cells = [];
    for (let c = 0; c < colCount; c++) {
      const col = cols[c] || {};
      const v = row[c];
      const ref = colName(c) + r;
      if (v === null || v === undefined || v === "") {
        cells.push(`<c r="${ref}" s="${BODY_TEXT}"/>`);
      } else if (col.t === "num" && Number.isFinite(Number(v))) {
        const style = col.money === false ? BODY_TEXT : BODY_MONEY;
        cells.push(`<c r="${ref}" s="${style}"><v>${Number(v)}</v></c>`);
      } else {
        cells.push(`<c r="${ref}" s="${BODY_TEXT}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`);
      }
    }
    body.push(`<row r="${r}">${cells.join("")}</row>`);
  });

  const lastRef = colName(colCount - 1) + (rows.length + 1);
  const dim = `A1:${lastRef}`;

  const colsXml = cols.length
    ? `<cols>${cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.w || 14}" customWidth="1"/>`).join("")}</cols>`
    : "";

  const pane = rows.length
    ? `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="${dim}"/>
<sheetViews><sheetView${isFirst ? ' tabSelected="1"' : ""} showGridLines="0" workbookViewId="0">${pane}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="17"/>
${colsXml}
<sheetData>
<row r="1" ht="26" customHeight="1">${headerCells.join("")}</row>
${body.join("\n")}
</sheetData>
${rows.length ? `<autoFilter ref="${dim}"/>` : ""}
<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>
</worksheet>`;
}

/* ---------------- 样式 ---------------- */
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
<fonts count="2">
<font><sz val="10.5"/><color rgb="FF1F2937"/><name val="微软雅黑"/><charset val="134"/></font>
<font><b/><sz val="10.5"/><color rgb="FFFFFFFF"/><name val="微软雅黑"/><charset val="134"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1E40AF"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border>
<left style="thin"><color rgb="FFE5E7EB"/></left>
<right style="thin"><color rgb="FFE5E7EB"/></right>
<top style="thin"><color rgb="FFE5E7EB"/></top>
<bottom style="thin"><color rgb="FFE5E7EB"/></bottom>
<diagonal/>
</border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3">
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" horizontal="right"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/* ---------------- 主入口 ---------------- */
function build(sheets, opt) {
  opt = opt || {};
  const list = (sheets || []).filter(Boolean);
  if (!list.length) throw new Error("导出内容为空");

  const used = new Set();
  const named = list.map((s) => ({ ...s, name: sheetNameSafe(s.name, used) }));

  const files = [];

  // [Content_Types].xml
  const overrides = named
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join("");
  files.push({
    name: "[Content_Types].xml",
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${overrides}
</Types>`
  });

  // _rels/.rels
  files.push({
    name: "_rels/.rels",
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
  });

  // xl/workbook.xml
  files.push({
    name: "xl/workbook.xml",
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="1"/>
<workbookPr/>
<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="14000"/></bookViews>
<sheets>${named.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>
<calcPr calcId="0" fullCalcOnLoad="1"/>
</workbook>`
  });

  // xl/_rels/workbook.xml.rels
  const rels = named
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join("");
  files.push({
    name: "xl/_rels/workbook.xml.rels",
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${rels}
<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
  });

  // xl/styles.xml
  files.push({ name: "xl/styles.xml", data: STYLES_XML });

  // 各工作表
  named.forEach((s, i) => {
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s, i === 0) });
  });

  return zip(files);
}

module.exports = { build };
