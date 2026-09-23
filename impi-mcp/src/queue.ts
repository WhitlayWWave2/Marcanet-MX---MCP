// src/queue.ts — Cola de trabajos por lotes.
// Con REDIS_URL: BullMQ (persistente, multi-proceso, escala horizontal).
// Sin Redis: cola en memoria con drenaje asíncrono — suficiente para dev y
// pruebas de humo del pipeline completo.

import { randomUUID } from "crypto";
import { searchImpi } from "./scrape/index.js";
import type { BusquedaResultado } from "./scrape/types.js";

export interface BatchJob {
  id: string;
  marcas: string[];
  clases: number[];
  estado: "queued" | "running" | "done" | "partial_failed";
  total: number;
  done: number;
  failed: number;
  startedAt?: string;
  finishedAt?: string;
  resultados: Record<string, BusquedaResultado | { error: string }>; // clave: marca|clase
}

const JOBS_TTL_MS = 7 * 24 * 3600 * 1000;

// ---------------- Implementación en memoria (dev) ----------------
const memJobs = new Map<string, BatchJob>();
let draining = false;

function pruneJobs() {
  const now = Date.now();
  for (const [id, j] of memJobs) {
    if (j.finishedAt && now - Date.parse(j.finishedAt) > JOBS_TTL_MS) memJobs.delete(id);
  }
}

async function drainMemoryQueue(concurrency: number) {
  if (draining) return;
  draining = true;
  try {
    while (true) {
      const job = [...memJobs.values()].find((j) => j.estado === "queued" || j.estado === "running");
      if (!job) break;
      job.estado = "running";
      job.startedAt ??= new Date().toISOString();
      const pending: Promise<void>[] = [];
      for (const marca of job.marcas) {
        for (const clase of job.clases) {
          const key = `${marca}|${clase}`;
          if (key in job.resultados) continue;
          const p = searchImpi({ nombre_marca: marca, clase, pagina: 1 })
            .then((r) => { job.resultados[key] = r; job.done++; })
            .catch((e) => { job.resultados[key] = { error: String(e?.message ?? e) }; job.failed++; job.done++; });
          pending.push(p);
          if (pending.length >= concurrency) { await Promise.race(pending.map((x) => x.then(() => pending.splice(pending.indexOf(x), 1)))); }
        }
      }
      await Promise.allSettled(pending);
      job.estado = job.failed ? "partial_failed" : "done";
      job.finishedAt = new Date().toISOString();
    }
  } finally {
    draining = false;
  }
}

// ---------------- Implementación BullMQ (producción) ----------------
let bullReady: Promise<void> | null = null;

async function ensureBull() {
  if (bullReady) return bullReady;
  bullReady = (async () => {
    const { Queue } = await import("bullmq");
    const { Redis } = await import("ioredis");
    const conn = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    const q = new Queue("impi-batch", { connection: conn });
    // El productor escribe el meta-job en un hash y empuja subtareas
    (globalThis as any).__IMPI_QUEUE__ = q;
  })();
  return bullReady;
}

// ---------------- API pública del módulo ----------------

export async function enqueueBatch(marcas: string[], clases: number[]): Promise<{ job_id: string; total: number }> {
  if (!marcas?.length) throw new Error("marcas[] vacío");
  if (marcas.length > 50_000) throw new Error("Máximo 50,000 marcas por lote (divide en varios /api/batch)");
  const job: BatchJob = {
    id: randomUUID(),
    marcas: marcas.map((m) => m.trim()).filter(Boolean),
    clases: clases.length ? clases : [30, 35],
    estado: "queued",
    total: marcas.length * (clases.length || 2),
    done: 0, failed: 0, resultados: {},
  };
  memJobs.set(job.id, job);
  pruneJobs();

  if (process.env.REDIS_URL) {
    await ensureBull();
    const q = (globalThis as any).__IMPI_QUEUE__ as import("bullmq").Queue;
    await q.addBulk(
      job.marcas.flatMap((m) => job.clases.map((c) => ({
        name: job.id, data: { jobId: job.id, marca: m, clase: c },
      })))
    );
  } else {
    void drainMemoryQueue(Number(process.env.FETCH_CONCURRENCY ?? 4));
  }
  return { job_id: job.id, total: job.total };
}

export async function getJobStatus(jobId: string): Promise<Omit<BatchJob, "resultados"> & { sample: unknown[] }> {
  const job = memJobs.get(jobId);
  if (!job) throw new Error(`job ${jobId} no existe (¿se reinició el proceso sin Redis?)`);
  const { resultados, ...meta } = job;
  return { ...meta, sample: Object.entries(resultados).slice(0, 5) };
}

export async function getJobResults(jobId: string): Promise<BatchJob> {
  const job = memJobs.get(jobId);
  if (!job) throw new Error(`job ${jobId} no existe`);
  return job;
}

/** Hook usado por worker.ts (modo BullMQ) para registrar resultados parciales. */
export function attachResult(jobId: string, key: string, r: BusquedaResultado | { error: string }) {
  const job = memJobs.get(jobId);
  if (!job) return;
  job.resultados[key] = r;
  if ("error" in r) job.failed++;
  if (++job.done >= job.total) {
    job.estado = job.failed ? "partial_failed" : "done";
    job.finishedAt = new Date().toISOString();
  }
}

export function toCsv(job: BatchJob): string {
  const head = "marca,clase,folio,denominacion_encontrada,estatus,titular,total_coincidencias,error\n";
  const rows: string[] = [];
  for (const [key, val] of Object.entries(job.resultados)) {
    const [marca, clase] = key.split("|");
    if ("error" in val) {
      rows.push([marca, clase, "", "", "", "", "", `"${val.error.replace(/"/g, '""')}"`].join(","));
    } else {
      for (const r of val.resultados.length ? val.resultados : [null]) {
        rows.push(r
          ? [marca, clase, r.folio, `"${r.marca}"`, r.estatus, `"${r.titular}"`, val.total, ""].join(",")
          : [marca, clase, "", "LIBRE", "sin_registros", "", 0, ""].join(","));
      }
    }
  }
  return head + rows.join("\n");
}
