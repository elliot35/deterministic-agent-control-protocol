import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GitCommitAdapter } from '../../src/tools/git-commit.js';
import { GitStatusAdapter } from '../../src/tools/git-status.js';
import type { ExecutionContext, Policy } from '../../src/types.js';

let tmpDir: string;

function makePolicy(): Policy {
  return {
    version: '1.0',
    name: 'test',
    capabilities: [
      { tool: 'git:commit', scope: { repos: [`${tmpDir}`] } },
      { tool: 'git:status', scope: { repos: [`${tmpDir}`] } },
    ],
    limits: { max_files_changed: 10 },
    gates: [],
    evidence: { require: ['checksums'], format: 'jsonl' },
    forbidden: [],
  };
}

function makeCtx(): ExecutionContext {
  return {
    sessionId: 'test-session',
    actionIndex: 0,
    dryRun: false,
    policy: makePolicy(),
    rollbackData: {},
    budget: {
      startedAt: Date.now(),
      filesChanged: 0,
      totalOutputBytes: 0,
      retries: 0,
      costUsd: 0,
      actionsEvaluated: 0,
      actionsDenied: 0,
    },
  };
}

function initGitRepo(): void {
  execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: tmpDir, stdio: 'pipe' });
  // Create initial commit
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test');
  execSync('git add .', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git commit -m "Initial commit"', { cwd: tmpDir, stdio: 'pipe' });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-test-'));
  initGitRepo();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('GitStatusAdapter', () => {
  const adapter = new GitStatusAdapter();

  it('should report clean status', async () => {
    const result = await adapter.execute(
      { repo: tmpDir, short: false, branch: true },
      makeCtx(),
    );
    expect(result.success).toBe(true);

    const output = result.output as { clean: boolean; summary: { total: number } };
    expect(output.clean).toBe(true);
    expect(output.summary.total).toBe(0);
  });

  it('should detect modified files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Modified');

    const result = await adapter.execute(
      { repo: tmpDir, short: false, branch: true },
      makeCtx(),
    );
    expect(result.success).toBe(true);

    const output = result.output as {
      clean: boolean;
      entries: Array<{ status: string }>;
      summary: { total: number };
    };
    expect(output.clean).toBe(false);
    expect(output.summary.total).toBeGreaterThan(0);
  });

  it('should detect untracked files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'new-file.txt'), 'Untracked');

    const result = await adapter.execute(
      { repo: tmpDir, short: false, branch: true },
      makeCtx(),
    );
    expect(result.success).toBe(true);

    const output = result.output as {
      entries: Array<{ status: string }>;
      summary: { untracked: number };
    };
    expect(output.summary.untracked).toBeGreaterThan(0);
  });

  it('should include branch info', async () => {
    const result = await adapter.execute(
      { repo: tmpDir, short: false, branch: true },
      makeCtx(),
    );
    expect(result.success).toBe(true);

    const output = result.output as { branch: { currentBranch: string } };
    expect(output.branch.currentBranch).toBeTruthy();
  });

  it('should rollback as no-op', async () => {
    const result = await adapter.rollback({}, makeCtx());
    expect(result.success).toBe(true);
  });

  it('should produce correct dry run output', async () => {
    const result = await adapter.dryRun(
      { repo: tmpDir, short: false, branch: true },
      makeCtx(),
    );
    expect(result.wouldDo).toContain('git status');
    expect(result.estimatedChanges).toHaveLength(0);
  });
});

describe('GitCommitAdapter', () => {
  const adapter = new GitCommitAdapter();

  it('should commit staged changes', async () => {
    fs.writeFileSync(path.join(tmpDir, 'new-file.txt'), 'New content');
    const ctx = makeCtx();

    const result = await adapter.execute(
      {
        repo: tmpDir,
        message: 'Add new file',
        paths: ['new-file.txt'],
        stageAll: false,
      },
      ctx,
    );
    expect(result.success).toBe(true);

    const output = result.output as { commitHash: string; message: string };
    expect(output.commitHash).toBeTruthy();
    expect(output.message).toBe('Add new file');

    // Verify commit exists
    const log = execSync('git log --oneline -1', { cwd: tmpDir, encoding: 'utf-8' });
    expect(log).toContain('Add new file');
  });

  it('should commit with stageAll', async () => {
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Updated');
    const ctx = makeCtx();

    const result = await adapter.execute(
      {
        repo: tmpDir,
        message: 'Update readme',
        stageAll: true,
      },
      ctx,
    );
    expect(result.success).toBe(true);
  });

  it('should produce commit hash artifact', async () => {
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'Test');

    const result = await adapter.execute(
      {
        repo: tmpDir,
        message: 'Test commit',
        paths: ['test.txt'],
        stageAll: false,
      },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    expect(result.artifacts!.some((a) => a.type === 'checksum' && a.value.startsWith('commit:'))).toBe(true);
  });

  it('should rollback by soft resetting', async () => {
    fs.writeFileSync(path.join(tmpDir, 'rollback.txt'), 'Rollback me');
    const ctx = makeCtx();

    await adapter.execute(
      {
        repo: tmpDir,
        message: 'Rollback test',
        paths: ['rollback.txt'],
        stageAll: false,
      },
      ctx,
    );

    const rollbackResult = await adapter.rollback(
      { repo: tmpDir, message: 'Rollback test' },
      ctx,
    );
    expect(rollbackResult.success).toBe(true);

    // Verify the commit was rolled back (HEAD should be initial commit)
    const log = execSync('git log --oneline', { cwd: tmpDir, encoding: 'utf-8' });
    expect(log).not.toContain('Rollback test');
  });

  it('should produce correct dry run output', async () => {
    const result = await adapter.dryRun(
      {
        repo: tmpDir,
        message: 'Test commit',
        stageAll: false,
      },
      makeCtx(),
    );
    expect(result.wouldDo).toContain('Commit');
    expect(result.wouldDo).toContain('Test commit');
  });
});
