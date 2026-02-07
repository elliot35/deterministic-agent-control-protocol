/**
 * file:copy — Scoped file copy tool adapter.
 *
 * Copies files within allowed path scopes.
 * Both source and destination must be within policy scope.
 * Rollback support: removes the copied file (or restores overwritten content).
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

export const FileCopyInputSchema = z.object({
  source: z.string().min(1, 'Source path is required'),
  destination: z.string().min(1, 'Destination path is required'),
  /** Overwrite destination if it exists */
  overwrite: z.boolean().default(false),
});

export type FileCopyInput = z.infer<typeof FileCopyInputSchema>;

export class FileCopyAdapter extends ToolAdapter {
  readonly name = 'file:copy';
  readonly description = 'Copy a file within allowed path scopes';
  readonly inputSchema = FileCopyInputSchema;

  validate(input: unknown, policy: Policy): ValidationResult {
    const parsed = FileCopyInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        verdict: 'deny',
        tool: this.name,
        reasons: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      };
    }

    // Source must be readable
    const sourceResult = evaluateAction(
      { tool: 'file:read', input: { path: parsed.data.source } },
      policy,
    );
    if (sourceResult.verdict === 'deny') {
      return {
        verdict: 'deny',
        tool: this.name,
        reasons: sourceResult.reasons.map((r) => `Source: ${r}`),
      };
    }

    // Destination must be writable
    const destResult = evaluateAction(
      { tool: 'file:write', input: { path: parsed.data.destination, content: '' } },
      policy,
    );
    if (destResult.verdict === 'deny') {
      return {
        verdict: 'deny',
        tool: this.name,
        reasons: destResult.reasons.map((r) => `Destination: ${r}`),
      };
    }

    // Evaluate the copy action itself for gate checks
    return evaluateAction(
      { tool: this.name, input: parsed.data },
      policy,
    );
  }

  async dryRun(input: Record<string, unknown>, _ctx: ExecutionContext): Promise<DryRunResult> {
    const { source, destination, overwrite } = input as FileCopyInput;
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
      wouldDo: `Copy ${absSrc} → ${absDest}`,
      estimatedChanges: [absDest],
      warnings,
    };
  }

  async execute(input: Record<string, unknown>, ctx: ExecutionContext): Promise<ExecutionResult> {
    const start = Date.now();
    const { source, destination, overwrite } = input as FileCopyInput;
    const absSrc = path.resolve(source);
    const absDest = path.resolve(destination);
    const artifacts: ExecutionArtifact[] = [];

    try {
      if (!fs.existsSync(absSrc)) {
        return this.failure(`Source file does not exist: ${absSrc}`, Date.now() - start);
      }

      // Check destination
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

      // Read source and compute checksum
      const srcContent = fs.readFileSync(absSrc);
      const srcChecksum = crypto.createHash('sha256').update(srcContent).digest('hex');

      artifacts.push({
        type: 'checksum',
        value: `sha256:${srcChecksum}`,
        description: `Checksum of copied file`,
      });

      artifacts.push({
        type: 'log',
        value: `Copied: ${absSrc} → ${absDest} (${srcContent.length} bytes)`,
        description: 'Copy record',
      });

      // Store rollback data
      const rollbackKey = `file:copy:${absSrc}:${absDest}`;
      ctx.rollbackData[rollbackKey] = {
        destination: absDest,
        destExisted,
        destPreviousContent,
      };

      // Execute the copy
      fs.copyFileSync(absSrc, absDest);

      ctx.budget.filesChanged++;
      ctx.budget.totalOutputBytes += srcContent.length;

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
    const { source, destination } = input as FileCopyInput;
    const absSrc = path.resolve(source);
    const absDest = path.resolve(destination);
    const rollbackKey = `file:copy:${absSrc}:${absDest}`;
    const rollbackData = ctx.rollbackData[rollbackKey] as {
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
      if (rollbackData.destExisted && rollbackData.destPreviousContent !== null) {
        // Restore overwritten destination
        const content = Buffer.from(rollbackData.destPreviousContent, 'base64');
        fs.writeFileSync(rollbackData.destination, content);
      } else {
        // Remove the copied file
        if (fs.existsSync(rollbackData.destination)) {
          fs.unlinkSync(rollbackData.destination);
        }
      }

      return {
        tool: this.name,
        success: true,
        description: rollbackData.destExisted
          ? `Restored original content at ${rollbackData.destination}`
          : `Removed copied file ${rollbackData.destination}`,
      };
    } catch (err) {
      return {
        tool: this.name,
        success: false,
        description: `Failed to rollback file copy`,
        error: (err as Error).message,
      };
    }
  }
}
