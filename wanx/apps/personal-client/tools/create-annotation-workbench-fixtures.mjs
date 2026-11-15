import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import JSZip from "jszip";
import { extractAnnotationContent } from "../shell/annotation-content.mjs";

const xml = value => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${value}`;
const packageNS = "http://schemas.openxmlformats.org/package/2006/relationships";
const officeNS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const typesNS = "http://schemas.openxmlformats.org/package/2006/content-types";
const slideNS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const drawingNS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const relationships = entries => xml(`<Relationships xmlns="${packageNS}">${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${officeNS}/${type}" Target="${target}"/>`).join("")}</Relationships>`);
const contentTypes = entries => xml(`<Types xmlns="${typesNS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${entries.map(([part, type]) => `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}"/>`).join("")}</Types>`);
async function zip(files) {
  const archive = new JSZip();
  for (const [name, value] of Object.entries(files)) archive.file(name, value, { date: new Date("2026-11-15T00:00:00Z"), createFolders: false });
  return archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

function pdfDocument(objects, trailer = "") {
  const parts = [Buffer.from("%PDF-1.4\n%synthetic-workbench-qa\n")], offsets = [0];
  let length = parts[0].length;
  for (const [index, value] of objects.entries()) {
    offsets.push(length);
    const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.isBuffer(value) ? value : Buffer.from(value), Buffer.from("\nendobj\n")]);
    parts.push(object); length += object.length;
  }
  const xref = length;
  const table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Root 1 0 R /Size ${objects.length + 1} ${trailer} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.concat([...parts, Buffer.from(table)]);
}
const pdfStream = (bytes, entries = "") => Buffer.concat([Buffer.from(`<< /Length ${bytes.length} ${entries} >>\nstream\n`), bytes, Buffer.from("\nendstream")]);
function textPDF() {
  const text = ["SYNTHETIC ANNOTATION WORKBENCH QA", "Synthetic Amber Harbor project report.", "Budget review and contract planning. No real customer data."];
  const commands = text.map((line, index) => `BT /F1 14 Tf 30 ${170 - index * 30} Td (${line.replace(/[\\()]/g, value => "\\" + value)}) Tj ET`).join("\n");
  return pdfDocument([
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 240] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    pdfStream(Buffer.from(commands)),
  ]);
}
function syntheticPixels() {
  const width = 160, height = 80, pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i += 3) { pixels[i] = 250; pixels[i + 1] = 244; pixels[i + 2] = 230; }
  const alphabet = {
    A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"], C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
    E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"], H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
    I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"], N: ["10001", "11001", "11001", "10101", "10011", "10011", "10001"],
    Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"], S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
    T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"], Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  };
  const draw = (text, x, y) => {
    for (const [index, letter] of [...text].entries()) for (const [row, bits] of alphabet[letter].entries()) for (const [column, bit] of [...bits].entries()) {
      if (bit !== "1") continue;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const offset = ((y + row * 2 + dy) * width + x + index * 12 + column * 2 + dx) * 3;
        pixels[offset] = 75; pixels[offset + 1] = 56; pixels[offset + 2] = 40;
      }
    }
  };
  draw("SYNTHETIC", 24, 19); draw("QA", 67, 45);
  return { width, height, pixels };
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(image) {
  const chunk = (type, body) => {
    const name = Buffer.from(type), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(body.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, body])));
    return Buffer.concat([size, name, body, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(image.width); header.writeUInt32BE(image.height, 4); header[8] = 8; header[9] = 2;
  const rows = [];
  for (let y = 0; y < image.height; y++) rows.push(Buffer.from([0]), image.pixels.subarray(y * image.width * 3, (y + 1) * image.width * 3));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("tEXt", Buffer.from("Description\0SYNTHETIC QA ONLY - NO REAL DATA")), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}
function scannedPDF(image) {
  return pdfDocument([
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 480 240] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>",
    pdfStream(Buffer.from("q 480 0 0 240 0 0 cm /Im0 Do Q")),
    pdfStream(deflateSync(image.pixels), `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`),
  ]);
}
async function docx() {
  return zip({
    "[Content_Types].xml": contentTypes([["word/document.xml", "wordprocessingml.document.main+xml"]]),
    "_rels/.rels": relationships([["rId1", "officeDocument", "word/document.xml"]]),
    "word/document.xml": xml('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>SYNTHETIC QA ONLY - NO REAL DATA</w:t></w:r></w:p><w:p><w:r><w:t>Synthetic Amber Harbor contract agreement for annotation review.</w:t></w:r></w:p><w:p><w:r><w:t>Fictional amount: 1200. Classification: project and contract.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>'),
  });
}
async function xlsx() {
  return zip({
    "[Content_Types].xml": contentTypes([["xl/workbook.xml", "spreadsheetml.sheet.main+xml"], ["xl/worksheets/sheet1.xml", "spreadsheetml.worksheet+xml"], ["xl/worksheets/sheet2.xml", "spreadsheetml.worksheet+xml"]]),
    "_rels/.rels": relationships([["rId1", "officeDocument", "xl/workbook.xml"]]),
    "xl/workbook.xml": xml(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${officeNS}"><sheets><sheet name="Synthetic Budget" sheetId="1" r:id="rId1"/><sheet name="Synthetic Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": relationships([["rId1", "worksheet", "worksheets/sheet1.xml"], ["rId2", "worksheet", "worksheets/sheet2.xml"]]),
    "xl/worksheets/sheet1.xml": xml('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>SYNTHETIC QA ONLY</t></is></c><c r="B1" t="inlineStr"><is><t>Fictional amount</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Amber Harbor budget</t></is></c><c r="B2"><v>1200</v></c></row></sheetData></worksheet>'),
    "xl/worksheets/sheet2.xml": xml('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>No real invoices, customers or financial records.</t></is></c></row></sheetData></worksheet>'),
  });
}
const groupTree = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const slideXML = text => xml(`<p:sld xmlns:a="${drawingNS}" xmlns:r="${officeNS}" xmlns:p="${slideNS}"><p:cSld><p:spTree>${groupTree}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Synthetic QA text"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="500000" y="500000"/><a:ext cx="11000000" cy="3000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="2400"/><a:t>${text}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
async function pptx() {
  return zip({
    "[Content_Types].xml": contentTypes([["ppt/presentation.xml", "presentationml.presentation.main+xml"], ["ppt/slides/slide1.xml", "presentationml.slide+xml"], ["ppt/slides/slide2.xml", "presentationml.slide+xml"], ["ppt/slideMasters/slideMaster1.xml", "presentationml.slideMaster+xml"], ["ppt/slideLayouts/slideLayout1.xml", "presentationml.slideLayout+xml"], ["ppt/theme/theme1.xml", "theme+xml"]]),
    "_rels/.rels": relationships([["rId1", "officeDocument", "ppt/presentation.xml"]]),
    "ppt/presentation.xml": xml(`<p:presentation xmlns:a="${drawingNS}" xmlns:r="${officeNS}" xmlns:p="${slideNS}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`),
    "ppt/_rels/presentation.xml.rels": relationships([["rId1", "slideMaster", "slideMasters/slideMaster1.xml"], ["rId2", "slide", "slides/slide1.xml"], ["rId3", "slide", "slides/slide2.xml"]]),
    "ppt/slides/slide1.xml": slideXML("SYNTHETIC QA ONLY - Amber Harbor project proposal"),
    "ppt/slides/slide2.xml": slideXML("Fictional training plan. No real customer data."),
    "ppt/slides/_rels/slide1.xml.rels": relationships([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]]),
    "ppt/slides/_rels/slide2.xml.rels": relationships([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]]),
    "ppt/slideMasters/slideMaster1.xml": xml(`<p:sldMaster xmlns:a="${drawingNS}" xmlns:r="${officeNS}" xmlns:p="${slideNS}"><p:cSld><p:spTree>${groupTree}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`),
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": relationships([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"], ["rId2", "theme", "../theme/theme1.xml"]]),
    "ppt/slideLayouts/slideLayout1.xml": xml(`<p:sldLayout xmlns:a="${drawingNS}" xmlns:r="${officeNS}" xmlns:p="${slideNS}" type="blank" preserve="1"><p:cSld name="Synthetic blank"><p:spTree>${groupTree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`),
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": relationships([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]),
    "ppt/theme/theme1.xml": xml(`<a:theme xmlns:a="${drawingNS}" name="Synthetic QA"><a:themeElements><a:clrScheme name="Synthetic"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="403020"/></a:dk2><a:lt2><a:srgbClr val="FAF4E6"/></a:lt2>${["B58550", "628764", "778AA0", "A67B8C", "B09E69", "8A7DAD"].map((color, index) => `<a:accent${index + 1}><a:srgbClr val="${color}"/></a:accent${index + 1}>`).join("")}<a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="Synthetic"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Synthetic"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`),
  });
}

async function createFixtures() {
  const args = process.argv.slice(2);
  let directory = fileURLToPath(new URL("../.local/workbench-qa-20261115/files/", import.meta.url));
  if (args.length === 1 && !args[0].startsWith("--")) directory = args[0];
  else if (args.length === 1 && args[0].startsWith("--dir=")) directory = args[0].slice(6);
  else if (args.length === 2 && args[0] === "--dir") directory = args[1];
  else if (args.length) throw new Error("Usage: node tools/create-annotation-workbench-fixtures.mjs [--dir <directory>]");
  directory = path.resolve(directory);
  if (directory === path.parse(directory).root) throw new Error("A dedicated fixture directory is required.");
  const image = syntheticPixels();
  const fixtures = [
    ["01-synthetic-project.txt", Buffer.from("SYNTHETIC QA ONLY - NO REAL DATA\nAmber Harbor project proposal and contract review.\n"), "content"],
    ["02-synthetic-meeting.md", Buffer.from("# SYNTHETIC QA ONLY\n\nFictional weekly meeting minutes.\n\n- Review Amber Harbor project budget.\n- Training document, not a real decision.\n"), "content"],
    ["03-synthetic-budget.csv", Buffer.from("notice,project,fictional_amount\nSYNTHETIC_QA_ONLY,Amber_Harbor,1200\nNO_REAL_DATA,Training,300\n"), "content"],
    ["04-synthetic-catalog.json", Buffer.from(JSON.stringify({ synthetic: true, notice: "SYNTHETIC QA ONLY - NO REAL DATA", project: "Amber Harbor", topics: ["project", "finance", "training"] }, null, 2) + "\n"), "content"],
    ["05-synthetic-report.pdf", textPDF(), "content"],
    ["06-synthetic-contract.docx", await docx(), "content"],
    ["07-synthetic-expenses.xlsx", await xlsx(), "content"],
    ["08-synthetic-proposal.pptx", await pptx(), "content"],
    ["09-synthetic-image.png", png(image), "name-only", "SPACE_ANNOTATION_IMAGE_NO_OCR"],
    ["10-synthetic-scan.pdf", scannedPDF(image), "name-only", "SPACE_ANNOTATION_PDF_NO_TEXT"],
    ["11-synthetic-archive.zip", await zip({ "SYNTHETIC-QA-ONLY.txt": "SYNTHETIC QA ONLY - NO REAL DATA. Archive content is not automatically expanded for annotation.\n" }), "name-only", "SPACE_ANNOTATION_CONTENT_UNSUPPORTED"],
    ["12-synthetic-opaque.bin", Buffer.concat([Buffer.from("SYNTHETIC QA ONLY - NO REAL DATA\0"), Buffer.from([0, 255, 1, 254, 2, 253])]), "name-only", "SPACE_ANNOTATION_CONTENT_UNSUPPORTED"],
  ];
  const items = [];
  for (const [name, bytes, expectedMode, expectedReason] of fixtures) {
    const parsed = await extractAnnotationContent({ entry: { name, kind: "file", size: bytes.length }, bytes });
    if (parsed.mode !== expectedMode || expectedReason && parsed.reason !== expectedReason || expectedMode === "content" && !/synthetic/i.test(parsed.content))
      throw new Error(`Synthetic fixture failed validation: ${name}`);
    const filename = path.join(directory, name);
    try { if (!(await readFile(filename)).equals(bytes)) throw new Error(`Refusing to overwrite an existing different file: ${filename}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    items.push({ name, file: filename, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), expectedMode, expectedReason: expectedReason || null, expectedFormat: parsed.format, expectedContentContains: expectedMode === "content" ? "SYNTHETIC" : null });
  }
  const manifest = { fixtureSet: "annotation-workbench-20261115-v1", syntheticOnly: true, containsRealData: false, directory, total: items.length, contentSupported: items.filter(item => item.expectedMode === "content").length, nameOnly: items.filter(item => item.expectedMode === "name-only").length, items };
  const manifestPath = directory + ".manifest.json", manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  try { if (!(await readFile(manifestPath)).equals(manifestBytes)) throw new Error(`Refusing to overwrite an existing different manifest: ${manifestPath}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [name, bytes] of fixtures) {
    try { await writeFile(path.join(directory, name), bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  try { await writeFile(manifestPath, manifestBytes, { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  console.log(JSON.stringify({ ...manifest, manifestPath }, null, 2));
}

await createFixtures();
