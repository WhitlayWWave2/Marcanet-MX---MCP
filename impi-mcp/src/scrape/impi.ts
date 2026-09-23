// src/scrape/impi.ts — Extracción REAL del Acervo de Marcas del IMPI.
// ⚠️ ADVERTENCIA: los selectores y URLs deben validarse contra el DOM actual
// del portal (https://dl.gob.mx / https://marcanet.impi.gob.mx). Este archivo
// es la PLANTILLA de producción: estructura correcta, puntos de anclaje marcados
// con TODO-SELECTOR para que se completen tras inspeccionar el sitio en vivo.
//
// Activación: SCRAPE_MODE=real  (requiere `npx playwright install chromium`)

import type { BusquedaParams, BusquedaResultado, ResultadoMarca } from "./types.js";

const BASE = process.env.IMPI_BASE_URL ?? "https://dl.gob.mx/marca/consulta/"; // TODO-URL: endpoint real del buscador
const NAV_TIMEOUT = Number(process.env.IMPI_NAV_TIMEOUT ?? 45_000);

let browserPromise: Promise<any> | null = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await import("playwright");
      return chromium.launch({
        headless: true,
        args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
      });
    })();
  }
  return browserPromise;
}

/** Rate limiter global compartido entre workers (token bucket simple en proceso;
 *  en multi-proceso usar Redis — ver Escalar100k.md). */
let lastHit = 0;
const MIN_INTERVAL = Number(process.env.IMPI_MIN_INTERVAL_MS ?? 1200); // ~0.8 req/s por instancia
async function politeWait() {
  const now = Date.now();
  const wait = Math.max(0, lastHit + MIN_INTERVAL - now);
  if (wait) await new Promise((r) => setTimeout(r, wait + Math.random() * 300)); // jitter
  lastHit = Date.now();
}

export async function searchImpiReal({ nombre_marca, clase, pagina = 1 }: BusquedaParams): Promise<BusquedaResultado> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    locale: "es-MX",
  });
  const page = await context.newPage();
  try {
    await politeWait();
    const url = new URL(BASE.toString());
    Object.assign(url.searchParams, {
      // TODO-URL: nombres reales de query params del buscador de Acervo
      denomination: nombre_marca,
      internationalClass: clase ? String(clase) : "",
      page: String(pagina),
    });
    await page.goto(url.toString(), { waitUntil: "networkidle", timeout: NAV_TIMEOUT });

    // Detección de CAPTCHA → señal para poner el job en needs_human
    if (await page.locator("iframe[src*='captcha'], .g-recaptcha, #captcha").count()) {
      return { total: 0, pagina, resultados: [], captcha: true };
    }

    // TODO-SELECTOR: tabla de resultados del buscador de Acervo de Marcas
    const rows = await page.$$eval("table.resultados tbody tr", (trs: Element[]) =>
      trs.map((tr) => {
        const cells = [...tr.querySelectorAll("td")].map((td) => td.textContent?.trim() ?? "");
        return {
          marca: cells[0] ?? "",            // TODO-SELECTOR: columna Denominación
          folio: cells[1] ?? "",            // TODO-SELECTOR: columna Folio/Expediente
          clase: Number(cells[2]) || 0,     // TODO-SELECTOR: columna Clase Niza
          estatus: mapEstatus(cells[3] ?? ""), // TODO-SELECTOR: columna Estatus
          titular: cells[4] ?? "",          // TODO-SELECTOR: columna Titular
          fecha_solicitud: cells[5] || undefined,
        };
      })
    );

    const totalTxt = await page.locator(".total-results").first().textContent().catch(() => null);
    return {
      total: totalTxt ? parseInt(totalTxt.replace(/\D/g, ""), 10) || rows.length : rows.length,
      pagina,
      resultados: rows as ResultadoMarca[],
    };
  } finally {
    await context.close();
  }
}

export async function getExpedienteReal(folio: string): Promise<ResultadoMarca> {
  const browser = await getBrowser();
  const context = await browser.newContext({ locale: "es-MX" });
  const page = await context.newPage();
  try {
    await politeWait();
    // TODO-URL: ruta directa a ficha de expediente
    await page.goto(`${BASE}expediente/${encodeURIComponent(folio)}`, { waitUntil: "networkidle", timeout: NAV_TIMEOUT });
    const grab = async (sel: string) => (await page.locator(sel).first().textContent().catch(() => ""))?.trim() ?? "";
    return {
      marca: await grab("[data-field='denomination']"),       // TODO-SELECTOR
      folio,
      clase: Number(await grab("[data-field='nice-class']")), // TODO-SELECTOR
      estatus: mapEstatus(await grab("[data-field='status']")),
      titular: await grab("[data-field='holder']"),
      fecha_solicitud: (await grab("[data-field='filed']")) || undefined,
      fecha_registro: (await grab("[data-field='registered']")) || undefined,
      vigencia_hasta: (await grab("[data-field='expires']")) || undefined,
    };
  } finally {
    await context.close();
  }
}

/** Mapea textos libres del portal al enum interno. Ampliar según glosa IMPI. */
function mapEstatus(txt: string): ResultadoMarca["estatus"] {
  const t = txt.toLowerCase();
  if (t.includes("vigente") || t.includes("registrad")) return "registrada_vigente";
  if (t.includes("venc")) return "registrada_vencida";
  if (t.includes("tramite") || t.includes("solicitud")) return "solicitud_en_tramite";
  if (t.includes("negad") || t.includes("denieg")) return "solicitud_negada";
  if (t.includes("abandono")) return "abandono";
  if (t.includes("cancel")) return "cancelada";
  return "desconocido";
}
