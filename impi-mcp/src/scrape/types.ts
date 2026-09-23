// src/scrape/types.ts — contratos de datos compartidos por toda la app.

export interface ResultadoMarca {
  marca: string;
  folio: string;          // número de expediente / solicitud
  clase: number;          // clase Niza (1-45)
  estatus: EstatusMarca;
  titular: string;
  fecha_solicitud?: string;   // ISO date
  fecha_registro?: string;    // ISO date, si aplica
  vigencia_hasta?: string;    // ISO date, si aplica
}

export type EstatusMarca =
  | "registrada_vigente"
  | "registrada_vencida"
  | "solicitud_en_tramite"
  | "solicitud_negada"
  | "abandono"
  | "cancelada"
  | "desconocido";

export interface BusquedaParams {
  nombre_marca: string;
  clase?: number;
  pagina?: number;
}

export interface BusquedaResultado {
  total: number;
  pagina: number;
  resultados: ResultadoMarca[];
  captcha?: boolean;      // true si el portal pidió verificación humana
}

export interface DisponibilidadDictamen {
  nombre: string;
  clases: number[];
  riesgo_por_clase: Record<number, "alto" | "medio" | "bajo">;
  conflictos: ResultadoMarca[];
  disponible: boolean;    // true si ninguna clase tiene riesgo alto
}

export const NIZA_CLASSES = Array.from({ length: 45 }, (_, i) => i + 1);

/** Normaliza nombres para claves de caché y comparación difusa. */
export function normalizar(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")   // quita acentos
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Similitud de Jaro-Winkler simplificada para detectar marcas parecidas. */
export function similitud(a: string, b: string): number {
  const s = normalizar(a), t = normalizar(b);
  if (!s.length || !t.length) return 0;
  const m = Math.max(s.length, t.length);
  let hits = 0;
  const used = new Array(t.length).fill(false);
  const window = Math.floor(m / 2);
  for (let i = 0; i < s.length; i++) {
    for (let j = Math.max(0, i - window); j < Math.min(t.length, i + window + 1); j++) {
      if (!used[j] && s[i] === t[j]) { used[j] = true; hits++; break; }
    }
  }
  return hits / m;
}
