// engine/recognisers.js
// Pattern-based PII recognisers (direct port of the UK recognisers in server.py)
// plus overlap resolution and clean-text export. Pure JavaScript, no network.

export const ENTITY_COLORS = {
  NAME:            "#c0392b",
  ORGANISATION:    "#0369a1",
  LOCATION:        "#0e7490",
  ADDRESS:         "#9d174d",
  EMAIL:           "#d35400",
  PHONE:           "#b7950b",
  DATE:            "#1a5276",
  AMOUNT:          "#6c3483",
  POSTCODE:        "#a93226",
  NI_NUMBER:       "#1a7a6e",
  NHS_NUMBER:      "#0e6655",
  VAT_NUMBER:      "#1e8449",
  BANK_ACCOUNT:    "#922b21",
  SORT_CODE:       "#7f1d1d",
  CARD_NUMBER:     "#922b21",
  PASSPORT:        "#4a1d96",
  DRIVING_LICENCE: "#5b21b6",
  ID_NUMBER:       "#374151",
};

const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const ORD   = "(?:st|nd|rd|th)?";

// Label-based recognisers capture the VALUE after a label. Built with the
// "d" flag so match indices of group 1 are available.
const NAME_TOKEN = "(?:[A-Z][A-Za-z'\\-]+|[A-Z]\\.?)";
const ID_LABEL =
  "(?:passport(?:\\s+(?:no|number))?|national\\s+insurance(?:\\s+(?:no|number))?|NI\\s+(?:no|number)|NINO|" +
  "employee\\s+(?:id|no|number)|staff\\s+(?:id|no|number)|(?:bank\\s+)?account(?:\\s+(?:no|number))?|sort\\s+code|" +
  "reference(?:\\s+(?:no|number))?|ref(?:\\.|\\s+no)?|case\\s+(?:no|number|ref)|matter\\s+(?:no|number|ref)|" +
  "claim\\s+(?:no|number)|policy\\s+(?:no|number)|customer\\s+(?:id|no|number)|membership\\s+(?:no|number)|" +
  "driving\\s+licence(?:\\s+(?:no|number))?|licence\\s+(?:no|number)|IMEI(?:\\s+code)?|serial\\s+(?:no|number)|" +
  "NHS\\s+(?:no|number)|invoice\\s+(?:no|number))";
const ID_VALUE = "(?:[A-Z]{1,5}[-/]?\\d{3,12}(?:[-/]?[A-Z0-9]{1,6})?|\\d(?:[\\d\\-/]|[ ](?=\\d)){2,30}\\d)";

const notBlank = v => !/^[\W_]+$/.test(v);

// ── Validators ────────────────────────────────────────────────────────────────
function luhn(s) {
  const digits = s.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0, dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}

function isIban(s) {
  const iban = s.replace(/\s+/g, "").toUpperCase();
  if (iban.length < 15 || iban.length > 34) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const v = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

// ── Recognisers ───────────────────────────────────────────────────────────────
const RECOGNISERS = [
  { label: "AMOUNT", patterns: [
    { re: /£\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?(?:million|billion|k|GBP|USD|EUR))?/g,   score: 0.99 },
    { re: /\$\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?(?:million|billion|k|USD|GBP|EUR))?/g,  score: 0.99 },
    { re: /\b\d[\d,]*(?:\.\d{1,2})?\s?(?:GBP|USD|EUR|pounds?)\b/g,                  score: 0.95 },
  ]},
  { label: "NI_NUMBER", patterns: [
    // Any two letters: HMRC's own example is "QQ 12 34 56 C"; over-matching is safer.
    { re: /\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g,                          score: 0.90 },
  ]},
  { label: "SORT_CODE", patterns: [
    { re: /\b\d{2}-\d{2}-\d{2}\b/g,                                                 score: 0.90 },
    { re: /\b\d{2} \d{2} \d{2}\b/g,                                                 score: 0.50, context: ["sort code", "sort"], boost: 0.90 },
  ]},
  { label: "BANK_ACCOUNT", patterns: [
    { re: /\b\d{8}\b/g,                                                             score: 0.50, context: ["account", "bank", "acct"], boost: 0.90 },
  ]},
  { label: "PASSPORT", patterns: [
    { re: /\b\d{9}\b/g,                                                             score: 0.50, context: ["passport"], boost: 0.90 },
  ]},
  { label: "DRIVING_LICENCE", patterns: [
    { re: /\b[A-Z9]{5}\d{6}[A-Z9]{2}\d[A-Z]{2}\b/g,                                 score: 0.90 },
  ]},
  { label: "ID_NUMBER", patterns: [
    { re: /\b[A-Z]{2,5}[-/]?\d{4,10}\b/g,                                           score: 0.60, context: ["reference", "ref", "case", "matter", "claim", "policy", "customer", "employee", "staff", "membership", "id", "number", "serial", "imei", "invoice"], boost: 0.90 },
    { re: /\b\d{10,16}\b/g,                                                         score: 0.40, context: ["reference", "ref", "case", "matter", "claim", "policy", "customer", "employee", "staff", "membership", "id", "number", "serial", "imei", "invoice"], boost: 0.90 },
    { re: new RegExp("\\b" + ID_LABEL + "\\s*(?:is|was|:|#|-|of)?\\s*:?\\s*(" + ID_VALUE + ")", "gid"), score: 0.75, group: 1 },
  ]},
  { label: "ADDRESS", patterns: [
    { re: /\b(?:(?:Flat|Apartment|Apt|Unit|Suite)\s+\w+,?\s+)?\d{1,4}[A-Za-z]?\s+(?:[A-Z][A-Za-z'\-]+\s+){1,3}(?:Street|St|Road|Rd|Lane|Ln|Avenue|Ave|Drive|Dr|Close|Cl|Court|Ct|Crescent|Cres|Way|Place|Pl|Gardens|Gdns|Grove|Square|Sq|Terrace|Parade|Park|Hill|Row|Walk|Mews|Rise|View|Green|Vale)\b\.?/g, score: 0.85 },
    { re: /^[ \t]*(?:home\s+|postal\s+|correspondence\s+|registered\s+)?(?:address|registered\s+office)\s*[:\-]\s*([^\n]{5,120}?)[ \t]*$/gimd, score: 0.85, group: 1, validate: notBlank },
  ]},
  { label: "ORGANISATION", patterns: [
    { re: /\b(?:[A-Z][A-Za-z&'.\-]*\s+){1,4}(?:Ltd|Limited|PLC|Plc|LLP|LLC|Inc|Incorporated|Solicitors|Chambers|Associates|Partners|Group|Holdings)\b\.?/g, score: 0.80 },
  ]},
  { label: "NAME", patterns: [
    { re: new RegExp("\\b(?:Mr|Mrs|Ms|Miss|Mx|Dr|Prof|Professor|Sir|Dame|Lord|Lady|Rev|Judge)\\.?\\s+(" + NAME_TOKEN + "(?:\\s+" + NAME_TOKEN + "){0,2})", "gd"), score: 0.88, group: 1 },
    { re: /^[ \t]*(?:full\s+name|name|first\s+name|forename|surname|last\s+name|applicant|claimant|defendant|tenant|landlord|employee|patient|witness|signed|signature|prepared\s+by)\s*[:\-]\s*([^\n]{2,60}?)[ \t]*$/gimd, score: 0.90, group: 1, validate: notBlank },
  ]},
  { label: "POSTCODE", patterns: [
    { re: /\b[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2}\b/g,                              score: 0.95 },
  ]},
  { label: "PHONE", patterns: [
    { re: /\b0\d{3,4}[\s.\-]?\d{3,4}[\s.\-]?\d{3,4}\b/g,                            score: 0.70 },
    { re: /\+44[\s.\-]?\(?0?\)?\d{2,4}[\s.\-]?\d{3,4}[\s.\-]?\d{3,4}\b/g,           score: 0.95 },
  ]},
  { label: "NHS_NUMBER", patterns: [
    { re: /\b\d{3}[\s\-]\d{3}[\s\-]\d{4}\b/g,                                        score: 0.80 },
  ]},
  { label: "VAT_NUMBER", patterns: [
    { re: /\bGB\s?\d{3}\s?\d{4}\s?\d{2}\b/g,                                        score: 0.99 },
  ]},
  { label: "EMAIL", patterns: [
    { re: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,                  score: 1.00 },
  ]},
  { label: "BANK_ACCOUNT", patterns: [
    { re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g,         score: 0.90, validate: isIban },
  ]},
  { label: "CARD_NUMBER", patterns: [
    { re: /\b(?:\d[ \-]?){13,19}\b/g,                                               score: 0.90, validate: luhn },
  ]},
  { label: "DATE", patterns: [
    { re: /\b\d{1,2}[\/\-.]\d{1,2}[\/\-.](?:\d{4}|\d{2})\b/g,                       score: 0.85 },
    { re: /\b\d{4}-\d{2}-\d{2}\b/g,                                                 score: 0.85 },
    { re: new RegExp(`\\b\\d{1,2}${ORD}\\s+(?:of\\s+)?${MONTH}\\.?,?\\s+\\d{4}\\b`, "gi"), score: 0.90 },
    { re: new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}${ORD},?\\s+\\d{4}\\b`, "gi"),         score: 0.90 },
    { re: new RegExp(`\\b\\d{1,2}${ORD}\\s+(?:of\\s+)?${MONTH}\\b`, "gi"),              score: 0.60 },
    { re: new RegExp(`\\b${MONTH}\\s+\\d{4}\\b`, "gi"),                                 score: 0.60 },
  ]},
];

/** Run every pattern recogniser. Returns raw {start,end,label,score} spans (may overlap). */
export function detectWithRegex(text) {
  const out = [];
  for (const r of RECOGNISERS) {
    for (const p of r.patterns) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(text)) !== null) {
        if (m[0].length === 0) { p.re.lastIndex++; continue; }

        let start = m.index, end = m.index + m[0].length;
        if (p.group) {
          if (!m.indices || !m.indices[p.group]) continue;
          [start, end] = m.indices[p.group];
        }
        const value = text.slice(start, end);
        if (!value) continue;
        if (p.validate && !p.validate(value)) continue;

        // Context boost: a keyword just before the match raises the score
        let score = p.score;
        if (p.context) {
          const before = text.slice(Math.max(0, start - 45), start).toLowerCase();
          if (p.context.some(k => before.includes(k))) score = Math.max(score, p.boost || 0.9);
        }
        out.push({ start, end, label: r.label, score });
      }
    }
  }
  return out;
}

/**
 * De-overlap raw spans (highest score wins), attach text + colour, sort by
 * position. Mirrors detect_pii() in server.py.
 */
export function resolveDetections(text, raw) {
  const detections = [];
  const occupied = [];
  const seen = new Set();

  for (const r of [...raw].sort((a, b) => b.score - a.score)) {
    if (occupied.some(([s, e]) => !(r.end <= s || r.start >= e))) continue;
    const original = text.slice(r.start, r.end).trim();
    if (!original || original.length < 2) continue;
    const key = r.start + ":" + r.end;
    if (seen.has(key)) continue;
    seen.add(key);
    occupied.push([r.start, r.end]);
    detections.push({
      start: r.start,
      end:   r.end,
      text:  original,
      label: r.label,
      color: ENTITY_COLORS[r.label] || "#2c5f8a",
      score: Math.round(r.score * 100) / 100,
    });
  }

  detections.sort((a, b) => a.start - b.start);

  // Merge adjacent NAME fragments separated only by a space
  // ("Md Abrar" + "Hossain" -> "Md Abrar Hossain").
  const merged = [];
  for (const d of detections) {
    const prev = merged[merged.length - 1];
    if (prev && d.label === "NAME" && prev.label === "NAME" && /^[ \t]{1,2}$/.test(text.slice(prev.end, d.start))) {
      prev.end   = d.end;
      prev.text  = text.slice(prev.start, prev.end).trim();
      prev.score = Math.max(prev.score, d.score);
      continue;
    }
    merged.push(d);
  }
  return merged;
}

export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build clean text with placeholders substituted. Mirrors /export in server.py. */
export function buildCleanText(text, redactions) {
  let result = text;
  const sorted = [...redactions].sort((a, b) => (b.original || "").length - (a.original || "").length);
  for (const { original, placeholder } of sorted) {
    if (!original) continue;
    try {
      const re = new RegExp("(?<!\\w)" + escapeRe(original) + "(?!\\w)", "gi");
      result = result.replace(re, () => placeholder);
    } catch (e) {
      result = result.split(original).join(placeholder);
    }
  }
  return result;
}
