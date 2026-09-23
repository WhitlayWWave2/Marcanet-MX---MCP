// src/scrape/index.ts — Dispatcher de modos de scraping.
// SCRAPE_MODE=auto  → scraper conductor guiado por scrape-profile.json (recomendado:
//                     se recalibra con `npm run calibrate` sin recompilar).
// SCRAPE_MODE=real  → plantilla hardcodeada en impi.ts (fallback/manual).
// por defecto       → mock determinista (todo el pipeline es utilizable sin red).

import type { BusquedaParams, BusquedaResultado, ResultadoMarca } from "./types.js";
import { searchImpiMock, getExpedienteMock } from "./mock.js";

const MODE = (process.env.SCRAPE_MODE ?? "mock").toLowerCase();

export async function searchImpi(p: BusquedaParams): Promise<BusquedaResultado> {
  if (MODE === "auto") {
    const m = await import("./auto.js");
    return m.searchImpiAuto(p);
  }
  if (MODE === "real") {
    const m = await import("./impi.js");
    return m.searchImpiReal(p);
  }
  return searchImpiMock(p);
}

export async function getExpediente(folio: string): Promise<ResultadoMarca> {
  if (MODE === "auto") {
    const m = await import("./auto.js");
    return m.getExpedienteAuto(folio);
  }
  if (MODE === "real") {
    const m = await import("./impi.js");
    return m.getExpedienteReal(folio);
  }
  return getExpedienteMock(folio);
}

export * from "./types.js";
