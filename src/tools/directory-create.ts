/**
 * directory:create — Scoped directory creation tool adapter.
 *
 * Creates directories within allowed path scopes.
 * Supports recursive creation (mkdir -p).
 * Rollback support: removes created directories.
 */

import fs from 'node:fs';
import path from 'node:path';
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

export const DirectoryCreateInputSchema = z.object({
  path: z.string().min(1, 'Directory path is required'),
  /** Create parent directories if they do not exist (like mkdir -p) */
  recursive: z.boolean().default(true),
});

export type DirectoryCreateInput = z.infer<typeof DirectoryCreateInputSchema>;

export class DirectoryCreateAdapter extends ToolAdapter {
  readonly name = 'directory:create';
  readonly description = 'Create a directory within allowed path scopes';
  readonly inputSchema = DirectoryCreateInputSchema;

  validate(input: unknown, policy: Policy): ValidationResult {
    const parsed = DirectoryCreateInputSchema.safeParse(input);
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
    const { path: dirPath, recursive } = input as DirectoryCreateInput;
    const absPath = path.resolve(dirPath);
    const warnings: string[] = [];

    if (fs.existsSync(absPath)) {
      warnings.push(`Directory already exists: ${absPath}`);
    } else if (!recursive) {
      const parent = path.dirname(absPath);
      if (!fs.existsSync(parent)) {
        warnings.push(`Parent directory does not exist: ${parent}. Set recursive: true to create.`);
      }
    }

    return {
      tool: this.name,
      wouldDo: `Create directory: ${absPath}${recursive ? ' (recursive)' : ''}`,
      estimatedChanges: [absPath],
      warnings,
    };
  }

  async execute(input: Record<string, unknown>, ctx: ExecutionContext): Promise<ExecutionResult> {
    const start = Date.now();
    const { path: dirPath, recursive } = input as DirectoryCreateInput;
    const absPath = path.resolve(dirPath);

    try {
      if (fs.existsSync(absPath)) {
        const stat = fs.statSync(absPath);
        if (stat.isDirectory()) {
          return this.success(
            { path: absPath, created: false, reason: 'Directory already exists' },
            Date.now() - start,
          );
        }
        return this.failure(`Path exists but is not a directory: ${absPath}`, Date.now() - start);
      }

      // Track what directories are actually created for rollback
      const createdDirs = this.findNewDirectories(absPath);

      // Create the directory
      fs.mkdirSync(absPath, { recursive });

      // Store rollback data: the topmost directory that was actually created
      const rollbackKey = `directory:create:${absPath}`;
      ctx.rollbackData[rollbackKey] = {
        createdDirs,
        path: absPath,
      };

      return this.success(
        { path: absPath, created: true, createdDirs },
        Date.now() - start,
        [
          {
            type: 'log',
            value: `Created directory: ${absPath} (dirs created: ${createdDirs.length})`,
            description: 'Directory creation record',
          },
        ],
      );
    } catch (err) {
      return this.failure((err as Error).message, Date.now() - start);
    }
  }

  async rollback(input: Record<string, unknown>, ctx: ExecutionContext): Promise<RollbackResult> {
    const { path: dirPath } = input as DirectoryCreateInput;
    const absPath = path.resolve(dirPath);
    const rollbackKey = `directory:create:${absPath}`;
    const rollbackData = ctx.rollbackData[rollbackKey] as {
      createdDirs: string[];
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
      // Remove created directories in reverse order (deepest first)
      const dirs = [...rollbackData.createdDirs].reverse();
      for (const dir of dirs) {
        if (fs.existsSync(dir)) {
          try {
            fs.rmdirSync(dir);
          } catch {
            // Directory not empty — skip (may have been used by other operations)
          }
        }
      }

      return {
        tool: this.name,
        success: true,
        description: `Removed created directories: ${dirs.join(', ')}`,
      };
    } catch (err) {
      return {
        tool: this.name,
        success: false,
        description: `Failed to rollback directory creation`,
        error: (err as Error).message,
      };
    }
  }

  /**
   * Walk up from the target path and find which directories don't exist yet.
   * Returns them in top-down order (parent first).
   */
  private findNewDirectories(targetPath: string): string[] {
    const dirs: string[] = [];
    let current = targetPath;

    while (!fs.existsSync(current)) {
      dirs.unshift(current);
      const parent = path.dirname(current);
      if (parent === current) break; // Reached filesystem root
      current = parent;
    }

    return dirs;
  }
}
