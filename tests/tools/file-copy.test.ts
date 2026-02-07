import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileCopyAdapter } from '../../src/tools/file-copy.js';
import type { ExecutionContext, Policy } from '../../src/types.js';

let tmpDir: string;

function makePolicy(): Policy {
  return {
    version: '1.0',
    name: 'test',
    capabilities: [
      { tool: 'file:copy', scope: { paths: [`${tmpDir}/**`] } },
      { tool: 'file:read', scope: { paths: [`${tmpDir}/**`] } },
      { tool: 'file:write', scope: { paths: [`${tmpDir}/**`] } },
    ],
    limits: { max_files_changed: 10 },
    gates: [],
    evidence: { require: ['checksums'], format: 'jsonl' },
    forbidden: [{ pattern: '**/.env' }],
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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('FileCopyAdapter', () => {
  const adapter = new FileCopyAdapter();

  it('should execute copy and create new file', async () => {
    const srcPath = path.join(tmpDir, 'source.txt');
    const destPath = path.join(tmpDir, 'copy.txt');
    fs.writeFileSync(srcPath, 'Copy me');
    const ctx = makeCtx();

    const result = await adapter.execute(
      { source: srcPath, destination: destPath, overwrite: false },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(fs.existsSync(srcPath)).toBe(true);
    expect(fs.existsSync(destPath)).toBe(true);
    expect(fs.readFileSync(destPath, 'utf-8')).toBe('Copy me');
    expect(ctx.budget.filesChanged).toBe(1);
  });

  it('should fail when source does not exist', async () => {
    const result = await adapter.execute(
      {
        source: path.join(tmpDir, 'nope.txt'),
        destination: path.join(tmpDir, 'dest.txt'),
        overwrite: false,
      },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('does not exist');
  });

  it('should fail when destination exists and overwrite is false', async () => {
    const srcPath = path.join(tmpDir, 'src.txt');
    const destPath = path.join(tmpDir, 'dest.txt');
    fs.writeFileSync(srcPath, 'Source');
    fs.writeFileSync(destPath, 'Existing');

    const result = await adapter.execute(
      { source: srcPath, destination: destPath, overwrite: false },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists');
  });

  it('should overwrite when overwrite is true', async () => {
    const srcPath = path.join(tmpDir, 'src.txt');
    const destPath = path.join(tmpDir, 'dest.txt');
    fs.writeFileSync(srcPath, 'New content');
    fs.writeFileSync(destPath, 'Old content');

    const result = await adapter.execute(
      { source: srcPath, destination: destPath, overwrite: true },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    expect(fs.readFileSync(destPath, 'utf-8')).toBe('New content');
  });

  it('should rollback by removing copied file', async () => {
    const srcPath = path.join(tmpDir, 'rollback-src.txt');
    const destPath = path.join(tmpDir, 'rollback-dest.txt');
    fs.writeFileSync(srcPath, 'Content');
    const ctx = makeCtx();

    await adapter.execute(
      { source: srcPath, destination: destPath, overwrite: false },
      ctx,
    );
    expect(fs.existsSync(destPath)).toBe(true);

    const rollbackResult = await adapter.rollback(
      { source: srcPath, destination: destPath, overwrite: false },
      ctx,
    );
    expect(rollbackResult.success).toBe(true);
    expect(fs.existsSync(destPath)).toBe(false);
    expect(fs.existsSync(srcPath)).toBe(true); // Source unchanged
  });

  it('should rollback by restoring overwritten file', async () => {
    const srcPath = path.join(tmpDir, 'src.txt');
    const destPath = path.join(tmpDir, 'dest.txt');
    fs.writeFileSync(srcPath, 'New');
    fs.writeFileSync(destPath, 'Original');
    const ctx = makeCtx();

    await adapter.execute(
      { source: srcPath, destination: destPath, overwrite: true },
      ctx,
    );
    expect(fs.readFileSync(destPath, 'utf-8')).toBe('New');

    const rollbackResult = await adapter.rollback(
      { source: srcPath, destination: destPath, overwrite: true },
      ctx,
    );
    expect(rollbackResult.success).toBe(true);
    expect(fs.readFileSync(destPath, 'utf-8')).toBe('Original');
  });

  it('should produce correct dry run output', async () => {
    const srcPath = path.join(tmpDir, 'src.txt');
    fs.writeFileSync(srcPath, 'data');

    const result = await adapter.dryRun(
      { source: srcPath, destination: path.join(tmpDir, 'dest.txt'), overwrite: false },
      makeCtx(),
    );
    expect(result.wouldDo).toContain('Copy');
    expect(result.estimatedChanges!.length).toBe(1);
  });
});
