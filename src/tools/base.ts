/**
 * Tool Adapter Base — the contract that every tool must implement.
 *
 * The runtime NEVER calls execute() directly. It always goes through:
 *   validate → dryRun → (gate check) → execute → verify
 *
 * Each step is recorded in the evidence ledger.
 */

import { z } from 'zod';
import type {
  ActionRequest,
  DryRunResult,
  ExecutionContext,
  ExecutionResult,
  Policy,
  RollbackResult,
  ValidationResult,
} from '../types.js';

export abstract class ToolAdapter {
  /** Unique tool identifier, e.g. "file:read" */
  abstract readonly name: string;

  /** Human-readable description */
  abstract readonly description: string;

  /** Zod schema for validating tool-specific input */
  abstract readonly inputSchema: z.ZodType;

  /**
   * Validate the input against the schema and the policy.
   * Returns allow/deny/gate verdict.
   */
  abstract validate(input: unknown, policy: Policy): ValidationResult;

  /**
   * Preview what the tool would do without making any changes.
   * Must be side-effect-free.
   */
  abstract dryRun(input: Record<string, unknown>, ctx: ExecutionContext): Promise<DryRunResult>;

  /**
   * Execute the action for real.
   * Must capture artifacts (diffs, checksums, logs) as evidence.
   * Must store rollback data in ctx.rollbackData if the action is reversible.
   */
  abstract execute(input: Record<string, unknown>, ctx: ExecutionContext): Promise<ExecutionResult>;

  /**
   * Undo the action. Called during rollback if the action was executed.
   * Should use ctx.rollbackData stored during execute().
   */
  abstract rollback(input: Record<string, unknown>, ctx: ExecutionContext): Promise<RollbackResult>;

  /**
   * Generate a deterministic idempotency key for this action + input.
   * Used to detect duplicate calls.
   */
  idempotencyKey(input: Record<string, unknown>): string {
    return `${this.name}:${JSON.stringify(input, Object.keys(input).sort())}`;
  }

  /**
   * Parse and validate the raw input against this tool's schema.
   * Returns the parsed input or throws.
   */
  parseInput(raw: unknown): Record<string, unknown> {
    return this.inputSchema.parse(raw) as Record<string, unknown>;
  }

  /**
   * Helper to create a successful execution result.
   */
  protected success(
    output: unknown,
    durationMs: number,
    artifacts: ExecutionResult['artifacts'] = [],
  ): ExecutionResult {
    return {
      tool: this.name,
      success: true,
      output,
      artifacts,
      durationMs,
    };
  }

  /**
   * Helper to create a failed execution result.
   */
  protected failure(error: string, durationMs: number): ExecutionResult {
    return {
      tool: this.name,
      success: false,
      error,
      durationMs,
    };
  }
}
