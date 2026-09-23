// src/http-api.ts — API REST: el "otro lado" sin LLM para n8n/cron/frontends.
// Endpoints: /api/buscar /api/detalle /api/disponibilidad /api/batch
//            /api/job/:id  /api/report/:id.csv|json   /healthz

import express from "express";
import { TOOLS } from "./tools.js";
import { getJobResults, toCsv } from "./queue.js";

const app = express();
app.use(express.json({ limit: "10mb" }));

// --- autenticación simple por API key ---
const KEYS = new Set((process.env.API_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
app.use("/api", (req, res, next) => {
  if (!KEYS.size) return next(); // sin keys configuradas = abierto (solo dev local)
  const k = req.header("x-api-key") ?? "";
  return KEYS.has(k) ? next() : res.status(401).json({ error: "x-api-key inválida" });
});

const wrap = (fn: (req: express.Request) => Promise<unknown>) =>
  async (req: express.Request, res: express.Response) => {
    try { res.json(await fn(req)); }
    catch (e: any) { res.status(400).json({ error: e?.message ?? String(e) }); }
  };

app.get("/healthz", (_req, res) => res.json({ ok: true, mode: process.env.SCRAPE_MODE ?? "mock" }));

app.post("/api/buscar",          wrap((r) => TOOLS.buscar_marca_impi(r.body)));
app.post("/api/detalle",         wrap((r) => TOOLS.detalle_expediente(r.body)));
app.post("/api/disponibilidad",  wrap((r) => TOOLS.verificar_disponibilidad(r.body)));
app.post("/api/batch",           wrap((r) => TOOLS.lote_disponibilidad(r.body)));
app.get ("/api/job/:id",         wrap((r) => TOOLS.estado_lote({ job_id: r.params.id })));

app.get("/api/report/:id.:fmt", async (req, res) => {
  try {
    const job = await getJobResults(req.params.id);
    if (job.estado === "queued" || job.estado === "running") {
      return res.status(409).json({ error: "lote aún en proceso", done: job.done, total: job.total });
    }
    if (req.params.fmt === "csv") {
      res.setHeader("content-type", "text/csv; charset=utf-8");
      res.setHeader("content-disposition", `attachment; filename="impi-${job.id}.csv"`);
      return res.send(toCsv(job));
    }
    return res.json(job);
  } catch (e: any) {
    return res.status(404).json({ error: e?.message ?? String(e) });
  }
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.error(`[impi-mcp] API HTTP en :${port} (${KEYS.size ? "con auth" : "SIN AUTH — solo dev"})`));
