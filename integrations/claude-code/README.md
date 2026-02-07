# Claude Code Integration

Add governance to **Claude Code** (Anthropic's CLI coding agent) so that every tool call is validated against your policy and logged to a tamper-evident evidence ledger.

## Architecture

```
Claude Code
    |
    |  MCP tool call (e.g. read_text_file)
    v
+----------------------------------+
|  Deterministic Agent Control Protocol MCP Proxy   |
|                                  |
|  1. Receives MCP tool call       |
|  2. Evaluates against policy     |
|  3. ALLOW -> forwards to backend |
|     DENY  -> returns error       |
|  4. Records to evidence ledger   |
+----------------------------------+
    |
    |  (forwarded only if allowed)
    v
+----------------------------------+
|  Backend MCP Server              |
|  (e.g. filesystem, database)     |
|                                  |
|  Executes the actual operation   |
+----------------------------------+
```

Claude Code has native MCP client support via `.mcp.json` (project scope) or `~/.claude.json` (user scope). The governed proxy registers as an MCP server, and all tool calls from the MCP server are validated against your policy.

## Governance Model: Soft + Semi-Hard

Claude Code provides the strongest built-in governance among the supported agents thanks to three layers:

1. **MCP proxy** (soft) -- The proxy validates all MCP tool calls against the policy, enforces session budgets and rate limits, and logs everything to the evidence ledger.

2. **CLAUDE.md** (soft) -- A `CLAUDE.md` file instructs Claude Code to prefer governed MCP tools over its built-in tools. This is equivalent to Cursor's governance rule.

3. **settings.json permissions** (semi-hard) -- Claude Code's built-in permission system can **deny** specific built-in tools, making it harder to bypass governance. For example, you can deny `Read`, `Write`, and `Edit` tools so Claude Code is forced to use the governed MCP alternatives.

The `settings.json` permission layer makes this integration stronger than Cursor's pure soft governance, since Claude Code will refuse to use denied tools even if instructed to.

## Setup

### Prerequisites

```bash
cd deterministic-agent-control-protocol
npm install
npm run build
```

### Quick Setup (Recommended)

From your **target project directory**, run:

```bash
npx det-acp init claude-code
```

This generates all required files with sensible defaults:

| File | Purpose |
|---|---|
| `policy.yaml` | Governance policy (edit to customize) |
| `.mcp.json` | Registers the governed MCP proxy in Claude Code |
| `CLAUDE.md` | Instructs the agent to use governed tools |
| `.claude/settings.json` | Denies built-in file tools (semi-hard enforcement) |

To use your own policy instead of the default:

```bash
npx det-acp init claude-code --policy ./my-policy.yaml
```

After running `init`, restart Claude Code to pick up the MCP server. That's it.

> **Note**: The generated `.claude/settings.json` denies built-in `Read`, `Write`, and `Edit` tools, forcing Claude Code to use the governed MCP alternatives. If this causes issues, you can safely delete `.claude/settings.json` -- the soft governance via `CLAUDE.md` will still work.

### Manual Setup (Advanced)

<details>
<summary>Click to expand manual setup instructions</summary>

#### Step 1: Copy the Policy

```bash
# From the deterministic-agent-control-protocol root:
cp integrations/claude-code/policy.yaml ./claude-code.policy.yaml
```

#### Step 2: Register the MCP Server

Claude Code uses `.mcp.json` at the project root for project-scoped MCP servers. Copy the template:

```bash
cp integrations/claude-code/mcp.json ./.mcp.json
```

Edit `.mcp.json` and replace the absolute paths:

```json
{
  "mcpServers": {
    "governed-filesystem": {
      "command": "node",
      "args": [
        "/absolute/path/to/deterministic-agent-control-protocol/dist/cli/index.js",
        "proxy",
        "/absolute/path/to/claude-code.policy.yaml"
      ]
    }
  }
}
```

> **Note**: Claude Code's `.mcp.json` format uses `command` and `args` for stdio servers, similar to Cursor. The file can be committed to git for team-wide governance.

#### Step 3: Add CLAUDE.md Governance Instructions

Copy the CLAUDE.md file into your project root:

```bash
cp integrations/claude-code/CLAUDE.md ./CLAUDE.md
```

This file instructs Claude Code to:
- Prefer `governed-filesystem` MCP tools over built-in `Read`, `Write`, `Edit` tools
- Respect policy denials and not fall back to direct tool use
- Report denials to the user

Claude Code automatically loads `CLAUDE.md` from the project root at session start.

#### Step 4: (Optional) Restrict Built-in Tools via Permissions

For stronger governance, copy the settings template that denies direct file access:

```bash
mkdir -p .claude
cp integrations/claude-code/settings.json .claude/settings.json
```

This settings file:
- **Denies** built-in `Read`, `Write`, and `Edit` tools for all paths
- **Allows** the `governed-filesystem` MCP tools
- **Allows** Bash commands (since the proxy does not govern shell access -- use the Shell Proxy separately if needed)

With these permissions, Claude Code physically cannot use its built-in file tools, even if it wanted to -- providing semi-hard governance.

> **Warning**: Denying built-in tools may impact Claude Code's ability to perform some operations if the governed MCP server does not expose equivalent functionality. Test thoroughly.

</details>

## Quick Test

### Set Up the Test Sandbox

```bash
cp -r integrations/claude-code/test-sandbox ./test-sandbox
```

### Run Claude Code with Governance

```bash
# Start Claude Code in the project directory
claude

# Try these prompts:
```

**Test 1 -- Allowed read (should succeed):**
> Read the file test-sandbox/hello.txt

Claude Code should use the governed MCP `read_text_file` tool and return the file contents.

**Test 2 -- Forbidden path (should be denied):**
> Read the file test-sandbox/.env

The proxy should deny this with: `Action denied by policy: Path "..." matches forbidden pattern "**/.env"`

**Test 3 -- Unconfigured tool (should be denied):**
> Create a directory called test-sandbox/new-folder

The proxy should deny this: `No capability defined for tool "create_directory"`

**Test 4 -- Built-in tool denied (if settings.json is installed):**
> Use the built-in Read tool to read test-sandbox/hello.txt

If `settings.json` denies the `Read` tool, Claude Code will refuse to use it and should fall back to the governed MCP tool (or report that the built-in tool is denied).

### Expected Results

| Action | Tool | Expected |
|---|---|---|
| Read a normal file | `read_text_file` (MCP) | ALLOWED |
| Write a normal file | `write_file` (MCP) | ALLOWED |
| List a directory | `list_directory` (MCP) | ALLOWED |
| Read `.env` | `read_text_file` (MCP) | **DENIED** (forbidden pattern) |
| Create a directory | `create_directory` (MCP) | **DENIED** (not in capabilities) |
| Built-in Read | `Read` (built-in) | **DENIED** (settings.json) |

### Inspect the Audit Trail

```bash
ls .det-acp/ledgers/
npx det-acp report .det-acp/ledgers/<session-file>.jsonl
```

## Files in This Folder

| File | Purpose |
|---|---|
| `policy.yaml` | Policy allowing filesystem MCP tools, blocking sensitive files |
| `mcp.json` | Template for `.mcp.json` to register the governed proxy in Claude Code |
| `CLAUDE.md` | Instructions for Claude Code to prefer governed MCP tools |
| `settings.json` | Template for `.claude/settings.json` that denies built-in file tools |
| `test-sandbox/hello.txt` | Test file for allowed reads |
| `test-sandbox/.env` | Test file for forbidden path denials |
