# Release Notes

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.2] - 2026-02-12

### Fixed

- **Policy evolution agent instructions** — Init governance templates (Cursor, OpenClaw, Claude Code) now include mandatory "Policy Evolution" instructions so agents present suggestion IDs to the user and call `policy_evolution_approve` with the user's decision; the MCP denial message was shortened to a single actionable line to avoid verbosity in tool responses.

---

## [0.4.1] - 2026-02-12

### Fixed

- **Policy evolution with MCP proxy** — When using `det-acp proxy --evolve`, evolution was previously wired at the gateway with a CLI handler that prompted on stderr, blocking stdin and conflicting with the MCP stdio transport. Evolution is now handled inside the MCP proxy via an MCP-native flow: on deny the proxy returns a structured response with a suggestion ID; the agent presents the suggestion in chat and can call the `policy_evolution_approve` tool to apply the user's decision. No terminal blocking; exports `McpEvolutionHandler` for custom integrations.

---

## [0.4.0] - 2026-02-12

### Added

- **Policy self-evolution** — When an action is denied, the system can suggest a minimal policy change, prompt the user for a decision, and optionally update the policy (in memory and/or on disk).
  - **Suggestion engine** — Pattern-matches denial reasons (no capability, path/binary/domain/method/repo scope violation, forbidden pattern) and produces a single minimal edit: add capability, widen scope, or remove forbidden pattern. Budget and session-limit denials are not suggestible.
  - **Policy Evolution Manager** — Orchestrates deny → prompt (with configurable timeout, default 30s) → apply change → re-evaluate. User choices: **Add to policy** (persist to YAML), **Allow once** (in-memory only for the session), or **Deny** (keep block).
  - **CLI handler** — Terminal prompt on stderr (`[A]dd to policy / allow [O]nce / [D]eny`) so MCP stdio is not interfered with.
  - **Pluggable handler** — Custom `EvolutionHandler` can be used for GUI dialogs, webhooks, etc.
- **MCP proxy `--evolve` flag** — Enables policy self-evolution when using `npx det-acp proxy --policy <file> --evolve`.
- **Library API** — `GatewayConfig.policyEvolution` with `policyPath`, `handler`, and optional `timeoutMs`. Exports: `PolicyEvolutionManager`, `suggestPolicyChange`, `applyPolicyChange`, `writePolicyToFile`, `createCliEvolutionHandler`, and evolution types from `@det-acp/core`.
- README: Policy Self-Evolution section with feature description, enabling instructions, and evolution architecture diagram. Component architecture diagram updated with optional Policy Self-Evolution (Policy Evolution Manager, Suggestion Engine) and Session Manager → Evolution path on deny.

---

## [0.3.1] - 2026-02-08

### Fixed

- **Windows path compatibility in `loadPolicy`** — File paths with Windows drive letters (e.g. `C:\Users\...\policy.yaml`) were misidentified as inline YAML because the heuristic checked for colons (`:`). Replaced the naive colon check with a robust `isFilePath` detector that correctly handles Windows absolute paths, Unix absolute paths, relative paths, and YAML file extensions.

---

## [0.3.0] - 2026-02-07

### Added

- **10 new built-in tool adapters** expanding the governance surface from 6 to 16 tools:
  - `file:delete` — Delete files with full content backup for rollback (previously referenced in policies but no adapter existed)
  - `file:move` — Move/rename files with rollback to original location
  - `file:copy` — Copy files with scope enforcement on both source and destination
  - `directory:list` — List directory contents with recursive support and depth control
  - `directory:create` — Create directories with `mkdir -p` semantics and rollback
  - `git:commit` — Stage and commit changes with `git reset --soft` rollback
  - `git:status` — Read-only git working tree status with structured output
  - `env:read` — Read environment variables with auto-redaction of sensitive values (keys, tokens, passwords)
  - `network:dns` — DNS lookups for allow-listed domains with multiple record types (A, AAAA, CNAME, MX, TXT, NS, SOA, SRV, PTR)
  - `archive:extract` — Extract tar/zip archives with tracked file listing for rollback
- **3 new built-in example policies:**
  - `data-analyst.policy.yaml` — Data analysis agents processing datasets and generating reports
  - `security-audit.policy.yaml` — Security scanning agents with read-only source access and strict write controls
  - `infrastructure-manager.policy.yaml` — Infrastructure management agents with human gates on destructive IaC operations
- Comprehensive unit tests for all new tool adapters (70+ new test cases)
- Updated `ToolName` union type with all new tool names

### Changed

- Updated existing example policies (`coding-agent`, `devops-deploy`, `video-upscaler`) to leverage new tool adapters
- Expanded Built-in Tool Adapters section in README with categorized tables (File, Directory, Git, Network, System)
- Updated Architecture diagram with organized tool adapter subgroups
- Expanded Built-in Policies table with tools-used counts

---

## [0.2.1] - 2026-02-07

### Added

- Development standards skill (`.cursor/skills/dev-standards/`) with workflow checklists, coding standards, security standards, commit conventions, and iterative design principles
- Built-in policy library reference with quality checklist, YAML template, and target policy roadmap
- Release notes file (`RELEASE_NOTES.md`)
- README: Table of Contents, shield badges, Contributing section, Built-in Policies table
- README: Mermaid diagrams — How It Works flowchart, component architecture, action evaluation sequence, session lifecycle state diagram

### Changed

- Overhauled README to open-source-ready format with structured tables, collapsible sections, and native Mermaid diagrams (replaced all ASCII diagrams)
- Promoted Policy DSL Reference, Built-in Tool Adapters, and Custom Tool Adapters to top-level README sections
- Streamlined Quick Start and agent integration setup instructions
- Restructured Integration Modes into collapsible `<details>` sections
- Renamed npm package to `@det-acp/core`
- Updated repository URLs to `elliot35/deterministic-agent-control-protocol`
- Updated LICENSE copyright year to 2026
- Removed standalone agent instruction files (`CLAUDE.md`, `AGENTS.md`) in favor of MCP-based governance

---

## [0.2.0] - 2026-02-07

Initial tracked release.

### Added

- Core governance engine (`AgentGateway`, `SessionManager`, `PolicyEvaluator`, `GateManager`)
- Evidence ledger with SHA-256 hash chain integrity (`EvidenceLedger`)
- Rollback manager for action compensation (`RollbackManager`)
- MCP proxy server for transparent agent governance (`MCPProxyServer`)
- Shell proxy for command-level governance (`ShellProxy`)
- HTTP session server (Fastify-based REST API)
- Policy DSL with capabilities, limits, gates, evidence, forbidden patterns, session constraints, and remediation
- Built-in tool adapters: `file:read`, `file:write`, `command:run`, `http:request`, `git:diff`, `git:apply`
- CLI tooling: `init`, `validate`, `serve`, `proxy`, `exec`, `report` commands
- Agent integrations: Cursor, Codex, Claude Code, OpenClaw
- Built-in example policies: coding-agent, devops-deploy, video-upscaler
- JSON Schema generation for policy validation

---

