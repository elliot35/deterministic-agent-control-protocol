---
name: dev-standards
description: Enforces development workflows, quality gates, coding standards, and release processes for the deterministic-agent-control-protocol project. Use when implementing features, fixing bugs, refactoring architecture, adding integrations, updating policies, writing tests, updating documentation, or preparing releases.
---

# Development Standards

This skill defines the mandatory workflows, quality gates, and coding standards for all changes to the deterministic-agent-control-protocol project.

## Change Type Classification

Before starting work, classify the change:

| Type | Unit Tests | README Update | Architecture Diagrams | Release Notes | PR Required |
|------|-----------|---------------|----------------------|---------------|-------------|
| New Feature | Required (must pass) | Yes | If related | Yes | No |
| Bug Fix | Required (cover the bug) | No | No | Yes | No |
| Re-architecture | Required (all affected) | Yes (full update) | Yes (mandatory) | Yes (full detail) | Yes (mandatory) |
| New Integration | Follow integration pattern | Yes (root + dedicated) | If related | Yes | No |
| New Policy | N/A | Yes (built-in policies section) | No | Yes | No |

## Workflow Checklists

### New Feature

```
Task Progress:
- [ ] 1. Create/update source files in src/
- [ ] 2. Add unit tests in tests/ mirroring src/ structure
         (e.g., src/engine/foo.ts -> tests/engine/foo.test.ts)
- [ ] 3. Run `npm test` -- ALL tests must pass
- [ ] 4. Run `npm run lint` -- no type errors
- [ ] 5. Update README.md (feature description, usage, new CLI commands/API methods)
- [ ] 6. Update Mermaid diagrams in README.md if architecture or data flow changed
- [ ] 7. Add entry to RELEASE_NOTES.md under current unreleased version
- [ ] 8. Run impact check on examples/ and integrations/
- [ ] 9. Generate commit message
```

### Bug Fix

```
Task Progress:
- [ ] 1. Write a FAILING unit test that reproduces the bug
- [ ] 2. Fix the bug in source code
- [ ] 3. Run `npm test` -- confirm the new test passes with all existing tests
- [ ] 4. Run `npm run lint` -- no type errors
- [ ] 5. Add entry to RELEASE_NOTES.md (Fixed section)
- [ ] 6. NO README update needed (unless bug was in documented behavior)
- [ ] 7. Run impact check on examples/ and integrations/
- [ ] 8. Generate commit message
```

### Re-architecture

```
Task Progress:
- [ ] 1. Document current design (reference existing Mermaid diagrams in README.md)
- [ ] 2. Propose new design with updated Mermaid diagrams
- [ ] 3. Implement changes incrementally
- [ ] 4. Update all affected unit tests; add new ones for new components
- [ ] 5. Run `npm test` -- ALL tests must pass
- [ ] 6. Run `npm run lint` -- no type errors
- [ ] 7. Update README.md architecture section, component diagram, and data flow diagram
- [ ] 8. Write detailed RELEASE_NOTES.md entry (what changed, why, before/after, benefits)
- [ ] 9. Run impact check on examples/ and integrations/
- [ ] 10. Create PR with body covering:
          - Previous design summary
          - New design summary
          - Rationale for the change
          - Migration notes (if any)
          - Benefits
          - How it differs from the previous design
```

### New Integration / Agent Support

```
Task Progress:
- [ ] 1. Create integrations/<agent-name>/ directory with:
         - README.md (follow integrations/cursor/README.md structure)
         - policy.yaml
         - Config templates (MCP config, governance rules, etc.)
         - test-sandbox/hello.txt
- [ ] 2. Integration README must include:
         - Architecture diagram (ASCII or Mermaid)
         - Governance model (Soft / Semi-Hard / Hard)
         - Quick setup (npx det-acp init <name>) + manual setup in <details>
         - Quick test section with expected results table
         - Files table listing every file in the folder
- [ ] 3. Update root README.md agent integrations table
- [ ] 4. Add example policy in examples/ if new use case
- [ ] 5. Add release notes entry
- [ ] 6. Generate commit message
```

### New Built-in Policy

```
Task Progress:
- [ ] 1. Identify use case and target persona
- [ ] 2. Research industry standards for the domain
- [ ] 3. Draft policy with ALL required sections (see policy-library-reference.md)
- [ ] 4. Review against quality checklist in policy-library-reference.md
- [ ] 5. Add policy to examples/
- [ ] 6. Update README.md built-in policies section
- [ ] 7. Add release notes entry
- [ ] 8. Generate commit message
```

### Source Code Impact Check

After ANY source code change, run this check:

1. Search `examples/` and `integrations/` for references to changed types, tools, config keys, or API methods
2. Update any affected policy files or config templates
3. Update any affected integration READMEs if API/CLI usage changed
4. Verify all example policies still conform to the current schema

## Commit Message Convention

Follow Conventional Commits:

```
<type>(<scope>): <short summary>

<optional body with details>
```

**Types**: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`, `ci`

**Scopes**: `engine`, `policy`, `ledger`, `proxy`, `tools`, `cli`, `server`, `rollback`, `integration/<name>`, `examples`

**Examples**:

```
feat(engine): add rate limiting per tool type

Add per-tool rate limits to PolicyEvaluator, enabling fine-grained
throttling beyond the session-level max_per_minute.
```

```
fix(ledger): correct hash chain validation on empty sessions

The integrity check threw on sessions with zero actions. Now returns
valid for empty ledgers with only start/terminate entries.
```

## Version Control and Release Notes

- **Semver**: MAJOR (breaking/re-architecture), MINOR (new features/integrations), PATCH (bug fixes)
- **RELEASE_NOTES.md** at project root with sections: Added, Changed, Fixed, Breaking Changes
- Version in `package.json` must match the latest release notes version
- If `RELEASE_NOTES.md` does not exist, create it using this structure:

```markdown
# Release Notes

## [Unreleased]

### Added
### Changed
### Fixed
### Breaking Changes

## [0.2.0] - YYYY-MM-DD
(initial tracked release)
```

## Testing Standards

- **Framework**: Vitest (configured in `vitest.config.ts`)
- **Structure**: test files mirror `src/` under `tests/` with `.test.ts` suffix
- **Coverage**: every public function/class must have corresponding tests
- **Determinism**: no reliance on external services, network calls, or timing
- **Commands**: `npm test` (run all), `npm run test:watch` (watch mode)
- **Type safety**: `npm run lint` (TypeScript strict type check)
- All tests must pass before any commit

## Coding Standards

- **TypeScript strict mode** -- `"strict": true` in tsconfig.json; no `any` types unless explicitly justified with a comment
- **ESM modules** -- project is `"type": "module"`; use `import`/`export`, never `require()`
- **Zod for validation** -- all external input schemas use Zod (pattern in `src/policy/schema.ts`)
- **Error handling** -- use typed errors; never swallow exceptions silently; always log or propagate
- **Naming conventions**:
  - PascalCase: classes, types, interfaces (e.g., `AgentGateway`, `PolicyEvaluator`)
  - camelCase: functions, variables, methods (e.g., `evaluateAction`, `sessionId`)
  - kebab-case: file names (e.g., `action-registry.ts`, `mcp-proxy.ts`)
- **Single responsibility** -- each file exports one primary class/function; keep files focused
- **No secrets in code** -- never hardcode API keys, tokens, or credentials; use environment variables
- **Imports** -- group imports: external packages first, then internal modules, separated by blank line

## Architecture Standards

- **Layer separation**: Integration Layer -> Core Engine -> Infrastructure (see README Mermaid diagram)
- **New components** must fit into the existing layer model; if they don't, propose a re-architecture
- **Tool adapters** extend `ToolAdapter` base class in `src/tools/base.ts`
- **Policy evaluation** always goes through `PolicyEvaluator` -- never bypass it for governance decisions
- **Session management** goes through `SessionManager` -- never manipulate session state directly
- **Ledger writes** go through `EvidenceLedger` -- never write audit records directly to disk

## Security Standards

- All file operations must respect policy scopes (path glob patterns)
- Forbidden patterns in policies must be checked before any action execution
- Evidence ledger integrity (SHA-256 hash chain) must never be compromised
- **No dynamic code execution**: no `eval()`, `Function()`, or dynamic `import()` from user input
- **Dependency hygiene**: prefer well-maintained packages with minimal transitive dependencies; audit with `npm audit`
- **Input validation**: all public API surfaces validate input using Zod schemas before processing
- **No credential leakage**: never log, return, or store credentials, tokens, or secrets in evidence records
- **Path traversal prevention**: all file paths must be resolved and validated against allowed scopes before access

## Iterative Solution Design

When implementing any change, follow this iterative approach. Do NOT jump straight to coding.

1. **Understand** -- read existing code, tests, and related documentation before making changes
2. **Propose** -- outline the approach; consider at least 2 alternatives for non-trivial changes
3. **Evaluate** -- compare alternatives on: simplicity, security, performance, consistency with existing patterns
4. **Implement** -- make focused, minimal changes; prefer small incremental steps over large rewrites
5. **Validate** -- run tests (`npm test`) and type check (`npm run lint`) after each meaningful change
6. **Review** -- check for edge cases, security implications, and consistency with existing patterns
7. **Refine** -- if issues found, iterate from step 1 rather than patching over problems

For complex changes, prefer multiple small PRs over one large PR.

## Root README Standards

The root `README.md` must follow this open-source-ready structure:

### Header (top of file)
- H1 project title
- Shield badges (shields.io): Stars, Forks, Contributors, License, npm version, language badges
- GitHub repo path for badges: `elliot35/deterministic-agent-control-protocol`
- One-line highlight summary
- Short project tagline

### Badge template

```markdown
[![Stars](https://img.shields.io/github/stars/elliot35/deterministic-agent-control-protocol?style=flat)](https://github.com/elliot35/deterministic-agent-control-protocol/stargazers)
[![Forks](https://img.shields.io/github/forks/elliot35/deterministic-agent-control-protocol?style=flat)](https://github.com/elliot35/deterministic-agent-control-protocol/network/members)
[![Contributors](https://img.shields.io/github/contributors/elliot35/deterministic-agent-control-protocol?style=flat)](https://github.com/elliot35/deterministic-agent-control-protocol/graphs/contributors)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/deterministic-agent-control-protocol)](https://www.npmjs.com/package/deterministic-agent-control-protocol)
![TypeScript](https://img.shields.io/badge/-TypeScript-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/-Node.js-339933?logo=node.js&logoColor=white)
```

### Visual demos
- Hero screenshot or GIF demonstrating governance flow (evaluate, deny, gate)
- Use collapsible `<details>` sections for longer demos

### Required sections (in order)
1. Badges + tagline
2. How It Works (brief, with Mermaid diagram)
3. Core Principles
4. Quick Start (install, init, basic usage)
5. Agent Integrations (table with links)
6. Built-in Policies (table linking to examples/)
7. Other Integration Modes (MCP Proxy, Shell Proxy, HTTP API, CLI)
8. Architecture (Mermaid component diagram + sequence diagram)
9. Policy DSL reference
10. Built-in Tool Adapters (table)
11. Custom Tool Adapters (code example)
12. Development (build, test, lint)
13. Contributing
14. License

### Mermaid diagram standards
- All architecture diagrams use Mermaid (renders natively on GitHub)
- Component architecture: show all layers (Integration, Core Engine, Infrastructure, Tool Adapters)
- Action evaluation flow: sequence diagram showing full request lifecycle
- Keep diagrams current -- any structural change to `src/` must be reflected
- Use clear, descriptive node labels (not abbreviations)
- Do NOT use inline styles or colors -- let GitHub theme handle rendering

### Integration README standards
Each `integrations/<name>/README.md` must include:
- Architecture diagram (ASCII or Mermaid)
- Governance model explanation (Soft / Semi-Hard / Hard)
- Quick setup (`npx det-acp init <name>`) + manual setup in `<details>`
- Quick test section with expected results table
- Files table listing every file in the folder

## Built-in Policy Library

The `examples/` folder is the built-in policy library -- production-ready policies users can adopt out of the box. For detailed standards, target policy list, quality checklist, and YAML template, see [policy-library-reference.md](policy-library-reference.md).

Key rules:
- Every policy must have ALL sections: version, name, description, capabilities, limits, gates, evidence, forbidden, session, remediation
- Security-first: always include forbidden patterns for .env, credentials, secrets, and domain-specific dangerous commands
- Human gates on all destructive actions (delete, deploy, production modify)
- Escalation rules and rate limiting are mandatory
- Continuously expand coverage for new industry use cases
