# Escalamiento a 100,000 usuarios/peticiones simultáneos

## La premisa que hace posible el objetivo

**No se puede (ni se debe) hacer 100,000 scrapings simultáneos al IMPI.** El portal de Acervo de Marcas tiene protección anti-bot y capacidad limitada; atacarlo con ese volumen sería bloqueado en segundos y sería además una práctica poco ética.

La clave del diseño: **desacoplar "usuarios concurrentes" de "consultas reales a IMPI"**. Un sistema bien diseñado convierte 100k peticiones entrantes en:

- ~95–99% resueltas desde caché Redis (< 2 ms cada una),
- ~1–5% convertidas en búsquedas *reales*, las cuales pasan por una cola que drena a la velocidad segura que IMPI tolera (p. ej. 1–3 req/s sostenidos).

## Desglose numérico del flujo

Supuestos: 100k usuarios activos, pico de 5,000 consultas/nuevo-minuto por usuario ocasional → ~830 req/s entrantes. Distribución típica tipo Zipf: las marcas más buscadas concentran la mayoría del tráfico.

| Capa | Throughput soportado | Cómo se escala |
|---|---|---|
| API HTTP (Express/Fastify) | ~10–20k req/s por núcleo | Réplicas detrás de Nginx/ALB + keep-alive. 8 réplicas cubren 830 req/s con holgura |
| Caché Redis | ~100k ops/s por instancia | Cluster/particiones si hace falta; un set de resultados pesa ~2 KB → 5M registros ≈ 10 GB RAM |
| Dedup in-flight | Reduce picos virales ("todos buscan LA misma marca") | Promise map en memoria por instancia + lock `SET NX` en Redis entre instancias |
| Cola BullMQ | Millones de jobs | Redis persistente; prioridad: interactivas > batch > re-scrape preventivo |
| Fetchers → IMPI | 1–3 req/s (límite externo) | Pool fijo; añadir réplicas NO aumenta throughput a IMPI, solo resiliencia |

Cálculo del peor caso: si el 5% de 830 req/s = ~42 req/s necesitan scraping real y sólo podemos 2 req/s, la cola crece. Mitigaciones reales:

1. **Precalentamiento**: un barrido periódico del catálogo popular (top N marcas por clase) mantiene la caché tibia. Con top 200k registros refrescados diario a 2 req/s → 200k/86400s ≈ 2.3 req/s… justo el límite; por eso:
2. **TTL inteligente**: registros `registrada_vigente` caducan en 30 días; solicitudes/trámites en 1 día; errores en 5 min. El churn real diario es ≪ 100%.
3. **Backpressure honesto**: cuando la cola supera umbral, `/api/batch` devuelve `retry-after` y los clientes (n8n con nodo Wait) reintenta. Mejor latencia degradada en fríos que colapso de calientes.

## Topología de despliegue sugerida

```
                    ┌──────────────┐
 n8n / web / CLI ──▶│ Nginx / CDN  │  (rate-limit por API key, waf básico)
                    └──────┬───────┘
                           │ stateless
              ┌────────────┼────────────┐
        api-1 ×N      api-2 ×N     api-N ×N        (Express, docker/K8s HPA por CPU)
              └────────────┴────────────┘
                     Redis Cluster (caché + cola BullMQ + locks in-flight)
                           ▲
              fetcher-1 … fetcher-M   (Playwright pool, concurrency fija,
                           │           rate limiter global compartido vía Redis)
                           ▼
                     gpi2.impi.gob.mx (Acervo de Marcas)
```

Notas operativas:
- **HPA sobre las APIs**, no sobre los fetchers (estos últimos dimensionados al límite de IMPI, con réplicas solo para alta disponibilidad).
- Playwright en contenedores `mcr.microsoft.com/playwright` o como servicio separado (browserless) para compartir navegadores entre workers.
- Métricas mínimas: hit-rate de caché, profundidad de cola, tiempo de drenaje, tasa de CAPTCHA/bloqueo, p95 de `/api/buscar`.
- Persistencia de resultados de lote en Redis con TTL de 7 días; para reportes históricos, volcar a Postgres/S3.

## Números guía de infraestructura (estimación inicial)

| Componente | Tamaño | Cantidad |
|---|---|---|
| API nodes | 2 vCPU / 1 GB | 4–8 (autoescalable) |
| Redis | 16 GB (cluster 3 nodos) | 1 clúster |
| Fetchers | 4 vCPU / 8 GB (Chromium come RAM) | 2–4 (HA, no throughput) |
| n8n | 2 vCPU / 2 GB | 1 |

Presupuesto de red: 100k usuarios × ~5 KB por respuesta ≈ 500 MB por "oleada" completa — trivial para cualquier CDN/egress normal.

## Cambios estructurales ya reflejados en los otros MD

- `Contexto.md`: justificación de operación sin LLM y estrategia de escalamiento.
- `Ideayfuncionamiento.md`: componente #3 (worker autónomo + API), herramientas MCP ampliadas, integración n8n.
- `Instructivodemontaje.md`: estructura de carpetas, código de servidor/API/worker, checklist de producción.

## Riesgos y cumplimiento

- Revisa los términos de uso del IMPI y considera contactar al instituto para uso intensivo (algunas oficinas de propiedad industrial ofrecen acceso a datos abiertos o dumps del gaceta — la Gaceta de la Propiedad Industrial se publica semanalmente y puede ser una fuente masiva mucho más amable que scrapear el buscador).
- **Sugerencia de alto impacto**: parsear la Gaceta XML/PDF semanal como fuente primaria de actualización de caché en bulk, y reservar el scraping interactivo sólo para consultas puntuales. Esto multiplica el throughput efectivo hacia los 100k sin tocar más el buscador.
