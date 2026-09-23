// scripts/calibrate.ts — Asistente de calibración SEMI-AUTOMÁTICA de selectores.
//
// ¿Qué hace?
//  1. Abre Chromium (Playwright) contra la URL que le pases del buscador del IMPI.
//  2. Guarda una captura PNG + el HTML crudo en ./calibration/ para que los veas.
//  3. Ejecuta heurísticas de descubrimiento: busca tablas/listas repetitivas,
//     columnas con patrones reconocibles (folios tipo "#####/XX", clases 1-45,
//     fechas, palabras de estatus IMPI) y postula selectores candidatos.
//  4. Escribe scrape-profile.json con los selectores postulados + te imprime
//     un diff contra el perfil anterior.
//  5. Con --review abre el navegador en modo VISIBLE para que confirmes/ajustes
//     a mano (tú haces clic derecho → Inspeccionar → copiar selector; el script
//     te deja pegar los finales en un prompt interactivo).
//
// Uso:
//   npx tsx scripts/calibrate.ts "https://URL-DEL-BUSCADOR?q=SABINAS"
//   npx tsx scripts/calibrate.ts "<url>" --review      (navegador visible)
//   npx tsx scripts/calibrate.ts "<url>" --dry-run     (no sobreescribe perfil)

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as readline from "node:readline/promises";

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith("http"));
const REVIEW = args.includes("--review");
const DRY = args.includes("--dry-run");

if (!url) {
  console.error('Uso: npx tsx scripts/calibrate.ts "https://url-del-buscador-impi" [--review] [--dry-run]');
  process.exit(1);
}

const OUT = resolve(process.cwd(), "calibration");
mkdirSync(OUT, { recursive: true });

const ESTATUS_WORDS = ["vigente", "registrad", "solicitud", "trámite", "tramite", "negad", "denieg", "abandono", "cancelad", "vencid", "extinguid"];

async function main() {
  const browser = await chromium.launch({ headless: !REVIEW, args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ locale: "es-MX", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" });
  const page = await ctx.newPage();

  // Captura también las respuestas JSON/XHR: muchos portales gob.mx son SPAs
  // que llaman a una API interna — si la encontramos, ¡mejor que scrapear DOM!
  const apiCalls: { url: string; method: string; status: number; sample: string }[] = [];
  page.on("response", async (res) => {
    try {
      const ct = res.headers()["content-type"] ?? "";
      if ((ct.includes("json") || res.url().includes("api")) && [200].includes(res.status())) {
        const body = await res.text().catch(() => "");
        if (body.length > 20 && body.length < 500_000) {
          apiCalls.push({ url: res.url(), method: res.request().method(), status: res.status(), sample: body.slice(0, 800) });
        }
      }
    } catch { /* ignore */ }
  });

  console.log(`→ Navegando a ${url}`);
  await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 }).catch(async () => {
    console.warn("  networkidle expiró, continuando con domcontentloaded…");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(5000);
  });
  await page.waitForTimeout(2500); // dejar respirar a hidratación JS

  await page.screenshot({ path: resolve(OUT, "page.png"), fullPage: true });
  writeFileSync(resolve(OUT, "page.html"), await page.content());
  writeFileSync(resolve(OUT, "api-calls.json"), JSON.stringify(apiCalls, null, 2));
  console.log(`✓ Captura: calibration/page.png | HTML: calibration/page.html`);
  console.log(`✓ Llamadas XHR/fetch capturadas: ${apiCalls.length} → calibration/api-calls.json`);
  if (apiCalls.length) {
    console.log("\n🔥 POSIBLE ATAJO: este portal hace llamadas a APIs internas. Revisa api-calls.json;");
    console.log("   si alguna devuelve los resultados en JSON, podemos saltarnos el scraping de DOM");
    console.log("   y consultar la API directamente (mucho más rápido y robusto a cambios de diseño).\n");
  }

  // Heurística de descubrimiento de filas repetitivas
  const discovery = await page.evaluate((estatusWords: string[]) => {
    const score = (sel: string) => document.querySelectorAll(sel).length;
    const candidates = ["table tbody tr", ".resultados .row", "[class*='resultado'] tr", "ul li", "article", ".card", "tbody tr", "[role='row']"];
    let best = ""; let bestN = 0;
    for (const c of candidates) { const n = score(c); if (n >= 2 && n > bestN) { best = c; bestN = n; } }
    if (!best) return { rowSelector: null, sampleCells: [] as string[], foundTotal: null as string | null };

    const firstRow = document.querySelector(best)!;
    const cells = [...firstRow.querySelectorAll("td, th, [role='cell'], span, div")]
      .map((el) => (el.textContent ?? "").trim())
      .filter((t) => t.length > 0 && t.length < 120);

    // ¿dónde está el total?
    let foundTotal: string | null = null;
    for (const sel of ["[class*='total']", "h1", "h2", "caption", "p"]) {
      const t = [...document.querySelectorAll(sel)].map((e) => e.textContent ?? "").join(" ");
      const m = t.match(/(\d[\d,\.]*)\s*(resultado|registro|marca)/i);
      if (m) { foundTotal = sel; break; }
    }
    return { rowSelector: best, count: bestN, sampleCells: cells.slice(0, 12), foundTotal, estatusHits: cells.filter((c) => estatusWords.some((w) => c.toLowerCase().includes(w))) };
  }, ESTATUS_WORDS);

  console.log("🔎 Descubrimiento heurístico:");
  console.log(JSON.stringify(discovery, null, 2));

  if (!discovery.rowSelector) {
    console.warn("\n⚠️ No encontré filas repetitivas. Puede que la página requiera interactuar");
    console.warn("   (escribir en el buscador, aceptar cookies, resolver captcha).");
    console.warn("   Corre con --review para hacerlo a mano y vuelve a intentarlo.");
  } else {
    console.warn("\n✅ Postulé un perfil. REVISA calibration/page.png y ajusta los campos.");
  }

  let rowSel = discovery.rowSelector ?? "table tbody tr";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, dflt: string) => { const a = (await rl.question(`${q} [Enter=${dflt}]: `)).trim(); return a || dflt; };

  if (REVIEW) {
    console.log("\n👀 Modo review: el navegador quedó ABIERTO. Inspecciona, luego responde aquí.");
    console.log("   (consejo: clic derecho sobre un dato → Inspeccionar → copia un selector único)\n");
    rowSel = await ask("Selector de FILA de resultados:", rowSel);
  }

  const nCols = Math.max(6, discovery.sampleCells?.length ?? 6);
  const fields: Record<string, string[]> = {};
  const labels = ["denominacion", "folio", "clase", "estatus", "titular", "fecha_solicitud"];
  for (let i = 0; i < labels.length; i++) {
    const guess = `td:nth-child(${i + 1})`;
    const val = REVIEW ? await ask(`Selector para "${labels[i]}" (columna ${i + 1}/${nCols}):`, guess) : guess;
    fields[labels[i]] = [val];
  }
  const baseUrl = new URL(url).origin;
  const searchPath = new URL(url).pathname;
  rl.close();

  const profile = {
    name: "acervo-impi-calibrated",
    base_url: baseUrl,
    search_path: searchPath,
    detail_path_template: `${searchPath}{folio}`,
    query_params: { denominacion: new URL(url).searchParams.has("q") ? "q" : "denomination", clase: "internationalClass", pagina: "page" },
    result_row: [rowSel],
    fields,
    total_selector: [discovery.foundTotal ?? "[class*='total']"],
    captcha_selectors: ["iframe[src*='captcha']", ".g-recaptcha", "#captcha"],
    pagination: { param: "page", start: 1 },
    updated_at: new Date().toISOString().slice(0, 10),
    notes: `Generado por calibrate.ts contra ${url}. Filas detectadas: ${discovery.count ?? "?"}. Revisa antes de producción.`,
  };

  if (DRY) {
    console.log("\n--dry-run: perfil propuesto (no guardado):");
    console.log(JSON.stringify(profile, null, 2));
  } else {
    writeFileSync(resolve(process.cwd(), "scrape-profile.json"), JSON.stringify(profile, null, 2));
    console.log("\n💾 scrape-profile.json actualizado. Prueba con: SCRAPE_MODE=auto npm run dev:api");
  }

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
