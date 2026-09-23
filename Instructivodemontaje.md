A continuación se detalla la configuración técnica para construir el servidor y conectarlo al grafo.

1. Construcción del Servidor MCP
Crea un proyecto Node.js e instala el SDK y herramientas de web scraping (Puppeteer recomendado por los bloqueos del IMPI).

Bash
npm init -y
npm install @modelcontextprotocol/sdk puppeteer
npm install -D typescript @types/node
Crea el archivo server.ts e implementa la exposición de la herramienta:

TypeScript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import puppeteer from 'puppeteer';

const server = new Server({ name: "impi-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "buscar_marca_impi",
    description: "Busca marcas registradas en el IMPI (México)",
    inputSchema: {
      type: "object",
      properties: { nombre_marca: { type: "string" } },
      required: ["nombre_marca"]
    }
  }]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "buscar_marca_impi") {
    const { nombre_marca } = request.params.arguments as { nombre_marca: string };
    
    // Lógica de Puppeteer para navegar Acervo de Marcas y extraer el HTML
    // const browser = await puppeteer.launch();
    // ... navegación y extracción ...
    // const resultados = data; 

    const resultados_mock = [{ marca: nombre_marca, estatus: "Registrada", titular: "Ejemplo S.A." }];
    
    return { content: [{ type: "text", text: JSON.stringify(resultados_mock) }] };
  }
  throw new Error("Tool not found");
});

const transport = new StdioServerTransport();
server.connect(transport).then(() => console.log("MCP Server running"));
Compila el servidor a JavaScript usando tsc.

2. Integración con LangGraph.js
En el proyecto donde reside tu agente, necesitas conectar un Cliente MCP e inyectar sus herramientas en el grafo.

Instala las dependencias del orquestador:

Bash
npm install @langchain/core @langchain/langgraph @modelcontextprotocol/sdk
Crea el archivo agent.ts para definir el grafo:

TypeScript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StateGraph, MessagesAnnotation } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai"; // O el modelo que utilices
import { tool } from "@langchain/core/tools";
import { z } from "zod";

async function iniciarAgente() {
  // 1. Conectar al servidor MCP local
  const transport = new StdioClientTransport({
    command: "node",
    args: ["/ruta/absoluta/a/tu/server-mcp/build/server.js"] // Ajusta tu ruta
  });
  
  const mcpClient = new Client({ name: "langgraph-client", version: "1.0.0" }, { capabilities: {} });
  await mcpClient.connect(transport);
  
  // 2. Mapear la herramienta MCP a una herramienta de LangChain
  const buscarMarcaTool = tool(
    async ({ nombre_marca }) => {
      const result = await mcpClient.callTool({
        name: "buscar_marca_impi",
        arguments: { nombre_marca }
      });
      return result.content[0].text;
    },
    {
      name: "buscar_marca_impi",
      description: "Busca marcas registradas en el IMPI (México)",
      schema: z.object({ nombre_marca: z.string() })
    }
  );

  const tools = [buscarMarcaTool];
  const toolNode = new ToolNode(tools);
  
  // 3. Configurar el LLM
  const model = new ChatOpenAI({ modelName: "gpt-4o-mini", temperature: 0 }).bindTools(tools);

  // 4. Definir nodos de LangGraph
  const callModel = async (state: typeof MessagesAnnotation.State) => {
    const response = await model.invoke(state.messages);
    return { messages: [response] };
  };

  const shouldContinue = (state: typeof MessagesAnnotation.State) => {
    const lastMessage = state.messages[state.messages.length - 1];
    return lastMessage.tool_calls?.length ? "tools" : "__end__";
  };

  // 5. Ensamblar el Grafo
  const workflow = new StateGraph(MessagesAnnotation)
    .addNode("agent", callModel)
    .addNode("tools", toolNode)
    .addEdge("__start__", "agent")
    .addConditionalEdges("agent", shouldContinue)
    .addEdge("tools", "agent");

  const app = workflow.compile();

  // 6. Ejecutar
  const finalState = await app.invoke({
    messages: [{ role: "user", content: "Busca la marca 'Sabinas' en el IMPI y dime su estatus." }]
  });

  console.log(finalState.messages[finalState.messages.length - 1].content);
}

iniciarAgente().catch(console.error);
