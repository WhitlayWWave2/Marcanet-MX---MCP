// src/cache.ts — Caché con TTL. Redis si REDIS_URL está definido (producción,
// compartida entre réplicas); fallback a Map en memoria para desarrollo local.

interface Entry { value: unknown; expiresAt: number }

const mem = new Map<string, Entry>();
let redis: any = null;

async function getRedis() {
  if (!process.env.REDIS_URL) return null;
  if (!redis) {
    const { Redis } = await import("ioredis");
    redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
    redis.on("error", (e: Error) => console.error("[cache] redis:", e.message));
  }
  return redis;
}

export async function cacheGet(key: string): Promise<unknown | null> {
  const r = await getRedis();
  if (r) {
    const raw = await r.get(`impi:${key}`);
    return raw ? JSON.parse(raw) : null;
  }
  const hit = mem.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) { mem.delete(key); return null; }
  return hit.value;
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const r = await getRedis();
  if (r) { await r.set(`impi:${key}`, JSON.stringify(value), "EX", ttlSeconds); return; }
  mem.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

/** TTL según naturaleza del dato: lo registrado casi no cambia; lo en trámite sí. */
export function ttlPorResultado(results: { resultados: { estatus: string }[] }): number {
  if (!results.resultados.length) return 5 * 60;                       // vacío: 5 min (evita cachear errores)
  const t = results.resultados[0].estatus;
  if (t.startsWith("registrada")) return 30 * 24 * 3600;               // 30 días
  if (t === "solicitud_en_tramite") return 24 * 3600;                  // 1 día
  return 7 * 24 * 3600;                                                // resto: 1 semana
}

// --- Deduplicación in-flight: muchas peticiones simultáneas de la misma clave
// comparten UNA sola promesa de scraping. ---
const inflight = new Map<string, Promise<unknown>>();

export async function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
