PDF Anonymiser - Browser-only version
=====================================

Everything runs inside the browser tab: PDF text extraction, OCR for
scanned pages, personal-information detection and PDF redaction.
No server ever receives a document. There is nothing to install.


HOW TO RUN (on this PC)
  1. Double-click  "Start JS Version.bat"
     It starts a tiny local file server (Python) and opens
     http://127.0.0.1:8080 in your browser.
     The server only hands the browser the app files. It never sees
     your text or PDFs.

  2. First run only: keep the internet connected for a minute.
     The browser fetches the JavaScript libraries and, if "AI name
     detection" is ticked, the name-detection model (about 110 MB).
     Both are stored in the browser and reused. After that the app
     works with the internet switched off.

  3. To stop: close the black console window.


HOW TO PUBLISH (for customers)
  Copy this folder to any static web host. There is no backend to run.
  HTTPS is required for offline support (service worker).

  Recommended, all free at small scale:
    1. Cloudflare Pages: create a project, upload this folder (or
       connect a Git repository). No build step. Every file is under
       25 MB, which is the Pages per-file limit; the model is shipped
       as numbered parts for that reason.
    2. Cloudflare Access (Zero Trust, free for up to 50 users): put an
       email one-time-code login in front of the site. When a customer
       pays, add their email address to the allowed list.
    3. A Stripe Payment Link or Gumroad page for the subscription.

  The site makes no requests to any third-party host. Everything the
  browser needs is in vendor/ and served from your own domain.


WHAT IS DETECTED
  Patterns (always, instant):
    email addresses, UK phone numbers, UK postcodes, NI numbers,
    NHS numbers, VAT numbers, IBANs (checksum verified), card numbers
    (Luhn verified), currency amounts, dates.
  AI name detection (optional, tick the box):
    people's names, using a BERT NER model run locally with
    Transformers.js. Slower on long documents (a few seconds per page).

  Exactly as in the Python version, every highlight is a suggestion.
  Click to confirm, click again to restore, click any other word to
  redact it manually, or use "Anonymise All".


REDACTED PDF OUTPUT
  Each page is rendered to an image, black boxes are painted over the
  matched text, and the images are written into a new PDF. The output
  therefore contains no text layer at all, which is the strongest form
  of redaction: nothing can be recovered by search or copy/paste.
  Side effects: the file is larger and not text-searchable.


FILES
  index.html               The UI.
  app.js                   UI logic.
  engine/recognisers.js    Pattern recognisers, overlap resolution,
                           placeholder substitution.
  engine/ner.js            Name detection (Transformers.js).
  engine/pdftools.js       PDF reading (pdf.js), OCR (tesseract.js),
                           redaction (canvas + pdf-lib).
  sw.js                    Service worker for offline use.
  serve.py                 Local static file server.
  Start JS Version.bat     One-click launcher.


LIBRARIES (all in vendor/, served from this site, no CDN)
  vendor/pdfjs/            pdf.js 3.11.174
  vendor/pdf-lib/          pdf-lib 1.17.1
  vendor/tesseract/        tesseract.js 5.1.1 (loader + worker)
  vendor/tesseract-core/   tesseract.js-core 5.1.x (wasm builds)
  vendor/tessdata/         English OCR language data
  vendor/transformers/     @huggingface/transformers 3.3.3 + ONNX runtime
  vendor/models/           Xenova/bert-base-NER (quantised), split into
                           model_quantized.onnx.partNN plus a manifest;
                           engine/ner.js reassembles the parts in memory
  vendor/fonts/            Playfair Display, Crimson Pro, JetBrains Mono
  Total about 170 MB. First visit stores it all in the browser.

SELF-TEST
  Open  http://127.0.0.1:8080/?selftest=1  and the page analyses a
  fixed sample automatically, printing the detections at the bottom.
  Useful after any change to confirm the model still loads.


LOCAL ENGINE PANEL
  The "Local engine" panel (under the text box, and in the sidebar)
  lists every component the app ever downloads: the PDF libraries,
  the name-detection model and the OCR data. While anything is being
  fetched it shows a progress bar with size and source. Once stored
  it says so, and confirms that the app now works offline and that
  documents never leave the device. The header pill mirrors this.
  "What is downloaded, from where, and what is never sent" expands
  to the full list.


VERIFYING THE PRIVACY CLAIM
  Open the browser's developer tools (F12), go to the Network tab,
  then paste text or upload a PDF. Apart from the one-off library and
  model downloads, no requests are made.


AUDIT LOG
  One row per export (copy, TXT, PDF) is stored in the browser's local
  storage. Download it as CSV from the sidebar.
