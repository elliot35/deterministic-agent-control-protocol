/**
 * MCP Proxy configuration types.
 *
 * Defines the configuration for the MCP proxy server, including
 * backend MCP server connections and transport settings.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

export interface MCPBackendConfig {
  /** Human-readable name for this backend */
  name: string;
  /** Transport type */
  transport: 'stdio' | 'sse';
  /** Command to spawn (for stdio transport) */
  command?: string;
  /** Arguments for the command (for stdio transport) */
  args?: string[];
  /** Environment variables for the command (for stdio transport) */
  env?: Record<string, string>;
  /** URL for SSE transport */
  url?: string;
}

export interface MCPProxyConfig {
  /** Path to policy YAML file or inline YAML */
  policy: string;
  /** Directory for evidence ledger files */
  ledgerDir: string;
  /** Backend MCP servers to proxy to */
  backends: MCPBackendConfig[];
  /** Transport to expose to agents (stdio for local, sse for remote) */
  transport: 'stdio' | 'sse';
  /** Port for SSE transport */
  port?: number;
  /** Host for SSE transport */
  host?: string;
  /** Metadata to attach to sessions */
  sessionMetadata?: Record<string, unknown>;
  /**
   * Enable policy self-evolution.
   * When true, denied actions trigger a user prompt that can update the policy.
   */
  enableEvolution?: boolean;
  /** Timeout in milliseconds for the evolution prompt (default: 30 000) */
  evolutionTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Zod schemas for config file validation
// ---------------------------------------------------------------------------

export const MCPBackendConfigSchema = z.object({
  name: z.string().min(1),
  transport: z.enum(['stdio', 'sse']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().url().optional(),
});

export const MCPProxyConfigSchema = z.object({
  policy: z.string().min(1),
  ledger_dir: z.string().default('.det-acp/ledgers'),
  backends: z.array(MCPBackendConfigSchema).min(1),
  transport: z.enum(['stdio', 'sse']).default('stdio'),
  port: z.number().int().positive().optional(),
  host: z.string().optional(),
  session_metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Resolved tool-to-backend mapping.
 */
export interface ToolMapping {
  toolName: string;
  backendName: string;
  backendIndex: number;
}
