/**
 * file:read — Scoped file read tool adapter.
 *
 * Reads file contents, enforcing path scope from the policy.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { minimatch } from 'minimatch';
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

export const FileReadInputSchema = z.object({
  path: z.string().min(1, 'File path is required'),
  encoding: z.enum(['utf-8', 'base64', 'hex']).default('utf-8'),
});

export type FileReadInput = z.infer<typeof FileReadInputSchema>;

export class FileReadAdapter extends ToolAdapter {
  readonly name = 'file:read';
  readonly description = 'Read the contents of a file within allowed path scopes';
  readonly inputSchema = FileReadInputSchema;

  validate(input: unknown, policy: Policy): ValidationResult {
    // Schema validation
    const parsed = FileReadInputSchema.safeParse(input);
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
    const { path: filePath } = input as FileReadInput;
    const absPath = path.resolve(filePath);
    const exists = fs.existsSync(absPath);

    return {
      tool: this.name,
      wouldDo: `Read file: ${absPath}`,
      estimatedChanges: [],
      warnings: exists ? [] : [`File does not exist: ${absPath}`],
    };
  }

  async execute(input: Record<string, unknown>, _ctx: ExecutionContext): Promise<ExecutionResult> {
    const start = Date.now();
    const { path: filePath, encoding } = input as FileReadInput;
    const absPath = path.resolve(filePath);

    try {
      const content = fs.readFileSync(absPath, encoding as BufferEncoding);
      const checksum = crypto.createHash('sha256').update(content).digest('hex');

      return this.success(
        { content, size: Buffer.byteLength(content), path: absPath },
        Date.now() - start,
        [
          { type: 'checksum', value: `sha256:${checksum}`, description: `Checksum of ${absPath}` },
        ],
      );
    } catch (err) {
      return this.failure((err as Error).message, Date.now() - start);
    }
  }

  async rollback(_input: Record<string, unknown>, _ctx: ExecutionContext): Promise<RollbackResult> {
    // file:read is side-effect-free — nothing to rollback
    return {
      tool: this.name,
      success: true,
      description: 'No rollback needed for read-only operation',
    };
  }
}
