// app.js
// UI logic for the browser-only PDF Anonymiser. No server: detection,
// OCR and redaction are performed by the modules in ./engine.

import { detectWithRegex, resolveDetections, buildCleanText, ENTITY_COLORS } from "./engine/recognisers.js";
import { loadNer, detectNames, nerStatus } from "./engine/ner.js";
import { analysePdf, buildRedactedPdf, closePdf } from "./engine/pdftools.js";

// ── State ─────────────────────────────────────────────────────────────────────
let state = freshState();
function freshState() {
  return {
    text:           "",
    detections:     [],
    piiRedacted:    {},   // { originalText: placeholder }
    manualRedacted: {},   // { wordId: { original, placeholder } }
    counters:       {},
    nextId:         0,
    source:         null, // "text" | "pdf"
    sourceName:     "",
    pdfDoc:         null, // result of analysePdf()
    nerUsed:        false,
  };
}

let pendingWordEl = null;
const AI_KEY    = "pdfanon_ai_enabled";
const AUDIT_KEY = "pdfanon_audit";

// Words that should prompt a confirmation before redacting
const COMMON_WORDS = new Set([
  "the","and","for","are","but","not","you","all","any","can","had",
  "her","was","one","our","out","said","she","who","did","its","let",
  "put","see","too","use","act","law","may","per","set","sub","nil",
  "ltd","plc","llp","esq","mr","mrs","ms","dr","sir","ref","no",
  "clause","term","party","date","name","address","agreement","contract",
  "section","schedule","appendix","exhibit","herein","hereof","thereof",
]);

const $ = id => document.getElementById(id);

// ── Local engine: components, download progress, offline status ─────────────
// Everything the app ever fetches is listed here so the user can see what is
// being downloaded, from where, and when it is stored for offline use.
const RUNTIME_CACHE = "pdfanon-runtime-v2";      // must match sw.js
const SITE = location.host || "this site";
const abs  = p => new URL(p, location.href).href;
const LIB_URLS = [
  "./vendor/pdfjs/pdf.min.js",
  "./vendor/pdfjs/pdf.worker.min.js",
  "./vendor/pdf-lib/pdf-lib.min.js",
  "./vendor/tesseract/tesseract.min.js",
  "./vendor/tesseract/worker.min.js",
  "./vendor/fonts/fonts.css",
  "./vendor/fonts/playfair-display-latin-500-normal.woff2",
  "./vendor/fonts/playfair-display-latin-700-normal.woff2",
  "./vendor/fonts/playfair-display-latin-500-italic.woff2",
  "./vendor/fonts/crimson-pro-latin-400-normal.woff2",
  "./vendor/fonts/crimson-pro-latin-600-normal.woff2",
  "./vendor/fonts/crimson-pro-latin-400-italic.woff2",
  "./vendor/fonts/jetbrains-mono-latin-400-normal.woff2",
  "./vendor/fonts/jetbrains-mono-latin-500-normal.woff2",
].map(abs);

const COMPONENTS = {
  libs: {
    name:   "PDF reader, writer and fonts",
    size:   "about 3 MB",
    source: SITE,
    status: "checking",
  },
  ner: {
    name:   "Name detection model and AI runtime",
    size:   "about 135 MB",
    source: SITE,
    status: "checking",
    pct: 0, files: {},
  },
  ocr: {
    name:   "OCR engine and English language data",
    size:   "about 20 MB",
    source: SITE,
    status: "checking",
  },
};

function aiEnabled() {
  try { return localStorage.getItem(AI_KEY) !== "0"; } catch (e) { return true; }
}
function toggleAi(on) {
  try { localStorage.setItem(AI_KEY, on ? "1" : "0"); } catch (e) {}
  if (on) warmUpNer();
  else { COMPONENTS.ner.status = "off"; renderEngine(); }
}

function statusInfo(c) {
  switch (c.status) {
    case "checking":    return { cls: "",        text: "Checking this browser's storage" };
    case "pending":     return { cls: "",        text: "Not downloaded yet" };
    case "ondemand":    return { cls: "",        text: "Downloaded only if you open a scanned PDF" };
    case "off":         return { cls: "",        text: "Switched off. Patterns still work." };
    case "downloading": return { cls: "loading", text: c.pct != null
                                   ? `Downloading ${c.pct}%` + (c.totalMb ? ` (${c.loadedMb} of ${c.totalMb} MB)` : "")
                                   : "Downloading" };
    case "loading":     return { cls: "loading", text: "Loading from this browser's storage, no download" };
    case "ready":       return { cls: "ready",   text: "Stored in this browser. Works offline.", ok: true };
    case "nocache":     return { cls: "ready",   text: "Loaded (offline storage not available on this address)", ok: true };
    case "failed":      return { cls: "failed",  text: "Could not download. Connect once and reload.", bad: true };
    default:            return { cls: "",        text: "" };
  }
}

let renderQueued = false;
function renderEngine() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderEngineNow(); });
}

function renderEngineNow() {
  const items = Object.values(COMPONENTS).map(c => {
    const s = statusInfo(c);
    const bar = c.status === "downloading"
      ? `<div class="engine-bar${c.pct == null ? " indeterminate" : ""}"><div style="width:${c.pct == null ? 40 : c.pct}%"></div></div>`
      : "";
    return `<div class="engine-item">
      <span class="engine-dot ${s.cls}"></span>
      <div class="engine-body">
        <div class="engine-name">${c.name} <span class="engine-size">${c.size}</span></div>
        <div class="engine-meta${s.ok ? " ok" : s.bad ? " bad" : ""}">${s.text} · from ${c.source}</div>
        ${bar}
      </div>
    </div>`;
  }).join("");
  if ($("engine-list"))      $("engine-list").innerHTML      = items;
  if ($("engine-list-side")) $("engine-list-side").innerHTML = items;

  const all         = Object.values(COMPONENTS);
  const downloading = all.filter(c => c.status === "downloading");
  const failed      = all.filter(c => c.status === "failed");
  const needed      = ["libs", ...(aiEnabled() ? ["ner"] : [])].map(k => COMPONENTS[k]);
  const coreReady   = needed.every(c => c.status === "ready" || c.status === "nocache");
  const ocrPending  = COMPONENTS.ocr.status === "ondemand";

  let summary, banner = "", kind = "", pill;
  if (downloading.length) {
    summary = `Downloading: ${downloading.map(c => c.name.toLowerCase()).join(" and ")}.`;
    kind    = "info";
    banner  = "This is the only time the app uses the internet. It is fetching public software components from " +
              SITE + " (no third-party server) and sending nothing. Your text and documents stay on this computer.";
    pill    = "🔒 Downloading engine · nothing uploaded";
  } else if (failed.length && !coreReady) {
    summary = "Some components could not be downloaded.";
    kind    = "warn";
    banner  = "Connect to the internet once, reload the page, and the missing components will be fetched and stored. " +
              "Pattern-based detection (postcodes, phone numbers, dates and so on) still works without them.";
    pill    = "🔒 Runs locally · engine incomplete";
  } else if (coreReady) {
    summary = "Ready. Everything runs on this computer.";
    kind    = "ok";
    banner  = "✓ All components are stored in this browser. From now on the app works with the internet switched off. " +
              "Your text, documents, detected items and redactions are processed here and never leave this device." +
              (ocrPending ? " OCR language data will be fetched only if you open a scanned PDF." : "");
    pill    = "🔒 Offline-ready · nothing uploaded";
  } else {
    summary = "Preparing the local engine.";
    pill    = "🔒 Runs locally · nothing uploaded";
  }

  if ($("engine-summary")) $("engine-summary").textContent = summary;
  const b = $("engine-banner");
  if (b) { b.className = "engine-banner" + (kind ? " visible " + kind : ""); b.textContent = banner; }
  const sb = $("engine-side-banner");
  if (sb) { sb.className = "side-banner" + (kind ? " visible " + kind : ""); sb.textContent = banner; }
  if ($("privacy-pill")) $("privacy-pill").textContent = pill;
}

// Is a URL matching `test` present in any Cache Storage cache?
async function cacheHas(test) {
  try {
    if (!window.caches) return false;
    for (const name of await caches.keys()) {
      const c = await caches.open(name);
      for (const req of await c.keys()) if (test(req.url)) return true;
    }
  } catch (e) {}
  return false;
}
const checkNerCached = () => cacheHas(u => /bert-base-NER/i.test(u) && /\.onnx(\.part\d+)?(\?|$)/.test(u));
const checkOcrCached = async () =>
  (await cacheHas(u => /traineddata/.test(u))) && (await cacheHas(u => /tesseract-core/.test(u)));

// Make sure the libraries are in the offline cache (first visit loads them
// before the service worker is in control, so they would otherwise be missing).
async function ensureLibsCached() {
  const c = COMPONENTS.libs;
  if (!("serviceWorker" in navigator) || !window.caches) { c.status = window.pdfjsLib ? "nocache" : "failed"; renderEngine(); return; }
  try {
    const ready = await Promise.race([
      navigator.serviceWorker.ready.then(() => true),
      new Promise(r => setTimeout(() => r(false), 8000)),
    ]);
    if (!ready) { c.status = window.pdfjsLib ? "nocache" : "failed"; renderEngine(); return; }

    const cache   = await caches.open(RUNTIME_CACHE);
    const missing = [];
    for (const u of LIB_URLS) if (!(await cache.match(u))) missing.push(u);
    if (missing.length) {
      c.status = "downloading"; c.pct = null; renderEngine();
      for (const u of missing) await cache.add(u);
    }
    c.status = "ready";
  } catch (e) {
    console.warn("Library caching failed:", e);
    c.status = window.pdfjsLib ? "nocache" : "failed";
  }
  renderEngine();
}

function onNerProgress(info) {
  const c = COMPONENTS.ner;
  if (info && info.file && (info.status === "progress" || info.status === "done")) {
    const total  = info.total || (c.files[info.file] && c.files[info.file].total) || 0;
    const loaded = info.status === "done" ? total : (info.loaded || 0);
    c.files[info.file] = { loaded, total };
  }
  const files  = Object.values(c.files).filter(f => f.total > 0);
  const loaded = files.reduce((a, f) => a + f.loaded, 0);
  const total  = files.reduce((a, f) => a + f.total, 0);
  if (total > 0) {
    c.pct      = Math.min(100, Math.round(loaded / total * 100));
    c.loadedMb = (loaded / 1048576).toFixed(0);
    c.totalMb  = (total  / 1048576).toFixed(0);
  }
  if (info && info.status === "ready") c.pct = 100;
  renderEngine();
}

async function warmUpNer() {
  const c = COMPONENTS.ner;
  if (!aiEnabled()) { c.status = "off"; renderEngine(); return; }
  if (nerStatus().status === "ready") { c.status = "ready"; renderEngine(); return; }

  const cached = await checkNerCached();
  c.status = cached ? "loading" : "downloading";
  c.pct = cached ? null : 0; c.files = {}; c.loadedMb = c.totalMb = null;
  renderEngine();

  try {
    await loadNer(onNerProgress);
    c.status = "ready";
    renderEngine();
    if (!cached) showToast("Name detection model downloaded and stored in this browser. No further downloads are needed.", "green");
  } catch (e) {
    console.warn("NER unavailable:", e);
    c.status = "failed";
    renderEngine();
  }
}

// ── Live network monitor ─────────────────────────────────────────────────────
// Green: nothing is being fetched. Red: a request is in flight (or an
// external host was contacted, which should never happen). The service
// worker reports every request, including those from the OCR and PDF
// workers. Without a service worker, the page's own fetches are monitored.
const NET = {
  inflight: new Map(),      // id -> { url, t }
  log: [],                  // newest first: { t, source, url }
  network: 0, cache: 0,
  external: new Set(),
  mode: "starting",         // "sw" | "page" | "starting"
  lastActivity: null,
};
const MAX_LOG = 200;

function shortUrl(u) {
  try {
    const x = new URL(u, location.href);
    if (x.origin === location.origin) return x.pathname.replace(/^\/+/, "") + (x.search || "") || "/";
    return x.host + x.pathname;
  } catch (e) { return String(u); }
}
function baseName(u) { return shortUrl(u).split("/").pop() || shortUrl(u); }

function netLogPush(source, url) {
  NET.log.unshift({ t: new Date(), source, url });
  if (NET.log.length > MAX_LOG) NET.log.length = MAX_LOG;
}

function handleNet(msg) {
  if (!msg || msg.type !== "net") return;
  NET.lastActivity = Date.now();
  if (msg.phase === "start") {
    NET.inflight.set(msg.id, { url: msg.url, t: Date.now() });
  } else if (msg.phase === "end") {
    NET.inflight.delete(msg.id);
    if (msg.source === "network") NET.network++;
    else if (msg.source === "cache") NET.cache++;
    netLogPush(msg.source, msg.url);
  } else if (msg.phase === "done") {
    if (msg.source === "cache") NET.cache++;
    netLogPush(msg.source, msg.url);
  } else if (msg.phase === "external") {
    try { NET.external.add(new URL(msg.url).host); } catch (e) { NET.external.add(String(msg.url)); }
    netLogPush("external", msg.url);
  }
  renderNet();
}

let netRenderQueued = false;
function renderNet() {
  if (netRenderQueued) return;
  netRenderQueued = true;
  requestAnimationFrame(() => { netRenderQueued = false; renderNetNow(); });
}

function renderNetNow() {
  const btn = $("net-btn"), txt = $("net-text");
  if (!btn) return;

  let cls, text;
  if (NET.external.size) {
    cls  = "warn";
    text = "External request: " + [...NET.external].join(", ");
  } else if (NET.inflight.size) {
    const first = [...NET.inflight.values()][0];
    cls  = "busy";
    text = "Network active: " + baseName(first.url) + (NET.inflight.size > 1 ? ` +${NET.inflight.size - 1}` : "");
  } else if (NET.mode === "starting") {
    cls  = "unknown";
    text = "Network monitor starting";
  } else {
    cls  = "idle";
    text = "Offline: no network activity";
  }
  btn.className = "net-btn " + cls;
  txt.textContent = text;
  btn.title = (NET.mode === "sw"
    ? "Every request from this page and its workers is reported by the service worker."
    : NET.mode === "page"
      ? "Service worker not active: only this page's own requests are monitored (not the OCR or PDF workers)."
      : "Waiting for the service worker.") + " Click for the log.";

  if (!$("net-panel").classList.contains("visible")) return;

  $("net-stat-network").querySelector("b").textContent = NET.network;
  $("net-stat-cache").querySelector("b").textContent   = NET.cache;
  const ext = $("net-stat-external");
  ext.querySelector("b").textContent = NET.external.size;
  ext.className = "net-stat " + (NET.external.size ? "bad" : "good");

  $("net-note").textContent = NET.mode === "sw"
    ? "Reported by the service worker, which sits between this site and the network and sees every request, including those from the OCR and PDF workers. Anything served from the stored copy never touched the network. Your documents are never in any request."
    : NET.mode === "page"
      ? "The service worker is not active on this address, so only the page's own requests are listed. Worker requests (OCR, PDF) are not shown here. Use the browser's Network tab (F12) for the complete picture."
      : "Waiting for the service worker to take control.";

  const rows = [];
  for (const [, r] of NET.inflight) rows.push(rowHtml(new Date(r.t), "inflight", r.url));
  for (const r of NET.log) rows.push(rowHtml(r.t, r.source, r.url));
  $("net-log").innerHTML = rows.length ? rows.join("") : '<div class="net-empty">No requests yet</div>';
}

function rowHtml(t, source, url) {
  const label = { network: "network", cache: "stored", inflight: "fetching", error: "failed", external: "EXTERNAL" }[source] || source;
  const time  = t.toTimeString().slice(0, 8);
  return `<div class="net-row"><span class="t">${time}</span><span class="src ${esc(source)}">${label}</span><span class="u" title="${esc(url)}">${esc(shortUrl(url))}</span></div>`;
}

function toggleNetPanel() {
  const p = $("net-panel");
  p.classList.toggle("visible");
  renderNet();
}
function clearNetLog() {
  NET.log = []; NET.network = 0; NET.cache = 0;
  renderNet();
}

// Fallback for pages without an active service worker: watch the page's own
// fetch() calls and completed resource loads.
let pageMonitorInstalled = false;
function installPageMonitor() {
  if (pageMonitorInstalled) return;
  pageMonitorInstalled = true;
  let seq = 0;
  const orig = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const id = "p" + (++seq);
    handleNet({ type: "net", phase: "start", id, url });
    try {
      const res = await orig(input, init);
      handleNet({ type: "net", phase: "end", id, url, source: "network", status: res.status });
      return res;
    } catch (e) {
      handleNet({ type: "net", phase: "end", id, url, source: "error" });
      throw e;
    }
  };
  try {
    const seen = new Set();
    const po = new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        if (e.initiatorType === "fetch" || seen.has(e.name)) continue;   // fetches are counted above
        seen.add(e.name);
        let external = false;
        try { external = new URL(e.name).origin !== location.origin; } catch (x) {}
        if (external) handleNet({ type: "net", phase: "external", url: e.name });
        else handleNet({ type: "net", phase: "done", url: e.name, source: e.transferSize > 0 ? "network" : "cache" });
      }
    });
    po.observe({ type: "resource", buffered: true });
  } catch (e) {}
}

function startNetMonitor() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", e => handleNet(e.data));
    const useSw = () => { NET.mode = "sw"; renderNet(); };
    if (navigator.serviceWorker.controller) useSw();
    else {
      navigator.serviceWorker.addEventListener("controllerchange", useSw);
      // If no worker takes control within a few seconds, fall back to page-level monitoring
      setTimeout(() => { if (NET.mode === "starting") { NET.mode = "page"; installPageMonitor(); renderNet(); } }, 9000);
    }
  } else {
    NET.mode = "page";
    installPageMonitor();
  }
  renderNet();
}

// ── Detection pipeline (shared by text + PDF) ─────────────────────────────────
async function runDetection(text, say) {
  const raw = detectWithRegex(text);
  let nerUsed = false;

  if (aiEnabled()) {
    try {
      const c = COMPONENTS.ner;
      if (c.status !== "ready") {
        say("Loading name detection model (progress shown in the Local engine panel)");
        if (c.status !== "downloading" && c.status !== "loading") await warmUpNer();
        else await loadNer(onNerProgress);
      }
      const names = await detectNames(text, (i, n) => say(`Detecting names: part ${i} of ${n}`));
      raw.push(...names);
      nerUsed = true;
      COMPONENTS.ner.status = "ready";
      renderEngine();
    } catch (e) {
      console.warn("NER failed, using patterns only:", e);
      COMPONENTS.ner.status = "failed";
      renderEngine();
      showToast("AI name detection unavailable (no internet for the first download?). Patterns only.", "red");
    }
  }

  return { detections: resolveDetections(text, raw), nerUsed };
}

// ── Input stage helpers ───────────────────────────────────────────────────────
function pickPdf() { $("file-input").click(); }

function updateCharCount() {
  const n = $("text-input").value.length;
  $("char-count").textContent = n.toLocaleString() + (n === 1 ? " character" : " characters");
}

function clearInput() {
  $("text-input").value = "";
  updateCharCount();
  $("text-input").focus();
}

function showLoading(msg) {
  $("input-stage").style.display = "none";
  $("results-foot").style.display = "none";
  $("doc-content").innerHTML =
    '<div class="loading"><div class="spinner"></div><span id="loading-msg"></span><small id="loading-sub"></small></div>';
  $("loading-msg").textContent = msg;
}
function setLoadingMsg(msg) {
  const el = $("loading-sub");
  if (el) el.textContent = msg;
}

function showInputStage() {
  $("doc-content").innerHTML = "";
  $("results-foot").style.display = "none";
  $("input-stage").style.display = "block";
  $("toolbar").classList.remove("visible");
  $("reset-btn").style.display = "none";
  ["legend-section","redacted-section","stats-section","copy-section"].forEach(id =>
    $(id).style.display = "none");
}

// ── Analyse pasted / typed text ───────────────────────────────────────────────
async function analyseText() {
  let text = $("text-input").value;
  if (!text.trim()) {
    showToast("Type or paste some text first", "red");
    $("text-input").focus();
    return;
  }
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const btn = $("identify-btn");
  btn.disabled = true;
  showLoading("Identifying personal information");

  try {
    await discardPdf();
    const { detections, nerUsed } = await runDetection(text, setLoadingMsg);
    showResults({ text, detections, nerUsed }, { source: "text", name: "Pasted text" });
  } catch (e) {
    console.error(e);
    showToast("Error: " + (e.message || e), "red");
    showInputStage();
  } finally {
    btn.disabled = false;
  }
}

// ── File upload ───────────────────────────────────────────────────────────────
async function uploadFile(file) {
  if (!file || !file.name.toLowerCase().endsWith(".pdf")) {
    showToast("Please upload a PDF file", "red");
    return;
  }

  showLoading("Analysing document");

  try {
    await discardPdf();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const doc   = await analysePdf(bytes, msg => {
      setLoadingMsg(msg);
      // First OCR run fetches the engine + language data: show it as a download
      if (/^(OCR|Scanned PDF)/.test(msg) && COMPONENTS.ocr.status !== "ready") {
        COMPONENTS.ocr.status = "downloading"; COMPONENTS.ocr.pct = null; renderEngine();
      }
    });
    if (doc.ocrUsed) {
      COMPONENTS.ocr.status = (await checkOcrCached()) ? "ready" : "nocache";
      renderEngine();
    }
    if (!doc.text.trim()) throw new Error("Could not extract any text from this PDF, even after OCR.");

    const { detections, nerUsed } = await runDetection(doc.text, setLoadingMsg);
    state.pdfDoc = doc;
    showResults({ text: doc.text, detections, nerUsed }, { source: "pdf", name: file.name, ocr: doc.ocrUsed });
  } catch (e) {
    console.error(e);
    showToast("Error: " + (e.message || e), "red");
    showInputStage();
  } finally {
    $("file-input").value = "";
  }
}

async function discardPdf() {
  if (state.pdfDoc) { await closePdf(state.pdfDoc); state.pdfDoc = null; }
}

// ── Show analysed results (shared by text + PDF paths) ────────────────────────
function showResults(data, meta) {
  const keepDoc = state.pdfDoc;
  state = freshState();
  state.pdfDoc     = keepDoc;
  state.text       = data.text;
  state.detections = data.detections;
  state.nerUsed    = !!data.nerUsed;
  state.source     = meta.source;
  state.sourceName = meta.name;

  const isPdf = meta.source === "pdf";

  $("input-stage").style.display = "none";
  renderDoc(data.text, data.detections);
  renderSidebar();
  $("results-foot").style.display = "flex";

  const badge = $("source-badge");
  badge.textContent = (isPdf ? "📄 " : "✎ ") + meta.name + (meta.ocr ? " · OCR" : "");
  badge.title = meta.name;
  $("toolbar").classList.add("visible");
  $("edit-btn").style.display  = isPdf ? "none" : "inline-flex";
  $("pdf-btn").style.display   = isPdf ? "inline-flex" : "none";
  $("reset-btn").style.display = "inline-flex";

  $("copy-section").style.display = "block";
  $("pdf-big-btn").style.display  = isPdf ? "flex" : "none";
  $("export-note").innerHTML = isPdf
    ? "PDF: pages are flattened to images with black boxes, so no hidden text remains.<br>TXT / Copy: clean text for pasting into Copilot."
    : "TXT / Copy: clean text with placeholders, ready for pasting into Copilot.";

  const n = data.detections.length;
  showToast(n ? `Found ${n} item${n === 1 ? "" : "s"} of personal information` : "No personal information detected", n ? "" : "green");
}

// ── Return to the text field (text mode only) ────────────────────────────────
function editText() {
  if (state.source !== "text") return;
  $("text-input").value = state.text;
  updateCharCount();
  showInputStage();
  $("text-input").focus();
}

// ── Render document with highlights ──────────────────────────────────────────
function renderDoc(text, detections) {
  const spanMap = {};
  for (const d of detections) {
    for (let i = d.start; i < d.end; i++) spanMap[i] = d;
  }

  let html = "";
  let i    = 0;

  while (i < text.length) {
    if (spanMap[i]) {
      const d   = spanMap[i];
      const tok = esc(text.slice(d.start, d.end));
      const bg  = hexToRgba(d.color, 0.15);
      html += `<span class="pii-token" id="tok_${state.nextId++}"
        data-original="${esc(d.text)}" data-label="${esc(d.label)}"
        data-color="${esc(d.color)}"
        style="background:${bg};color:${d.color};border:1.5px solid ${hexToRgba(d.color,0.4)}"
        title="${esc(d.label)}: click to redact"
        onclick="toggleToken(this)">${tok}</span>`;
      i = d.end;
    } else {
      let chunk = "";
      while (i < text.length && !spanMap[i]) {
        const ch = text[i];
        if (/\w/.test(ch)) {
          let word = "";
          while (i < text.length && !spanMap[i] && /[\w''-]/.test(text[i])) { word += text[i]; i++; }
          const wid = "w_" + (state.nextId++);
          chunk += `<span class="word-token" id="${wid}" data-word="${esc(word)}"
            title="Click to manually redact" onclick="toggleWord(this)">${esc(word)}</span>`;
        } else {
          chunk += esc(ch);
          i++;
        }
      }
      html += chunk;
    }
  }

  $("doc-content").innerHTML = html;
}

// ── Toggle a detected token ───────────────────────────────────────────────────
function toggleToken(el) {
  const original = el.dataset.original;
  const label    = el.dataset.label;
  const color    = el.dataset.color;

  if (state.piiRedacted[original]) {
    delete state.piiRedacted[original];
    document.querySelectorAll(".pii-token").forEach(t => {
      if (t.dataset.original === original) {
        t.textContent = original;
        t.classList.remove("redacted");
        t.style.background = hexToRgba(color, 0.15);
        t.style.color      = color;
        t.style.border     = `1.5px solid ${hexToRgba(color,0.4)}`;
      }
    });
  } else {
    const ph = makePlaceholder(label);
    state.piiRedacted[original] = ph;
    document.querySelectorAll(".pii-token").forEach(t => {
      if (t.dataset.original === original) {
        t.textContent = ph;
        t.classList.add("redacted");
        t.style.background = "";
        t.style.color      = "";
        t.style.border     = "";
      }
    });
  }

  renderRedactedList();
}

// ── Toggle a manually-clicked word ───────────────────────────────────────────
function toggleWord(el) {
  const id = el.id;

  if (state.manualRedacted[id]) {
    el.textContent = state.manualRedacted[id].original;
    el.classList.remove("manually-redacted");
    el.title = "Click to manually redact";
    delete state.manualRedacted[id];
    renderRedactedList();
    return;
  }

  const word  = el.dataset.word;
  const clean = word.toLowerCase().replace(/[^a-z]/g, "");

  if (COMMON_WORDS.has(clean)) {
    pendingWordEl = el;
    $("popup-msg").innerHTML =
      `"<strong style="color:var(--text)">${esc(word)}</strong>" looks like a common legal word, not personal data.<br><br>Are you sure you want to redact it?`;
    $("popup").style.display = "flex";
    return;
  }

  doManualRedact(el);
}

function closePopup(confirm) {
  $("popup").style.display = "none";
  if (confirm && pendingWordEl) doManualRedact(pendingWordEl);
  pendingWordEl = null;
}

function doManualRedact(el) {
  const id       = el.id;
  const original = el.dataset.word;
  const ph       = makePlaceholder("REDACTED");
  state.manualRedacted[id] = { original, placeholder: ph };
  el.textContent = ph;
  el.classList.add("manually-redacted");
  el.title = "Click to undo";
  renderRedactedList();
}

function makePlaceholder(label) {
  state.counters[label] = (state.counters[label] || 0) + 1;
  return `[${label}_${state.counters[label]}]`;
}

// ── Anonymise / restore every detected PII item in one click ─────────────────
function anonymiseAll() {
  const firstByOriginal = {};
  document.querySelectorAll(".pii-token").forEach(t => {
    const o = t.dataset.original;
    if (!(o in firstByOriginal)) firstByOriginal[o] = t;
  });
  const originals = Object.keys(firstByOriginal);

  if (!originals.length) {
    showToast("No personal information was detected", "red");
    return;
  }

  const allRedacted = originals.every(o => state.piiRedacted[o]);

  if (allRedacted) {
    originals.forEach(o => toggleToken(firstByOriginal[o]));
    showToast("Restored " + originals.length + " item" + (originals.length === 1 ? "" : "s"));
  } else {
    let n = 0;
    originals.forEach(o => {
      if (!state.piiRedacted[o]) { toggleToken(firstByOriginal[o]); n++; }
    });
    showToast("✓ Anonymised " + n + " item" + (n === 1 ? "" : "s"), "green");
  }
}

function updateAnonymiseBtn() {
  const btn     = $("anon-btn");
  const summary = $("results-summary");
  if (!btn) return;

  const originals = [...new Set(state.detections.map(d => d.text))];
  const doneCount = originals.filter(o => state.piiRedacted[o]).length;
  const manual    = Object.keys(state.manualRedacted).length;

  if (!originals.length) {
    btn.disabled = true;
    btn.classList.remove("restore");
    btn.innerHTML = "🛡 Anonymise All";
    summary.textContent = manual
      ? manual + " word" + (manual === 1 ? "" : "s") + " redacted manually"
      : "No personal information detected";
    return;
  }

  btn.disabled = false;
  const allRedacted = doneCount === originals.length;
  btn.classList.toggle("restore", allRedacted);
  btn.innerHTML = allRedacted ? "↩ Restore All" : "🛡 Anonymise All";

  let s = doneCount + " of " + originals.length + " detected item" + (originals.length === 1 ? "" : "s") + " anonymised";
  if (manual) s += ", " + manual + " manual";
  summary.textContent = s;
}

// ── Redaction list + clean text ───────────────────────────────────────────────
function buildRedactionsList() {
  return [
    ...Object.entries(state.piiRedacted).map(([original, placeholder]) => ({ original, placeholder })),
    ...Object.values(state.manualRedacted).map(({ original, placeholder }) => ({ original, placeholder })),
  ];
}

function cleanText() {
  return buildCleanText(state.text, buildRedactionsList());
}

// ── Copy to clipboard ─────────────────────────────────────────────────────────
async function copyClean() {
  try {
    const redactions = buildRedactionsList();
    await navigator.clipboard.writeText(cleanText());
    const btns = [$("copy-btn"), $("copy-big-btn")];
    btns.forEach(b => { if (b) { b.textContent = "✓ Copied!"; b.classList.add("copied"); } });
    setTimeout(() => {
      const cb = $("copy-btn"), cb2 = $("copy-big-btn");
      if (cb)  { cb.innerHTML  = "📋 Copy Text"; cb.classList.remove("copied"); }
      if (cb2) { cb2.innerHTML = "📋 Copy Anonymised Text"; cb2.classList.remove("copied"); }
    }, 2000);
    writeAudit("copy", redactions);
    showToast("✓ Copied. Paste directly into your LLM", "green");
  } catch (e) {
    showToast("Could not copy. Try Export TXT instead");
  }
}

// ── Export clean TXT ──────────────────────────────────────────────────────────
function exportClean() {
  const redactions = buildRedactionsList();
  const blob = new Blob([cleanText()], { type: "text/plain" });
  triggerDownload(blob, stem(state.sourceName) + "_anonymised.txt");
  writeAudit("txt", redactions);
  showToast("✓ Clean TXT downloaded");
}

// ── Download Redacted PDF (PDF sources only) ──────────────────────────────────
async function downloadPDF() {
  if (state.source !== "pdf" || !state.pdfDoc) {
    showToast("Redacted PDF is only available for uploaded PDFs", "red");
    return;
  }

  const redactions = buildRedactionsList();
  if (redactions.length === 0) {
    showToast("Approve at least one redaction first", "red");
    return;
  }

  const btns = [$("pdf-btn"), $("pdf-big-btn")];
  btns.forEach(b => { if (b) { b.disabled = true; b.classList.add("loading"); b.innerHTML = "⏳ Generating PDF"; } });
  showToast("Building redacted PDF");

  try {
    const texts = redactions.map(r => r.original).filter(Boolean);
    const { bytes, hits } = await buildRedactedPdf(state.pdfDoc, texts, msg => {
      btns.forEach(b => { if (b) b.innerHTML = "⏳ " + msg; });
    });
    triggerDownload(new Blob([bytes], { type: "application/pdf" }), stem(state.sourceName) + "_REDACTED.pdf");
    writeAudit("pdf", redactions);
    showToast(`✓ Redacted PDF downloaded: ${redactions.length} items, ${hits} boxes drawn`, "green");
  } catch (e) {
    console.error(e);
    showToast("PDF generation failed: " + (e.message || e), "red");
  } finally {
    btns.forEach(b => { if (b) { b.disabled = false; b.classList.remove("loading"); } });
    if ($("pdf-btn"))     $("pdf-btn").innerHTML     = "📄 Download PDF";
    if ($("pdf-big-btn")) $("pdf-big-btn").innerHTML = "📄 Download Redacted PDF";
  }
}

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function stem(name) {
  const base = (name || "document").replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]+/g, "_").trim();
  return base || "document";
}

// ── Audit log (browser storage, downloadable as CSV) ─────────────────────────
function readAudit() {
  try { return JSON.parse(localStorage.getItem(AUDIT_KEY) || "[]"); } catch (e) { return []; }
}
function writeAudit(action, redactions) {
  const rows = readAudit();
  rows.push({
    timestamp: new Date().toISOString().slice(0, 19),
    action,
    filename:  state.sourceName || "",
    total:     redactions.length,
    sample:    redactions.slice(0, 5).map(r => `${r.original} -> ${r.placeholder}`).join("; "),
  });
  try { localStorage.setItem(AUDIT_KEY, JSON.stringify(rows)); } catch (e) {}
  updateAuditBtn();
}
function updateAuditBtn() {
  const n = readAudit().length;
  const b = $("audit-btn");
  if (b) b.textContent = `⬇ Download audit log (CSV${n ? ", " + n + " row" + (n === 1 ? "" : "s") : ""})`;
}
function downloadAudit() {
  const rows = readAudit();
  if (!rows.length) { showToast("Audit log is empty", "red"); return; }
  const q = v => `"${String(v).replace(/"/g, '""')}"`;
  const csv = ["timestamp,action,filename,total_redactions,sample",
    ...rows.map(r => [r.timestamp, r.action, r.filename, r.total, r.sample].map(q).join(","))].join("\r\n");
  triggerDownload(new Blob(["﻿" + csv], { type: "text/csv" }), "audit_log.csv");
}

// ── Sidebar rendering ─────────────────────────────────────────────────────────
function renderSidebar() {
  const counts = {};
  for (const d of state.detections) counts[d.label] = (counts[d.label] || 0) + 1;

  $("legend-list").innerHTML = Object.keys(counts).length
    ? Object.entries(counts).map(([label, count]) =>
        `<div class="legend-item">
          <div class="legend-dot" style="background:${ENTITY_COLORS[label] || '#1d4a7a'}"></div>
          <span>${label}</span>
          <span class="legend-count">${count}</span>
        </div>`
      ).join("")
    : `<div class="legend-empty">Nothing detected automatically. Click any word in the text to redact it manually.</div>`;
  $("legend-section").style.display = "block";

  $("stats-list").innerHTML = `
    <div class="stat"><span>Source</span><span>${state.source === "pdf" ? "PDF" : "Text"}</span></div>
    <div class="stat"><span>Name detection</span><span>${state.nerUsed ? "AI + patterns" : "patterns"}</span></div>
    <div class="stat"><span>Processed</span><span>on this device</span></div>
    <div class="stat"><span>Characters</span><span>${state.text.length.toLocaleString()}</span></div>
    <div class="stat"><span>Words</span><span>${state.text.trim().split(/\s+/).filter(Boolean).length.toLocaleString()}</span></div>
    <div class="stat"><span>Auto-detected</span><span>${state.detections.length}</span></div>`;
  $("stats-section").style.display = "block";

  renderRedactedList();
}

function renderRedactedList() {
  const items = [
    ...Object.entries(state.piiRedacted).map(([orig, ph]) => ({ orig, ph })),
    ...Object.values(state.manualRedacted).map(({ original, placeholder }) => ({ orig: original, ph: placeholder })),
  ];

  $("redacted-count").textContent = items.length;
  $("redacted-section").style.display = items.length ? "block" : "none";

  $("redacted-list").innerHTML = items
    .map(({ orig, ph }) =>
      `<div class="redacted-item">
        <span class="r-orig">${esc(orig.length > 18 ? orig.slice(0,18) + "…" : orig)}</span>
        <span class="r-ph">${esc(ph)}</span>
      </div>`
    ).join("");

  updateAnonymiseBtn();
}

// ── Reset ─────────────────────────────────────────────────────────────────────
async function resetApp() {
  await discardPdf();
  state = freshState();
  $("text-input").value = "";
  updateCharCount();
  $("file-input").value = "";
  showInputStage();
  $("text-input").focus();
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function showToast(msg, type) {
  const t = document.createElement("div");
  t.className = "toast" + (type === "green" ? " green" : type === "red" ? " red" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ── Keyboard: Ctrl/Cmd + Enter in the text field runs identification ─────────
$("text-input").addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    analyseText();
  }
});

// ── Drag & drop a PDF anywhere on the window ─────────────────────────────────
let dragDepth = 0;
const overlay = $("drop-overlay");

window.addEventListener("dragenter", e => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes("Files")) return;
  e.preventDefault();
  dragDepth++;
  overlay.classList.add("visible");
});
window.addEventListener("dragover",  e => e.preventDefault());
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) overlay.classList.remove("visible");
});
window.addEventListener("drop", e => {
  e.preventDefault();
  dragDepth = 0;
  overlay.classList.remove("visible");
  const file = e.dataTransfer.files[0];
  if (file) uploadFile(file);
});

// ── Expose handlers used by inline onclick attributes ────────────────────────
Object.assign(window, {
  pickPdf, updateCharCount, clearInput, analyseText, uploadFile, editText,
  anonymiseAll, resetApp, copyClean, exportClean, downloadPDF,
  toggleToken, toggleWord, closePopup, downloadAudit, toggleAi,
  toggleNetPanel, clearNetLog,
});

// ── Start-up ─────────────────────────────────────────────────────────────────
updateCharCount();
updateAuditBtn();
$("ai-toggle").checked = aiEnabled();
renderEngine();

startNetMonitor();
if ("serviceWorker" in navigator && (location.protocol === "https:" || ["localhost","127.0.0.1"].includes(location.hostname))) {
  navigator.serviceWorker.register("./sw.js").catch(e => console.warn("Service worker not registered:", e));
}

ensureLibsCached();
checkOcrCached().then(ok => { COMPONENTS.ocr.status = ok ? "ready" : "ondemand"; renderEngine(); });
if (aiEnabled()) setTimeout(warmUpNer, 300); else { COMPONENTS.ner.status = "off"; renderEngine(); }

// ── Self-test (open index.html?selftest=1): analyses a fixed sample and
//    writes the result into the page so a headless browser can read it. ──
if (/[?&]selftest=1/.test(location.search)) {
  (async () => {
    const out = document.createElement("pre");
    out.id = "selftest-result";
    document.body.appendChild(out);
    try {
      $("text-input").value =
        "Dear Mr John Smith,\nI met Priya Patel from Northbridge Solutions Ltd in Manchester on 12 March 2024. " +
        "Her postcode is SW1A 1AA, NI number QQ 12 34 56 C, phone 07700 900123, email priya@example.com.";
      await analyseText();
      out.textContent = JSON.stringify({
        ok: true,
        nerUsed: state.nerUsed,
        engine: Object.fromEntries(Object.entries(COMPONENTS).map(([k, c]) => [k, c.status])),
        detections: state.detections.map(d => [d.label, d.text]),
      });
    } catch (e) {
      out.textContent = JSON.stringify({ ok: false, error: String(e && e.stack || e) });
    }
  })();
}
