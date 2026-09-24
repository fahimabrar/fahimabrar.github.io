// engine/pdftools.js
// PDF text extraction (pdf.js), OCR for scanned pages (tesseract.js) and
// redaction (canvas + pdf-lib). Everything happens in the browser.
//
// Redaction output: every page is rasterised, black boxes are painted over
// the matched text, and the image is written into a fresh PDF. No text layer
// survives, so nothing can be recovered by copy/paste or text search.

// All components are served from this site (see vendor/). Absolute URLs are
// built from the page address because the OCR worker resolves paths itself.
const abs = p => new URL(p, window.location.href).href;
const PDFJS_WORKER   = abs("./vendor/pdfjs/pdf.worker.min.js");
const TESS_WORKER    = abs("./vendor/tesseract/worker.min.js");
const TESS_CORE_DIR  = abs("./vendor/tesseract-core");
const TESS_LANG_DIR  = abs("./vendor/tessdata");

function pdfjs() {
  const lib = window.pdfjsLib;
  if (!lib) throw new Error("pdf.js failed to load. Reload the page.");
  if (!lib.GlobalWorkerOptions.workerSrc) lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  return lib;
}

// ── Text extraction for digital PDFs ─────────────────────────────────────────
// Builds page text plus a per-character map back to the pdf.js text item and
// the character index inside it, so redaction can locate exact glyph runs.
async function extractDigitalPage(page) {
  const tc    = await page.getTextContent();
  const items = tc.items.filter(it => typeof it.str === "string");

  let text = "";
  const map = [];
  let lastX2 = null, lastY = null, lastEOL = true;

  items.forEach((it, idx) => {
    const x = it.transform[4], y = it.transform[5];

    if (it.str.length) {
      if (!lastEOL && lastY !== null) {
        if (Math.abs(y - lastY) > 2) {
          text += "\n"; map.push(null);
        } else if (x - lastX2 > 1.0 && !/\s$/.test(text) && !/^\s/.test(it.str)) {
          text += " "; map.push(null);
        }
      }
      for (let ci = 0; ci < it.str.length; ci++) {
        text += it.str[ci];
        map.push({ item: idx, ci });
      }
      lastX2  = x + it.width;
      lastY   = y;
      lastEOL = false;
    }
    if (it.hasEOL) {
      text += "\n"; map.push(null);
      lastEOL = true;
    }
  });

  return { text, map, items, styles: tc.styles || {} };
}

// ── OCR for scanned pages ─────────────────────────────────────────────────────
function ocrLines(data) {
  const lines = [];
  const pushLine = ln => {
    const ws = (ln.words || []).filter(w => w.text && w.text.trim());
    if (ws.length) lines.push(ws.map(w => ({ text: w.text.trim(), bbox: w.bbox })));
  };

  if (Array.isArray(data.blocks) && data.blocks.length) {
    data.blocks.forEach((b, bi) => {
      if (bi > 0) lines.push([]);                       // blank line between blocks
      for (const p of b.paragraphs || []) for (const ln of p.lines || []) pushLine(ln);
    });
  } else if (Array.isArray(data.lines) && data.lines.length) {
    for (const ln of data.lines) pushLine(ln);
  } else if (Array.isArray(data.words)) {
    pushLine({ words: data.words });
  }
  return lines;
}

async function ocrPage(page, worker, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width  = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

  const { data } = await worker.recognize(canvas);
  const lines = ocrLines(data);

  let text = "";
  const map = [];
  const words = [];

  lines.forEach((line, li) => {
    if (li > 0) { text += "\n"; map.push(null); }
    line.forEach((w, wi) => {
      if (wi > 0) { text += " "; map.push(null); }
      const widx = words.length;
      words.push({ text: w.text, bbox: w.bbox });
      for (let k = 0; k < w.text.length; k++) {
        text += w.text[k];
        map.push({ word: widx });
      }
    });
  });

  return { text, map, words, ocrScale: scale };
}

// ── Public: analyse a PDF ─────────────────────────────────────────────────────
/**
 * Returns { pdf, pages, text, ocrUsed }.
 *   pages[i] = { index, width, height, kind: "text"|"ocr", text, map, ... }
 *   text     = page texts joined with "\n\n"
 */
export async function analysePdf(bytes, onProgress) {
  const say = m => { try { onProgress && onProgress(m); } catch (e) {} };
  const lib = pdfjs();
  const pdf = await lib.getDocument({ data: bytes }).promise;
  const n   = pdf.numPages;
  const pages = [];

  for (let i = 1; i <= n; i++) {
    say(`Reading page ${i} of ${n}`);
    const page = await pdf.getPage(i);
    const vp   = page.getViewport({ scale: 1 });
    const d    = await extractDigitalPage(page);
    pages.push({ index: i - 1, width: vp.width, height: vp.height, kind: "text", ...d });
  }

  let ocrUsed = false;
  const joined = pages.map(p => p.text).join("\n\n");

  if (joined.trim().length < 100) {
    if (!window.Tesseract) throw new Error("This looks like a scanned PDF but the OCR library is not loaded. Reload the page.");
    ocrUsed = true;
    let current = 1;
    say("Scanned PDF detected. Starting OCR engine (first run fetches language data from this site)");
    const worker = await window.Tesseract.createWorker("eng", 1, {
      workerPath: TESS_WORKER,
      corePath:   TESS_CORE_DIR,
      langPath:   TESS_LANG_DIR,
      logger: m => {
        if (m.status === "recognizing text") say(`OCR page ${current} of ${n}: ${Math.round((m.progress || 0) * 100)}%`);
        else if (m.status) say(`OCR: ${m.status}`);
      },
    });
    try {
      for (let i = 1; i <= n; i++) {
        current = i;
        const page = await pdf.getPage(i);
        const d = await ocrPage(page, worker, 3);
        pages[i - 1] = { ...pages[i - 1], kind: "ocr", ...d };
      }
    } finally {
      await worker.terminate();
    }
  }

  let off = 0;
  for (const p of pages) { p.offset = off; off += p.text.length + 2; }

  return { pdf, pages, text: pages.map(p => p.text).join("\n\n"), ocrUsed };
}

// ── Redaction ─────────────────────────────────────────────────────────────────
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function findMatches(text, target) {
  const collapsed = target.replace(/\s+/g, " ").trim();
  if (!collapsed) return [];
  const pattern = collapsed.split(" ").map(escapeRe).join("\\s+");
  let re;
  try { re = new RegExp("(?<!\\w)" + pattern + "(?!\\w)", "gi"); }
  catch (e) { re = new RegExp(pattern, "gi"); }
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!m[0].length) { re.lastIndex++; continue; }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

function rectsForRange(p, a, b, viewport, meas) {
  const rects = [];

  if (p.kind === "ocr") {
    const s = viewport.scale / p.ocrScale;
    const idx = new Set();
    for (let i = a; i < b; i++) { const m = p.map[i]; if (m && m.word !== undefined) idx.add(m.word); }
    for (const i of idx) {
      const bb = p.words[i].bbox;
      rects.push({ x: bb.x0 * s, y: bb.y0 * s, w: (bb.x1 - bb.x0) * s, h: (bb.y1 - bb.y0) * s });
    }
    return rects;
  }

  // Digital page: group matched characters by text item
  const groups = new Map();
  for (let i = a; i < b; i++) {
    const m = p.map[i];
    if (!m) continue;
    const g = groups.get(m.item);
    if (!g) groups.set(m.item, { min: m.ci, max: m.ci });
    else { g.min = Math.min(g.min, m.ci); g.max = Math.max(g.max, m.ci); }
  }

  for (const [idx, g] of groups) {
    const it = p.items[idx];
    const style = p.styles[it.fontName] || {};
    const [ta, tb, tc, td, e, f] = it.transform;
    const fontSize = Math.hypot(tc, td) || Math.hypot(ta, tb) || it.height || 10;

    // Estimate glyph positions the same way pdf.js's text layer does:
    // measure with a fallback font and scale so the total matches item.width.
    meas.font = `${fontSize}px ${style.fontFamily || "sans-serif"}`;
    const total = meas.measureText(it.str).width || 1;
    const ratio = (it.width || total) / total;
    const pre   = meas.measureText(it.str.slice(0, g.min)).width * ratio;
    const wid   = meas.measureText(it.str.slice(g.min, g.max + 1)).width * ratio;

    const len  = Math.hypot(ta, tb) || 1, ux = ta / len, uy = tb / len;      // along-text direction
    const lenv = Math.hypot(tc, td) || 1, vx = tc / lenv, vy = td / lenv;    // up direction
    const asc = fontSize * 0.85, desc = fontSize * 0.25;
    const x0 = e + ux * pre, y0 = f + uy * pre;

    const corners = [
      [x0 - vx * desc,            y0 - vy * desc],
      [x0 + ux * wid - vx * desc, y0 + uy * wid - vy * desc],
      [x0 + vx * asc,             y0 + vy * asc],
      [x0 + ux * wid + vx * asc,  y0 + uy * wid + vy * asc],
    ].map(([x, y]) => viewport.convertToViewportPoint(x, y));

    const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    rects.push({ x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY });
  }
  return rects;
}

/**
 * Build a redacted PDF. `doc` is the object returned by analysePdf().
 * Returns { bytes: Uint8Array, hits, misses }.
 */
export async function buildRedactedPdf(doc, redactionTexts, onProgress, scale = 2) {
  const say = m => { try { onProgress && onProgress(m); } catch (e) {} };
  const PDFLib = window.PDFLib;
  if (!PDFLib) throw new Error("pdf-lib failed to load. Reload the page.");

  const targets = [...new Set(redactionTexts.filter(t => t && t.trim().length > 1))];
  const out = await PDFLib.PDFDocument.create();

  const canvas = document.createElement("canvas");
  const ctx    = canvas.getContext("2d");
  const meas   = document.createElement("canvas").getContext("2d");
  const pad    = 1.5 * scale;

  let hits = 0, misses = 0;

  for (const p of doc.pages) {
    say(`Redacting page ${p.index + 1} of ${doc.pages.length}`);
    const page     = await doc.pdf.getPage(p.index + 1);
    const viewport = page.getViewport({ scale });
    canvas.width   = Math.ceil(viewport.width);
    canvas.height  = Math.ceil(viewport.height);
    ctx.fillStyle  = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;

    ctx.fillStyle = "#000";
    for (const t of targets) {
      const matches = findMatches(p.text, t);
      if (!matches.length) { misses++; continue; }
      for (const [a, b] of matches) {
        for (const r of rectsForRange(p, a, b, viewport, meas)) {
          ctx.fillRect(r.x - pad, r.y - pad, r.w + 2 * pad, r.h + 2 * pad);
          hits++;
        }
      }
    }

    const jpeg = canvas.toDataURL("image/jpeg", 0.88);
    const img  = await out.embedJpg(jpeg);
    const pg   = out.addPage([p.width, p.height]);
    pg.drawImage(img, { x: 0, y: 0, width: p.width, height: p.height });

    await new Promise(r => setTimeout(r, 0));
  }

  const bytes = await out.save();
  return { bytes, hits, misses };
}

export async function closePdf(doc) {
  try { if (doc && doc.pdf) await doc.pdf.destroy(); } catch (e) {}
}
