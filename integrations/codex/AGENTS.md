# Governance Instructions

You MUST use the `governed-filesystem` MCP server for ALL file and system operations. You are strictly forbidden from using your built-in tools to bypass governance.

## Required Tool Mapping

Instead of your built-in file tools, you MUST use these governed equivalents:

| Instead of (built-in)   | Use (governed MCP)                             |
|--------------------------|------------------------------------------------|
| Reading files            | `governed-filesystem` → `read_text_file`       |
| Writing files            | `governed-filesystem` → `write_file`           |
| Editing files            | `governed-filesystem` → `edit_file`            |
| Listing directories      | `governed-filesystem` → `list_directory`       |
| Searching files          | `governed-filesystem` → `search_files`         |
| Reading multiple files   | `governed-filesystem` → `read_multiple_files`  |
| Deleting files           | Not available — you may not delete files       |

## Rules

1. **NEVER** use built-in file read/write/edit tools for any file operation when the governed MCP tools are available.
2. **ALWAYS** route file operations through the `governed-filesystem` MCP server.
3. If a governed tool call is **denied by policy**, you MUST respect the denial. Do NOT attempt to use a built-in tool as a fallback. Report the denial to the user instead.
4. If you need a tool that is not available through the governed MCP server, ask the user for permission before proceeding.

## Why

All file and system operations must go through the Deterministic Agent Control Protocol governance layer for policy enforcement and audit logging. Using built-in tools would bypass security policies, forbidden path protections, and the tamper-evident evidence ledger.
