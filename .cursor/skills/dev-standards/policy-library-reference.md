# Built-in Policy Library Reference

Detailed reference for the `examples/` policy library. The main skill file ([SKILL.md](SKILL.md)) links here for policy-specific guidance.

## Current Coverage

| Policy | File | Use Case |
|--------|------|----------|
| Coding Agent | `coding-agent.policy.yaml` | AI coding agents (Cursor, Claude Code, Codex) operating on a project |
| DevOps Deploy | `devops-deploy.policy.yaml` | Deployment agents that build, test, and deploy application code |
| Video Upscaler | `video-upscaler.policy.yaml` | Media processing agents running upscaling/transcoding pipelines |

## Target Policies (Priority Order)

Expand the library to cover these major industry use cases. Each policy must be **production-ready** -- usable out of the box without modification for its target scenario.

### Tier 1 -- High Priority (common agent use cases)

| Policy | File | Description |
|--------|------|-------------|
| Data Analysis Agent | `data-analysis.policy.yaml` | Jupyter/pandas/SQL workflows. Read-only DB access, scoped file output to `./output/**` and `./notebooks/**`, no credential access, gate on external data exports |
| QA/Testing Agent | `qa-testing.policy.yaml` | Test writing and execution. Read source dirs, write to `./tests/**` only, run test/lint commands, forbidden: production API calls, deployment commands |
| API Development Agent | `api-dev.policy.yaml` | Backend API development. Scoped to API source dirs, allowed test/lint/build commands, forbidden: production endpoints, secret exposure, database drops |
| Security Audit Agent | `security-audit.policy.yaml` | SAST/DAST/dependency scanning. Read-only source access, scoped report output to `./reports/**`, forbidden: data exfiltration patterns, outbound network to non-scan domains |

### Tier 2 -- Medium Priority (specialized workflows)

| Policy | File | Description |
|--------|------|-------------|
| Database Admin Agent | `database-admin.policy.yaml` | Migrations, backups, queries. Gate all DDL operations, human approval for schema changes, forbidden: `DROP DATABASE`, `TRUNCATE` without WHERE, production connection strings in logs |
| Infrastructure-as-Code Agent | `iac-agent.policy.yaml` | Terraform/CloudFormation/Pulumi. Gate all `apply`/`destroy`, read-only `plan` by default, forbidden: wildcard IAM policies, public S3 buckets, hardcoded secrets in state |
| CI/CD Pipeline Agent | `ci-cd-pipeline.policy.yaml` | GitHub Actions/Jenkins workflows. Scoped to `.github/workflows/**` and pipeline configs, gate deployments to production, forbidden: secret printing, force push, branch deletion |
| ML Training Agent | `ml-training.policy.yaml` | Model training/fine-tuning. Scoped to `./data/**` and `./models/**`, GPU command allow-list (python, nvidia-smi, torchrun), resource limits, forbidden: data exfiltration |

### Tier 3 -- Extended Coverage

| Policy | File | Description |
|--------|------|-------------|
| Content Generation Agent | `content-generation.policy.yaml` | Writing/docs/marketing. File write to `./content/**` and `./docs/**` only, no code execution, no network access, forbidden: PII patterns |
| Research/Browsing Agent | `research-browsing.policy.yaml` | Web research. HTTP GET only to allow-listed domains, file writes only to `./research-output/**`, no code execution, rate-limited requests |
| Compliance/Audit Agent | `compliance-audit.policy.yaml` | SOC2/HIPAA/GDPR scanning. Strictly read-only, no writes, no execution, evidence: full audit trail with checksums, scoped to project dirs |
| Customer Support Agent | `customer-support.policy.yaml` | Ticket triage/response. Read-only knowledge base access, scoped API access to ticketing system, forbidden: PII export, account deletion, billing changes |

## Quality Checklist

Every policy in `examples/` MUST pass this checklist before merge:

### Structure
- [ ] Has `version: "1.0"` at top
- [ ] Has descriptive `name` (kebab-case, matches filename without extension)
- [ ] Has `description` explaining the use case in one sentence
- [ ] Has 2-3 line YAML comment header explaining who this policy is for

### Capabilities
- [ ] All allowed tools are explicitly listed with scoped paths/binaries/domains
- [ ] Scopes use realistic, representative paths (not `/tmp/test` or `TODO`)
- [ ] No overly broad scopes (e.g., `/**` or `*` without justification)

### Limits
- [ ] `max_runtime_ms` set (appropriate to use case)
- [ ] `max_files_changed` set
- [ ] `max_output_bytes` set
- [ ] `max_cost_usd` set (where applicable)
- [ ] `max_retries` set

### Gates
- [ ] All destructive actions (delete, deploy, schema change) require `approval: "human"`
- [ ] Risk levels assigned: `low`, `medium`, `high`, `critical`
- [ ] Out-of-scope actions gated (not silently allowed)

### Evidence
- [ ] `require` includes at minimum: `checksums`, `diffs`
- [ ] `format: "jsonl"` specified
- [ ] Domain-specific evidence types added where relevant (exit_codes, logs)

### Forbidden Patterns
- [ ] `**/.env` and `**/.env.*` included
- [ ] `**/credentials*` and `**/secrets*` included
- [ ] Domain-specific dangerous commands included (e.g., `rm -rf /`, `DROP DATABASE`)
- [ ] No overly broad patterns that would block legitimate use

### Session
- [ ] `max_actions` set (proportional to use case complexity)
- [ ] `max_denials` set
- [ ] `rate_limit.max_per_minute` set
- [ ] At least one `escalation` rule defined (after_actions or after_minutes)

### Remediation
- [ ] At least 2 domain-specific error patterns with actions
- [ ] `fallback_chain` defined
- [ ] Actions are one of: `retry`, `skip`, `abort`, or `fallback:<name>`

## YAML Template

Use this template when creating a new policy:

```yaml
# <Policy Display Name>
# <One sentence: who this is for and what it constrains>
# <One sentence: key security boundaries>

version: "1.0"
name: "<kebab-case-name>"
description: "<One sentence description matching the header>"

capabilities:
  - tool: "file:read"
    scope:
      paths:
        - "<scoped read paths>"

  - tool: "file:write"
    scope:
      paths:
        - "<scoped write paths>"

  - tool: "command:run"
    scope:
      binaries:
        - "<allowed binaries>"

  # Add http:request, git:diff, git:apply as needed
  # - tool: "http:request"
  #   scope:
  #     domains: ["<allowed domains>"]
  #     methods: ["GET", "POST"]

limits:
  max_runtime_ms: 1800000       # 30 minutes (adjust per use case)
  max_files_changed: 50
  max_output_bytes: 10485760    # 10 MB (adjust per use case)
  max_retries: 3
  max_cost_usd: 5.0

gates:
  - action: "<destructive-action>"
    approval: "human"
    risk_level: "high"

  - action: "command:run"
    approval: "human"
    risk_level: "high"
    condition: "outside_scope"

evidence:
  require:
    - "checksums"
    - "diffs"
  format: "jsonl"

forbidden:
  - pattern: "**/.env"
  - pattern: "**/.env.*"
  - pattern: "**/credentials*"
  - pattern: "**/secrets*"
  # Add domain-specific forbidden patterns below

session:
  max_actions: 100
  max_denials: 10
  rate_limit:
    max_per_minute: 30
  escalation:
    - after_actions: 50
      require: human_checkin
    - after_minutes: 15
      require: human_checkin

remediation:
  rules:
    - match: "<domain-specific-error-1>"
      action: "retry"
    - match: "<domain-specific-error-2>"
      action: "abort"
  fallback_chain: ["retry", "skip", "abort"]
```

## New Policy Workflow

1. **Identify** the use case and target persona (who will use this policy?)
2. **Research** industry standards and compliance requirements for the domain
3. **Draft** the policy using the YAML template above
4. **Fill** all sections -- leave nothing as placeholder or TODO
5. **Review** against the quality checklist above (every box must be checked)
6. **Test** the policy by loading it with `npx det-acp validate <policy-file>`
7. **Add** the policy to `examples/`
8. **Document** in root `README.md` under the built-in policies table
9. **Add** release notes entry under "Added"
10. **Generate** commit message: `feat(examples): add <name> built-in policy`

## Policy Naming Convention

- File: `<kebab-case-use-case>.policy.yaml` (e.g., `data-analysis.policy.yaml`)
- Name field: matches filename without `.policy.yaml` (e.g., `data-analysis`)
- Description: one sentence, starts with "Policy for..." (e.g., "Policy for data analysis agents working with Jupyter notebooks and SQL databases")
