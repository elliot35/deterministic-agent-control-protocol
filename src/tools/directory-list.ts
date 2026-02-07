/**
 * directory:list — Scoped directory listing tool adapter.
 *
 * Lists files and directories within allowed path scopes.
 * Read-only operation — no rollback needed.
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

export const DirectoryListInputSchema = z.object({
  path: z.string().min(1, 'Directory path is required'),
  /** Include files in subdirectories recursively */
  recursive: z.boolean().default(false),
  /** Maximum depth for recursive listing (default: 5) */
  maxDepth: z.number().int().min(1).max(20).default(5),
  /** Only include files matching this glob pattern */
  pattern: z.string().optional(),
});

export type DirectoryListInput = z.infer<typeof DirectoryListInputSchema>;

interface DirectoryEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
}

export class DirectoryListAdapter extends ToolAdapter {
  readonly name = 'directory:list';
  readonly description = 'List files and directories within allowed path scopes';
  readonly inputSchema = DirectoryListInputSchema;

  validate(input: unknown, policy: Policy): ValidationResult {
    const parsed = DirectoryListInputSchema.safeParse(input);
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
    const { path: dirPath, recursive } = input as DirectoryListInput;
    const absPath = path.resolve(dirPath);
    const exists = fs.existsSync(absPath);

    return {
      tool: this.name,
      wouldDo: `List directory: ${absPath}${recursive ? ' (recursive)' : ''}`,
      estimatedChanges: [],
      warnings: exists ? [] : [`Directory does not exist: ${absPath}`],
    };
  }

  async execute(input: Record<string, unknown>, _ctx: ExecutionContext): Promise<ExecutionResult> {
    const start = Date.now();
    const { path: dirPath, recursive, maxDepth } = input as DirectoryListInput;
    const absPath = path.resolve(dirPath);

    try {
      if (!fs.existsSync(absPath)) {
        return this.failure(`Directory does not exist: ${absPath}`, Date.now() - start);
      }

      const stat = fs.statSync(absPath);
      if (!stat.isDirectory()) {
        return this.failure(`Path is not a directory: ${absPath}`, Date.now() - start);
      }

      const entries: DirectoryEntry[] = [];
      this.listDir(absPath, entries, recursive ? maxDepth : 1, 0);

      return this.success(
        {
          path: absPath,
          totalEntries: entries.length,
          entries,
        },
        Date.now() - start,
        [
          {
            type: 'log',
            value: `Listed ${entries.length} entries in ${absPath}`,
            description: 'Directory listing',
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
      description: 'No rollback needed for read-only directory listing',
    };
  }

  private listDir(
    dirPath: string,
    entries: DirectoryEntry[],
    maxDepth: number,
    currentDepth: number,
  ): void {
    if (currentDepth >= maxDepth) return;

    const items = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dirPath, item.name);
      let size = 0;
      let type: DirectoryEntry['type'] = 'other';

      try {
        if (item.isFile()) {
          type = 'file';
          size = fs.statSync(fullPath).size;
        } else if (item.isDirectory()) {
          type = 'directory';
        } else if (item.isSymbolicLink()) {
          type = 'symlink';
        }
      } catch {
        // Permission denied or broken symlink
      }

      entries.push({ name: item.name, path: fullPath, type, size });

      if (item.isDirectory() && currentDepth + 1 < maxDepth) {
        this.listDir(fullPath, entries, maxDepth, currentDepth + 1);
      }
    }
  }
}
