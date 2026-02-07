import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileDeleteAdapter } from '../../src/tools/file-delete.js';
import type { ExecutionContext, Policy } from '../../src/types.js';

let tmpDir: string;

function makePolicy(): Policy {
  return {
    version: '1.0',
    name: 'test',
    capabilities: [
      { tool: 'file:delete', scope: { paths: [`${tmpDir}/**`] } },
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delete-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('FileDeleteAdapter', () => {
  const adapter = new FileDeleteAdapter();

  it('should validate allowed file delete', () => {
    const result = adapter.validate(
      { path: `${tmpDir}/test.txt` },
      makePolicy(),
    );
    expect(result.verdict).toBe('allow');
  });

  it('should deny delete outside scope', () => {
    const result = adapter.validate(
      { path: '/etc/passwd' },
      makePolicy(),
    );
    expect(result.verdict).toBe('deny');
  });

  it('should deny delete of .env files', () => {
    const result = adapter.validate(
      { path: `${tmpDir}/.env` },
      makePolicy(),
    );
    expect(result.verdict).toBe('deny');
  });

  it('should execute delete and remove file', async () => {
    const filePath = path.join(tmpDir, 'to-delete.txt');
    fs.writeFileSync(filePath, 'Delete me');
    const ctx = makeCtx();

    const result = await adapter.execute({ path: filePath, force: false }, ctx);
    expect(result.success).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(ctx.budget.filesChanged).toBe(1);
    expect(result.artifacts!.some((a) => a.type === 'checksum')).toBe(true);
  });

  it('should fail when file does not exist (force=false)', async () => {
    const result = await adapter.execute(
      { path: path.join(tmpDir, 'nope.txt'), force: false },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('does not exist');
  });

  it('should succeed when file does not exist (force=true)', async () => {
    const result = await adapter.execute(
      { path: path.join(tmpDir, 'nope.txt'), force: true },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    expect((result.output as { deleted: boolean }).deleted).toBe(false);
  });

  it('should fail when path is a directory', async () => {
    const dirPath = path.join(tmpDir, 'subdir');
    fs.mkdirSync(dirPath);

    const result = await adapter.execute({ path: dirPath, force: false }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toContain('directory');
  });

  it('should rollback by restoring deleted file', async () => {
    const filePath = path.join(tmpDir, 'rollback-delete.txt');
    fs.writeFileSync(filePath, 'Restore me');
    const ctx = makeCtx();

    await adapter.execute({ path: filePath, force: false }, ctx);
    expect(fs.existsSync(filePath)).toBe(false);

    const rollbackResult = await adapter.rollback({ path: filePath, force: false }, ctx);
    expect(rollbackResult.success).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('Restore me');
  });

  it('should produce correct dry run output', async () => {
    const filePath = path.join(tmpDir, 'dry-run.txt');
    fs.writeFileSync(filePath, 'data');

    const result = await adapter.dryRun({ path: filePath, force: false }, makeCtx());
    expect(result.wouldDo).toContain('Delete file');
    expect(result.estimatedChanges!.length).toBe(1);
  });

  it('should warn on dry run for non-existent file', async () => {
    const result = await adapter.dryRun(
      { path: path.join(tmpDir, 'nope.txt'), force: false },
      makeCtx(),
    );
    expect(result.warnings!.length).toBeGreaterThan(0);
  });
});
