# OpenClaw Integration

Add governance to **OpenClaw** (self-hosted AI assistant) so that tool executions are validated against your policy and logged to a tamper-evident evidence ledger.

## Architecture

```
OpenClaw Gateway
    |
    |  HTTP request (evaluate action)
    v
+----------------------------------+
|  Deterministic Agent Control Protocol HTTP Server |
|                                  |
|  1. Receives action evaluation   |
|  2. Evaluates against policy     |
|  3. ALLOW -> returns approval    |
|     DENY  -> returns denial      |
|  4. Records to evidence ledger   |
+----------------------------------+
    |
    |  (result recorded after execution)
    v
+----------------------------------+
|  OpenClaw Exec / Tool            |
|  (shell, file, browser, etc.)    |
|                                  |
|  Executes only if allowed        |
+----------------------------------+
```

Unlike Cursor, Codex, and Claude Code, OpenClaw does **not** support MCP. Instead, governance is achieved through:

1. The **HTTP Session Server** (`npx det-acp serve`) running alongside the OpenClaw gateway
2. A custom **OpenClaw Skill** that wraps tool execution with policy checks via the HTTP API
3. OpenClaw's built-in **tool allow/deny lists** and **Docker sandboxing**

## Governance Model: Hard

OpenClaw provides the strongest governance among the supported agents because it offers multiple hard enforcement layers:

1. **Docker sandboxing** (hard) -- OpenClaw can run all tool execution inside Docker containers with no network access, read-only or read-write workspace access, and isolated sessions.

2. **Tool allow/deny lists** (hard) -- OpenClaw's config can restrict which tools and binaries are available, enforced at the gateway level.

3. **Deterministic Agent Control Protocol HTTP API** (hard) -- A custom skill wraps exec/read/write operations with policy checks via the HTTP API. The skill only executes the action if the control plane allows it.

4. **Governance skill instructions** (soft) -- The skill's instructions tell the agent to use governed operations, adding a soft layer on top.

## Setup

### Prerequisites

```bash
cd deterministic-agent-control-protocol
npm install
npm run build
```

### Step 1: Start the HTTP Session Server

The control plane HTTP server runs alongside OpenClaw's gateway:

```bash
# Start the Deterministic Agent Control Protocol HTTP server
npx det-acp serve --port 3100 --ledger-dir ./.det-acp/ledgers
```

This exposes the session API at `http://localhost:3100`.

### Step 2: Create a Session

Before OpenClaw starts working, create a session with your policy:

```bash
# Create a session (returns a session ID)
curl -X POST http://localhost:3100/sessions \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "policyPath": "./integrations/openclaw/policy.yaml",
  "metadata": {
    "agent": "openclaw",
    "source": "http-api"
  }
}
EOF
```

Save the returned session ID -- the skill will need it.

### Step 3: Install the Governance Skill

Copy the governance skill into OpenClaw's skills directory:

```bash
# Managed skills (available to all sessions):
cp integrations/openclaw/governance-skill.md ~/.openclaw/skills/deterministic-agent-control-protocol.md

# Or workspace skills (project-scoped):
mkdir -p skills
cp integrations/openclaw/governance-skill.md skills/deterministic-agent-control-protocol.md
```

The skill teaches OpenClaw to:
- Evaluate actions against the policy via the HTTP API before execution
- Record results after execution
- Respect denials and report them to the user

### Step 4: Configure Tool Restrictions

For additional hardening, add tool restrictions to your OpenClaw config. Copy the config snippet and merge it into `~/.openclaw/openclaw.json`:

See [openclaw-config.json5](openclaw-config.json5) for the recommended settings.

Key settings:
- `sandbox.mode: "all"` -- run all tool execution in Docker containers
- `sandbox.workspaceAccess: "rw"` -- allow workspace read/write
- `sandbox.network: false` -- no network access from sandbox
- Tool allow/deny lists to restrict available binaries

### Step 5: Set Environment Variables

The governance skill needs to know the control plane URL and session ID:

```bash
# In your OpenClaw config or environment:
export DET_ACP_URL=http://localhost:3100
export DET_ACP_SESSION_ID=<session-id-from-step-2>
```

## Quick Test

### Set Up the Test Sandbox

```bash
cp -r integrations/openclaw/test-sandbox ./test-sandbox
```

### Run the Tests

Start the HTTP server and create a session, then interact with OpenClaw:

```bash
# Terminal 1: Start the control protocol
npx det-acp serve --port 3100

# Terminal 2: Create a session
curl -s -X POST http://localhost:3100/sessions \
  -H "Content-Type: application/json" \
  -d '{"policyPath": "./integrations/openclaw/policy.yaml"}' | jq .

# Terminal 3: Test via curl (simulating what the skill does)
# Evaluate a read action:
curl -s -X POST http://localhost:3100/sessions/<session-id>/evaluate \
  -H "Content-Type: application/json" \
  -d '{"action": {"tool": "read_text_file", "input": {"path": "test-sandbox/hello.txt"}}}'

# Evaluate a forbidden read:
curl -s -X POST http://localhost:3100/sessions/<session-id>/evaluate \
  -H "Content-Type: application/json" \
  -d '{"action": {"tool": "read_text_file", "input": {"path": "test-sandbox/.env"}}}'
```

### Expected Results

| Action | Tool | Expected |
|---|---|---|
| Read a normal file | `read_text_file` | ALLOWED |
| Write a normal file | `write_file` | ALLOWED |
| Read `.env` | `read_text_file` | **DENIED** (forbidden pattern) |
| Read `secrets.json` | `read_text_file` | **DENIED** (forbidden pattern) |
| Create a directory | `create_directory` | **DENIED** (not in capabilities) |

### Inspect the Audit Trail

```bash
ls .det-acp/ledgers/
npx det-acp report .det-acp/ledgers/<session-file>.jsonl
```

## Files in This Folder

| File | Purpose |
|---|---|
| `policy.yaml` | Policy allowing common file tools, blocking sensitive files |
| `governance-skill.md` | OpenClaw skill that wraps tool execution with policy checks |
| `openclaw-config.json5` | Config snippet for `openclaw.json` with sandbox and tool restrictions |
| `test-sandbox/hello.txt` | Test file for allowed reads |
| `test-sandbox/.env` | Test file for forbidden path denials |
