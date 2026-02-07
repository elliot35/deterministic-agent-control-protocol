/**
 * MCP Proxy Server — transparent governance layer for MCP-compatible agents.
 *
 * Sits between an MCP client (e.g. Cursor, Claude Code) and backend MCP
 * tool servers. Every tool call is validated against the session policy
 * before being forwarded to the real backend.
 *
 * Architecture:
 *   Agent (MCP Client) → MCP Proxy (this) → Backend MCP Servers
 *
 * The proxy:
 *   1. Connects to all configured backend MCP servers
 *   2. Discovers tools from each backend
 *   3. Presents aggregated tool list as its own MCP server
 *   4. On each tool call: evaluate against policy → forward or deny
 *   5. Records all actions and results in the evidence ledger
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type { AgentGateway } from '../engine/runtime.js';
import type { MCPProxyConfig, MCPBackendConfig, ToolMapping } from './mcp-types.js';

interface BackendConnection {
  config: MCPBackendConfig;
  client: Client;
  transport: StdioClientTransport;
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
}

export class MCPProxyServer {
  private server: Server;
  private backends: BackendConnection[] = [];
  private toolMap = new Map<string, ToolMapping>();
  private gateway: AgentGateway;
  private config: MCPProxyConfig;
  private sessionId: string | null = null;

  constructor(config: MCPProxyConfig, gateway: AgentGateway) {
    this.config = config;
    this.gateway = gateway;

    this.server = new Server(
      {
        name: 'det-acp-proxy',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.setupHandlers();
  }

  /**
   * Start the MCP proxy server.
   */
  async start(): Promise<void> {
    // Connect to all backend MCP servers
    await this.connectBackends();

    // Create a session for this proxy connection
    const session = await this.gateway.createSession(
      this.config.policy,
      {
        source: 'mcp-proxy',
        ...this.config.sessionMetadata,
      },
    );
    this.sessionId = session.id;

    // Start the proxy server
    if (this.config.transport === 'stdio') {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
    } else {
      throw new Error('SSE transport not yet implemented for MCP proxy server');
    }
  }

  /**
   * Stop the MCP proxy server.
   */
  async stop(): Promise<void> {
    // Terminate the session
    if (this.sessionId) {
      try {
        await this.gateway.terminateSession(this.sessionId, 'MCP proxy stopped');
      } catch {
        // Best effort
      }
    }

    // Disconnect backends
    for (const backend of this.backends) {
      try {
        await backend.transport.close();
      } catch {
        // Best effort
      }
    }

    await this.server.close();
  }

  /**
   * Get the current session ID.
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  // ---------------------------------------------------------------------------
  // Private: handler setup
  // ---------------------------------------------------------------------------

  private setupHandlers(): void {
    // Handle tools/list — return aggregated tools from all backends
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = [];
      for (const backend of this.backends) {
        for (const tool of backend.tools) {
          tools.push({
            name: tool.name,
            description: tool.description
              ? `[${backend.config.name}] ${tool.description}`
              : `Tool from ${backend.config.name}`,
            inputSchema: tool.inputSchema ?? { type: 'object' as const, properties: {} },
          });
        }
      }
      return { tools };
    });

    // Handle tools/call — evaluate against policy, then forward
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name: toolName, arguments: toolArgs } = request.params;
      const mapping = this.toolMap.get(toolName);

      if (!mapping) {
        return {
          content: [{ type: 'text' as const, text: `Unknown tool: ${toolName}` }],
          isError: true,
        };
      }

      if (!this.sessionId) {
        return {
          content: [{ type: 'text' as const, text: 'No active session' }],
          isError: true,
        };
      }

      // Evaluate the action against the session policy
      const evaluation = await this.gateway.evaluate(this.sessionId, {
        tool: toolName,
        input: (toolArgs ?? {}) as Record<string, unknown>,
      });

      // If denied, return the denial reasons
      if (evaluation.decision === 'deny') {
        return {
          content: [{
            type: 'text' as const,
            text: `Action denied by policy: ${evaluation.reasons.join('; ')}`,
          }],
          isError: true,
        };
      }

      // If gated and pending, return a message indicating approval is needed
      if (evaluation.decision === 'gate') {
        return {
          content: [{
            type: 'text' as const,
            text: `Action requires approval: ${evaluation.reasons.join('; ')}. Waiting for gate resolution.`,
          }],
          isError: true,
        };
      }

      // Allowed — forward to the backend
      const backend = this.backends[mapping.backendIndex];
      try {
        const result = await backend.client.callTool({
          name: toolName,
          arguments: toolArgs,
        });

        // Record the result
        const isError = result.isError === true;
        const resultText = Array.isArray(result.content)
          ? result.content.map((c: { text?: string }) => c.text ?? '').join('\n')
          : String(result.content);

        await this.gateway.recordResult(this.sessionId, evaluation.actionId, {
          success: !isError,
          output: resultText,
          error: isError ? resultText : undefined,
        });

        return result;
      } catch (err) {
        const errorMsg = (err as Error).message;

        // Record the failure
        await this.gateway.recordResult(this.sessionId, evaluation.actionId, {
          success: false,
          error: errorMsg,
        });

        return {
          content: [{ type: 'text' as const, text: `Backend error: ${errorMsg}` }],
          isError: true,
        };
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Private: backend connections
  // ---------------------------------------------------------------------------

  private async connectBackends(): Promise<void> {
    for (let i = 0; i < this.config.backends.length; i++) {
      const backendConfig = this.config.backends[i];

      if (backendConfig.transport === 'stdio') {
        if (!backendConfig.command) {
          throw new Error(`Backend "${backendConfig.name}" is stdio but has no command`);
        }

        const client = new Client(
          {
            name: `det-acp-proxy-client-${backendConfig.name}`,
            version: '0.1.0',
          },
          {
            capabilities: {},
          },
        );

        const transport = new StdioClientTransport({
          command: backendConfig.command,
          args: backendConfig.args,
          env: backendConfig.env
            ? { ...process.env, ...backendConfig.env } as Record<string, string>
            : undefined,
        });

        await client.connect(transport);

        // Discover tools
        const toolsResponse = await client.listTools();
        const tools = toolsResponse.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));

        // Map tools to this backend
        for (const tool of tools) {
          this.toolMap.set(tool.name, {
            toolName: tool.name,
            backendName: backendConfig.name,
            backendIndex: i,
          });
        }

        this.backends.push({
          config: backendConfig,
          client,
          transport,
          tools,
        });
      } else {
        throw new Error(`SSE transport not yet implemented for backend "${backendConfig.name}"`);
      }
    }
  }
}
