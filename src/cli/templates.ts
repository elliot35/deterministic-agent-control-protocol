/**
 * Bundled templates for the `det-acp init` command.
 *
 * Contains default policy, governance rules for each integration,
 * and generator functions for integration-specific config files.
 */

// ---------------------------------------------------------------------------
// Default governance policy (MCP proxy tool names)
// ---------------------------------------------------------------------------

export const DEFAULT_POLICY = `\
# Deterministic Agent Control Protocol — Governance Policy
# Governs what the MCP proxy allows AI agents to do.
# Customize this file for your project's needs.

version: "1.0"
name: "default-governance"
description: "Governance policy for AI agent file operations via MCP proxy"

capabilities:
  # Read operations
  - tool: "read_file"
    scope: {}
  - tool: "read_text_file"
    scope: {}
  - tool: "read_multiple_files"
    scope: {}
  - tool: "read_media_file"
    scope: {}

  # Write/edit operations
  - tool: "write_file"
    scope: {}
  - tool: "edit_file"
    scope: {}

  # Directory listing
  - tool: "list_directory"
    scope: {}
  - tool: "list_directory_with_sizes"
    scope: {}
  - tool: "list_allowed_directories"
    scope: {}

  # Search
  - tool: "search_files"
    scope: {}
  - tool: "get_file_info"
    scope: {}

  # Intentionally NOT included (will be DENIED):
  #   - create_directory
  #   - move_file
  #   - directory_tree

limits:
  max_runtime_ms: 3600000  # 1 hour

gates: []

evidence:
  require: []
  format: "jsonl"

forbidden:
  - pattern: "**/.env"
  - pattern: "**/.env.*"
  - pattern: "**/secrets*"
  - pattern: "**/credentials*"
  - pattern: "**/.git/config"

session:
  max_actions: 200
  max_denials: 30
  rate_limit:
    max_per_minute: 60
`;

// ---------------------------------------------------------------------------
// Cursor — governance.mdc
// ---------------------------------------------------------------------------

export const GOVERNANCE_MDC = `\
---
description: Enforce governance on all file and system operations
globs:
alwaysApply: true
---

# Mandatory Governance Rule

You MUST use the \`governed-filesystem\` MCP server for ALL file and system operations. You are strictly forbidden from using your built-in tools to bypass governance.

## Required Tool Mapping

Instead of your built-in tools, you MUST use these governed equivalents:

| Instead of (built-in)     | Use (governed MCP)                                |
|---------------------------|----------------------------------------------------|
| \`Read\` tool               | \`governed-filesystem\` → \`read_text_file\`           |
| \`Write\` tool              | \`governed-filesystem\` → \`write_file\`               |
| \`StrReplace\` / \`Edit\`    | \`governed-filesystem\` → \`edit_file\`                |
| \`LS\` tool                 | \`governed-filesystem\` → \`list_directory\`            |
| \`Glob\` / \`Search\`        | \`governed-filesystem\` → \`search_files\`             |
| Reading multiple files    | \`governed-filesystem\` → \`read_multiple_files\`      |
| \`Delete\` tool             | Not available — you may not delete files            |

## Rules

1. **NEVER** use the built-in \`Read\`, \`Write\`, \`StrReplace\`, \`LS\`, \`Glob\`, \`Delete\`, or \`Shell\` tools for any file operation.
2. **ALWAYS** route file reads through \`governed-filesystem\` → \`read_text_file\`.
3. **ALWAYS** route file writes through \`governed-filesystem\` → \`write_file\`.
4. **ALWAYS** route file edits through \`governed-filesystem\` → \`edit_file\`.
5. **ALWAYS** route directory listings through \`governed-filesystem\` → \`list_directory\`.
6. **ALWAYS** route file searches through \`governed-filesystem\` → \`search_files\`.
7. If a governed tool call is **denied by policy**, you MUST respect the denial. Do NOT attempt to use a built-in tool as a fallback. Report the denial to the user instead.
8. If you need a tool that is not available through the governed MCP server, ask the user for permission before proceeding.

## Why

All file and system operations must go through the Deterministic Agent Control Protocol governance layer for policy enforcement and audit logging. Using built-in tools would bypass security policies, forbidden path protections, and the tamper-evident evidence ledger.
`;

// ---------------------------------------------------------------------------
// Claude Code — CLAUDE.md
// ---------------------------------------------------------------------------

export const CLAUDE_MD = `\
# Governance Instructions

You MUST use the \`governed-filesystem\` MCP server for ALL file and system operations. You are strictly forbidden from using your built-in tools to bypass governance.

## Required Tool Mapping

Instead of your built-in file tools, you MUST use these governed equivalents:

| Instead of (built-in)   | Use (governed MCP)                             |
|--------------------------|------------------------------------------------|
| \`Read\` tool              | \`governed-filesystem\` → \`read_text_file\`       |
| \`Write\` tool             | \`governed-filesystem\` → \`write_file\`           |
| \`Edit\` tool              | \`governed-filesystem\` → \`edit_file\`            |
| \`LS\` / \`Glob\`           | \`governed-filesystem\` → \`list_directory\`       |
| \`Grep\` / \`Search\`       | \`governed-filesystem\` → \`search_files\`         |
| Reading multiple files   | \`governed-filesystem\` → \`read_multiple_files\`  |
| Deleting files           | Not available — you may not delete files       |

## Rules

1. **NEVER** use the built-in \`Read\`, \`Write\`, \`Edit\`, \`Grep\`, \`Glob\`, or \`Bash\` (for file operations) tools when the governed MCP tools are available.
2. **ALWAYS** route file reads through \`governed-filesystem\` → \`read_text_file\`.
3. **ALWAYS** route file writes through \`governed-filesystem\` → \`write_file\`.
4. **ALWAYS** route file edits through \`governed-filesystem\` → \`edit_file\`.
5. **ALWAYS** route directory listings through \`governed-filesystem\` → \`list_directory\`.
6. **ALWAYS** route file searches through \`governed-filesystem\` → \`search_files\`.
7. If a governed tool call is **denied by policy**, you MUST respect the denial. Do NOT attempt to use a built-in tool as a fallback. Report the denial to the user instead.
8. If you need a tool that is not available through the governed MCP server, ask the user for permission before proceeding.

## Why

All file and system operations must go through the Deterministic Agent Control Protocol governance layer for policy enforcement and audit logging. Using built-in tools would bypass security policies, forbidden path protections, and the tamper-evident evidence ledger.
`;

// ---------------------------------------------------------------------------
// Codex — AGENTS.md
// ---------------------------------------------------------------------------

export const AGENTS_MD = `\
# Governance Instructions

You MUST use the \`governed-filesystem\` MCP server for ALL file and system operations. You are strictly forbidden from using your built-in tools to bypass governance.

## Required Tool Mapping

Instead of your built-in file tools, you MUST use these governed equivalents:

| Instead of (built-in)   | Use (governed MCP)                             |
|--------------------------|------------------------------------------------|
| Reading files            | \`governed-filesystem\` → \`read_text_file\`       |
| Writing files            | \`governed-filesystem\` → \`write_file\`           |
| Editing files            | \`governed-filesystem\` → \`edit_file\`            |
| Listing directories      | \`governed-filesystem\` → \`list_directory\`       |
| Searching files          | \`governed-filesystem\` → \`search_files\`         |
| Reading multiple files   | \`governed-filesystem\` → \`read_multiple_files\`  |
| Deleting files           | Not available — you may not delete files       |

## Rules

1. **NEVER** use built-in file read/write/edit tools for any file operation when the governed MCP tools are available.
2. **ALWAYS** route file operations through the \`governed-filesystem\` MCP server.
3. If a governed tool call is **denied by policy**, you MUST respect the denial. Do NOT attempt to use a built-in tool as a fallback. Report the denial to the user instead.
4. If you need a tool that is not available through the governed MCP server, ask the user for permission before proceeding.

## Why

All file and system operations must go through the Deterministic Agent Control Protocol governance layer for policy enforcement and audit logging. Using built-in tools would bypass security policies, forbidden path protections, and the tamper-evident evidence ledger.
`;

// ---------------------------------------------------------------------------
// Claude Code — .claude/settings.json
// ---------------------------------------------------------------------------

export const CLAUDE_SETTINGS_JSON = `\
{
  "permissions": {
    "deny": [
      "Read",
      "Write",
      "Edit"
    ],
    "allow": [
      "Bash",
      "Grep",
      "Glob",
      "governed-filesystem"
    ]
  }
}
`;

// ---------------------------------------------------------------------------
// Config generators
// ---------------------------------------------------------------------------

/**
 * Generate .cursor/mcp.json content.
 * Uses the simplified `proxy --policy` mode so no mcp-proxy.yaml is needed.
 * Includes --evolve by default for policy self-evolution.
 */
export function generateCursorMcpJson(cliPath: string, policyAbsPath: string): string {
  const config = {
    mcpServers: {
      'governed-filesystem': {
        command: 'node',
        args: [cliPath, 'proxy', '--policy', policyAbsPath, '--evolve'],
      },
    },
  };
  return JSON.stringify(config, null, 2) + '\n';
}

/**
 * Generate .mcp.json content for Claude Code.
 * Uses the simplified `proxy --policy` mode so no mcp-proxy.yaml is needed.
 * Includes --evolve by default for policy self-evolution.
 */
export function generateClaudeCodeMcpJson(cliPath: string, policyAbsPath: string): string {
  const config = {
    mcpServers: {
      'governed-filesystem': {
        command: 'node',
        args: [cliPath, 'proxy', '--policy', policyAbsPath, '--evolve'],
      },
    },
  };
  return JSON.stringify(config, null, 2) + '\n';
}

/**
 * Generate .codex/config.toml content.
 * Uses the simplified `proxy --policy` mode so no mcp-proxy.yaml is needed.
 * Includes --evolve by default for policy self-evolution.
 */
export function generateCodexConfigToml(cliPath: string, policyAbsPath: string): string {
  return `\
# Codex CLI config with Deterministic Agent Control Protocol governance
# Generated by: det-acp init codex

# Use workspace-write sandbox for OS-level filesystem restrictions
sandbox_mode = "workspace-write"

# Governed MCP proxy — routes file operations through policy enforcement
[mcp_servers.governed-filesystem]
command = "node"
args = [
  ${JSON.stringify(cliPath)},
  "proxy",
  "--policy",
  ${JSON.stringify(policyAbsPath)},
  "--evolve"
]
`;
}
