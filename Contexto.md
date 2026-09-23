El Instituto Mexicano de la Propiedad Industrial (IMPI) gestiona el registro de marcas en México a través de su plataforma Acervo de Marcas (anteriormente Marcanet). Esta plataforma es una base de datos cerrada y sin una API pública oficial, lo que impide que los modelos de lenguaje (LLMs) consulten el estatus de una marca de manera nativa.

El Model Context Protocol (MCP) resuelve este problema al proporcionar un estándar de comunicación universal entre los LLMs y fuentes de datos externas. Desarrollar un servidor MCP específico para Marcanet permite encapsular la complejidad de la extracción de datos (web scraping o ingeniería inversa de peticiones HTTP) en un microservicio aislado.

Al integrar este servidor MCP dentro de una arquitectura de agentes utilizando LangGraph.js, se dota a un sistema de inteligencia artificial de la capacidad de razonar, planificar y ejecutar búsquedas de disponibilidad marcaria en tiempo real, procesando los resultados y entregando reportes estructurados al usuario final.

## Actualización importante: operación SIN LLM propia

Originalmente este documento asumía que una LLM (Gemini, Qwen, GPT) operaría el "otro lado" del MCP. Dado que no se dispone de una, la arquitectura se adapta para que el MCP sea utilizable de dos formas complementarias:

1. **Modo interactivo (stdio)** — Para cuando exista acceso eventual a un cliente MCP compatible (Claude Desktop, Cursor, etc.). El protocolo sigue expuesto; no se pierde nada.
2. **Modo autónomo (HTTP + cola de trabajo)** — El servidor MCP corre además como microservicio HTTP con autenticación por API key. Un *worker* propio (sin LLM) hace de "otro lado": toma peticiones de una cola (Redis o SQLite según escala), invoca las herramientas vía el cliente MCP y escribe resultados. n8n, cron jobs o cualquier frontend REST pueden encolar trabajos y consumir reportes sin tocar un modelo de lenguaje.

La investigación masiva (p. ej. disponibilidad de miles de marcas) ya no depende del razonamiento de una LLM: es un proceso determinista de *batch* — cola → scraper → caché → reporte JSON/CSV — que sí puede escalar horizontalmente.

## Escalamiento a 100,000 consultas concurrentes

IMPI es el cuello de botella físico: su portal tiene protección anti-bot y ningún scraping responsable puede sostener 100k consultas/s reales contra él. La estrategia para soportar hasta 100,000 usuarios/peticiones simultáneas es absorber la demanda antes de que llegue a IMPI:

- **Caché compartida (Redis)** con TTL largo para datos registrados (rara vez cambian) y corto para solicitudes en trámite. En un catálogo de ~5M de registros, la mayoría de consultas repetidas se resuelven en milisegundos sin tocar IMPI.
- **Deduplicación in-flight**: si 500 usuarios consultan la misma marca a la vez, se dispara UNA sola petición a IMPI y se reparte el resultado.
- **Cola asíncrona (BullMQ/Redis)**: las consultas frías entran a la cola y el usuario recibe un ID de tarea; los *fetchers* (N instancias del worker) consumen a la velocidad máxima segura que IMPI tolera (rate limiting adaptativo con backoff ante 429/CAPTCHA).
- **Pools de navegador (Playwright)** dimensionados por CPU/RAM, con opción de modo headless y proxies rotativos donde aplique.
- **API pública escalable detrás de Nginx/CDN**: endpoints HTTP del microservicio son stateless salvo la caché/cola, por lo que horizontalizan con réplicas.

Con esta arquitectura, 100k usuarios simultáneos no significan 100k scrapings: significan 100k lecturas de Redis + una fracción pequeña y controlada de extracciones reales a IMPI. Ver `Escalar100k.md` para el desglose numérico y topología de despliegue.
