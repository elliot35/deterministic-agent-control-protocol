# Release Notes

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Development standards skill (`.cursor/skills/dev-standards/`) defining workflow checklists, coding standards, security standards, commit conventions, README standards, and iterative design principles
- Built-in policy library reference with quality checklist, YAML template, and target policy roadmap
- This release notes file

### Changed

### Fixed

### Breaking Changes

---

## [0.2.0] - 2025-06-01

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
