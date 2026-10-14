// Сборка PDF лекции: Markdown (главы) -> HTML -> Chromium (Mermaid, KaTeX) -> PDF.
// Двухпроходная сборка: первый проход определяет номера страниц заголовков для оглавления.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT, "лекция");
const OUT_PDF = process.env.OUT_PDF || path.join(ROOT, "Хроническая_сердечная_недостаточность_Лекция.pdf");
const OUT_HTML = path.join(__dirname, "out", "lecture.html");
const OUT_MD = path.join(ROOT, "ЛЕКЦИЯ-полный-текст.md");
fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });

// ---------- 1. Чтение глав ----------
const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith(".md")).sort();
if (files.length === 0) throw new Error("Нет файлов в папке лекция/");
const parts = files.map((f) => fs.readFileSync(path.join(SRC_DIR, f), "utf8").trim());
const fullMd = parts.join("\n\n");
fs.writeFileSync(OUT_MD, "<!-- Файл собран автоматически из лекция/*.md скриптом build-tools/build.mjs; не редактировать вручную -->\n\n" + fullMd + "\n");

// ---------- 2. Markdown -> HTML ----------
const md = new MarkdownIt({ html: true, linkify: false, typographer: false, breaks: false });
const headings = []; // {level, text, id}
let hCounter = 0;
md.core.ruler.push("heading_ids", (state) => {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "heading_open") {
      const inline = tokens[i + 1];
      const text = inline.children.filter((c) => c.type === "text" || c.type === "code_inline").map((c) => c.content).join("");
      const id = "h-" + (++hCounter);
      t.attrSet("id", id);
      headings.push({ level: Number(t.tag.slice(1)), text, id });
    }
  }
});
const defaultFence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const lang = (token.info || "").trim().split(/\s+/)[0];
  if (lang === "mermaid") {
    return `<div class="figure"><pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre></div>\n`;
  }
  if (lang === "svg") {
    return `<div class="figure svg-figure">${token.content}</div>\n`;
  }
  return defaultFence(tokens, idx, options, env, self);
};
let bodyHtml = md.render(fullMd);

// Классы для маркированных абзацев/цитат (легенда маркеров)
const markerClass = [
  ["📌", "def"], ["💡", "fact"], ["❗", "err"], ["🔬", "deep"], ["📝", "summary"],
  ["❓", "quest"], ["[🖼️", "viz"], ["[⚠️", "verify"],
];
for (const [mark, cls] of markerClass) {
  const m = mark.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  bodyHtml = bodyHtml.replace(new RegExp(`<blockquote>\\n<p>${m}`, "g"), `<blockquote class="callout ${cls}">\n<p>${mark}`);
  bodyHtml = bodyHtml.replace(new RegExp(`<p>${m}`, "g"), `<p class="mark ${cls}">${mark}`);
}
// Подписи к рисункам и таблицам
bodyHtml = bodyHtml.replace(/<p><strong>(Рис\. \d+\.)<\/strong>/g, '<p class="caption fig-caption"><strong>$1</strong>');
bodyHtml = bodyHtml.replace(/<p><strong>(Табл\. \d+\.)<\/strong>/g, '<p class="caption tab-caption"><strong>$1</strong>');
// Маркер начала основного текста (для поиска страниц)
bodyHtml = bodyHtml.replace(/<h2 /, '<span class="body-start">BODYSTARTMARK</span><h2 ');

// ---------- 3. Оглавление и титульный лист ----------
const docTitle = (headings.find((h) => h.level === 1) || { text: "Лекция" }).text;
function tocHtml(pageMap) {
  const items = headings.filter((h) => h.level === 2 || h.level === 3);
  return `<nav class="toc"><h2 class="toc-title">Оглавление</h2>` + items.map((h) => {
    const p = pageMap ? (pageMap[h.id] ?? "") : "";
    return `<div class="toc-entry lvl${h.level}"><a class="toc-text" href="#${h.id}">${md.utils.escapeHtml(h.text)}</a><span class="toc-dots"></span><span class="toc-page">${p}</span></div>`;
  }).join("") + `</nav>`;
}
const titlePage = fs.existsSync(path.join(__dirname, "title.html")) ? fs.readFileSync(path.join(__dirname, "title.html"), "utf8") : `<section class="title-page"><h1>${md.utils.escapeHtml(docTitle)}</h1></section>`;

const css = fs.readFileSync(path.join(__dirname, "style.css"), "utf8")
  .replace(/__FONTS__/g, "file://" + path.join(__dirname, "fonts"));
const katexCss = "file://" + path.join(__dirname, "node_modules/katex/dist/katex.min.css");
const katexJs = "file://" + path.join(__dirname, "node_modules/katex/dist/katex.min.js");
const katexAuto = "file://" + path.join(__dirname, "node_modules/katex/dist/contrib/auto-render.min.js");
const mermaidJs = "file://" + path.join(__dirname, "node_modules/mermaid/dist/mermaid.min.js");

function pageHtml(pageMap) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${md.utils.escapeHtml(docTitle)}</title>
<link rel="stylesheet" href="${katexCss}"><style>${css}</style></head><body>
${titlePage}
${tocHtml(pageMap)}
<main class="lecture">${bodyHtml}</main>
<script src="${mermaidJs}"></script><script src="${katexJs}"></script><script src="${katexAuto}"></script>
<script>
window.__done = false; window.__errors = [];
(async () => {
  try {
    renderMathInElement(document.body, {delimiters: [{left: "$$", right: "$$", display: true}, {left: "$", right: "$", display: false}], throwOnError: false});
  } catch (e) { window.__errors.push("katex: " + e); }
  try {
    mermaid.initialize({ startOnLoad: false, securityLevel: "loose", theme: "base", fontFamily: "'PT Sans', Arial, sans-serif",
      themeVariables: { fontFamily: "'PT Sans', Arial, sans-serif", fontSize: "15px", primaryColor: "#EFF6FF", primaryBorderColor: "#1D4ED8", primaryTextColor: "#0F172A", lineColor: "#334155", secondaryColor: "#FEF3C7", tertiaryColor: "#F1F5F9", clusterBkg: "#F8FAFC", clusterBorder: "#94A3B8", edgeLabelBackground: "#FFFFFF" },
      flowchart: { htmlLabels: true, curve: "basis", padding: 8, nodeSpacing: 30, rankSpacing: 40, useMaxWidth: true },
      mindmap: { useMaxWidth: true }, timeline: { useMaxWidth: true }, sequence: { useMaxWidth: true } });
    const nodes = Array.from(document.querySelectorAll("pre.mermaid"));
    for (const n of nodes) {
      const code = n.textContent;
      try { await mermaid.run({ nodes: [n] }); }
      catch (e) { window.__errors.push("mermaid: " + String(e).slice(0, 300) + " :: " + code.slice(0, 80)); n.outerHTML = '<pre class="mermaid-error">Ошибка рендеринга схемы:\\n' + code.replace(/</g, "&lt;") + '</pre>'; }
    }
  } catch (e) { window.__errors.push("mermaid-global: " + e); }
  document.fonts && await document.fonts.ready;
  window.__done = true;
})();
</script></body></html>`;
}

// ---------- 4. Печать через Chromium ----------
const execPath = await chromium.executablePath();
process.env.LD_LIBRARY_PATH = "/tmp/al2023/lib:" + (process.env.LD_LIBRARY_PATH || "");
try { const { inflate } = await import("@sparticuz/chromium"); await inflate(path.join(__dirname, "node_modules/@sparticuz/chromium/bin/al2023.tar.br")); } catch {}

async function printPdf(html, outPath) {
  fs.writeFileSync(OUT_HTML, html);
  const browser = await puppeteer.launch({
    args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox", "--font-render-hinting=none", "--allow-file-access-from-files"],
    defaultViewport: { width: 1000, height: 1400 }, executablePath: execPath, headless: true,
    env: { ...process.env, LD_LIBRARY_PATH: "/tmp/al2023/lib" },
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  await page.goto("file://" + OUT_HTML, { waitUntil: "load", timeout: 120000 });
  await page.waitForFunction("window.__done === true", { timeout: 600000 });
  const errors = await page.evaluate(() => window.__errors);
  for (const e of errors) console.error("RENDER:", e);
  const footer = `<div style="font-family:'PT Sans',Arial,sans-serif;font-size:8pt;color:#64748B;width:100%;padding:0 16mm;display:flex;justify-content:space-between;"><span>${md.utils.escapeHtml(docTitle)}</span><span>стр. <span class="pageNumber"></span> из <span class="totalPages"></span></span></div>`;
  await page.pdf({ path: outPath, format: "A4", printBackground: true, displayHeaderFooter: true, headerTemplate: "<div></div>", footerTemplate: footer,
    margin: { top: "16mm", bottom: "18mm", left: "16mm", right: "16mm" } });
  await browser.close();
  return errors.length;
}

// Проход 1: без номеров страниц
const tmpPdf = path.join(__dirname, "out", "pass1.pdf");
const nErr = await printPdf(pageHtml(null), tmpPdf);

// Извлечение номеров страниц
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const data = new Uint8Array(fs.readFileSync(tmpPdf));
const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
const norm = (s) => s.replace(/\s+/g, "").replace(/[«»"'’‘]/g, "").toLowerCase();
const pageTexts = [];
for (let i = 1; i <= doc.numPages; i++) {
  const tc = await (await doc.getPage(i)).getTextContent();
  pageTexts.push(norm(tc.items.map((it) => it.str).join(" ")));
}
let startPage = pageTexts.findIndex((t) => t.includes("bodystartmark"));
if (startPage < 0) startPage = 0;
const pageMap = {};
let cur = startPage;
for (const h of headings) {
  if (h.level === 1) continue;
  const key = norm(h.text);
  let found = -1;
  for (let p = cur; p < pageTexts.length && p <= cur + 60; p++) { if (pageTexts[p].includes(key)) { found = p; break; } }
  if (found >= 0) { pageMap[h.id] = found + 1; cur = found; } else { pageMap[h.id] = ""; }
}
// Проход 2: с номерами страниц
await printPdf(pageHtml(pageMap), OUT_PDF);
const missing = headings.filter((h) => h.level > 1 && pageMap[h.id] === "").length;
console.log(`PDF готов: ${OUT_PDF}; страниц: ${doc.numPages}; заголовков: ${headings.length}; не найдено страниц для ${missing}; ошибок рендеринга: ${nErr}`);
