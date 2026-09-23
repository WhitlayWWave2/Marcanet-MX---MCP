// scripts/smoke.ts — Prueba de humo end-to-end SIN LLM y SIN Redis:
// 1) MCP stdio handshake + listTools + callTool (como lo haría cualquier cliente MCP)
// 2) API HTTP: buscar → batch → poll job → reporte CSV
// Corre con: npx tsx scripts/smoke.ts

import { spawn } from "child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PORT = 3100 + Math.floor(Math.random() * 90);
let failures = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name} ${extra}`);
  if (!cond) failures++;
};

async function waitHealth(base: string, tries = 60): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`${base}/healthz`); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  // ---------- A) API HTTP en subproceso ----------
  const apiProc = spawn("npx", ["tsx", "src/http-api.ts"], {
    env: { ...process.env, PORT: String(PORT) }, stdio: "ignore", detached: true,
  });

  // ---------- B) Servidor MCP por stdio ----------
  const transport = new StdioClientTransport({ command: "npx", args: ["tsx", "src/server.ts"] });
  const client = new Client({ name: "smoke", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  const tools = await client.listTools();
  ok("MCP listTools = 5 herramientas", tools.tools.length === 5, `→ ${tools.tools.map((t) => t.name).join(", ")}`);

  const search: any = await client.callTool({ name: "buscar_marca_impi", arguments: { nombre_marca: "SABINAS", clase: 30 } });
  const searchData = JSON.parse(search.content[0].text);
  ok("MCP buscar_marca_impi devuelve resultados mock", Array.isArray(searchData.resultados), `→ ${searchData.resultados?.length ?? 0} hits`);

  const disp: any = await client.callTool({ name: "verificar_disponibilidad", arguments: { nombre: "GRINDELWALD", clases: [30, 35] } });
  const dispData = JSON.parse(disp.content[0].text);
  ok("MCP verificar_disponibilidad dictamina riesgo", !!dispData.riesgo_por_clase, `→ disponible=${dispData.disponible}`);

  const lote: any = await client.callTool({ name: "lote_disponibilidad", arguments: { marcas: ["QUETZAL", "LUMINA", "NOEXISTEXYZ"], clases: [35] } });
  const { job_id } = JSON.parse(lote.content[0].text);
  ok("MCP lote_disponibilidad encola y devuelve job_id", !!job_id, `→ ${job_id}`);

  let st: any;
  for (let i = 0; i < 60; i++) {
    const r: any = await client.callTool({ name: "estado_lote", arguments: { job_id } });
    st = JSON.parse(r.content[0].text);
    if (st.estado === "done" || st.estado === "partial_failed") break;
    await new Promise((r) => setTimeout(r, 300));
  }
  ok("MCP estado_lote llega a done", st?.estado === "done", `→ ${st?.done}/${st?.total}`);
  await client.close();

  // ---------- C) API HTTP ----------
  ok("API /healthz responde", await waitHealth(`http://127.0.0.1:${PORT}`));
  const b = await (await fetch(`http://127.0.0.1:${PORT}/api/buscar`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nombre_marca: "SABINAS", clase: 30 }),
  })).json() as any;
  ok("HTTP /api/buscar responde", Array.isArray(b.resultados), `→ cached=${b.cached}`);

  const batch = await (await fetch(`http://127.0.0.1:${PORT}/api/batch`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ marcas: ["TORAL", "CENIZO", "MARCAFAKE123"], clases: [30] }),
  })).json() as any;
  ok("HTTP /api/batch devuelve job_id", !!batch.job_id);

  let job: any;
  for (let i = 0; i < 80; i++) {
    job = await (await fetch(`http://127.0.0.1:${PORT}/api/job/${batch.job_id}`)).json();
    if (job.estado === "done" || job.estado === "partial_failed") break;
    await new Promise((r) => setTimeout(r, 300));
  }
  ok("HTTP /api/job/:id completa el lote", job?.estado === "done", `→ ${job?.done}/${job?.total}`);

  const csvRes = await fetch(`http://127.0.0.1:${PORT}/api/report/${batch.job_id}.csv`);
  const csv = await csvRes.text();
  ok("HTTP /api/report CSV descargable", csvRes.ok && csv.includes("marca,clase"), `→ ${csv.split("\n").length - 1} filas`);

  try { process.kill(-apiProc.pid!, "SIGKILL"); } catch {}
  console.log(failures ? `\n💥 ${failures} fallos` : "\n🎉 Smoke test completo: pipeline funcional SIN LLM");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
