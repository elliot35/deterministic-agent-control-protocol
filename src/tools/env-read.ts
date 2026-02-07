/**
 * env:read — Governed environment variable read tool adapter.
 *
 * Reads environment variables with strict allow-listing.
 * Policy controls which environment variable names/prefixes are accessible.
 * Automatically redacts sensitive values in evidence records.
 *
 * This tool NEVER exposes .env file contents — only process.env values.
 * Sensitive variable names (matching configurable patterns) are hashed, not logged.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { ToolAdapter } from './base.js';
import { evaluateAction } from '../policy/evaluator.js';
import type {
  DryRunResult,
  ExecutionContext,
  ExecutionResult,
  Policy,
  RollbackResult,
  ValidationResult,
} from '../types.js';

export const EnvReadInputSchema = z.object({
  /** The environment variable name to read */
  name: z.string().min(1, 'Environment variable name is required'),
  /** If true, hash the value in evidence instead of logging it */
  redact: z.boolean().default(false),
});

export type EnvReadInput = z.infer<typeof EnvReadInputSchema>;

/**
 * Patterns that indicate a sensitive environment variable.
 * Values of these variables are always hashed in evidence, never logged plaintext.
 */
const SENSITIVE_PATTERNS = [
  /key/i,
  /secret/i,
  /token/i,
  /password/i,
  /credential/i,
  /auth/i,
  /private/i,
  /api_key/i,
  /apikey/i,
  /access_key/i,
];

function isSensitive(name: string): boolean {
  return SENSITIVE_PATTERNS.some((p) => p.test(name));
}

export class EnvReadAdapter extends ToolAdapter {
  readonly name = 'env:read';
  readonly description = 'Read an environment variable (with allow-listing and redaction)';
  readonly inputSchema = EnvReadInputSchema;

  validate(input: unknown, policy: Policy): ValidationResult {
    const parsed = EnvReadInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        verdict: 'deny',
        tool: this.name,
        reasons: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      };
    }

    return evaluateAction(
      { tool: this.name, input: parsed.data },
      policy,
    );
  }

  async dryRun(input: Record<string, unknown>, _ctx: ExecutionContext): Promise<DryRunResult> {
    const { name } = input as EnvReadInput;
    const exists = name in process.env;
    const sensitive = isSensitive(name);

    return {
      tool: this.name,
      wouldDo: `Read environment variable: ${name}${sensitive ? ' (value will be redacted)' : ''}`,
      estimatedChanges: [],
      warnings: [
        ...(!exists ? [`Environment variable not set: ${name}`] : []),
        ...(sensitive ? [`Variable "${name}" matches sensitive pattern — value will be hashed in evidence`] : []),
      ],
    };
  }

  async execute(input: Record<string, unknown>, _ctx: ExecutionContext): Promise<ExecutionResult> {
    const start = Date.now();
    const { name, redact } = input as EnvReadInput;

    try {
      const value = process.env[name];

      if (value === undefined) {
        return this.failure(`Environment variable not set: ${name}`, Date.now() - start);
      }

      const shouldRedact = redact || isSensitive(name);
      const evidenceValue = shouldRedact
        ? `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`
        : value;

      return this.success(
        { name, value, exists: true },
        Date.now() - start,
        [
          {
            type: 'log',
            value: shouldRedact
              ? `env:${name} = [REDACTED] (hash: ${evidenceValue})`
              : `env:${name} = ${value.slice(0, 256)}${value.length > 256 ? '...' : ''}`,
            description: `Environment variable read${shouldRedact ? ' (redacted)' : ''}`,
          },
          {
            type: 'checksum',
            value: `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`,
            description: `Value hash for ${name}`,
          },
        ],
      );
    } catch (err) {
      return this.failure((err as Error).message, Date.now() - start);
    }
  }

  async rollback(_input: Record<string, unknown>, _ctx: ExecutionContext): Promise<RollbackResult> {
    return {
      tool: this.name,
      success: true,
      description: 'No rollback needed for read-only environment variable access',
    };
  }
}
