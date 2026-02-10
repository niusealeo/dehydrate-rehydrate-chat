/**
 * export_virtual_chat_chatgptish.js
 *
 * Features:
 *  - Loads a saved ChatGPT HTML snapshot (virtualized)
 *  - Incrementally scrolls to harvest BOTH user + assistant messages in TURN order
 *  - Rehydrates formatting (headings/lists/code/quotes/tables)
 *  - Strips images from output (keeps PDF small) but lists detected file names per message
 *  - Shows 3 counters per message:
 *      - Global message index (#)
 *      - Per-role index (U# or A#)
 *      - Running totals (U:x • A:y) (not faded)
 *  - Removes the left-side "circle" by removing the avatar column entirely
 *  - Adds PDF page numbering via Puppeteer header/footer template
 *
 * Usage:
 *   node export_virtual_chat_chatgptish.js "/path/to/saved_chat.html" "out.pdf"
 */

const path = require("path");
const puppeteer = require("puppeteer");

const fs = require("fs");


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const inFile = process.argv[2];
  const outPdf = process.argv[3] || "chat.pdf";

  if (!inFile) {
    console.error("Usage: node export_virtual_chat_chatgptish.js input.html output.pdf");
    process.exit(1);
  }

  // Tunables
  const STEP_FRAC = 0.9;
  const WAIT_MS = 850;
  const STALL_LIMIT = 26;

  // Render policy
  const STRIP_IMAGES = false; //true;   // do not embed images in PDF
  const LIST_FILES = true;     // list detected file names per message

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

  const fileUrl = "file://" + path.resolve(inFile);
  await page.goto(fileUrl, { waitUntil: "load" });

  // Choose best scroll container (largest scrollHeight among plausible scrollers).
  const scrollerHandle = await page.evaluateHandle(() => {
    const candidates = [
      document.scrollingElement,
      document.documentElement,
      document.body,
      ...Array.from(document.querySelectorAll("*")).filter((el) => {
        const cs = getComputedStyle(el);
        const oy = cs.overflowY;
        return (
          (oy === "auto" || oy === "scroll") &&
          el.scrollHeight > el.clientHeight + 200
        );
      }),
    ].filter(Boolean);

    let best = candidates[0];
    for (const el of candidates) {
      if ((el.scrollHeight || 0) > (best?.scrollHeight || 0)) best = el;
    }
    return best || document.scrollingElement || document.documentElement;
  });

  // Start at top
  await page.evaluate((scroller) => {
    scroller.scrollTop = 0;
  }, scrollerHandle);
  await sleep(WAIT_MS);

  const turnMap = new Map(); // turnId -> { turnId, turnNum, firstSeen, msgs: [] }
  let turnCounter = 0;

  function msgFallbackKey(m) {
    const t = (m.text || "").trim();
    const head = t.slice(0, 120);
    const tail = t.length > 240 ? t.slice(-120) : "";
    return `${(m.role || "").toLowerCase()}::${head}::${tail}`;
  }

  async function harvestMountedTurns() {
    const turns = await page.evaluate(() => {
      const uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));

      const basename = (s) => {
        try {
          if (!s) return "";
          const noHash = s.split("#")[0];
          const noQuery = noHash.split("?")[0];
          const parts = noQuery.split("/");
          return parts[parts.length - 1] || "";
        } catch {
          return "";
        }
      };

      const looksLikeFilename = (s) => {
        if (!s) return false;
        const t = s.trim();
        if (t.length < 3 || t.length > 180) return false;
        if (!t.includes(".")) return false;
        if (t.startsWith("http://") || t.startsWith("https://")) {
          return /\.[a-z0-9]{1,8}$/i.test(basename(t));
        }
        return /\.[a-z0-9]{1,8}$/i.test(t);
      };

      const extractFilesFromMessageNode = (n) => {
        const files = [];

        // Links (attachment chips / downloads / normal anchors)
        const links = Array.from(n.querySelectorAll("a[href]"));
        for (const a of links) {
          const txt = (a.textContent || "").trim();
          const href = a.getAttribute("href") || "";
          const dl = (a.getAttribute("download") || "").trim();

          if (looksLikeFilename(dl)) files.push(dl);
          if (looksLikeFilename(txt)) files.push(txt);

          const bn = basename(href);
          if (looksLikeFilename(bn)) files.push(bn);
        }

        // Images (we'll strip them in render but keep names)
        const imgs = Array.from(n.querySelectorAll("img"));
        for (const img of imgs) {
          const alt = (img.getAttribute("alt") || "").trim();
          const title = (img.getAttribute("title") || "").trim();
          const aria = (img.getAttribute("aria-label") || "").trim();
          const src = img.getAttribute("src") || "";

          if (looksLikeFilename(alt)) files.push(alt);
          if (looksLikeFilename(title)) files.push(title);
          if (looksLikeFilename(aria)) files.push(aria);

          const bn = basename(src);
          if (looksLikeFilename(bn)) files.push(bn);
          else if (bn) files.push(bn);
        }

        // Titles / aria-labels (sometimes filenames are stored there)
        const titled = Array.from(n.querySelectorAll("[title],[aria-label]"));
        for (const el of titled) {
          const t = (el.getAttribute("title") || "").trim();
          const a = (el.getAttribute("aria-label") || "").trim();
          if (looksLikeFilename(t)) files.push(t);
          if (looksLikeFilename(a)) files.push(a);
        }

        const cleaned = uniq(files)
          .map((f) => f.trim())
          .filter((f) => f && f !== "Image" && f !== "image" && f !== "file");

        return cleaned;
      };

      const turnEls = Array.from(document.querySelectorAll("[data-turn-id]"));

      return turnEls
        .map((t) => {
          const turnId = t.getAttribute("data-turn-id") || "";
          const turnNumRaw = t.getAttribute("data-turn");
          const turnNum =
            turnNumRaw != null && turnNumRaw !== "" ? Number(turnNumRaw) : null;

          const msgs = Array.from(t.querySelectorAll("[data-message-author-role]"))
            .map((n) => {
              const role = (n.getAttribute("data-message-author-role") || "").toLowerCase();

              const md =
                n.querySelector(".markdown") ||
                n.querySelector(".prose") ||
                n.querySelector("[class*='markdown']") ||
                null;

              const html = md ? md.innerHTML : "";
              const text = (n.innerText || "").trim();
              const msgId = n.getAttribute("data-message-id") || "";
              const files = extractFilesFromMessageNode(n);

              return { msgId, role, html, text, files };
            })
            .filter((m) => m.role && (m.html || m.text || (m.files && m.files.length)));

          return { turnId, turnNum, msgs };
        })
        .filter((x) => x.turnId && x.msgs.length);
    });

    let newStuff = 0;

    for (const t of turns) {
      if (!turnMap.has(t.turnId)) {
        turnMap.set(t.turnId, {
          turnId: t.turnId,
          turnNum: t.turnNum,
          firstSeen: turnCounter++,
          msgs: [],
        });
        newStuff++;
      }

      const entry = turnMap.get(t.turnId);

      if (entry.turnNum == null && t.turnNum != null && !Number.isNaN(t.turnNum)) {
        entry.turnNum = t.turnNum;
      }

      const existing = new Set(entry.msgs.map((m) => m.msgId || msgFallbackKey(m)));

      for (const m of t.msgs) {
        const k = m.msgId || msgFallbackKey(m);
        if (!existing.has(k)) {
          entry.msgs.push(m);
          existing.add(k);
          newStuff++;
        } else {
          // Merge newly found files
          const found = entry.msgs.find((x) => (x.msgId || msgFallbackKey(x)) === k);
          if (found) {
            found.files = Array.from(new Set([...(found.files || []), ...(m.files || [])]));
          }
        }
      }
    }

    return newStuff;
  }

  // Initial harvest
  await harvestMountedTurns();

  // Scroll + harvest loop
  let stall = 0;
  while (stall < STALL_LIMIT) {
    const added = await harvestMountedTurns();
    if (added === 0) stall++;
    else stall = 0;

    const nearBottom = await page.evaluate((scroller) => {
      const eps = 10;
      return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - eps;
    }, scrollerHandle);

    if (nearBottom && stall >= 3) {
      await harvestMountedTurns();
      break;
    }

    await page.evaluate(
      (scroller, frac) => {
        const step = Math.floor(window.innerHeight * frac);
        scroller.scrollTop = Math.min(scroller.scrollTop + step, scroller.scrollHeight);
      },
      scrollerHandle,
      STEP_FRAC
    );

    await sleep(WAIT_MS);
  }

  // Order turns: prefer numeric data-turn; fallback to firstSeen
  const turnsSorted = Array.from(turnMap.values()).sort((a, b) => {
    const an = a.turnNum;
    const bn = b.turnNum;
    const aHas = an != null && !Number.isNaN(an);
    const bHas = bn != null && !Number.isNaN(bn);
    if (aHas && bHas) return an - bn;
    if (aHas && !bHas) return -1;
    if (!aHas && bHas) return 1;
    return a.firstSeen - b.firstSeen;
  });

  // Flatten: user -> assistant -> others per turn
  const flattened = [];
  for (const t of turnsSorted) {
    const users = t.msgs.filter((m) => m.role === "user");
    const assistants = t.msgs.filter((m) => m.role === "assistant");
    const others = t.msgs.filter((m) => m.role !== "user" && m.role !== "assistant");
    flattened.push(...users, ...assistants, ...others);
  }

  // Indices: global + per-role + running
  let userIdx = 0;
  let assistantIdx = 0;

  const numbered = flattened.map((m, i) => {
    const role = m.role || "unknown";
    let roleIdx = null;

    if (role === "user") roleIdx = ++userIdx;
    else if (role === "assistant") roleIdx = ++assistantIdx;

    return {
      ...m,
      globalIdx: i + 1,
      userIdx: role === "user" ? roleIdx : null,
      assistantIdx: role === "assistant" ? roleIdx : null,
      userCountSoFar: userIdx,
      assistantCountSoFar: assistantIdx,
    };
  });

  // Render helpers
  const escapeHtml = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  function stripImagesFromHtml(html) {
    if (!STRIP_IMAGES) return String(html);
    return String(html)
      .replace(/<picture[\s\S]*?<\/picture>/gi, "")
      .replace(/<img\b[^>]*>/gi, "")
      .replace(/<video[\s\S]*?<\/video>/gi, "");
  }

  function renderFilesList(files) {
    if (!LIST_FILES) return "";
    const list = (files || []).filter(Boolean);
    if (!list.length) return "";
    const items = list
      .map((f) => `<li><span class="file">${escapeHtml(f)}</span></li>`)
      .join("");
    return `
      <div class="files">
        <div class="filesLabel">Files</div>
        <ul class="filesList">${items}</ul>
      </div>
    `;
  }

  function renderMessage(m) {
    const role = (m.role || "").toLowerCase();

    const html = m.html ? stripImagesFromHtml(m.html) : "";
    const content =
      html && html.trim()
        ? html
        : `<pre class="plain">${escapeHtml(m.text || "")}</pre>`;

    const roleBadge =
      role === "user"
        ? `User ${m.userIdx}`
        : role === "assistant"
        ? `Assistant ${m.assistantIdx}`
        : role.toUpperCase();

    const global = `Index #${m.globalIdx}`;
    const running = `U:${m.userCountSoFar} + A:${m.assistantCountSoFar}`;

    return `
<div class="turn ${role}">
  <div class="bubble">
    <div class="meta">
      <span class="badge">${roleBadge}</span>
      <span class="global">${global}</span>
      <span class="dot">=</span>
      <span class="running">${running}</span>
    </div>

    ${renderFilesList(m.files)}

    <div class="content markdown">${content}</div>
  </div>
</div>`;
  }

  const body = numbered.map(renderMessage).join("\n");

  const totalTurns = turnsSorted.length;
  const totalMessages = numbered.length;
  const totalUsers = userIdx;
  const totalAssistants = assistantIdx;

  // Footer for PDF page numbering (Puppeteer feature)
  const footerTemplate = `
    <div style="width:100%; font-size:10px; padding:0 12mm; color:#666; display:flex; justify-content:space-between;">
      <div></div>
      <div>Page <span class="pageNumber"></span> / <span class="totalPages"></span></div>
    </div>
  `;

  const printHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Chat Transcript: ${path.basename(inFile).replace(/\.html$/i, "")}</title>
<style>
  :root{
    --bg: #0b0f19;
    --panel: rgba(255,255,255,.04);
    --bubble-assistant: #111827;
    --bubble-user: #0b2a1b;
    --text: #f4f6fb;
    --border: rgba(255,255,255,.12);
    --code-bg: rgba(255,255,255,.07);
    --shadow: rgba(0,0,0,.35);
    --file-bg: rgba(255,255,255,.06);
  }

  body{
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family:
      "Atkinson Hyperlegible",
      "Inter",
      "Segoe UI",
      "Noto Sans",
      "Roboto",
      system-ui,
      -apple-system,
      sans-serif;
    font-size: 16px;
    line-height: 1.62;
    text-rendering: optimizeLegibility;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  .wrap{
    max-width: 980px;
    margin: 0 auto;
    padding: 22px 16px 48px;
  }

  .header{
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 14px 16px;
    margin-bottom: 16px;
    box-shadow: 0 8px 22px var(--shadow);
  }

  .title{
    font-weight: 900;
    letter-spacing: .01em;
    margin: 0 0 6px;
    font-size: 16px;
  }
  .summary{
    margin: 0;
    font-size: 13px;
    font-weight: 800;
  }

  .turn{
    display: block;
    margin: 12px 0;
    page-break-inside: avoid;
  }

  .bubble{
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 12px 14px 12px;
    box-shadow: 0 8px 22px var(--shadow);
    background: var(--bubble-assistant);
  }

  .turn.user .bubble{
    background: var(--bubble-user);
  }

  .meta{
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text);       /* do not fade */
    font-size: 13px;
    font-weight: 900;
    margin-bottom: 10px;
  }

  .badge{
    font-weight: 950;
    letter-spacing: .02em;
    color: var(--text);
    background: rgba(255,255,255,.06);
    border: 1px solid rgba(255,255,255,.12);
    padding: 2px 10px;
    border-radius: 999px;
  }

  .global{ font-weight: 950; }
  .dot{ opacity: .85; }
  .running{ font-weight: 900; }

  /* Files block */
  .files{
    margin: 0 0 10px 0;
    padding: 10px 10px;
    border-radius: 14px;
    border: 1px dashed rgba(255,255,255,.16);
    background: var(--file-bg);
  }
  .filesLabel{
    font-size: 12px;
    font-weight: 950;
    letter-spacing: .03em;
    margin-bottom: 6px;
  }
  .filesList{
    margin: 0 0 0 18px;
    padding: 0;
  }
  .filesList li{
    margin: 3px 0;
  }
  .file{
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    font-size: 13px;
  }

  /* Markdown-ish rendering */
  .content > *:first-child{ margin-top: 0; }
  .content > *:last-child{ margin-bottom: 0; }
  .content p{ margin: 0 0 12px; }

  .content ul, .content ol{ margin: 8px 0 12px 22px; padding: 0; }
  .content li{ margin: 4px 0; }

  .content blockquote{
    margin: 12px 0;
    padding: 12px 14px;
    border-left: 3px solid rgba(255,255,255,.22);
    background: rgba(255,255,255,.06);
    border-radius: 14px;
  }

  .content h1,.content h2,.content h3,.content h4{
    margin: 16px 0 10px;
    line-height: 1.25;
    letter-spacing: .01em;
  }
  .content h1{ font-size: 22px; }
  .content h2{ font-size: 18px; }
  .content h3{ font-size: 16px; }
  .content h4{ font-size: 15px; }

  .content a{ color: #8ab4f8; text-decoration: none; }
  .content a:hover{ text-decoration: underline; }

  .content code{
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    font-size: 0.96em;
    background: var(--code-bg);
    padding: 0.18em 0.40em;
    border-radius: 10px;
    border: 1px solid rgba(255,255,255,.10);
  }

  .content pre{
    margin: 12px 0;
    padding: 14px 14px;
    overflow: auto;
    background: var(--code-bg);
    border: 1px solid rgba(255,255,255,.12);
    border-radius: 16px;
  }

  .content pre code{
    background: transparent;
    border: 0;
    padding: 0;
  }

  .content hr{
    border: 0;
    border-top: 1px solid rgba(255,255,255,.14);
    margin: 16px 0;
  }

  /* Tables */
  .content table{
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
    border-radius: 16px;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,.14);
  }
  .content th, .content td{
    padding: 10px 12px;
    vertical-align: top;
    border-bottom: 1px solid rgba(255,255,255,.12);
  }
  .content th{
    text-align: left;
    background: rgba(255,255,255,.06);
    font-weight: 950;
  }
  .content tr:last-child td{ border-bottom: 0; }

  /* Plain fallback */
  .plain{
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
  }

  /* Ensure images never render into PDF */
  img, picture, video, svg { display: none !important; }

  @media print{
    body{ background: white; color: #111; }
    .wrap{ padding: 0; }
    .header{
      background: #fff;
      border-color: #ddd;
      box-shadow: none;
    }
    .bubble{
      background: #fff !important;
      border-color: #ddd;
      box-shadow: none;
    }
    .meta{ color: #111; }
    .badge{
      color: #111;
      background: #f2f2f2;
      border-color: #e0e0e0;
    }
    .files{
      background: #f7f7f7;
      border-color: #d9d9d9;
    }
    .content a{ color: #0b5ed7; }
    .content code, .content pre{
      background: #f4f4f4;
      border-color: #e2e2e2;
    }
    .content blockquote{
      background: #f7f7f7;
      border-left-color: #bbb;
    }
    .content table{ border-color: #e2e2e2; }
    .content th, .content td{ border-bottom-color: #e2e2e2; }
  }
</style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <p class="title">Chat Transcript: ${path.basename(inFile).replace(/\.html$/i, "")} (rehydrated, images stripped)</p>
      <p class="summary">
        Turns: <strong>${totalTurns}</strong> • Messages: <strong>${totalMessages}</strong> •
        User msgs: <strong>${totalUsers}</strong> • Assistant msgs: <strong>${totalAssistants}</strong> •
        (Images generated ≈ User−Assistant): <strong>${totalUsers - totalAssistants}</strong>
      </p>
    </div>

    ${body}
  </div>
</body>
</html>`;

// Optional: also save the rehydrated transcript as standalone HTML
const outHtml =
  outPdf.replace(/\.pdf$/i, "") + ".html";

fs.writeFileSync(outHtml, printHtml, "utf8");

console.log(`Saved HTML transcript → ${outHtml}`);

  // Replace page with lightweight transcript, then print to PDF
  await page.setContent(printHtml, { waitUntil: "load" });

  await page.pdf({
    path: outPdf,
    format: "A4",
    printBackground: true,
    margin: { top: "12mm", right: "12mm", bottom: "18mm", left: "12mm" }, // room for footer
    displayHeaderFooter: true,
    headerTemplate: `<div></div>`,
    footerTemplate,
    timeout: 0,
  });

  console.log(
    `Captured turns: ${totalTurns}, messages: ${totalMessages} (user ${totalUsers}, assistant ${totalAssistants}) → ${outPdf}`
  );

  await browser.close();
})().catch((err) => {
  console.error("Export failed:", err);
  process.exit(1);
});
