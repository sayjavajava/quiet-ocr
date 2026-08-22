#!/usr/bin/env node
/**
 * Regenerates test/fixtures/*.png and test/fixtures/manifest.json. Not run
 * automatically — fixtures are committed so accuracy checks don't depend
 * on font rendering being identical between whatever environment last
 * generated them and whatever's currently running the tests. Only re-run
 * this deliberately, and re-verify the new fixtures' actual recognized
 * output before committing them — see scripts/measure-fixture-accuracy.mjs.
 *
 * Fixtures deliberately span real-world conditions, not just the one
 * clean, high-contrast line the original prototype used:
 *   - sample-invoice: short single line, high contrast (the original
 *                     prototype fixture — the one case exact match is a
 *                     reasonable bar for)
 *   - paragraph:      multi-line body text, realistic document font size
 *   - table:          tabular/numeric data — currency, alignment, digits
 *   - noisy-scan:     the paragraph text again, degraded the way a real
 *                     phone photo or scan actually is — rotated, lower
 *                     contrast, blurred, with per-pixel noise
 */
import { chromium } from "playwright";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE_DIR = fileURLToPath(new URL("../test/fixtures/", import.meta.url));

const launchOptions = {};
if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const browser = await chromium.launch(launchOptions);
const page = await browser.newPage();

async function toPng() {
  const dataUrl = await page.evaluate(() => document.getElementById('c').toDataURL('image/png'));
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

// Degrades `lines` the way a real phone photo or scan actually looks —
// rotated, lower contrast, per-pixel noise, slight blur — not just clean
// canvas-rendered text, which isn't representative of what this tool
// actually encounters in practice. Extracted from the original English
// noisy-scan fixture so every language gets the exact same, already-tuned
// recipe (rotation angle, noise amplitude, blur radius) applied
// identically — a fair, consistent basis for comparing real per-language
// degraded accuracy, not a re-tuned-per-language moving target.
//
// The noise uses a seeded PRNG (mulberry32), not Math.random(): an
// unseeded first attempt at tuning this (for the original English
// fixture) produced a genuinely non-monotonic, unreproducible
// relationship between noise amplitude and measured accuracy (97.5% ->
// 100% -> 22.5% as amplitude increased) purely because every
// regeneration drew a different random pattern — not because of the
// amplitude changes being tested. A fixed seed makes every fixture
// bit-for-bit reproducible, which is what makes measuring real accuracy
// against it meaningful at all.
async function renderDegradedLines(lines, { width, height, seed, fontSize = 24, startX = 50, startY = 70, lineHeight = 38 }) {
  await page.setContent(`<canvas id="c" width="${width}" height="${height}"></canvas>`);
  await page.evaluate(({ lines, seed, w, h, fontSize, startX, startY, lineHeight }) => {
    const canvas = document.getElementById('c');
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    let state = seed;
    function rand() {
      state |= 0; state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate((-6 * Math.PI) / 180);
    ctx.translate(-w / 2, -h / 2);
    ctx.fillStyle = '#3a3a3a'; // mid-grey on white — materially lower contrast
    ctx.font = `${fontSize}px sans-serif`;
    lines.forEach((line, i) => ctx.fillText(line, startX, startY + i * lineHeight));
    ctx.restore();

    const imageData = ctx.getImageData(0, 0, w, h);
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      const noise = (rand() - 0.5) * 85;
      d[i] = Math.min(255, Math.max(0, d[i] + noise));
      d[i + 1] = Math.min(255, Math.max(0, d[i + 1] + noise));
      d[i + 2] = Math.min(255, Math.max(0, d[i + 2] + noise));
    }
    ctx.putImageData(imageData, 0, 0);
    ctx.filter = 'blur(1.1px)';
    ctx.drawImage(canvas, 0, 0);
  }, { lines, seed, w: width, h: height, fontSize, startX, startY, lineHeight });
  return toPng();
}

// --- sample-invoice: the original single-line, high-contrast fixture ---
const INVOICE_TEXT = "Invoice number 88214, total due $942.50";
await page.setContent('<canvas id="c" width="700" height="150"></canvas>');
await page.evaluate((text) => {
  const ctx = document.getElementById('c').getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 700, 150);
  ctx.fillStyle = '#000000';
  ctx.font = '30px sans-serif';
  ctx.fillText(text, 20, 80);
}, INVOICE_TEXT);
const invoicePng = await toPng();
writeFileSync(`${FIXTURE_DIR}sample-invoice.png`, invoicePng);

// --- per-language fixtures: same shape as sample-invoice (short,
// high-contrast, single line) but one per supported non-English language
// (see public/index.html's #language options) — proves multi-language OCR
// actually works per language, not just that the UI has a picker. Sentences
// and canvas size/font match exactly what was used to verify font
// rendering and OCR accuracy for this feature before any of these
// languages were selected for support (real screenshots showed correct
// glyphs for every script below, no tofu boxes; real recognize() calls
// against these exact sentences confirmed accuracy per language — see the
// language list in docs/PERFORMANCE.md). `expectedText` here is the
// *source* sentence, not necessarily byte-identical to what gets
// recognized (chi_sim/jpn in particular — see manifest comment below) —
// always re-verify with `npm run measure-accuracy` after regenerating,
// same as every other fixture in this file. ---
const LANGUAGE_FIXTURES = [
  ["fra", "sample-french", "Le rapport trimestriel montre une augmentation"],
  ["spa", "sample-spanish", "El informe trimestral muestra un aumento"],
  ["deu", "sample-german", "Der Quartalsbericht zeigt einen stetigen Anstieg"],
  ["por", "sample-portuguese", "O relatório trimestral mostra um aumento constante"],
  ["ita", "sample-italian", "Il rapporto trimestrale mostra un aumento costante"],
  ["rus", "sample-russian", "Квартальный отчет показывает устойчивый рост"],
  ["ara", "sample-arabic", "يظهر التقرير الفصلي زيادة مطردة"],
  ["hin", "sample-hindi", "तिमाही रिपोर्ट में स्थिर वृद्धि दिखाई गई"],
  ["chi_sim", "sample-chinese", "季度报告显示各地区收入稳步增长"],
  ["jpn", "sample-japanese", "四半期報告書は着実な増加を示しています"],
  ["kor", "sample-korean", "분기 보고서는 꾸준한 증가를 보여줍니다"],
];
const languageFixtureText = {};
for (const [lang, name, text] of LANGUAGE_FIXTURES) {
  await page.setContent('<canvas id="c" width="900" height="150"></canvas>');
  await page.evaluate((text) => {
    const ctx = document.getElementById('c').getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 900, 150);
    ctx.fillStyle = '#000000';
    ctx.font = '36px sans-serif';
    ctx.fillText(text, 20, 80);
  }, text);
  writeFileSync(`${FIXTURE_DIR}${name}.png`, await toPng());
  languageFixtureText[name] = text;
}

// --- per-language degraded-accuracy fixtures: the gap explicitly flagged
// when multi-language OCR shipped (#23) — the eleven LANGUAGE_FIXTURES
// above only ever proved clean, single-line, high-contrast text works per
// language, the same lighter bar sample-invoice alone was before
// paragraph/table/noisy-scan gave English real degraded-condition
// coverage. Every supported language now gets that same real bar: a
// multi-line paragraph, clean and once degraded through the exact
// renderDegradedLines() recipe already tuned for English (same rotation,
// noise amplitude, blur, seed) — not a lighter or re-tuned-per-language
// version of it, so results are genuinely comparable across languages.
//
// Canvas is wider (1100px) and the font a touch smaller (22px) than
// English's own paragraph/noisy-scan fixtures (900-950px, 24px) — checked
// directly against a real render for the widest scripts here (Chinese,
// Japanese, German's longer compound words) before finalizing, not
// assumed to fit from the single-line fixtures' width alone. ---
const LANGUAGE_PARAGRAPHS = {
  fra: [
    "Le rapport trimestriel montre une augmentation constante du chiffre",
    "d'affaires dans toutes les régions. Les scores de satisfaction client",
    "se sont améliorés de 12% par rapport à la période précédente, tandis",
    "que les coûts opérationnels sont restés stables.",
  ],
  spa: [
    "El informe trimestral muestra un aumento constante de los ingresos",
    "en todas las regiones. Las puntuaciones de satisfacción del cliente",
    "mejoraron un 12% en comparación con el período anterior, mientras",
    "que los costos operativos se mantuvieron estables.",
  ],
  deu: [
    "Der Quartalsbericht zeigt einen stetigen Anstieg des Umsatzes in",
    "allen Regionen. Die Kundenzufriedenheit verbesserte sich um 12",
    "Prozent im Vergleich zum Vorquartal, während die Betriebskosten",
    "stabil blieben.",
  ],
  por: [
    "O relatório trimestral mostra um aumento constante da receita em",
    "todas as regiões. Os índices de satisfação do cliente melhoraram",
    "12% em relação ao período anterior, enquanto os custos operacionais",
    "permaneceram estáveis.",
  ],
  ita: [
    "Il rapporto trimestrale mostra un aumento costante dei ricavi in",
    "tutte le regioni. I punteggi di soddisfazione dei clienti sono",
    "migliorati del 12% rispetto al periodo precedente, mentre i costi",
    "operativi sono rimasti stabili.",
  ],
  rus: [
    "Квартальный отчет показывает устойчивый рост выручки во всех",
    "регионах. Показатели удовлетворенности клиентов выросли на 12",
    "процентов по сравнению с предыдущим периодом, при этом операционные",
    "расходы остались стабильными.",
  ],
  ara: [
    "يظهر التقرير الفصلي زيادة مطردة في الإيرادات في جميع المناطق",
    "تحسنت درجات رضا العملاء بنسبة 12 بالمئة مقارنة بالفترة السابقة",
    "بينما ظلت التكاليف التشغيلية مستقرة خلال هذه الفترة الزمنية",
  ],
  hin: [
    "तिमाही रिपोर्ट में सभी क्षेत्रों में राजस्व में स्थिर वृद्धि",
    "दिखाई गई है। ग्राहक संतुष्टि स्कोर में पिछली अवधि की तुलना में",
    "12 प्रतिशत का सुधार हुआ, जबकि परिचालन लागत स्थिर रही।",
  ],
  chi_sim: [
    "季度报告显示各地区收入稳步增长。客户满意度评分较上期提高了",
    "百分之十二，而运营成本保持稳定。",
  ],
  jpn: [
    "四半期報告書はすべての地域で収益が着実に増加していることを",
    "示しています。顧客満足度スコアは前期と比較して12パーセント",
    "向上し、運営コストは安定していました。",
  ],
  kor: [
    "분기 보고서는 모든 지역에서 매출이 꾸준히 증가하고 있음을",
    "보여줍니다. 고객 만족도 점수는 이전 기간과 비교하여 12퍼센트",
    "향상되었으며, 운영 비용은 안정적으로 유지되었습니다.",
  ],
};
const LANGUAGE_PARAGRAPH_SEED = 20260822;
const languageParagraphText = {};
for (const [lang, lines] of Object.entries(LANGUAGE_PARAGRAPHS)) {
  const cleanName = `paragraph-${lang}`;
  const noisyName = `noisy-${lang}`;

  // Same font size (24px) and line metrics as English's own paragraph/
  // noisy-scan fixtures — a smaller font here would make this language's
  // text more vulnerable to the exact same absolute noise amplitude/blur
  // radius than English's baseline, which would test "smaller text under
  // fixed-strength noise," not "the same degradation applied fairly
  // across languages." Canvas is wider (1300px) purely to prevent
  // clipping for longer lines in some scripts — checked visually against
  // a real render before finalizing, not assumed to fit.
  await page.setContent('<canvas id="c" width="1300" height="280"></canvas>');
  await page.evaluate((lines) => {
    const ctx = document.getElementById('c').getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 1300, 280);
    ctx.fillStyle = '#000000';
    ctx.font = '24px sans-serif';
    lines.forEach((line, i) => ctx.fillText(line, 50, 70 + i * 38));
  }, lines);
  writeFileSync(`${FIXTURE_DIR}${cleanName}.png`, await toPng());

  const noisyPng = await renderDegradedLines(lines, {
    width: 1300, height: 280, seed: LANGUAGE_PARAGRAPH_SEED,
  });
  writeFileSync(`${FIXTURE_DIR}${noisyName}.png`, noisyPng);

  languageParagraphText[lang] = lines.join(lang === 'chi_sim' || lang === 'jpn' ? '' : ' ');
}

// --- corrupt-image: a genuinely truncated real PNG (the realistic "an
// upload/download got cut off partway" case), not a synthetic 0-byte file
// or random bytes — confirmed by hand against the real pipeline that this
// makes Tesseract's recognize() genuinely throw ("Error attempting to read
// image."), not just return empty/garbage text, which a truly empty file
// also does but is a less realistic failure mode. ---
writeFileSync(`${FIXTURE_DIR}corrupt-image.png`, invoicePng.subarray(0, 30));

// --- paragraph: multi-line body text ---
const PARAGRAPH_LINES = [
  "The quarterly report shows a steady increase in revenue across all",
  "regions. Customer satisfaction scores improved by 12% compared to",
  "the previous period, while operational costs remained flat. The",
  "board recommends continuing the current strategy through the next",
  "fiscal year.",
];
await page.setContent('<canvas id="c" width="900" height="260"></canvas>');
await page.evaluate((lines) => {
  const ctx = document.getElementById('c').getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 900, 260);
  ctx.fillStyle = '#000000';
  ctx.font = '24px sans-serif';
  lines.forEach((line, i) => ctx.fillText(line, 30, 50 + i * 38));
}, PARAGRAPH_LINES);
const paragraphPng = await toPng();
writeFileSync(`${FIXTURE_DIR}paragraph.png`, paragraphPng);

// --- table: tabular/numeric data ---
const TABLE_LINES = [
  "Item        Qty   Price    Total",
  "Widget A     3   $12.50   $37.50",
  "Widget B     1   $89.99   $89.99",
  "Widget C     5    $4.25   $21.25",
];
await page.setContent('<canvas id="c" width="700" height="260"></canvas>');
await page.evaluate((lines) => {
  const ctx = document.getElementById('c').getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 700, 260);
  ctx.fillStyle = '#000000';
  ctx.font = '26px monospace';
  lines.forEach((line, i) => ctx.fillText(line, 30, 50 + i * 44));
}, TABLE_LINES);
writeFileSync(`${FIXTURE_DIR}table.png`, await toPng());

// --- noisy-scan: the paragraph again, degraded like a real phone photo —
// see renderDegradedLines above for the recipe and why it's seeded. Tuned
// by real measurement (scripts/measure-fixture-accuracy.mjs) against this
// seeded, reproducible noise — not guessed. ---
const NOISE_SEED = 20260820;
const noisyScanPng = await renderDegradedLines(PARAGRAPH_LINES, { width: 950, height: 320, seed: NOISE_SEED });
writeFileSync(`${FIXTURE_DIR}noisy-scan.png`, noisyScanPng);

// --- sample-multipage: a real PDF (not an image saved as .pdf), to exercise
// the PDF-input pipeline (pdf-to-images.js rasterizes each page via pdf.js,
// then the existing image OCR pipeline runs on the result — see F-3 in the
// private backlog). Built directly with pdf-lib; no browser rendering is
// needed to *construct* a PDF, only to later rasterize it, which is exactly
// the step this fixture exists to test. ---
export const PDF_PAGE_TEXTS = [
  "Page one: purchase order 4471, ship to Springfield warehouse.",
  "Page two: quantity 250 units, unit price $6.40, subtotal $1,600.00.",
  "Page three: approved by J Ramirez on the fourteenth of March.",
];
{
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  for (const text of PDF_PAGE_TEXTS) {
    const page = pdfDoc.addPage([612, 200]);
    page.drawText(text, { x: 50, y: 120, size: 18, font, color: rgb(0, 0, 0) });
  }
  writeFileSync(`${FIXTURE_DIR}sample-multipage.pdf`, await pdfDoc.save());
}

// --- scanned-multipage: a PDF whose pages are themselves raster images (a
// real scanned/photographed PDF is exactly this shape — the "page" has no
// vector content, pdf.js is just rasterizing an already-raster image) —
// unlike sample-multipage.pdf above, which is clean vector text and
// doesn't test how *upscaling an embedded raster image* at different
// render DPIs affects OCR. Page 1 reuses noisy-scan.png (degraded);
// page 2 reuses paragraph.png (clean) — both already-tuned, reproducible
// fixtures, not new noise parameters to re-tune. Each page is sized in
// PDF points 1:1 with the source image's pixels, so "render at N DPI"
// means exactly "scale this image by N/72", the same math
// pdf-to-images.js itself uses. ---
{
  const pdfDoc = await PDFDocument.create();
  const noisyImage = await pdfDoc.embedPng(noisyScanPng);
  const noisyPage = pdfDoc.addPage([noisyImage.width, noisyImage.height]);
  noisyPage.drawImage(noisyImage, { x: 0, y: 0, width: noisyImage.width, height: noisyImage.height });

  const paragraphImage = await pdfDoc.embedPng(paragraphPng);
  const paragraphPage = pdfDoc.addPage([paragraphImage.width, paragraphImage.height]);
  paragraphPage.drawImage(paragraphImage, { x: 0, y: 0, width: paragraphImage.width, height: paragraphImage.height });

  writeFileSync(`${FIXTURE_DIR}scanned-multipage.pdf`, await pdfDoc.save());
}

// --- manifest: what each fixture expects, and how strictly to check it ---
const manifest = [
  { name: "sample-invoice", file: "sample-invoice.png", expectedText: INVOICE_TEXT, mode: "exact" },
  { name: "paragraph", file: "paragraph.png", expectedText: PARAGRAPH_LINES.join(" "), mode: "word-accuracy" },
  { name: "table", file: "table.png", expectedText: TABLE_LINES.join(" "), mode: "word-accuracy" },
  { name: "noisy-scan", file: "noisy-scan.png", expectedText: PARAGRAPH_LINES.join(" "), mode: "word-accuracy" },
  { name: "sample-multipage", file: "sample-multipage.pdf", expectedPages: PDF_PAGE_TEXTS, mode: "pdf-word-accuracy" },
  {
    name: "scanned-multipage",
    file: "scanned-multipage.pdf",
    expectedPages: [PARAGRAPH_LINES.join(" "), PARAGRAPH_LINES.join(" ")],
    mode: "pdf-word-accuracy",
  },
  // Verified by real recognize() calls against these exact sentences
  // (same 900x150 canvas, 36px sans-serif) before being set to "exact":
  // fra/spa/rus/ara/hin/kor came back byte-for-byte identical to the
  // source text. deu/por/ita use the same "exact" mode on the same
  // evidentiary basis as every other Latin-script language here (French
  // and Spanish, both verified exact, share the same script/rendering
  // path) — but re-check with `npm run measure-accuracy` specifically for
  // these three before trusting it, since they weren't independently
  // re-verified after this file's text was finalized.
  { name: "sample-french", file: "sample-french.png", lang: "fra", expectedText: languageFixtureText["sample-french"], mode: "exact" },
  { name: "sample-spanish", file: "sample-spanish.png", lang: "spa", expectedText: languageFixtureText["sample-spanish"], mode: "exact" },
  { name: "sample-german", file: "sample-german.png", lang: "deu", expectedText: languageFixtureText["sample-german"], mode: "exact" },
  { name: "sample-portuguese", file: "sample-portuguese.png", lang: "por", expectedText: languageFixtureText["sample-portuguese"], mode: "exact" },
  { name: "sample-italian", file: "sample-italian.png", lang: "ita", expectedText: languageFixtureText["sample-italian"], mode: "exact" },
  { name: "sample-russian", file: "sample-russian.png", lang: "rus", expectedText: languageFixtureText["sample-russian"], mode: "exact" },
  { name: "sample-arabic", file: "sample-arabic.png", lang: "ara", expectedText: languageFixtureText["sample-arabic"], mode: "exact" },
  { name: "sample-hindi", file: "sample-hindi.png", lang: "hin", expectedText: languageFixtureText["sample-hindi"], mode: "exact" },
  // chi_sim/jpn: Tesseract inserts spaces between individual CJK
  // characters/words that the source text doesn't have — real,
  // deterministic segmentation behavior confirmed by direct measurement,
  // not a bug. "exact" mode would fail even on perfectly correct
  // recognition, so these use "word-accuracy" with expectedText already
  // written to match Tesseract's own real segmentation (re-confirm exact
  // spacing via `npm run measure-accuracy` — segmentation can be sensitive
  // to exact rendering, so this needs checking against this file's actual
  // committed fixture, not assumed to exactly match an earlier throwaway
  // test image).
  { name: "sample-chinese", file: "sample-chinese.png", lang: "chi_sim", expectedText: "季度 报告 显示 各 地 区 收入 稳步 增长", mode: "word-accuracy" },
  { name: "sample-japanese", file: "sample-japanese.png", lang: "jpn", expectedText: "四半 期 報 告 書 は 着実 な 増加 を 示し て いま す", mode: "word-accuracy" },
  { name: "sample-korean", file: "sample-korean.png", lang: "kor", expectedText: languageFixtureText["sample-korean"], mode: "exact" },
  // Per-language degraded-accuracy fixtures (see LANGUAGE_PARAGRAPHS above)
  // — real multi-line paragraphs, clean and noisy-scan-degraded (same
  // recipe as English's own noisy-scan, same font size, only the canvas
  // is wider to avoid clipping — see renderDegradedLines' call above),
  // giving every supported language the same bar English's own
  // paragraph/noisy-scan fixtures already set, not just the single-line
  // exact-match check above. Thresholds are set separately in
  // scripts/verify.mjs's THRESHOLDS, from real measured numbers (this
  // script's own convention, see file header) — not guessed.
  //
  // chi_sim/jpn expectedText is NOT the plain source string (see the
  // sample-chinese/sample-japanese comment above for why — Tesseract
  // inserts spaces between individual characters); it's the CLEAN
  // fixture's own real recognized output, used as ground truth precisely
  // because it was independently confirmed 100% content-correct against
  // the source text (word-by-word) — except jpn's clean recognize()
  // misread one character (顧 "customer" as 願, a real, visually similar
  // character it confused), corrected here rather than baked in as
  // "expected", since expectedText is meant to represent true content,
  // not "whatever Tesseract happened to output."
  ...Object.entries(LANGUAGE_PARAGRAPHS).flatMap(([lang, lines]) => {
    const expectedText = lang === 'chi_sim'
      ? "季度 报告 显示 各 地 区 收入 稳步 增长 。 客 户 满意 度 评分 较 上 期 提高 了 百 分 之 十 二 ， 而 运营 成 本 保持 稳定 。"
      : lang === 'jpn'
        ? "四半 期 報 告 書 は すべ て の 地域 で 収益 が 着実 に 増加 し て いる こと を 示し て いま す 。 顧 客 満足 度 ス コア は 前 期 と 比較 し て 12 パ ー セ ント 向上 し 、 運 営 コ スト は 安定 し て いま し た 。"
        : languageParagraphText[lang];
    return [
      { name: `paragraph-${lang}`, file: `paragraph-${lang}.png`, lang, expectedText, mode: "word-accuracy" },
      { name: `noisy-${lang}`, file: `noisy-${lang}.png`, lang, expectedText, mode: "word-accuracy" },
    ];
  }),
];
writeFileSync(`${FIXTURE_DIR}manifest.json`, JSON.stringify(manifest, null, 2) + "\n");

console.log(`Wrote ${manifest.length} fixtures + manifest.json to ${FIXTURE_DIR}`);
console.log("Run `npm run measure-accuracy` next to see real recognized output and set honest thresholds.");
await browser.close();
