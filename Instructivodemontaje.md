A continuación se detalla la configuración técnica para construir el servidor, el worker autónomo (sin LLM) y —opcionalmente— conectarlo al grafo de LangGraph cuando se disponga de un modelo.

> **Nota de versión 2:** este instructivo asume ahora la estructura de carpetas del repo (`impi-mcp/`), donde `src/server.ts` expone 5 herramientas MCP, `src/scrape/` contiene la capa de extracción (mock hoy, Playwright mañana), `src/http-api.ts` levanta la API REST y `src/worker.ts` es el consumidor de cola reemplazo del "otro lado" basado en LLM.

## 0. Estructura de carpetas recomendada

```
impi-mcp/
├── package.json
├── tsconfig.json
├── src/
│   ├── server.ts          # Servidor MCP (stdio): registra las 5 herramientas
│   ├── http-api.ts        # API Express: /api/buscar, /api/batch, /api/job/:id, reportes CSV
│   ├── worker.ts          # Consumidor de cola (el "otro lado" SIN LLM)
│   ├── queue.ts           # BullMQ+Redis en prod; cola en memoria para dev
│   ├── cache.ts           # Redis o Map<TTL> como fallback local
│   ├── tools.ts           # Implementación compartida de las herramientas
│   └── scrape/
│       ├── index.ts       # Dispatcher: mock ↔ real
│       ├── mock.ts        # Datos sintéticos para desarrollo
│       └── impi.ts        # Playwright contra Acervo de Marcas (producción)
├── workflows/             # JSON exportables de n8n
└── build/                 # salida de tsc
```

## 1. Construcción del Servidor MCP

Crea el proyecto e instala dependencias (Playwright sustituye a Puppeteer: mejor anti-detección, más rápido y soporta contextos aislados para paralelizar):

Bash
npm init -y
npm install @modelcontextprotocol/sdk playwright express bullmq ioredis zod
npm install -D typescript @types/node tsx
npx playwright install chromium

`src/tools.ts` concentra la lógica; `src/server.ts` solo la expone por MCP. Así el worker y la API HTTP llaman a las MISMAS funciones sin duplicar scraping:

TypeScript
// src/tools.ts — implementación única compartida por MCP, HTTP y worker
import { searchImpi, getExpediente, checkAvailability } from "./scrape/index.js";
import { enqueueBatch, getJobStatus } from "./queue.js";
import { cacheGet, cacheSet } from "./cache.js";

export async function buscarMarcaImei(nombre_marca: string, clase?: number, pagina = 1) {
  const key = `search:${nombre_marca.toLowerCase().trim()}:${clase ?? "*"}:${pagina}`;
  const hit = await cacheGet(key);
  if (hit) return { cached: true, resultados: hit };
  const resultados = await searchImpi({ nombre_marca, clase, pagina });
  await cacheSet(key, resultados, ttlPorEstatus(resultados));
  return { cached: false, resultados };
}

export const TOOLS = {
  buscar_marca_impi:      (a: any) => buscarMarcaImei(a.nombre_marca, a.clase, a.pagina),
  detalle_expediente:     (a: any) => getExpediente(a.folio),
  verificar_disponibilidad: (a: any) => checkAvailability(a.nombre, a.clases),
  lote_disponibilidad:    (a: any) => enqueueBatch(a.marcas, a.clases ?? [0, 35]),
  estado_lote:            (a: any) => getJobStatus(a.job_id),
};

TypeScript
// src/server.ts — capa MCP delgada (stdio)
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "./tools.js";

const TOOL_DEFS = [ /* los 5 schemas JSON descritos en Ideayfuncionamiento.md */ ];

const server = new Server({ name: "impi-mcp", version: "2.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const fn = (TOOLS as any)[req.params.name];
  if (!fn) throw new Error(`Tool not found: ${req.params.name}`);
  const out = await fn(req.params.arguments ?? {});
  return { content: [{ type: "text", text: JSON.stringify(out) }] };
});

await server.connect(new StdioServerTransport());

Compila con `tsc` (recuerda `"module": "NodeNext"` en tsconfig). IMPORTANTE: en modo stdio jamás hagas `console.log` — stdout es el canal JSON-RPC; usa stderr o un logger a archivo.

## 2. El Worker Autónomo + API HTTP (funciona SIN LLM)

### 2.1 API HTTP (src/http-api.ts)

TypeScript
import express from "express";
import crypto from "crypto";
import { TOOLS } from "./tools.js";

const app = express();
app.use(express.json({ limit: "10mb" }));

const KEYS = new Set((process.env.API_KEYS ?? "").split(",").filter(Boolean));
app.use("/api", (req, res, next) =>
  KEYS.has(req.header("x-api-key") ?? "") ? next() : res.status(401).json({ error: "bad key" }));

app.post("/api/buscar", async (req, res) => res.json(await TOOLS.buscar_marca_impi(req.body)));
app.post("/api/batch",  async (req, res) => res.json(await TOOLS.lote_disponibilidad(req.body)));
app.get ("/api/job/:id", async (req, res) => res.json(await TOOLS.estado_lote({ job_id: req.params.id })));
app.get ("/api/report/:id.:fmt", /* genera CSV/JSON del lote terminado */);

app.listen(process.env.PORT ?? 3000);

### 2.2 Worker consumidor de cola (src/worker.ts)

TypeScript
import { Worker } from "bullmq";
import { searchImpi } from "./scrape/index.js";
import { saveJobResult } from "./queue.js";

new Worker("impi-batch", async (job) => {
  const { nombre, clase } = job.data;
  const r = await searchImpi({ nombre_marca: nombre, clase, pagina: 1 });
  await saveJobResult(job.id!, r);
  return r;
}, { concurrency: Number(process.env.FETCH_CONCURRENCY ?? 4) }); // sube esto al escalar

Arranque:

Bash
# Terminal 1: redis (docker run -d -p 6379:6379 redis)
# Terminal 2: API        → node build/http-api.js
# Terminal 3: workers    → node build/worker.js   (tantas réplicas como necesites)
# MCP stdio sigue disponible para clientes LLM → node build/server.js

Validación rápida sin cliente alguno:

Bash
curl -s -X POST localhost:3000/api/batch -H "x-api-key: demo" \
  -H "content-type: application/json" \
  -d '{"marcas":["SABINAS","GRINDELWALD"],"clases":[30,35]}'
curl -s localhost:3000/api/job/<jobId> -H "x-api-key: demo"

## 3. Conexión con n8n (orquestación sin código)

1. Despliega n8n (docker compose) o usa n8n Cloud.
2. Importa los JSON de `workflows/`:
   - `vigilancia-diaria.json`: Schedule Trigger → Read File (lista de monitoreo CSV) → HTTP Request `POST /api/batch` → Wait until `estado_lote == done` → IF cambios vs. reporte anterior → Email/Slack/Telegram.
   - `consulta-webhook.json`: Webhook → HTTP Request `POST /api/buscar` → Respond to Webhook con el JSON del IMPI.
3. Guarda la API key en credenciales de n8n (nunca en el workflow exportado).
4. Para lotes enormes, usa el nodo *SplitInBatches* (p. ej. 500 marcas por petición) para no violar el límite de 10MB de la API.

## 4. (Opcional, para cuando tengas LLM) Integración con LangGraph.js

El grafo original NO cambia; solo se mapean las 5 herramientas nuevas en lugar de una. Instala:

Bash
npm install @langchain/core @langchain/langgraph @modelcontextprotocol/sdk zod

Y en `agent.ts`, en lugar de declarar cada tool a mano, genéralas en bucle desde `mcpClient.listTools()` adaptando `inputSchema` con `zodToJsonSchema` inverso (existe `@langchain/mcp-adapters` que hace esto automáticamente: `MCPServerStdio`). El resto del grafo (StateGraph, ToolNode, enrutado condicional) queda exactamente como en la versión 1 de este instructivo.

## 5. Checklist antes de producción masiva

- [ ] Reemplazar `scrape/mock.ts` por `scrape/impi.ts` (Playwright) y validar selectores contra el DOM real de Acervo.
- [ ] Rate limiter global a IMPI (p. ej. 1 req/s/IP con jitter) + backoff ante CAPTCHA.
- [ ] Redis con persistencia AOF; claves de caché con TTL diferenciado.
- [ ] Variables de entorno: `REDIS_URL`, `API_KEYS`, `FETCH_CONCURRENCY`, `IMPI_BASE_RATE`.
- [ ] Observabilidad: métricas de hit-rate de caché, profundidad de cola, tasa de éxito de scraping (un simple `/metrics` Prometheus basta).
- [ ] Ver `Escalar100k.md` para la topología de 100k usuarios simultáneos.
