/**
 * file:move — Scoped file move/rename tool adapter.
 *
 * Moves or renames files within allowed path scopes.
 * Both source and destination must be within policy scope.
 * Full rollback support: moves the file back to original location.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { ToolAdapter } from './base.js';
import { evaluateAction } from '../policy/evaluator.js';
import type {
  DryRunResult,
  ExecutionContext,
  ExecutionResult,
  ExecutionArtifact,
  Policy,
  RollbackResult,
  ValidationResult,
} from '../types.js';

export const FileMoveInputSchema = z.object({
  source: z.string().min(1, 'Source path is required'),
  destination: z.string().min(1, 'Destination path is required'),
  /** Overwrite destination if it exists */
  overwrite: z.boolean().default(false),
});

export type FileMoveInput = z.infer<typeof FileMoveInputSchema>;

export class FileMoveAdapter extends ToolAdapter {
  readonly name = 'file:move';
  readonly description = 'Move or rename a file within allowed path scopes';
  readonly inputSchema = FileMoveInputSchema;

  validate(input: unknown, policy: Policy): ValidationResult {
    const parsed = FileMoveInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        verdict: 'deny',
        tool: this.name,
        reasons: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      };
    }

    // Validate both source and destination paths against the policy
    const sourceResult = evaluateAction(
      { tool: this.name, input: { ...parsed.data, path: parsed.data.source } },
      policy,
    );
    if (sourceResult.verdict === 'deny') {
      return {
        ...sourceResult,
        reasons: sourceResult.reasons.map((r) => `Source: ${r}`),
      };
    }

    const destResult = evaluateAction(
      { tool: this.name, input: { ...parsed.data, path: parsed.data.destination } },
      policy,
    );
    if (destResult.verdict === 'deny') {
      return {
        ...destResult,
        reasons: destResult.reasons.map((r) => `Destination: ${r}`),
      };
    }

    // Return the more restrictive result (gate > allow)
    if (sourceResult.verdict === 'gate' || destResult.verdict === 'gate') {
      return sourceResult.verdict === 'gate' ? sourceResult : destResult;
    }

    return sourceResult;
  }

  async dryRun(input: Record<string, unknown>, _ctx: ExecutionContext): Promise<DryRunResult> {
    const { source, destination, overwrite } = input as FileMoveInput;
    const absSrc = path.resolve(source);
    const absDest = path.resolve(destination);
    const warnings: string[] = [];

    if (!fs.existsSync(absSrc)) {
      warnings.push(`Source file does not exist: ${absSrc}`);
    }

    if (fs.existsSync(absDest) && !overwrite) {
      warnings.push(`Destination already exists and overwrite is false: ${absDest}`);
    }

    const destDir = path.dirname(absDest);
    if (!fs.existsSync(destDir)) {
      warnings.push(`Destination directory does not exist: ${destDir}`);
    }

    return {
      tool: this.name,
      wouldDo: `Move ${absSrc} → ${absDest}`,
      estimatedChanges: [absSrc, absDest],
      warnings,
    };
  }

  async execute(input: Record<string, unknown>, ctx: ExecutionContext): Promise<ExecutionResult> {
    const start = Date.now();
    const { source, destination, overwrite } = input as FileMoveInput;
    const absSrc = path.resolve(source);
    const absDest = path.resolve(destination);
    const artifacts: ExecutionArtifact[] = [];

    try {
      // Check source exists
      if (!fs.existsSync(absSrc)) {
        return this.failure(`Source file does not exist: ${absSrc}`, Date.now() - start);
      }

      // Check destination doesn't exist (unless overwrite)
      let destExisted = false;
      let destPreviousContent: string | null = null;
      if (fs.existsSync(absDest)) {
        if (!overwrite) {
          return this.failure(
            `Destination already exists: ${absDest}. Set overwrite: true to replace.`,
            Date.now() - start,
          );
        }
        destExisted = true;
        destPreviousContent = fs.readFileSync(absDest, 'base64');
      }

      // Checksum source before move
      const srcContent = fs.readFileSync(absSrc);
      const srcChecksum = crypto.createHash('sha256').update(srcContent).digest('hex');

      artifacts.push({
        type: 'checksum',
        value: `sha256:${srcChecksum}`,
        description: `Checksum of moved file (source: ${absSrc})`,
      });

      artifacts.push({
        type: 'log',
        value: `Moved: ${absSrc} → ${absDest}`,
        description: 'Move record',
      });

      // Store rollback data
      const rollbackKey = `file:move:${absSrc}:${absDest}`;
      ctx.rollbackData[rollbackKey] = {
        source: absSrc,
        destination: absDest,
        destExisted,
        destPreviousContent,
      };

      // Execute the move
      fs.renameSync(absSrc, absDest);

      ctx.budget.filesChanged++;

      return this.success(
        { source: absSrc, destination: absDest, size: srcContent.length },
        Date.now() - start,
        artifacts,
      );
    } catch (err) {
      return this.failure((err as Error).message, Date.now() - start);
    }
  }

  async rollback(input: Record<string, unknown>, ctx: ExecutionContext): Promise<RollbackResult> {
    const { source, destination } = input as FileMoveInput;
    const absSrc = path.resolve(source);
    const absDest = path.resolve(destination);
    const rollbackKey = `file:move:${absSrc}:${absDest}`;
    const rollbackData = ctx.rollbackData[rollbackKey] as {
      source: string;
      destination: string;
      destExisted: boolean;
      destPreviousContent: string | null;
    } | undefined;

    if (!rollbackData) {
      return {
        tool: this.name,
        success: false,
        description: 'No rollback data available',
        error: 'Rollback data not found — execute() may not have been called',
      };
    }

    try {
      // Move file back to original location
      if (fs.existsSync(rollbackData.destination)) {
        fs.renameSync(rollbackData.destination, rollbackData.source);
      }

      // Restore overwritten destination if applicable
      if (rollbackData.destExisted && rollbackData.destPreviousContent !== null) {
        const content = Buffer.from(rollbackData.destPreviousContent, 'base64');
        fs.writeFileSync(rollbackData.destination, content);
      }

      return {
        tool: this.name,
        success: true,
        description: `Moved ${rollbackData.destination} back to ${rollbackData.source}`,
      };
    } catch (err) {
      return {
        tool: this.name,
        success: false,
        description: `Failed to rollback file move`,
        error: (err as Error).message,
      };
    }
  }
}
