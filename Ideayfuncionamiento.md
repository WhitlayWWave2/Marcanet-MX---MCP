La arquitectura se divide en dos componentes principales que interactúan de forma asíncrona: el Servidor MCP (que interactúa con el IMPI) y el Grafo de LangGraph.js (que orquesta la lógica del agente).

1. El Servidor MCP (Data Fetcher)
Actúa como un puente de una sola vía hacia la web del IMPI.

Se ejecuta como un proceso de Node.js independiente.

Expone una herramienta registrada (buscar_marca_impi) a través de un canal de comunicación estándar (stdio).

Al recibir una petición, utiliza herramientas de automatización (como Puppeteer para renderizado de JavaScript o Axios/Cheerio para scraping directo) para simular una búsqueda humana en el portal del IMPI.

Extrae el DOM, lo parsea y devuelve un objeto JSON limpio (Titular, Número de Expediente, Clase, Estatus) al cliente.

2. El Agente en LangGraph.js (Orquestador)
LangGraph.js maneja el flujo de decisión mediante un grafo de estados cíclico (StateGraph).

Estado (State): Mantiene el historial de mensajes (messages).

Nodo LLM (Agent Node): Un modelo (ej. Gemini o Qwen) recibe la pregunta del usuario (ej. "¿Quién es el dueño de la marca Bimbo?"). El modelo conoce la existencia de la herramienta MCP porque el cliente MCP se la inyecta en su contexto.

Enrutamiento Condicional: Si el modelo decide que necesita buscar en Marcanet, LangGraph suspende la generación de texto y enruta el flujo al nodo de herramientas.

Nodo de Herramienta (Tool Node): Este nodo toma los parámetros generados por el LLM, llama al cliente MCP mediante IPC (stdio), espera el JSON del servidor MCP y lo añade al estado como un ToolMessage.

Resolución: El flujo regresa al Nodo LLM, que ahora lee los datos del IMPI en su contexto y redacta la respuesta final en lenguaje natural.

---

## Actualización de arquitectura: el "otro lado" ya no necesita una LLM

El diseño anterior (puntos 1 y 2) sigue siendo válido para el modo interactivo con clientes MCP. Pero como NO se dispone de una LLM propia, se añade un tercer componente — y opcionalmente se usa como vía principal:

### 3. El Worker Autónomo + API HTTP (el "otro lado" sin LLM)

En lugar de un agente que razona, tenemos un *orquestador determinista*:

- **API HTTP (Express)** expuesta por el mismo proceso del servidor MCP (o un sidecar):
  - `POST /api/buscar` → consulta individual (síncrona si hay caché, asíncrona si no).
  - `POST /api/batch` → sube una lista de miles/millares de marcas, devuelve un `jobId`.
  - `GET /api/job/:id` → estado y resultados parciales de un lote.
  - `GET /api/report/:id.csv|json` → reporte final descargable.
  - Autenticación por header `x-api-key`.
- **Cola de trabajo**: BullMQ sobre Redis en producción; en local/dev basta SQLite o incluso un array en memoria. Cada job = una búsqueda a IMPI.
- **Pool de fetchers**: N workers que consumen la cola y llaman a la capa de scraping. Aquí es donde vive el rate limiting a IMPI (token bucket), reintentos con backoff exponencial y detección de CAPTCHA (el job pasa a estado `needs_human`).
- **Caché Redis** delante de todo: clave normalizada (`marca:clase`), TTL según estatus del registro.
- **Cliente MCP interno**: los fetchers invocan las herramientas a través del propio cliente MCP por stdio, de modo que la MISMA lógica sirve tanto a un LLM externo como al worker sin LLM. No se duplica código de scraping.

Flujo sin LLM:
`n8n/frontend/CLI → POST /api/batch → cola → fetcher → (caché miss?) → Playwright a IMPI → parseo → Redis + resultado del job → webhook/CSV`

### Integración con n8n

n8n sustituye al nodo LLM como orquestador de negocio:

- **Webhooks de n8n** reciben solicitudes de formularios/WhatsApp/web y hacen `HTTP Request` contra la API del MCP (encolar búsquedas).
- **Workflow "Vigilancia de marcas"**: cron diario que toma una lista de monitoreo, llama `/api/batch`, compara con el último reporte y notifica cambios de estatus por email/Slack/Telegram.
- **Ratelimit + SplitInBatches** de n8n controlan el ritmo de envío para no saturar la API.
- El nodo **MCP Client Tool** de n8n puede conectarse directamente al servidor por stdio/SSE cuando más adelante sí se quiera añadir una LLM al flujo.

### Nuevas herramientas expuestas por el MCP

Para que cualquier cliente (LLM o worker) haga investigación completa, el servidor registra ahora:

1. `buscar_marca_impi(nombre, clase?, pagina?)` — búsqueda paginada por nombre.
2. `detalle_expediente(folio)` — ficha completa de un registro.
3. `verificar_disponibilidad(nombre, clases[])` — dictamen rápido multi-clase (Nice) para evaluación de riesgo.
4. `lote_disponibilidad(marcas[], clases[])` → encola un batch y devuelve `jobId` (no bloquea el canal stdio).
5. `estado_lote(jobId)` — progreso/resultados de un batch.

Esto mantiene el contrato MCP intacto: un futuro LLM ve exactamente las mismas herramientas que consume el worker determinista.
