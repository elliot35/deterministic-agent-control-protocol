/**
 * file:delete — Scoped file deletion tool adapter.
 *
 * Deletes files within allowed path scopes, enforcing policy constraints.
 * Creates a full backup of file contents for rollback support.
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

export const FileDeleteInputSchema = z.object({
  path: z.string().min(1, 'File path is required'),
  /** If true, do not error when the file does not exist */
  force: z.boolean().default(false),
});

export type FileDeleteInput = z.infer<typeof FileDeleteInputSchema>;

export class FileDeleteAdapter extends ToolAdapter {
  readonly name = 'file:delete';
  readonly description = 'Delete a file within allowed path scopes (with backup for rollback)';
  readonly inputSchema = FileDeleteInputSchema;

  validate(input: unknown, policy: Policy): ValidationResult {
    const parsed = FileDeleteInputSchema.safeParse(input);
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
    const { path: filePath, force } = input as FileDeleteInput;
    const absPath = path.resolve(filePath);
    const exists = fs.existsSync(absPath);
    const warnings: string[] = [];

    if (!exists && !force) {
      warnings.push(`File does not exist: ${absPath}`);
    }

    let size = 0;
    if (exists) {
      try {
        const stat = fs.statSync(absPath);
        size = stat.size;
        if (stat.isDirectory()) {
          warnings.push(`Path is a directory, not a file: ${absPath}`);
        }
      } catch {
        warnings.push(`Cannot stat file: ${absPath}`);
      }
    }

    return {
      tool: this.name,
      wouldDo: exists
        ? `Delete file: ${absPath} (${size} bytes)`
        : `No-op: file does not exist: ${absPath}`,
      estimatedChanges: exists ? [absPath] : [],
      warnings,
    };
  }

  async execute(input: Record<string, unknown>, ctx: ExecutionContext): Promise<ExecutionResult> {
    const start = Date.now();
    const { path: filePath, force } = input as FileDeleteInput;
    const absPath = path.resolve(filePath);
    const artifacts: ExecutionArtifact[] = [];

    try {
      const exists = fs.existsSync(absPath);

      if (!exists) {
        if (force) {
          return this.success(
            { path: absPath, deleted: false, reason: 'File did not exist' },
            Date.now() - start,
          );
        }
        return this.failure(`File does not exist: ${absPath}`, Date.now() - start);
      }

      // Verify it's a file, not a directory
      const stat = fs.statSync(absPath);
      if (stat.isDirectory()) {
        return this.failure(`Path is a directory, not a file: ${absPath}`, Date.now() - start);
      }

      // Backup file content for rollback
      const content = fs.readFileSync(absPath);
      const checksum = crypto.createHash('sha256').update(content).digest('hex');

      artifacts.push({
        type: 'checksum',
        value: `sha256:${checksum}`,
        description: `Checksum of deleted file: ${absPath}`,
      });

      artifacts.push({
        type: 'log',
        value: `Deleted: ${absPath} (${stat.size} bytes)`,
        description: 'Deletion record',
      });

      // Store rollback data (full content backup)
      const rollbackKey = `file:delete:${absPath}`;
      ctx.rollbackData[rollbackKey] = {
        path: absPath,
        content: content.toString('base64'),
        mode: stat.mode,
      };

      // Delete the file
      fs.unlinkSync(absPath);

      ctx.budget.filesChanged++;

      return this.success(
        { path: absPath, deleted: true, size: stat.size },
        Date.now() - start,
        artifacts,
      );
    } catch (err) {
      return this.failure((err as Error).message, Date.now() - start);
    }
  }

  async rollback(input: Record<string, unknown>, ctx: ExecutionContext): Promise<RollbackResult> {
    const { path: filePath } = input as FileDeleteInput;
    const absPath = path.resolve(filePath);
    const rollbackKey = `file:delete:${absPath}`;
    const rollbackData = ctx.rollbackData[rollbackKey] as {
      path: string;
      content: string;
      mode: number;
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
      // Restore the file from the base64-encoded backup
      const content = Buffer.from(rollbackData.content, 'base64');
      fs.writeFileSync(rollbackData.path, content, { mode: rollbackData.mode });

      return {
        tool: this.name,
        success: true,
        description: `Restored deleted file: ${rollbackData.path}`,
      };
    } catch (err) {
      return {
        tool: this.name,
        success: false,
        description: `Failed to restore deleted file: ${rollbackData.path}`,
        error: (err as Error).message,
      };
    }
  }
}
