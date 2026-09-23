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
