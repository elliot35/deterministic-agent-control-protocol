# Codex CLI Integration

Add governance to **OpenAI Codex CLI** so that every tool call the agent makes is validated against your policy and logged to a tamper-evident evidence ledger.

## Architecture

```
Codex CLI
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

Codex CLI has native MCP client support. The governed proxy registers as an MCP server in Codex's config, and all tool calls from the MCP server are validated against your policy before being forwarded to the real backend.

## Governance Model: Soft + Sandbox

Codex provides two complementary governance layers:

1. **Built-in sandbox** (hard) -- Codex has platform-specific sandboxing (Seatbelt on macOS, Landlock on Linux) that restricts filesystem and network access at the OS level. Configured via `sandbox_mode` in `config.toml`.

2. **Deterministic Agent Control Protocol MCP proxy** (soft) -- The proxy adds policy-level governance on top: forbidden patterns, session budgets, rate limits, and audit logging for all MCP tool calls.

3. **AGENTS.md** (soft) -- An `AGENTS.md` file instructs Codex to prefer governed MCP tools over its built-in tools for file operations.

The combination of OS-level sandbox + policy proxy + AGENTS.md instructions provides layered defense.

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
npx det-acp init codex
```

This generates all required files with sensible defaults:

| File | Purpose |
|---|---|
| `policy.yaml` | Governance policy (edit to customize) |
| `.codex/config.toml` | Registers the governed MCP proxy in Codex |
| `AGENTS.md` | Instructs the agent to use governed tools |

To use your own policy instead of the default:

```bash
npx det-acp init codex --policy ./my-policy.yaml
```

After running `init`, start Codex to pick up the MCP server. That's it.

### Manual Setup (Advanced)

<details>
<summary>Click to expand manual setup instructions</summary>

#### Step 1: Copy the Policy and Proxy Config

```bash
# From the deterministic-agent-control-protocol root:
cp integrations/codex/policy.yaml ./codex.policy.yaml
cp integrations/codex/mcp-proxy.yaml ./codex-mcp-proxy.yaml
```

Edit `codex-mcp-proxy.yaml` and replace the backend path with the absolute path to your project:

```yaml
backends:
  - name: filesystem
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/absolute/path/to/your/project"]
```

#### Step 2: Register the MCP Server in Codex

Add the governed proxy to your Codex config. You can either:

**Option A: Use the CLI**

```bash
codex mcp add governed-filesystem \
  -- node /absolute/path/to/deterministic-agent-control-protocol/dist/cli/index.js proxy /absolute/path/to/codex-mcp-proxy.yaml
```

**Option B: Edit config.toml directly**

Copy the template from this folder and merge into your Codex config:

```bash
# Project-scoped (recommended for testing):
mkdir -p .codex
cp integrations/codex/config.toml .codex/config.toml

# Or global:
# cp integrations/codex/config.toml ~/.codex/config.toml
```

Edit the paths in `config.toml` to match your machine. See [config.toml](config.toml) for the template.

#### Step 3: Add the AGENTS.md Governance Instructions

Copy the AGENTS.md file into your project root:

```bash
cp integrations/codex/AGENTS.md ./AGENTS.md
```

This file instructs Codex to:
- Prefer `governed-filesystem` MCP tools over built-in file operations
- Respect policy denials and not fall back to direct tool use
- Report denials to the user

Codex discovers `AGENTS.md` files by walking from the project root to the current directory. Files closer to the working directory take precedence.

</details>

## Quick Test

### Set Up the Test Sandbox

```bash
cp -r integrations/codex/test-sandbox ./test-sandbox
```

### Run Codex with Governance

```bash
# Start Codex in the project directory
codex

# Try these prompts:
```

**Test 1 -- Allowed read (should succeed):**
> Read the file test-sandbox/hello.txt

Codex should use the governed MCP `read_text_file` tool and return the file contents.

**Test 2 -- Forbidden path (should be denied):**
> Read the file test-sandbox/.env

The proxy should deny this with: `Action denied by policy: Path "..." matches forbidden pattern "**/.env"`

**Test 3 -- Unconfigured tool (should be denied):**
> Create a directory called test-sandbox/new-folder

The proxy should deny this: `No capability defined for tool "create_directory"`

### Expected Results

| Action | Tool | Expected |
|---|---|---|
| Read a normal file | `read_text_file` | ALLOWED |
| Write a normal file | `write_file` | ALLOWED |
| List a directory | `list_directory` | ALLOWED |
| Read `.env` | `read_text_file` | **DENIED** (forbidden pattern) |
| Create a directory | `create_directory` | **DENIED** (not in capabilities) |
| Move/rename a file | `move_file` | **DENIED** (not in capabilities) |

### Inspect the Audit Trail

```bash
ls .det-acp/ledgers/
npx det-acp report .det-acp/ledgers/<session-file>.jsonl
```

## Files in This Folder

| File | Purpose |
|---|---|
| `policy.yaml` | Policy allowing filesystem MCP tools, blocking sensitive files |
| `mcp-proxy.yaml` | Proxy config pointing at `@modelcontextprotocol/server-filesystem` |
| `config.toml` | Template for `.codex/config.toml` with governed MCP server registration |
| `AGENTS.md` | Instructions for Codex to prefer governed MCP tools |
| `test-sandbox/hello.txt` | Test file for allowed reads |
| `test-sandbox/.env` | Test file for forbidden path denials |
