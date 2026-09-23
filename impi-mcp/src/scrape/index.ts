// src/scrape/index.ts — Dispatcher mock ↔ real.
// SCRAPE_MODE=real → Playwright contra IMPI (requiere selectores validados).
// por defecto     → mock determinista (todo el pipeline es utilizable hoy).

import type { BusquedaParams, BusquedaResultado, ResultadoMarca } from "./types.js";
import { searchImpiMock, getExpedienteMock } from "./mock.js";

const REAL = process.env.SCRAPE_MODE === "real";

export async function searchImpi(p: BusquedaParams): Promise<BusquedaResultado> {
  if (REAL) {
    const m = await import("./impi.js");
    return m.searchImpiReal(p);
  }
  return searchImpiMock(p);
}

export async function getExpediente(folio: string): Promise<ResultadoMarca> {
  if (REAL) {
    const m = await import("./impi.js");
    return m.getExpedienteReal(folio);
  }
  return getExpedienteMock(folio);
}

export * from "./types.js";
