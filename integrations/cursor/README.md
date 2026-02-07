# Cursor Integration

Add governance to **Cursor** so that every file operation the agent makes is validated against your policy and logged to a tamper-evident evidence ledger.

## Architecture

```
Cursor Agent Mode
    |
    |  tool call (e.g. read_text_file)
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

The MCP proxy sits transparently between Cursor and the real MCP tool servers. Cursor talks to the proxy as if it were a normal MCP server, but every tool call is validated against your policy first.

## Governance Model: Soft

Cursor has built-in tools (`Read`, `Write`, `Shell`, etc.) that bypass MCP entirely. To route operations through the governed proxy, we use a **Cursor Rule** (`.cursor/rules/governance.mdc`) that instructs the agent to prefer governed MCP tools.

This is **soft governance** -- it relies on the LLM following the rule. It is effective in practice (Cursor generally follows rules well), but a sufficiently creative prompt could theoretically convince the agent to use built-in tools and bypass governance.

For **hard governance** (where bypass is impossible), the agent must run in an environment where the governed tools are the *only* tools available. See the [OpenClaw integration](../openclaw/) or build a custom agent harness that only exposes tools through the gateway.

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
npx det-acp init cursor
```

This generates all required files with sensible defaults:

| File | Purpose |
|---|---|
| `policy.yaml` | Governance policy (edit to customize) |
| `.cursor/mcp.json` | Registers the governed MCP proxy in Cursor |
| `.cursor/rules/governance.mdc` | Instructs the agent to use governed tools |

To use your own policy instead of the default:

```bash
npx det-acp init cursor --policy ./my-policy.yaml
```

After running `init`:

1. Open **Cursor Settings** (Cmd+Shift+P > "Cursor Settings")
2. Navigate to the **MCP** section
3. You should see `governed-filesystem` listed -- click the restart/refresh button to start it

That's it. The agent will now route file operations through governance.

### Manual Setup (Advanced)

<details>
<summary>Click to expand manual setup instructions</summary>

#### Step 1: Copy the Policy and Proxy Config

Copy the files from this folder into your target project (or the deterministic-agent-control-protocol root for testing):

```bash
# From the deterministic-agent-control-protocol root:
cp integrations/cursor/policy.yaml ./cursor.policy.yaml
cp integrations/cursor/mcp-proxy.yaml ./cursor-mcp-proxy.yaml
```

Edit `cursor-mcp-proxy.yaml` and replace the `args` path with the absolute path to the directory you want governed:

```yaml
backends:
  - name: filesystem
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/absolute/path/to/your/project"]
```

#### Step 2: Register the MCP Server in Cursor

Create `.cursor/mcp.json` in your project root (or copy from this folder):

```json
{
  "mcpServers": {
    "governed-filesystem": {
      "command": "node",
      "args": [
        "/absolute/path/to/deterministic-agent-control-protocol/dist/cli/index.js",
        "proxy",
        "/absolute/path/to/cursor-mcp-proxy.yaml"
      ]
    }
  }
}
```

Replace the absolute paths with the real paths on your machine. Then:

1. Open **Cursor Settings** (Cmd+Shift+P > "Cursor Settings")
2. Navigate to the **MCP** section
3. You should see `governed-filesystem` listed -- click the restart/refresh button to start it

#### Step 3: Add the Governance Rule

Copy the Cursor rule into your project:

```bash
mkdir -p .cursor/rules
cp integrations/cursor/governance.mdc .cursor/rules/governance.mdc
```

This rule has `alwaysApply: true`, so it applies to every agent chat in the workspace. It instructs the agent to:

- **NEVER** use built-in `Read`, `Write`, `StrReplace`, `LS`, `Glob`, `Delete`, or `Shell` tools for file operations
- **ALWAYS** route file operations through `governed-filesystem` MCP tools
- **Respect denials** -- do not fall back to built-in tools if the policy denies an action

See [governance.mdc](governance.mdc) for the full rule content.

</details>

## Quick Test

### Set Up the Test Sandbox

Copy the test sandbox into your project root:

```bash
cp -r integrations/cursor/test-sandbox ./test-sandbox
```

This creates:
- `test-sandbox/hello.txt` -- a normal file (should be readable)
- `test-sandbox/.env` -- a sensitive file (should be blocked by the `**/.env` forbidden pattern)

### Run the Tests

Open a new Cursor agent chat (Cmd+I) and try these prompts:

**Test 1 -- Allowed read (should succeed):**
> Read the file test-sandbox/hello.txt

The agent should use `governed-filesystem` -> `read_text_file` and return: `Hello from the governance test!`

**Test 2 -- Forbidden path (should be denied):**
> Read the file test-sandbox/.env

The agent should receive: `Action denied by policy: Path "..." matches forbidden pattern "**/.env"` and report the denial to you.

**Test 3 -- Unconfigured tool (should be denied):**
> Create a directory called test-sandbox/new-folder

The agent should receive: `Action denied by policy: No capability defined for tool "create_directory"` since `create_directory` is not in the policy capabilities.

**Test 4 -- Allowed write (should succeed):**
> Create a file called test.txt with the content "hello world"

The agent should use `governed-filesystem` -> `write_file` and create the file.

### Expected Results

| Action | Tool | Expected |
|---|---|---|
| Read a normal file | `read_text_file` | ALLOWED |
| Write a normal file | `write_file` | ALLOWED |
| Edit a file | `edit_file` | ALLOWED |
| List a directory | `list_directory` | ALLOWED |
| Read `.env` | `read_text_file` | **DENIED** (forbidden pattern) |
| Read `secrets.json` | `read_text_file` | **DENIED** (forbidden pattern) |
| Create a directory | `create_directory` | **DENIED** (not in capabilities) |
| Move/rename a file | `move_file` | **DENIED** (not in capabilities) |
| Get directory tree | `directory_tree` | **DENIED** (not in capabilities) |

### Inspect the Audit Trail

Every action -- allowed or denied -- is recorded in the evidence ledger:

```bash
# List ledger files
ls .det-acp/ledgers/

# View a session summary
npx det-acp report .det-acp/ledgers/<session-file>.jsonl
```

Example output:

```
--- Ledger Integrity ---
Valid: true
Entries: 8

--- Session Summary (abc123) ---
Total entries: 8
Actions evaluated: 5
  Allowed: 3
  Denied: 2
  Gated: 0
Results recorded: 3
Escalations triggered: 0
State changes: active -> completed
```

## Files in This Folder

| File | Purpose |
|---|---|
| `policy.yaml` | Policy allowing filesystem MCP tools, blocking sensitive files |
| `mcp-proxy.yaml` | Proxy config pointing at `@modelcontextprotocol/server-filesystem` |
| `mcp.json` | Template for `.cursor/mcp.json` to register the governed proxy |
| `governance.mdc` | Cursor rule that redirects built-in tools to governed MCP tools |
| `test-sandbox/hello.txt` | Test file for allowed reads |
| `test-sandbox/.env` | Test file for forbidden path denials |
