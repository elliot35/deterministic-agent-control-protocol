/**
 * file:write — Scoped file write tool adapter.
 *
 * Writes file contents, enforcing path scope from the policy.
 * Creates a backup before writing for rollback support.
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

export const FileWriteInputSchema = z.object({
  path: z.string().min(1, 'File path is required'),
  content: z.string(),
  encoding: z.enum(['utf-8', 'base64', 'hex']).default('utf-8'),
  createDirs: z.boolean().default(false),
});

export type FileWriteInput = z.infer<typeof FileWriteInputSchema>;

export class FileWriteAdapter extends ToolAdapter {
  readonly name = 'file:write';
  readonly description = 'Write contents to a file within allowed path scopes';
  readonly inputSchema = FileWriteInputSchema;

  validate(input: unknown, policy: Policy): ValidationResult {
    const parsed = FileWriteInputSchema.safeParse(input);
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
    const { path: filePath, content } = input as FileWriteInput;
    const absPath = path.resolve(filePath);
    const exists = fs.existsSync(absPath);
    const warnings: string[] = [];

    if (!exists) {
      const dir = path.dirname(absPath);
      if (!fs.existsSync(dir)) {
        warnings.push(`Parent directory does not exist: ${dir}`);
      }
    }

    return {
      tool: this.name,
      wouldDo: exists
        ? `Overwrite file: ${absPath} (${Buffer.byteLength(content)} bytes)`
        : `Create new file: ${absPath} (${Buffer.byteLength(content)} bytes)`,
      estimatedChanges: [absPath],
      warnings,
    };
  }

  async execute(input: Record<string, unknown>, ctx: ExecutionContext): Promise<ExecutionResult> {
    const start = Date.now();
    const { path: filePath, content, encoding, createDirs } = input as FileWriteInput;
    const absPath = path.resolve(filePath);
    const artifacts: ExecutionArtifact[] = [];

    try {
      // Backup existing file for rollback
      let previousContent: string | null = null;
      const existed = fs.existsSync(absPath);
      if (existed) {
        previousContent = fs.readFileSync(absPath, 'utf-8');
        const prevChecksum = crypto.createHash('sha256').update(previousContent).digest('hex');
        artifacts.push({
          type: 'checksum',
          value: `sha256:${prevChecksum}`,
          description: `Previous checksum of ${absPath}`,
        });
      }

      // Store rollback data
      const rollbackKey = `file:write:${absPath}`;
      ctx.rollbackData[rollbackKey] = {
        existed,
        previousContent,
        path: absPath,
      };

      // Create directories if needed
      if (createDirs) {
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
      }

      // Write the file
      fs.writeFileSync(absPath, content, encoding as BufferEncoding);

      // Produce evidence
      const newChecksum = crypto.createHash('sha256').update(content).digest('hex');
      artifacts.push({
        type: 'checksum',
        value: `sha256:${newChecksum}`,
        description: `New checksum of ${absPath}`,
      });

      if (previousContent !== null) {
        artifacts.push({
          type: 'diff',
          value: `--- ${absPath}\n+++ ${absPath}\n@@ modified @@\n-${previousContent.length} bytes\n+${content.length} bytes`,
          description: 'Size diff',
        });
      }

      // Update budget
      ctx.budget.filesChanged++;
      ctx.budget.totalOutputBytes += Buffer.byteLength(content);

      return this.success(
        { path: absPath, bytesWritten: Buffer.byteLength(content), created: !existed },
        Date.now() - start,
        artifacts,
      );
    } catch (err) {
      return this.failure((err as Error).message, Date.now() - start);
    }
  }

  async rollback(input: Record<string, unknown>, ctx: ExecutionContext): Promise<RollbackResult> {
    const { path: filePath } = input as FileWriteInput;
    const absPath = path.resolve(filePath);
    const rollbackKey = `file:write:${absPath}`;
    const rollbackData = ctx.rollbackData[rollbackKey] as {
      existed: boolean;
      previousContent: string | null;
      path: string;
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
      if (rollbackData.existed && rollbackData.previousContent !== null) {
        // Restore previous content
        fs.writeFileSync(rollbackData.path, rollbackData.previousContent, 'utf-8');
        return {
          tool: this.name,
          success: true,
          description: `Restored previous content of ${rollbackData.path}`,
        };
      } else if (!rollbackData.existed) {
        // File was newly created — delete it
        if (fs.existsSync(rollbackData.path)) {
          fs.unlinkSync(rollbackData.path);
        }
        return {
          tool: this.name,
          success: true,
          description: `Deleted newly created file ${rollbackData.path}`,
        };
      }

      return {
        tool: this.name,
        success: true,
        description: 'No rollback action needed',
      };
    } catch (err) {
      return {
        tool: this.name,
        success: false,
        description: `Failed to rollback file write to ${rollbackData.path}`,
        error: (err as Error).message,
      };
    }
  }
}
