/**
 * git:status — Read-only git status tool adapter.
 *
 * Reports the working tree status of a git repository.
 * Read-only operation — no rollback needed.
 */

import { execSync } from 'node:child_process';
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

export const GitStatusInputSchema = z.object({
  repo: z.string().min(1, 'Repository path is required'),
  /** Show short format output */
  short: z.boolean().default(false),
  /** Show branch tracking info */
  branch: z.boolean().default(true),
});

export type GitStatusInput = z.infer<typeof GitStatusInputSchema>;

interface StatusEntry {
  path: string;
  status: string;
  staged: boolean;
}

export class GitStatusAdapter extends ToolAdapter {
  readonly name = 'git:status';
  readonly description = 'Get git working tree status for a repository';
  readonly inputSchema = GitStatusInputSchema;

  validate(input: unknown, policy: Policy): ValidationResult {
    const parsed = GitStatusInputSchema.safeParse(input);
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
    const { repo } = input as GitStatusInput;
    return {
      tool: this.name,
      wouldDo: `Get git status of ${repo}`,
      estimatedChanges: [],
      warnings: [],
    };
  }

  async execute(input: Record<string, unknown>, _ctx: ExecutionContext): Promise<ExecutionResult> {
    const start = Date.now();
    const { repo, short, branch } = input as GitStatusInput;

    try {
      // Get porcelain status for parsing
      const porcelainOutput = execSync('git status --porcelain=v1', {
        cwd: repo,
        encoding: 'utf-8',
        timeout: 10000,
      });

      // Parse porcelain output into structured entries
      const entries: StatusEntry[] = [];
      for (const line of porcelainOutput.split('\n').filter(Boolean)) {
        const indexStatus = line[0];
        const workingStatus = line[1];
        const filePath = line.slice(3);

        let status = 'unknown';
        const staged = indexStatus !== ' ' && indexStatus !== '?';

        if (indexStatus === '?' && workingStatus === '?') {
          status = 'untracked';
        } else if (indexStatus === 'A') {
          status = 'added';
        } else if (indexStatus === 'M' || workingStatus === 'M') {
          status = 'modified';
        } else if (indexStatus === 'D' || workingStatus === 'D') {
          status = 'deleted';
        } else if (indexStatus === 'R') {
          status = 'renamed';
        } else if (indexStatus === 'C') {
          status = 'copied';
        }

        entries.push({ path: filePath, status, staged });
      }

      // Get branch info
      let branchInfo: Record<string, string> = {};
      if (branch) {
        try {
          const branchOutput = execSync('git branch --show-current', {
            cwd: repo,
            encoding: 'utf-8',
            timeout: 5000,
          }).trim();

          branchInfo = { currentBranch: branchOutput || '(detached HEAD)' };

          // Get upstream tracking info
          try {
            const upstream = execSync('git rev-parse --abbrev-ref @{upstream}', {
              cwd: repo,
              encoding: 'utf-8',
              timeout: 5000,
            }).trim();
            branchInfo.upstream = upstream;

            const aheadBehind = execSync('git rev-list --left-right --count HEAD...@{upstream}', {
              cwd: repo,
              encoding: 'utf-8',
              timeout: 5000,
            }).trim();
            const [ahead, behind] = aheadBehind.split('\t');
            branchInfo.ahead = ahead;
            branchInfo.behind = behind;
          } catch {
            // No upstream configured
          }
        } catch {
          branchInfo = { currentBranch: '(unknown)' };
        }
      }

      // Get readable output too
      let readableOutput = '';
      if (short) {
        readableOutput = porcelainOutput;
      } else {
        readableOutput = execSync('git status', {
          cwd: repo,
          encoding: 'utf-8',
          timeout: 10000,
        });
      }

      return this.success(
        {
          repo,
          branch: branchInfo,
          entries,
          clean: entries.length === 0,
          summary: {
            total: entries.length,
            staged: entries.filter((e) => e.staged).length,
            unstaged: entries.filter((e) => !e.staged).length,
            untracked: entries.filter((e) => e.status === 'untracked').length,
          },
          raw: readableOutput.trim(),
        },
        Date.now() - start,
        [
          {
            type: 'log',
            value: readableOutput.trim().slice(0, 4096),
            description: 'Git status output',
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
      description: 'No rollback needed for read-only git status',
    };
  }
}
