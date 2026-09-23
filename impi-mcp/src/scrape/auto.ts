// src/scrape/auto.ts — Scraper CONDUCTOR: opera contra el sitio real usando el
// perfil declarativo (scrape-profile.json) en lugar de selectores hardcodeados.
//
// SCRAPE_MODE=auto → usa este módulo (recomendado para producción).
// Flujo por búsqueda:
//  1. Abre página de resultados con los query_params del perfil.
//  2. Detecta CAPTCHA → devuelve { captcha: true } (el worker pone needs_human).
//  3. Prueba cada selector candidato de fila hasta que uno produzca ≥1 fila con datos.
//  4. Extrae columnas con los selectores de campos; valida tipos (clase 1-45, fechas).
//  5. Si un selector falla sistemáticamente, loguea qué falló → te da diagnóstico
//     accionable ("ejecuta npm run calibrate") sin romper el servicio.

import type { BusquedaParams, BusquedaResultado, ResultadoMarca } from "./types.js";
import { loadProfile, type ScrapeProfile } from "./profile.js";

const NAV_TIMEOUT = Number(process.env.IMPI_NAV_TIMEOUT ?? 45_000);
const MIN_INTERVAL = Number(process.env.IMPI_MIN_INTERVAL_MS ?? 1200);

let browserPromise: Promise<any> | null = null;
async function getBrowser() {
  if (!browserPromise) {
    const { chromium } = await import("playwright");
    browserPromise = chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"] });
  }
  return browserPromise;
}

let lastHit = 0;
async function politeWait() {
  const now = Date.now();
  const wait = Math.max(0, lastHit + MIN_INTERVAL - now);
  if (wait) await new Promise((r) => setTimeout(r, wait + Math.random() * 300));
  lastHit = Date.now();
}

function buildSearchUrl(p: BusquedaParams, prof: ScrapeProfile): string {
  const u = new URL(prof.search_path, prof.base_url);
  const map = prof.query_params;
  if (map.denominacion) u.searchParams.set(map.denominacion, p.nombre_marca);
  if (map.clase && p.clase) u.searchParams.set(map.clase, String(p.clase));
  if (map.pagina) u.searchParams.set(map.pagina, String(p.pagina ?? prof.pagination.start));
  return u.toString();
}

const looksLikeFolio = (s: string) => /\d{3,}[/\-]?\d{0,4}|[A-Z]{1,3}\d{4,}/i.test(s);
const looksLikeClase = (n: number) => Number.isInteger(n) && n >= 1 && n <= 45;
const looksLikeFecha = (s: string) => /\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}/.test(s) || /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Mapea textos libres del portal al enum interno (glosa IMPI). */
export function mapEstatus(txt: string): ResultadoMarca["estatus"] {
  const t = (txt ?? "").toLowerCase();
  if (t.includes("vigente") || t.includes("registrad")) return "registrada_vigente";
  if (t.includes("venc")) return "registrada_vencida";
  if (t.includes("trámite") || t.includes("tramite") || t.includes("solicitud")) return "solicitud_en_tramite";
  if (t.includes("negad") || t.includes("denieg")) return "solicitud_negada";
  if (t.includes("abandono")) return "abandono";
  if (t.includes("cancel") || t.includes("extinguid")) return "cancelada";
  return "desconocido";
}

async function extractWithSelectors(page: any, prof: ScrapeProfile): Promise<{ rows: ResultadoMarca[]; rowSelUsed: string | null }> {
  for (const rowSel of prof.result_row) {
    try {
      const count = await page.locator(rowSel).count();
      if (!count) continue;
      const rows: ResultadoMarca[] = [];
      for (let i = 0; i < Math.min(count, 50); i++) {
        const tr = page.locator(rowSel).nth(i);
        const grab = async (sels: string[]) => {
          for (const s of sels) {
            const txt = (await tr.locator(s).first().textContent().catch(() => null))?.trim();
            if (txt) return txt;
          }
          // fallback posicional: celdas td/th
          const cells = await tr.locator("td, th").allTextContents().catch(() => [] as string[]);
          const idx = Object.values(prof.fields).findIndex((arr) => arr.includes(sels[0]));
          return cells[idx]?.trim() ?? "";
        };
        const marca = await grab(prof.fields.denominacion);
        const folio = await grab(prof.fields.folio);
        if (!marca && !folio) continue;
        const claseRaw = await grab(prof.fields.clase);
        const clase = parseInt(claseRaw.replace(/\D/g, ""), 10);
        const fecha = await grab(prof.fields.fecha_solicitud);
        rows.push({
          marca,
          folio,
          clase: looksLikeClase(clase) ? clase : 0,
          estatus: mapEstatus(await grab(prof.fields.estatus)),
          titular: await grab(prof.fields.titular),
          fecha_solicitud: looksLikeFecha(fecha) ? fecha : undefined,
        });
      }
      if (rows.length) return { rows, rowSelUsed: rowSel };
    } catch (e) {
      console.warn(`[auto] selector de fila "${rowSel}" falló:`, (e as Error).message);
    }
  }
  return { rows: [], rowSelUsed: null };
}

export async function searchImpiAuto(p: BusquedaParams): Promise<BusquedaResultado> {
  const prof = loadProfile();
  const browser = await getBrowser();
  const ctx = await browser.newContext({ locale: "es-MX", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" });
  const page = await ctx.newPage();
  try {
    await politeWait();
    await page.goto(buildSearchUrl(p, prof), { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    await page.waitForTimeout(1500); // hidratación SPA

    if (await page.locator(prof.captcha_selectors.join(", ")).count()) {
      return { total: 0, pagina: p.pagina ?? 1, resultados: [], captcha: true };
    }

    const { rows, rowSelUsed } = await extractWithSelectors(page, prof);
    if (!rowSelUsed) {
      console.error(`[auto] ⚠️ Ningún selector de fila produjo datos para "${p.nombre_marca}". ` +
        `El DOM cambió o la URL base es incorrecta → ejecuta: npm run calibrate -- "<url-real>"`);
    }
    let total = rows.length;
    for (const sel of prof.total_selector) {
      const t = (await page.locator(sel).first().textContent().catch(() => null)) ?? "";
      const m = t.match(/(\d[\d,\.]*)\s*(resultado|registro|marca)/i);
      if (m) { total = parseInt(m[1].replace(/[^\d]/g, ""), 10) || total; break; }
    }
    return { total, pagina: p.pagina ?? 1, resultados: rows };
  } finally {
    await ctx.close();
  }
}

export async function getExpedienteAuto(folio: string): Promise<ResultadoMarca> {
  const prof = loadProfile();
  const browser = await getBrowser();
  const ctx = await browser.newContext({ locale: "es-MX" });
  const page = await ctx.newPage();
  try {
    await politeWait();
    const url = new URL(prof.detail_path_template.replace("{folio}", encodeURIComponent(folio)), prof.base_url).toString();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    await page.waitForTimeout(1200);
    const grab = async (sels: string[]) => {
      for (const s of sels) {
        const txt = (await page.locator(s).first().textContent().catch(() => null))?.trim();
        if (txt) return txt;
      }
      return "";
    };
    const clase = parseInt((await grab(prof.fields.clase)).replace(/\D/g, ""), 10);
    return {
      marca: await grab(prof.fields.denominacion),
      folio,
      clase: looksLikeClase(clase) ? clase : 0,
      estatus: mapEstatus(await grab(prof.fields.estatus)),
      titular: await grab(prof.fields.titular),
      fecha_solicitud: (await grab(prof.fields.fecha_solicitud)) || undefined,
    };
  } finally {
    await ctx.close();
  }
}
