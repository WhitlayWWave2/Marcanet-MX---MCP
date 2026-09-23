// src/scrape/mock.ts — Generador determinista de datos sintéticos.
// Permite desarrollar y probar TODO el pipeline (MCP, API, cola, worker,
// reportes CSV) sin tocar IMPI. Se desactiva con SCRAPE_MODE=real.

import type { BusquedaParams, BusquedaResultado, ResultadoMarca } from "./types.js";
import { normalizar, similitud } from "./types.js";

const TITULARES = [
  "GRUPO BIMBO S.A. DE C.V.", "CEMEX S.A.B. DE C.V.", "AMÉRICA MÓVIL PUBLIJET S.A. DE C.V.",
  "GRUMA S.A.B. DE C.V.", "BACHOCO MÉXICO S.A. DE C.V.", "INDUSTRIA VIZCANA S.A. DE C.V.",
  "EL PUERTO DE ACAPULCO S.A. DE C.V.", "COMERCIAL MEXICANA S.A. DE C.V.",
];
const ESTATUS = ["registrada_vigente", "solicitud_en_tramite", "abandono", "cancelada", "registrada_vencida"] as const;

/** PRNG determinista (mulberry32) sembrado con el hash del nombre+clase:
 *  la misma consulta devuelve siempre el mismo mock → la caché se puede probar de verdad. */
function hashSeed(s: string): number {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mkResultado(nombreBase: string, clase: number, rnd: () => number): ResultadoMarca {
  const estatus = ESTATUS[Math.floor(rnd() * ESTATUS.length)];
  const anio = 1995 + Math.floor(rnd() * 28);
  const mm = String(1 + Math.floor(rnd() * 12)).padStart(2, "0");
  const dd = String(1 + Math.floor(rnd() * 28)).padStart(2, "0");
  return {
    marca: nombreBase.toUpperCase(),
    folio: `${anio}${String(Math.floor(rnd() * 900000) + 100000)}`,
    clase,
    estatus,
    titular: TITULARES[Math.floor(rnd() * TITULARES.length)],
    fecha_solicitud: `${anio}-${mm}-${dd}`,
    ...(estatus.startsWith("registrada") ? { fecha_registro: `${anio}-${mm}-${dd}`, vigencia_hasta: `${anio + 10}-${mm}-${dd}` } : {}),
  };
}

// "Población" de marcas registradas falsas para que existan colisiones realistas.
const POBLACION = [
  "SABINAS", "GRINDELWALD", "LUMINA", "VOLTA", "KAVAS", "NEBLINA", "TORAL",
  "AZULITA", "MAREA ALTA", "CENIZO", "QUETZAL", "OLINALI", "TEMPERLEY",
];

export async function searchImpiMock({ nombre_marca, clase, pagina = 1 }: BusquedaParams): Promise<BusquedaResultado> {
  await sleep(150 + Math.random() * 250); // latencia simulada de red
  const query = normalizar(nombre_marca);
  const clases = clase ? [clase] : [30, 35]; // default: productos y servicios
  const resultados: ResultadoMarca[] = [];

  for (const c of clases) {
    for (const p of POBLACION) {
      const sim = similitud(query, p);
      const rnd = mulberry32(hashSeed(`${query}|${c}|${p}`));
      // coincidencias exactas o muy altas generan registro; las demás no
      if (sim > 0.85 || (sim > 0.6 && rnd() > 0.7)) {
        resultados.push(mkResultado(p, c, rnd));
      }
    }
  }
  // paginación simple
  const PER_PAGE = 20;
  const start = (pagina - 1) * PER_PAGE;
  return {
    total: resultados.length,
    pagina,
    resultados: resultados.slice(start, start + PER_PAGE),
  };
}

export async function getExpedienteMock(folio: string): Promise<ResultadoMarca> {
  await sleep(120);
  const rnd = mulberry32(hashSeed(`exp|${folio}`));
  const nombre = POBLACION[Math.floor(rnd() * POBLACION.length)];
  return mkResultado(nombre, 1 + Math.floor(rnd() * 45), rnd);
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
