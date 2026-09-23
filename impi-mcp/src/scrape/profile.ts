// src/scrape/profile.ts — Perfil de scraping declarativo (JSON) para el modo "auto".
// La idea: en lugar de hardcodear selectores en código, el descubrimiento de
// selectores se guarda en un perfil versionado (scrape-profile.json). Así:
//  - Puedes regenerar el perfil cuando IMPI cambie el DOM, sin recompilar.
//  - Puedes compartirlo/publisharlo junto al paquete.
//  - El scraper "auto" lo carga y opera contra el sitio real.

export interface FieldSelectors {
  /** Selectores CSS candidatos, en orden de prioridad (el primero que dé datos gana). */
  denominacion: string[];
  folio: string[];
  clase: string[];
  estatus: string[];
  titular: string[];
  fecha_solicitud: string[];
}

export interface ScrapeProfile {
  name: string;
  base_url: string;
  search_path: string;              // p.ej. "/marca/consulta/"
  detail_path_template: string;     // p.ej. "/marca/expediente/{folio}"
  query_params: Record<string, string>; // mapa campo→nombre del param (?denomination=...)
  result_row: string[];             // selectores de fila de resultados (candidatos)
  fields: FieldSelectors;
  total_selector: string[];         // dónde está "N resultados"
  captcha_selectors: string[];
  pagination: { param: string; start: number };
  updated_at: string;
  notes?: string;
}

/** Perfil inicial razonable para Acervo de Marcas (gob.mx / dl.gob.mx).
 *  Se sobreescribe automáticamente tras correr `npm run calibrate`. */
export const DEFAULT_PROFILE: ScrapeProfile = {
  name: "acervo-impi-v0",
  base_url: "https://dl.gob.mx",
  search_path: "/marca/consulta/",
  detail_path_template: "/marca/expediente/{folio}",
  query_params: {
    denominacion: "denomination",
    clase: "internationalClass",
    pagina: "page",
  },
  result_row: [
    "table tbody tr",
    ".resultados .row",
    "[class*='resultado'] tr",
    "article",
  ],
  fields: {
    denominacion: ["td:nth-child(1)", "[data-field='denomination']", "th"],
    folio: ["td:nth-child(2)", "[data-field='folio']", "a[href*='expediente']"],
    clase: ["td:nth-child(3)", "[data-field='nice-class']"],
    estatus: ["td:nth-child(4)", "[data-field='status']"],
    titular: ["td:nth-child(5)", "[data-field='holder']"],
    fecha_solicitud: ["td:nth-child(6)", "[data-field='filed']"],
  },
  total_selector: [".total-results", "[class*='total']", "h1", "caption"],
  captcha_selectors: ["iframe[src*='captcha']", ".g-recaptcha", "#captcha", "input[name*='captcha']"],
  pagination: { param: "page", start: 1 },
  updated_at: "2026-09-24",
  notes: "Perfil por defecto; ejecutar `npm run calibrate -- '<url-real>'` para descubrir selectores.",
};

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROFILE_PATH = resolve(__dirname, "../../scrape-profile.json");

export function loadProfile(): ScrapeProfile {
  if (existsSync(PROFILE_PATH)) {
    try {
      return JSON.parse(readFileSync(PROFILE_PATH, "utf8")) as ScrapeProfile;
    } catch (e) {
      console.error("[profile] scrape-profile.json inválido, usando default:", e);
    }
  }
  return DEFAULT_PROFILE;
}

export function saveProfile(p: ScrapeProfile) {
  writeFileSync(PROFILE_PATH, JSON.stringify(p, null, 2));
}
