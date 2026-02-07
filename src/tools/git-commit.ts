/**
 * git:commit — Scoped git commit tool adapter.
 *
 * Stages and commits changes in a repository.
 * Rollback support via git revert.
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
  ExecutionArtifact,
  Policy,
  RollbackResult,
  ValidationResult,
} from '../types.js';

export const GitCommitInputSchema = z.object({
  repo: z.string().min(1, 'Repository path is required'),
  message: z.string().min(1, 'Commit message is required'),
  /** Paths to stage before committing. If empty, commits currently staged changes. */
  paths: z.array(z.string()).optional(),
  /** Stage all tracked changes (git add -u) before committing */
  stageAll: z.boolean().default(false),
  /** Author override in "Name <email>" format */
  author: z.string().optional(),
});

export type GitCommitInput = z.infer<typeof GitCommitInputSchema>;

export class GitCommitAdapter extends ToolAdapter {
  readonly name = 'git:commit';
  readonly description = 'Stage and commit changes in a git repository';
  readonly inputSchema = GitCommitInputSchema;

  validate(input: unknown, policy: Policy): ValidationResult {
    const parsed = GitCommitInputSchema.safeParse(input);
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
    const { repo, message, paths, stageAll } = input as GitCommitInput;
    const warnings: string[] = [];

    try {
      // Check if there are changes to commit
      const status = execSync('git status --porcelain', {
        cwd: repo,
        encoding: 'utf-8',
        timeout: 10000,
      }).trim();

      if (!status && !paths?.length && !stageAll) {
        warnings.push('No changes detected to commit');
      }
    } catch (err) {
      warnings.push(`Cannot check git status: ${(err as Error).message}`);
    }

    return {
      tool: this.name,
      wouldDo: `Commit to ${repo}: "${message.slice(0, 72)}"${stageAll ? ' (staging all)' : ''}`,
      estimatedChanges: [`Git commit in ${repo}`],
      warnings,
    };
  }

  async execute(input: Record<string, unknown>, ctx: ExecutionContext): Promise<ExecutionResult> {
    const start = Date.now();
    const { repo, message, paths, stageAll, author } = input as GitCommitInput;
    const artifacts: ExecutionArtifact[] = [];

    try {
      // Stage changes
      if (paths && paths.length > 0) {
        const sanitizedPaths = paths.map((p) => `"${p}"`).join(' ');
        execSync(`git add ${sanitizedPaths}`, {
          cwd: repo,
          encoding: 'utf-8',
          timeout: 10000,
        });
      } else if (stageAll) {
        execSync('git add -u', {
          cwd: repo,
          encoding: 'utf-8',
          timeout: 10000,
        });
      }

      // Build commit command
      let commitCmd = `git commit -m "${message.replace(/"/g, '\\"')}"`;
      if (author) {
        commitCmd += ` --author="${author.replace(/"/g, '\\"')}"`;
      }

      const output = execSync(commitCmd, {
        cwd: repo,
        encoding: 'utf-8',
        timeout: 30000,
      });

      // Get the commit hash
      const commitHash = execSync('git rev-parse HEAD', {
        cwd: repo,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();

      const messageHash = crypto.createHash('sha256').update(message).digest('hex');

      artifacts.push({
        type: 'checksum',
        value: `commit:${commitHash}`,
        description: `Commit hash`,
      });

      artifacts.push({
        type: 'checksum',
        value: `message:sha256:${messageHash}`,
        description: 'Commit message hash',
      });

      artifacts.push({
        type: 'log',
        value: output.trim().slice(0, 4096),
        description: 'Git commit output',
      });

      // Store rollback data
      const rollbackKey = `git:commit:${repo}:${commitHash}`;
      ctx.rollbackData[rollbackKey] = {
        repo,
        commitHash,
      };

      return this.success(
        { commitHash, message, repo },
        Date.now() - start,
        artifacts,
      );
    } catch (err) {
      return this.failure((err as Error).message, Date.now() - start);
    }
  }

  async rollback(input: Record<string, unknown>, ctx: ExecutionContext): Promise<RollbackResult> {
    const { repo } = input as GitCommitInput;

    // Find the rollback data by searching for the repo key prefix
    const rollbackKey = Object.keys(ctx.rollbackData).find(
      (k) => k.startsWith(`git:commit:${repo}:`),
    );

    if (!rollbackKey) {
      return {
        tool: this.name,
        success: false,
        description: 'No rollback data available',
        error: 'Rollback data not found — execute() may not have been called',
      };
    }

    const rollbackData = ctx.rollbackData[rollbackKey] as {
      repo: string;
      commitHash: string;
    };

    try {
      // Verify HEAD is still the commit we made
      const currentHead = execSync('git rev-parse HEAD', {
        cwd: rollbackData.repo,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();

      if (currentHead !== rollbackData.commitHash) {
        return {
          tool: this.name,
          success: false,
          description: 'Cannot rollback — HEAD has moved since the commit was made',
          error: `Expected HEAD ${rollbackData.commitHash}, found ${currentHead}`,
        };
      }

      // Soft reset to undo the commit while keeping changes staged
      execSync('git reset --soft HEAD~1', {
        cwd: rollbackData.repo,
        encoding: 'utf-8',
        timeout: 10000,
      });

      return {
        tool: this.name,
        success: true,
        description: `Rolled back commit ${rollbackData.commitHash} (changes are staged)`,
      };
    } catch (err) {
      return {
        tool: this.name,
        success: false,
        description: `Failed to rollback git commit`,
        error: (err as Error).message,
      };
    }
  }
}
