---
name: deterministic-agent-control-protocol
description: Govern tool execution through the Deterministic Agent Control Protocol policy gateway
version: "1.0"
requires:
  env:
    - DET_ACP_URL
    - DET_ACP_SESSION_ID
---

# Deterministic Agent Control Protocol Governance Skill

This skill wraps tool execution with policy checks via the Deterministic Agent Control Protocol HTTP API. Before executing any file or shell operation, the action is evaluated against the session policy. Only allowed actions are executed.

## Environment Variables

- `DET_ACP_URL` -- URL of the Deterministic Agent Control Protocol HTTP server (e.g. `http://localhost:3100`)
- `DET_ACP_SESSION_ID` -- Session ID obtained when creating a session via the API

## How to Use

Before executing any file read, file write, shell command, or HTTP request, you MUST first evaluate the action against the policy by calling the Deterministic Agent Control Protocol API.

### Step 1: Evaluate the Action

```bash
curl -s -X POST $DET_ACP_URL/sessions/$DET_ACP_SESSION_ID/evaluate \
  -H "Content-Type: application/json" \
  -d '{
    "action": {
      "tool": "<tool-name>",
      "input": { <tool-arguments> }
    }
  }'
```

The response will contain:
- `decision`: `"allow"`, `"deny"`, or `"gate"`
- `actionId`: ID for recording the result (if allowed)
- `reasons`: Array of reasons for the decision

### Step 2: Execute Only If Allowed

- If `decision` is `"allow"`: proceed with the operation, then record the result (Step 3)
- If `decision` is `"deny"`: do NOT execute. Report the denial reasons to the user.
- If `decision` is `"gate"`: the action requires human approval. Wait or report to the user.

### Step 3: Record the Result

After executing an allowed action, record the result:

```bash
curl -s -X POST $DET_ACP_URL/sessions/$DET_ACP_SESSION_ID/record \
  -H "Content-Type: application/json" \
  -d '{
    "actionId": "<action-id-from-step-1>",
    "result": {
      "success": true,
      "output": "<output-of-the-action>"
    }
  }'
```

## Tool Name Mapping

When evaluating actions, use these tool names:

| Operation | Tool Name | Input Fields |
|---|---|---|
| Read a file | `read_text_file` | `{ "path": "..." }` |
| Write a file | `write_file` | `{ "path": "...", "content": "..." }` |
| Edit a file | `edit_file` | `{ "path": "...", "content": "..." }` |
| List directory | `list_directory` | `{ "path": "..." }` |
| Run a command | `command:run` | `{ "command": "..." }` |
| HTTP request | `http:request` | `{ "url": "...", "method": "..." }` |

## Rules

1. **ALWAYS** evaluate actions before execution.
2. **NEVER** execute an action that was denied by the policy.
3. **ALWAYS** record results after successful execution.
4. If the API is unreachable, do NOT proceed with the action. Report the error to the user.
