// engine/ner.js
// Name detection in the browser using Transformers.js and a quantised
// BERT NER model (CoNLL-03: PER / ORG / LOC / MISC). Only PER is used, to
// mirror the PERSON entity from spaCy in the Python version.
//
// The model (~110 MB), the Transformers.js library and its ONNX runtime are
// all served from this site (vendor/). Nothing is fetched from Hugging Face
// or any CDN. The service worker stores the files for offline use.
//
// Static hosts such as Cloudflare Pages refuse files over 25 MB, so the
// model is stored as numbered parts plus a small manifest. A fetch wrapper
// reassembles them transparently when Transformers.js asks for the .onnx.

const abs = p => new URL(p, window.location.href).href;
const TRANSFORMERS_URL = "../vendor/transformers/transformers.min.js";   // relative to this module
const WASM_DIR         = abs("./vendor/transformers/");
const MODELS_DIR       = abs("./vendor/models/");
const MODEL_ID         = "Xenova/bert-base-NER";

let pipe    = null;
let loading = null;
let status  = "idle";   // idle | loading | ready | failed
let lastError = null;
let progressHook = null;

export function nerStatus() { return { status, error: lastError }; }

// ── Reassemble split model files ─────────────────────────────────────────────
let fetchPatched = false;
function patchFetchForParts() {
  if (fetchPatched) return;
  fetchPatched = true;
  const orig = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (/\/vendor\/models\/.*\.onnx(\?.*)?$/.test(url)) return assembleParts(url, orig);
    return orig(input, init);
  };
}

async function assembleParts(url, orig) {
  const base = url.replace(/\?.*$/, "");
  const manifestRes = await orig(base + ".parts.json");
  if (!manifestRes.ok) return orig(url);            // no manifest: whole file is present
  const manifest = await manifestRes.json();
  const dir = base.replace(/[^/]+$/, "");
  const chunks = [];
  let loaded = 0;
  for (const part of manifest.parts) {
    const res = await orig(dir + part.name);
    if (!res.ok) throw new Error("Missing model part " + part.name);
    const buf = await res.arrayBuffer();
    chunks.push(buf);
    loaded += buf.byteLength;
    try {
      progressHook && progressHook({ status: "progress", file: manifest.file, loaded, total: manifest.size, progress: loaded / manifest.size * 100 });
    } catch (e) {}
  }
  return new Response(new Blob(chunks), {
    status: 200,
    headers: { "Content-Type": "application/octet-stream", "Content-Length": String(loaded) },
  });
}

/**
 * Load (or return the already loaded) token-classification pipeline.
 * onProgress receives Transformers.js progress objects:
 *   { status: "initiate"|"download"|"progress"|"done"|"ready", file, progress, loaded, total }
 */
export async function loadNer(onProgress) {
  if (pipe) return pipe;
  if (loading) return loading;

  status = "loading";
  progressHook = onProgress || null;
  loading = (async () => {
    patchFetchForParts();                              // must happen before the library is imported
    const { pipeline, env } = await import(TRANSFORMERS_URL);
    env.allowLocalModels  = true;
    env.allowRemoteModels = false;                     // never contact huggingface.co
    env.localModelPath    = MODELS_DIR;
    env.useBrowserCache   = false;                     // sw.js already stores the parts; avoid a second copy
    env.backends.onnx.wasm.wasmPaths = WASM_DIR;       // ONNX runtime from this site, not a CDN

    const p = await pipeline("token-classification", MODEL_ID, {
      dtype: "q8",
      progress_callback: info => { try { onProgress && onProgress(info); } catch (e) {} },
    });
    pipe = p;
    status = "ready";
    return p;
  })();

  try {
    return await loading;
  } catch (e) {
    status = "failed";
    lastError = e;
    loading = null;
    throw e;
  }
}

// ── Chunking (BERT is limited to 512 tokens) ─────────────────────────────────
function chunkText(text, max = 1200) {
  const chunks = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + max, text.length);
    if (end < text.length) {
      const window = text.slice(pos, end);
      const minCut = Math.floor(max * 0.5);
      const candidates = [
        window.lastIndexOf("\n\n"),
        window.lastIndexOf("\n"),
        window.lastIndexOf(". "),
        window.lastIndexOf(" "),
      ];
      for (const c of candidates) {
        if (c >= minCut) { end = pos + c + 1; break; }
      }
    }
    chunks.push({ text: text.slice(pos, end), offset: pos });
    pos = end;
  }
  return chunks;
}

// ── Token → word → character offsets ─────────────────────────────────────────
// Transformers.js does not return character offsets, so we rebuild them by
// walking the word-pieces and locating each one sequentially in the chunk.
const SPECIAL = new Set(["[CLS]", "[SEP]", "[PAD]", "[UNK]", "[MASK]"]);

// Model entity type -> app label (MISC is ignored: too noisy)
const NER_LABELS = { PER: "NAME", ORG: "ORGANISATION", LOC: "LOCATION" };

function tokensToWords(chunk, tokens) {
  const words = [];
  let cursor = 0;

  for (const t of tokens) {
    let w = t.word;
    if (!w || SPECIAL.has(w)) continue;
    const cont = w.startsWith("##");
    if (cont) w = w.slice(2);
    if (!w) continue;

    if (cont && words.length) {
      const prev = words[words.length - 1];
      if (chunk.startsWith(w, prev.end)) {
        prev.end  += w.length;
        prev.text += w;
        prev.scores.push(t.score);
        cursor = prev.end;
        continue;
      }
    }

    const pos = chunk.indexOf(w, cursor);
    if (pos < 0) continue;              // tokenizer normalised something we can't find; skip
    words.push({ text: w, start: pos, end: pos + w.length, entity: t.entity || "O", scores: [t.score] });
    cursor = pos + w.length;
  }
  return words;
}

function wordsToEntities(chunk, words) {
  const ents = [];
  let cur = null;

  for (const w of words) {
    const lab = w.entity;
    if (!lab || lab === "O" || lab.length < 3) { cur = null; continue; }
    const prefix = lab[0];               // "B" or "I"
    const type   = lab.slice(2);         // "PER", "ORG", ...

    if (cur && cur.type === type) {
      const gap = chunk.slice(cur.end, w.start);
      const joinable = prefix === "I" ? /^\s{0,2}$/.test(gap) : /^ ?$/.test(gap);
      if (joinable) {
        cur.end = w.end;
        cur.scores.push(...w.scores);
        continue;
      }
    }
    cur = { type, start: w.start, end: w.end, scores: [...w.scores] };
    ents.push(cur);
  }

  return ents.map(e => ({
    type:  e.type,
    start: e.start,
    end:   e.end,
    score: e.scores.reduce((a, b) => a + b, 0) / e.scores.length,
  }));
}

/**
 * Detect person names in `text`. Returns raw spans {start,end,label:"NAME",score}
 * suitable for resolveDetections(). onProgress(i, n) is called per chunk.
 */
export async function detectNames(text, onProgress) {
  const p = await loadNer();
  const chunks = chunkText(text);
  const out = [];

  for (let i = 0; i < chunks.length; i++) {
    onProgress && onProgress(i + 1, chunks.length);
    // Let the UI repaint between chunks (inference runs on the main thread)
    await new Promise(r => setTimeout(r, 0));

    const c = chunks[i];
    if (!c.text.trim()) continue;

    const tokens = await p(c.text, { ignore_labels: [] });
    const words  = tokensToWords(c.text, tokens);
    for (const e of wordsToEntities(c.text, words)) {
      const label = NER_LABELS[e.type];
      if (!label) continue;
      if (e.score < 0.5) continue;
      out.push({ start: e.start + c.offset, end: e.end + c.offset, label, score: e.score });
    }
  }
  return out;
}
