import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileReadAdapter } from '../../src/tools/file-read.js';
import { FileWriteAdapter } from '../../src/tools/file-write.js';
import type { ExecutionContext, Policy } from '../../src/types.js';

let tmpDir: string;

function makePolicy(): Policy {
  return {
    version: '1.0',
    name: 'test',
    capabilities: [
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('FileReadAdapter', () => {
  const adapter = new FileReadAdapter();

  it('should validate allowed file read', () => {
    const result = adapter.validate(
      { path: `${tmpDir}/test.txt` },
      makePolicy(),
    );
    expect(result.verdict).toBe('allow');
  });

  it('should deny read outside scope', () => {
    const result = adapter.validate(
      { path: '/etc/passwd' },
      makePolicy(),
    );
    expect(result.verdict).toBe('deny');
  });

  it('should deny read of .env files', () => {
    const result = adapter.validate(
      { path: `${tmpDir}/.env` },
      makePolicy(),
    );
    expect(result.verdict).toBe('deny');
  });

  it('should execute and return file contents with checksum', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'Hello World');

    const result = await adapter.execute({ path: filePath, encoding: 'utf-8' }, makeCtx());
    expect(result.success).toBe(true);
    expect((result.output as any).content).toBe('Hello World');
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts![0].type).toBe('checksum');
  });

  it('should fail on non-existent file', async () => {
    const result = await adapter.execute({ path: path.join(tmpDir, 'nope.txt'), encoding: 'utf-8' }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('should dry run successfully', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'data');

    const result = await adapter.dryRun({ path: filePath, encoding: 'utf-8' }, makeCtx());
    expect(result.wouldDo).toContain('Read file');
    expect(result.warnings).toHaveLength(0);
  });

  it('should warn on dry run for non-existent file', async () => {
    const result = await adapter.dryRun({ path: path.join(tmpDir, 'nope.txt'), encoding: 'utf-8' }, makeCtx());
    expect(result.warnings!.length).toBeGreaterThan(0);
  });

  it('should rollback as no-op', async () => {
    const result = await adapter.rollback({}, makeCtx());
    expect(result.success).toBe(true);
  });
});

describe('FileWriteAdapter', () => {
  const adapter = new FileWriteAdapter();

  it('should validate allowed file write', () => {
    const result = adapter.validate(
      { path: `${tmpDir}/out.txt`, content: 'data' },
      makePolicy(),
    );
    expect(result.verdict).toBe('allow');
  });

  it('should execute write and create file', async () => {
    const filePath = path.join(tmpDir, 'new-file.txt');
    const ctx = makeCtx();

    const result = await adapter.execute(
      { path: filePath, content: 'Hello', encoding: 'utf-8', createDirs: false },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('Hello');
    expect(ctx.budget.filesChanged).toBe(1);
  });

  it('should create backup for rollback on overwrite', async () => {
    const filePath = path.join(tmpDir, 'existing.txt');
    fs.writeFileSync(filePath, 'Original');
    const ctx = makeCtx();

    const result = await adapter.execute(
      { path: filePath, content: 'Modified', encoding: 'utf-8', createDirs: false },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('Modified');

    // Rollback should restore original
    const rollbackResult = await adapter.rollback(
      { path: filePath, content: 'Modified', encoding: 'utf-8', createDirs: false },
      ctx,
    );
    expect(rollbackResult.success).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('Original');
  });

  it('should rollback newly created files by deleting them', async () => {
    const filePath = path.join(tmpDir, 'rollback-new.txt');
    const ctx = makeCtx();

    await adapter.execute(
      { path: filePath, content: 'New file', encoding: 'utf-8', createDirs: false },
      ctx,
    );
    expect(fs.existsSync(filePath)).toBe(true);

    await adapter.rollback(
      { path: filePath, content: 'New file', encoding: 'utf-8', createDirs: false },
      ctx,
    );
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('should produce diff artifacts on overwrite', async () => {
    const filePath = path.join(tmpDir, 'diff-test.txt');
    fs.writeFileSync(filePath, 'Before');

    const result = await adapter.execute(
      { path: filePath, content: 'After', encoding: 'utf-8', createDirs: false },
      makeCtx(),
    );
    expect(result.artifacts!.some((a) => a.type === 'diff')).toBe(true);
    expect(result.artifacts!.some((a) => a.type === 'checksum')).toBe(true);
  });
});
