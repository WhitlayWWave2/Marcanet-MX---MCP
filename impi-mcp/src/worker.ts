// src/worker.ts — Consumidor BullMQ (producción, requiere REDIS_URL).
// Cada worker es un "fetcher": saca subtareas {jobId, marca, clase} de la cola,
// hace el scraping con rate limiting y registra el resultado en el meta-job.
// En modo mock sin Redis, queue.ts drena solo (ver drainMemoryQueue) y este
// proceso no es necesario.

import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { searchImpi } from "./scrape/index.js";
import { cacheGet, cacheSet, ttlPorResultado } from "./cache.js";
import { attachResult } from "./queue.js";

const URL_ = process.env.REDIS_URL;
if (!URL_) {
  console.error("[worker] REDIS_URL no definido: usa `npm run dev:api` (cola en memoria) o arranca redis.");
  process.exit(1);
}

const connection = new Redis(URL_, { maxRetriesPerRequest: null });

// Rate limiter global compartido entre workers vía token bucket en Redis.
const RATE = Number(process.env.IMPI_RATE_PER_SEC ?? 2); // req/s sostenidos hacia IMPI
async function globalThrottle() {
  const now = Date.now();
  // ventana deslizante simple con INCR + EXPIRE
  const key = `impi:rl:${Math.floor(now / 1000)}`;
  const n = await connection.incr(key);
  if (n === 1) await connection.expire(key, 2);
  if (n > RATE) await new Promise((r) => setTimeout(r, 1000 - (now % 1000) + Math.random() * 50));
}

new Worker(
  "impi-batch",
  async (job) => {
    const { jobId, marca, clase } = job.data as { jobId: string; marca: string; clase: number };
    const key = `${marca}|${clase}`;
    const ck = `search:${marca.toLowerCase().trim()}:${clase}:1`;

    const hit = await cacheGet(ck);
    if (hit) { attachResult(jobId, key, hit as any); return "cached"; }

    await globalThrottle();
    try {
      const r = await searchImpi({ nombre_marca: marca, clase, pagina: 1 });
      if (r.captcha) throw Object.assign(new Error("captcha"), { attemptsMade: 0 }); // reintento más tarde
      await cacheSet(ck, r, ttlPorResultado(r));
      attachResult(jobId, key, r);
      return "ok";
    } catch (e: any) {
      attachResult(jobId, key, { error: e?.message ?? String(e) });
      throw e; // BullMQ reintenta según backoff configurado abajo
    }
  },
  {
    connection,
    concurrency: Number(process.env.FETCH_CONCURRENCY ?? 2),
    settings: { backoffStrategy: (a) => Math.min(60_000, 2 ** a * 1000) },
  }
);

console.error(`[worker] listo (rate=${RATE}/s, conc=${process.env.FETCH_CONCURRENCY ?? 2})`);
