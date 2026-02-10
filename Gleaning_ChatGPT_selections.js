/**
 * crop_transcript_keep_original_counters.js
 *
 * Purpose:
 *   Take a rehydrated lightweight transcript HTML (from your exporter),
 *   keep ONLY selected ORIGINAL global message indexes, and output:
 *     - Cropped HTML
 *     - Cropped PDF (optional)
 *
 * IMPORTANT COUNTER BEHAVIOR (per your request):
 *   - KEEP the original three counters exactly as in the source transcript:
 *       1) Original per-role badge:  U### / A###
 *       2) Original global index:    ####
 *       3) Original running totals:  U:### • A:###
 *     These remain UNCHANGED to cross-reference the source transcript.
 *
 *   - ADD a NEW counter for the cropped transcript sequence:
 *       "KEEP k/N" where:
 *          k = position in the cropped output (1..N)
 *          N = total kept messages
 *
 *   - We DO NOT renumber original counters.
 *
 * Usage:
 *   node crop_transcript_keep_original_counters.js in.html out.html out.pdf --keep "1-20,45,60-100"
 *   node crop_transcript_keep_original_counters.js in.html out.html --keep "10-200" --html-only
 *
 * Notes:
 *   - Cropping selection is based on ORIGINAL global index printed in ".global" (e.g. "#123").
 *   - If a turn has no parseable original global index, it is kept (safe default) and tagged.
 */

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

function getArg(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function parseKeepSpec(spec) {
  if (!spec || !spec.trim()) {
    throw new Error('Missing --keep spec. Example: --keep "1-20,45,60-100"');
  }

  const set = new Set();
  const parts = spec.split(",").map((x) => x.trim()).filter(Boolean);

  for (const p of parts) {
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      let a = Number(m[1]);
      let b = Number(m[2]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      if (b < a) [a, b] = [b, a];
      for (let k = a; k <= b; k++) set.add(k);
      continue;
    }

    const n = Number(p);
    if (Number.isFinite(n) && n > 0) set.add(n);
  }

  if (set.size === 0) {
    throw new Error(`--keep spec parsed to empty set: "${spec}"`);
  }
  return set;
}

(async () => {
  const inHtml = process.argv[2];
  const outHtml = process.argv[3];
  const outPdf =
    process.argv[4] && !process.argv[4].startsWith("--") ? process.argv[4] : null;

  const keepSpec = getArg("--keep");
  const htmlOnly = hasFlag("--html-only");

  if (!inHtml || !outHtml) {
    console.error(
      `Usage:
  node crop_transcript_keep_original_counters.js in.html out.html out.pdf --keep "1-20,45,60-100"
  node crop_transcript_keep_original_counters.js in.html out.html --keep "10-200" --html-only`
    );
    process.exit(1);
  }

  const keepSet = parseKeepSpec(keepSpec);
  const input = fs.readFileSync(inHtml, "utf8");

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      // If Chromium hard-crashes in WSL/containers, uncomment:
      // "--no-sandbox",
      // "--no-zygote",
    ],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(0);
  page.setDefaultNavigationTimeout(0);

  await page.setContent(input, { waitUntil: "load" });

  const result = await page.evaluate((keepList) => {
    const keep = new Set(keepList);

    // Selectors based on your rehydrated transcript
    const TURN_SEL = ".turn";
    const GLOBAL_SEL = ".global";          // "#123"
    const META_SEL = ".meta";              // metadata line container
    const HEADER_SEL = ".header";
    const SUMMARY_SEL = ".summary";

    const parseOriginalGlobalIndex = (turn) => {
      const g = turn.querySelector(GLOBAL_SEL);
      if (!g) return null;
      const m = (g.textContent || "").match(/#\s*(\d+)/);
      return m ? Number(m[1]) : null;
    };

    // Pass 1: remove non-kept turns (based on ORIGINAL global index)
    const turns = Array.from(document.querySelectorAll(TURN_SEL));
    let removed = 0;
    let kept = 0;
    let missingIndexKept = 0;

    for (const t of turns) {
      const idx = parseOriginalGlobalIndex(t);
      if (idx == null) {
        // Safe default: keep if we can't parse original global index
        t.setAttribute("data-crop-warning", "missing-original-global-index");
        kept++;
        missingIndexKept++;
        continue;
      }
      if (!keep.has(idx)) {
        t.remove();
        removed++;
      } else {
        kept++;
      }
    }

    // Pass 2: add NEW cropped counter: "KEEP k/N"
    const remaining = Array.from(document.querySelectorAll(TURN_SEL));
    const totalKept = remaining.length;

    for (let i = 0; i < remaining.length; i++) {
      const t = remaining[i];
      const k = i + 1;

      // Put KEEP counter into meta line without touching original counters
      const meta = t.querySelector(META_SEL);
      if (!meta) continue;

      // Avoid double-inserting if script is run twice
      const existing = meta.querySelector(".keepCounter");
      if (existing) {
        existing.textContent = `KEEP ${k}/${totalKept}`;
        continue;
      }

      const dot = document.createElement("span");
      dot.className = "keepDot";
      dot.textContent = "•";

      const keepSpan = document.createElement("span");
      keepSpan.className = "keepCounter";
      keepSpan.textContent = `KEEP ${k}/${totalKept}`;

      meta.appendChild(dot);
      meta.appendChild(keepSpan);
    }

    // Update header summary to include both "original-crossref" nature and kept counts
    const header = document.querySelector(HEADER_SEL);
    const summary = document.querySelector(SUMMARY_SEL);

    if (summary) {
      // We cannot reliably recompute original totals from cropped set, so we report:
      summary.innerHTML = `
        Cropped messages: <strong>${totalKept}</strong> • Removed: <strong>${removed}</strong>
        ${missingIndexKept ? `• Kept-without-original-index: <strong>${missingIndexKept}</strong>` : ``}
      `.trim();
    }

    if (header) {
      // Add a note explaining counters
      const noteId = "keepCounterNote";
      let note = header.querySelector(`#${noteId}`);
      if (!note) {
        note = document.createElement("div");
        note.id = noteId;
        note.style.marginTop = "8px";
        note.style.fontSize = "12px";
        note.style.fontWeight = "750";
        note.style.opacity = "0.95";
        header.appendChild(note);
      }
      note.textContent =
        "Original counters preserved for cross-reference; added KEEP k/N for cropped sequence.";
    }

    return { kept, removed, remaining: totalKept, missingIndexKept };
  }, Array.from(keepSet));

  // Enhance CSS so KEEP counter is readable and consistent with the transcript theme
  // We'll inject a small style block without otherwise modifying your layout.
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = `
      .keepDot{
        margin-left: 4px;
        margin-right: 0px;
        opacity: 0.85;
      }
      .keepCounter{
        font-weight: 950;
        letter-spacing: .02em;
        padding: 2px 10px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,.14);
        background: rgba(255,255,255,.06);
      }
      @media print{
        .keepCounter{
          border-color: #e0e0e0;
          background: #f2f2f2;
          color: #111;
        }
      }
    `;
    document.head.appendChild(style);
  });

  const updatedHtml = await page.content();

  fs.writeFileSync(outHtml, updatedHtml, "utf8");
  console.log(`Saved cropped HTML → ${outHtml}`);
  console.log(
    `Kept ${result.kept}, removed ${result.removed}, remaining ${result.remaining}` +
      (result.missingIndexKept ? ` (kept w/o original index: ${result.missingIndexKept})` : "")
  );

  if (!htmlOnly) {
    const pdfPath = outPdf || outHtml.replace(/\.html$/i, "") + ".pdf";

    const footerTemplate = `
      <div style="width:100%; font-size:10px; padding:0 12mm; color:#666; display:flex; justify-content:flex-end;">
        <div>Page <span class="pageNumber"></span> / <span class="totalPages"></span></div>
      </div>
    `;

    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
      margin: { top: "12mm", right: "12mm", bottom: "18mm", left: "12mm" },
      displayHeaderFooter: true,
      headerTemplate: `<div></div>`,
      footerTemplate,
      timeout: 0,
    });

    console.log(`Saved cropped PDF → ${pdfPath}`);
  }

  await browser.close();
})().catch((err) => {
  console.error("Crop failed:", err);
  process.exit(1);
});