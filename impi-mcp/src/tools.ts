// src/tools.ts — Única implementación de las 5 herramientas del MCP.
// Consumida por: server.ts (stdio/MCP), http-api.ts (REST) y worker.ts (cola).

import { searchImpi, getExpediente } from "./scrape/index.js";
import type { BusquedaResultado, DisponibilidadDictamen, ResultadoMarca } from "./scrape/types.js";
import { similitud } from "./scrape/types.js";
import { cacheGet, cacheSet, dedupe, ttlPorResultado } from "./cache.js";
import { enqueueBatch, getJobStatus } from "./queue.js";

export async function buscarMarca(nombre_marca: string, clase?: number, pagina = 1) {
  const key = `search:${nombre_marca.toLowerCase().trim()}:${clase ?? "*"}:${pagina}`;
  const hit = await cacheGet(key);
  if (hit) return { cached: true, ...(hit as BusquedaResultado) };

  const out = await dedupe(key, () => searchImpi({ nombre_marca, clase, pagina }));
  await cacheSet(key, out, ttlPorResultado(out));
  return { cached: false, ...out };
}

export async function detalleExpediente(folio: string) {
  const key = `exp:${folio}`;
  const hit = await cacheGet(key);
  if (hit) return { cached: true, ...(hit as ResultadoMarca) };
  const out = await dedupe(key, () => getExpediente(folio));
  await cacheSet(key, out, ttlPorResultado({ resultados: [out] }));
  return { cached: false, ...out };
}

/** Dictamen de disponibilidad multi-clase con heurística de riesgo simple. */
export async function verificarDisponibilidad(nombre: string, clases: number[]): Promise<DisponibilidadDictamen> {
  const conflictos: ResultadoMarca[] = [];
  const riesgo: Record<number, "alto" | "medio" | "bajo"> = {};
  for (const c of clases) {
    const r = await buscarMarca(nombre, c);
    let worst: "alto" | "medio" | "bajo" = "bajo";
    for (const m of (r.resultados ?? [])) {
      const viva = m.estatus === "registrada_vigente" || m.estatus === "solicitud_en_tramite";
      if (!viva) continue;
      conflictos.push(m);
      const sim = similitud(nombre, m.marca);
      if (sim > 0.92 && m.estatus === "registrada_vigente") worst = "alto";
      else if (sim > 0.8) worst = worst === "alto" ? worst : "medio";
    }
    riesgo[c] = worst;
  }
  return {
    nombre,
    clases,
    riesgo_por_clase: riesgo,
    conflictos,
    disponible: !Object.values(riesgo).includes("alto"),
  };
}

export const TOOLS: Record<string, (a: any) => Promise<unknown>> = {
  buscar_marca_impi: (a) => buscarMarca(String(a.nombre_marca), a.clase ? Number(a.clase) : undefined, a.pagina ? Number(a.pagina) : 1),
  detalle_expediente: (a) => detalleExpediente(String(a.folio)),
  verificar_disponibilidad: (a) => verificarDisponibilidad(String(a.nombre), (a.clases ?? [30, 35]).map(Number)),
  lote_disponibilidad: (a) => enqueueBatch(a.marcas.map(String), (a.clases ?? []).map(Number)),
  estado_lote: (a) => getJobStatus(String(a.job_id)),
};

export const TOOL_DEFS = [
  {
    name: "buscar_marca_impi",
    description: "Busca marcas registradas en el Acervo de Marcas del IMPI (México) por denominación. Paginado. Usa caché transparente.",
    inputSchema: {
      type: "object" as const,
      properties: {
        nombre_marca: { type: "string", description: "Denominación a buscar" },
        clase: { type: "number", description: "Clase Niza 1-45 (opcional)" },
        pagina: { type: "number", description: "Página de resultados (default 1)" },
      },
      required: ["nombre_marca"],
    },
  },
  {
    name: "detalle_expediente",
    description: "Obtiene la ficha completa de un expediente/registro del IMPI por su folio.",
    inputSchema: { type: "object" as const, properties: { folio: { type: "string" } }, required: ["folio"] },
  },
  {
    name: "verificar_disponibilidad",
    description: "Dictamen rápido de registrabilidad de una marca en una o varias clases Niza: riesgo alto/medio/bajo por clase y lista de conflictos.",
    inputSchema: {
      type: "object" as const,
      properties: {
        nombre: { type: "string" },
        clases: { type: "array", items: { type: "number" }, description: "Clases Niza a evaluar (default [30,35])" },
      },
      required: ["nombre"],
    },
  },
  {
    name: "lote_disponibilidad",
    description: "Encola un batch de hasta 50,000 marcas × clases para verificación asíncrona. Devuelve job_id inmediatamente (no bloquea).",
    inputSchema: {
      type: "object" as const,
      properties: {
        marcas: { type: "array", items: { type: "string" } },
        clases: { type: "array", items: { type: "number" } },
      },
      required: ["marcas"],
    },
  },
  {
    name: "estado_lote",
    description: "Progreso y muestra de resultados de un batch encolado con lote_disponibilidad.",
    inputSchema: { type: "object" as const, properties: { job_id: { type: "string" } }, required: ["job_id"] },
  },
];
