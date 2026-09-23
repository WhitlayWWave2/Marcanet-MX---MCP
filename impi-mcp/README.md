# impi-mcp — MCP + API + Worker para el Acervo de Marcas (IMPI, México)

Servidor **Model Context Protocol** que encapsula la búsqueda/scrapping del portal
de marcas del IMPI, **usable SIN LLM**: expone además una API REST y una cola de
trabajos por lotes para que n8n, cron o cualquier frontend hagan investigación
masiva de disponibilidad marcaria.

## Uso rápido (sin Redis, sin navegador real — modo mock)

```bash
npm install
npm run dev:api        # API HTTP en :3000 (cola en memoria)
# en otra terminal:
curl -s localhost:3000/healthz
curl -s -X POST localhost:3000/api/batch -H 'content-type: application/json' \
  -d '{"marcas":["SABINAS","GRINDELWALD"],"clases":[30,35]}'
curl -s localhost:3000/api/job/<job_id>
curl -s localhost:3000/api/report/<job_id>.csv
```

Prueba de humo completa (MCP stdio + API + lote + CSV):

```bash
npm run smoke
```

## Como servidor MCP (para Claude Desktop / Cursor / LangGraph futuro)

Configuración de cliente (`claude_desktop_config.json` o similar):

```json
{ "mcpServers": { "impi": { "command": "node", "args": ["/ruta/impi-mcp/build/server.js"] } } }
```

Herramientas expuestas: `buscar_marca_impi`, `detalle_expediente`,
`verificar_disponibilidad`, `lote_disponibilidad`, `estado_lote`.

## Producción escalable (objetivo: hasta 100k usuarios simultáneos)

```bash
docker run -d -p 6379:6379 redis
export REDIS_URL=redis://localhost:6379
export API_KEYS=cambia-esto
export SCRAPE_MODE=real      # activa Playwright (valida selectores en src/scrape/impi.ts)
npm run build
node build/http-api.js &     # ×N réplicas detrás de Nginx
node build/worker.js &       # ×2-4 fetchers (rate limit a IMPI compartido vía Redis)
```

La estrategia de escalamiento (caché Redis + dedup in-flight + cola BullMQ +
rate limiting a IMPI) está documentada en `/Escalar100k.md` (raíz del repo).

## Variables de entorno

| Var | Default | Descripción |
|---|---|---|
| `SCRAPE_MODE` | `mock` | `real` usa Playwright contra IMPI |
| `REDIS_URL` | – | Activa caché compartida + cola BullMQ |
| `API_KEYS` | – (abierto, solo dev) | Lista separada por comas |
| `PORT` | 3000 | API HTTP |
| `FETCH_CONCURRENCY` | 4 (mem) / 2 (bull) | Tareas simultáneas por worker |
| `IMPI_RATE_PER_SEC` | 2 | Límite global de peticiones a IMPI |
| `IMPI_BASE_URL` | plantilla | Endpoint real del buscador (TODO al activar modo real) |

## Workflows n8n incluidos

`workflows/vigilancia-diaria.json` (cron → batch → poll → CSV → email) y
`workflows/consulta-webhook.json` (webhook → dictamen síncrono). Importa el JSON
en n8n y reemplaza `TU-HOST` + credenciales.

## Estado del scraping real

`src/scrape/impi.ts` es una **plantilla funcional**: la estructura (browser pool,
rate limiting, detección de CAPTCHA, mapeo de estatus) está lista; los puntos
marcados con `TODO-SELECTOR`/`TODO-URL` deben completarse inspeccionando el DOM
actual del buscador de Acervo de Marcas. Mientras tanto, todo el pipeline opera
con datos sintéticos deterministas (`src/scrape/mock.ts`).

⚖️ Antes de activar modo real, revisa los términos de uso del IMPI y considera la
Gaceta de la Propiedad Industrial como fuente bulk alternativa (ver Escalar100k.md).

## 🎯 Puesta a punto contra el sitio real (calibración)

No hace falta editar código: los selectores viven en `scrape-profile.json`.

```bash
# 1. Encuentra la URL real del buscador de Acervo de Marcas (cópiala del navegador
#    tras hacer una búsqueda, p.ej. https://.../marca/consulta?denomination=SABINAS)
# 2. Corre el asistente (headless, heurístico):
npm run calibrate -- "https://URL-REAL-DEL-BUSCADOR?q=SABINAS"
#    → guarda calibration/page.png + page.html + api-calls.json y postula selectores
# 3. Modo interactivo con navegador visible para confirmar/ajustar cada selector:
npm run calibrate -- "https://URL-REAL" --review
# 4. Activa el modo real:
SCRAPE_MODE=auto npm run dev:api   # o SCRAPE_MODE=real si editaste impi.ts a mano
```

💡 **Atajo**: si `calibration/api-calls.json` muestra que el portal llama a una API
interna que devuelve JSON, se puede copiar esa llamada al scraper y evitar el DOM
por completo (más rápido y robusto). Mueve el perfil calibrado a tu repo:
`scrape-profile.json` es portable y versionable.

## 📦 Publicar para que cualquier IA lo use

```bash
npm login
npm publish          # publica el paquete bin "impi-mcp"
```

Cualquier cliente MCP (Claude Desktop, Cursor, Windsurf, n8n MCP Client, LangGraph)
lo usa con:
```json
{ "mcpServers": { "impi": { "command": "npx", "args": ["-y", "impi-mcp"] } } }
```
Y quien no tenga LLM simplemente levanta `impi-mcp serve-http` (API REST documentada arriba).
Sugerencia: registra también el endpoint HTTP en un repositorio de servidores MCP
(p.ej. mcpservers.org / Smithery) para descubribilidad.
