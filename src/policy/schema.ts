/**
 * Zod schemas for the Agent Policy YAML DSL.
 *
 * These schemas are the source of truth for policy validation.
 * They mirror (and enforce) the types defined in ../types.ts.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const ToolNameSchema = z.string().min(1).describe('Tool identifier, e.g. "file:read"');

export const ApprovalModeSchema = z.enum(['auto', 'human', 'webhook']);

export const RiskLevelSchema = z.enum(['low', 'medium', 'high', 'critical']);

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

export const CapabilityScopeSchema = z.object({
  paths: z.array(z.string()).optional(),
  binaries: z.array(z.string()).optional(),
  domains: z.array(z.string()).optional(),
  methods: z.array(z.string().toUpperCase()).optional(),
  repos: z.array(z.string()).optional(),
}).describe('Scope constraints for a capability');

export const CapabilitySchema = z.object({
  tool: ToolNameSchema,
  scope: CapabilityScopeSchema,
});

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export const GateSchema = z.object({
  action: ToolNameSchema,
  approval: ApprovalModeSchema,
  risk_level: RiskLevelSchema.optional(),
  condition: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const LimitsSchema = z.object({
  max_runtime_ms: z.number().positive().optional(),
  max_output_bytes: z.number().positive().optional(),
  max_files_changed: z.number().int().positive().optional(),
  max_retries: z.number().int().nonnegative().optional(),
  max_cost_usd: z.number().nonnegative().optional(),
}).describe('Budget / resource limits');

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export const EvidenceConfigSchema = z.object({
  require: z.array(z.string()).default([]),
  format: z.literal('jsonl').default('jsonl'),
});

// ---------------------------------------------------------------------------
// Forbidden
// ---------------------------------------------------------------------------

export const ForbiddenPatternSchema = z.object({
  pattern: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Remediation
// ---------------------------------------------------------------------------

export const RemediationRuleSchema = z.object({
  match: z.string().min(1),
  action: z.string().min(1),
});

export const RemediationSchema = z.object({
  rules: z.array(RemediationRuleSchema).default([]),
  fallback_chain: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Session Constraints
// ---------------------------------------------------------------------------

export const RateLimitSchema = z.object({
  max_per_minute: z.number().int().positive(),
});

export const EscalationRuleSchema = z.object({
  after_actions: z.number().int().positive().optional(),
  after_minutes: z.number().positive().optional(),
  require: z.enum(['human_checkin']),
});

export const SessionConstraintsSchema = z.object({
  /** Maximum actions per session */
  max_actions: z.number().int().positive().optional(),
  /** Terminate session after N denials */
  max_denials: z.number().int().positive().optional(),
  /** Rate limiting for actions */
  rate_limit: RateLimitSchema.optional(),
  /** Escalation rules based on thresholds */
  escalation: z.array(EscalationRuleSchema).optional(),
}).describe('Session-level constraints for the gateway model');

// ---------------------------------------------------------------------------
// Top-level Policy
// ---------------------------------------------------------------------------

export const PolicySchema = z.object({
  version: z.string().default('1.0'),
  name: z.string().min(1),
  description: z.string().optional(),
  capabilities: z.array(CapabilitySchema).min(1, 'At least one capability must be defined'),
  limits: LimitsSchema.default({}),
  gates: z.array(GateSchema).default([]),
  evidence: EvidenceConfigSchema.default({ require: [], format: 'jsonl' }),
  forbidden: z.array(ForbiddenPatternSchema).default([]),
  remediation: RemediationSchema.optional(),
  session: SessionConstraintsSchema.optional(),
});

export type PolicyInput = z.input<typeof PolicySchema>;
export type PolicyOutput = z.output<typeof PolicySchema>;
