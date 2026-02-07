/**
 * git:diff and git:apply — Scoped git tool adapters.
 *
 * git:diff — produces a diff of changes in a repo (read-only).
 * git:apply — applies a patch to a repo (with rollback via git stash).
 */

import { execSync } from 'node:child_process';
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

// ---------------------------------------------------------------------------
// git:diff
// ---------------------------------------------------------------------------

export const GitDiffInputSchema = z.object({
  repo: z.string().min(1, 'Repository path is required'),
  ref: z.string().default('HEAD'),
  paths: z.array(z.string()).optional(),
});

export type GitDiffInput = z.infer<typeof GitDiffInputSchema>;

export class GitDiffAdapter extends ToolAdapter {
  readonly name = 'git:diff';
  readonly description = 'Get git diff output for a repository';
  readonly inputSchema = GitDiffInputSchema;

  validate(input: unknown, policy: Policy): ValidationResult {
    const parsed = GitDiffInputSchema.safeParse(input);
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
    const { repo, ref, paths } = input as GitDiffInput;
    return {
      tool: this.name,
      wouldDo: `git diff ${ref} in ${repo}${paths ? ` -- ${paths.join(' ')}` : ''}`,
      estimatedChanges: [],
      warnings: [],
    };
  }

  async execute(input: Record<string, unknown>, _ctx: ExecutionContext): Promise<ExecutionResult> {
    const start = Date.now();
    const { repo, ref, paths } = input as GitDiffInput;

    try {
      let cmd = `git diff ${ref}`;
      if (paths && paths.length > 0) {
        cmd += ` -- ${paths.join(' ')}`;
      }

      const diff = execSync(cmd, {
        cwd: repo,
        encoding: 'utf-8',
        timeout: 30000,
      });

      const diffHash = crypto.createHash('sha256').update(diff).digest('hex');

      return this.success(
        { diff, linesChanged: diff.split('\n').length },
        Date.now() - start,
        [
          { type: 'diff', value: diff.slice(0, 8192), description: `git diff ${ref} (truncated)` },
          { type: 'checksum', value: `sha256:${diffHash}`, description: 'Diff content hash' },
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
      description: 'No rollback needed for read-only git diff',
    };
  }
}

// ---------------------------------------------------------------------------
// git:apply
// ---------------------------------------------------------------------------

export const GitApplyInputSchema = z.object({
  repo: z.string().min(1, 'Repository path is required'),
  patch: z.string().min(1, 'Patch content is required'),
  check: z.boolean().default(false),
});

export type GitApplyInput = z.infer<typeof GitApplyInputSchema>;

export class GitApplyAdapter extends ToolAdapter {
  readonly name = 'git:apply';
  readonly description = 'Apply a git patch to a repository';
  readonly inputSchema = GitApplyInputSchema;

  validate(input: unknown, policy: Policy): ValidationResult {
    const parsed = GitApplyInputSchema.safeParse(input);
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
    const { repo, patch } = input as GitApplyInput;
    const patchLines = patch.split('\n').length;

    // Actually test the patch with --check
    let warnings: string[] = [];
    try {
      execSync('git apply --check --stat', {
        cwd: repo,
        input: patch,
        encoding: 'utf-8',
        timeout: 10000,
      });
    } catch (err) {
      warnings = [`Patch may not apply cleanly: ${(err as Error).message}`];
    }

    return {
      tool: this.name,
      wouldDo: `Apply ${patchLines}-line patch to ${repo}`,
      estimatedChanges: [`Patch applied to ${repo}`],
      warnings,
    };
  }

  async execute(input: Record<string, unknown>, ctx: ExecutionContext): Promise<ExecutionResult> {
    const start = Date.now();
    const { repo, patch } = input as GitApplyInput;

    try {
      // Stash any existing changes as a safety net
      const stashOutput = execSync('git stash push -m "det-acp-pre-apply-backup"', {
        cwd: repo,
        encoding: 'utf-8',
        timeout: 10000,
      });

      const didStash = !stashOutput.includes('No local changes');
      ctx.rollbackData[`git:apply:${repo}`] = { repo, didStash };

      // Apply the patch
      execSync('git apply', {
        cwd: repo,
        input: patch,
        encoding: 'utf-8',
        timeout: 30000,
      });

      const patchHash = crypto.createHash('sha256').update(patch).digest('hex');

      ctx.budget.filesChanged++;

      return this.success(
        { applied: true, repo },
        Date.now() - start,
        [
          { type: 'diff', value: patch.slice(0, 8192), description: 'Applied patch (truncated)' },
          { type: 'checksum', value: `sha256:${patchHash}`, description: 'Patch content hash' },
        ],
      );
    } catch (err) {
      return this.failure((err as Error).message, Date.now() - start);
    }
  }

  async rollback(input: Record<string, unknown>, ctx: ExecutionContext): Promise<RollbackResult> {
    const { repo } = input as GitApplyInput;
    const rollbackData = ctx.rollbackData[`git:apply:${repo}`] as {
      repo: string;
      didStash: boolean;
    } | undefined;

    if (!rollbackData) {
      return {
        tool: this.name,
        success: false,
        description: 'No rollback data available',
        error: 'Rollback data not found',
      };
    }

    try {
      // Revert to pre-apply state
      execSync('git checkout .', {
        cwd: rollbackData.repo,
        encoding: 'utf-8',
        timeout: 10000,
      });

      // Restore stashed changes if we stashed them
      if (rollbackData.didStash) {
        execSync('git stash pop', {
          cwd: rollbackData.repo,
          encoding: 'utf-8',
          timeout: 10000,
        });
      }

      return {
        tool: this.name,
        success: true,
        description: `Reverted patch in ${rollbackData.repo}${rollbackData.didStash ? ' and restored stashed changes' : ''}`,
      };
    } catch (err) {
      return {
        tool: this.name,
        success: false,
        description: `Failed to rollback git apply in ${rollbackData.repo}`,
        error: (err as Error).message,
      };
    }
  }
}
