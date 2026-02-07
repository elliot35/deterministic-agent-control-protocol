import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DirectoryListAdapter } from '../../src/tools/directory-list.js';
import { DirectoryCreateAdapter } from '../../src/tools/directory-create.js';
import type { ExecutionContext, Policy } from '../../src/types.js';

let tmpDir: string;

function makePolicy(): Policy {
  return {
    version: '1.0',
    name: 'test',
    capabilities: [
      { tool: 'directory:list', scope: { paths: [`${tmpDir}/**`] } },
      { tool: 'directory:create', scope: { paths: [`${tmpDir}/**`] } },
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dir-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('DirectoryListAdapter', () => {
  const adapter = new DirectoryListAdapter();

  it('should validate allowed directory list', () => {
    const subDir = `${tmpDir}/subdir`;
    const result = adapter.validate(
      { path: subDir },
      makePolicy(),
    );
    expect(result.verdict).toBe('allow');
  });

  it('should deny list outside scope', () => {
    const result = adapter.validate(
      { path: '/etc' },
      makePolicy(),
    );
    expect(result.verdict).toBe('deny');
  });

  it('should execute list and return entries', async () => {
    fs.writeFileSync(path.join(tmpDir, 'file1.txt'), 'a');
    fs.writeFileSync(path.join(tmpDir, 'file2.txt'), 'b');
    fs.mkdirSync(path.join(tmpDir, 'subdir'));

    const result = await adapter.execute(
      { path: tmpDir, recursive: false, maxDepth: 5 },
      makeCtx(),
    );
    expect(result.success).toBe(true);

    const output = result.output as { entries: Array<{ name: string; type: string }> };
    expect(output.entries.length).toBe(3);
    expect(output.entries.some((e) => e.name === 'file1.txt' && e.type === 'file')).toBe(true);
    expect(output.entries.some((e) => e.name === 'subdir' && e.type === 'directory')).toBe(true);
  });

  it('should list recursively', async () => {
    fs.writeFileSync(path.join(tmpDir, 'top.txt'), 'a');
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    fs.writeFileSync(path.join(tmpDir, 'sub', 'deep.txt'), 'b');

    const result = await adapter.execute(
      { path: tmpDir, recursive: true, maxDepth: 5 },
      makeCtx(),
    );
    expect(result.success).toBe(true);

    const output = result.output as { entries: Array<{ name: string }> };
    expect(output.entries.some((e) => e.name === 'deep.txt')).toBe(true);
  });

  it('should fail on non-existent directory', async () => {
    const result = await adapter.execute(
      { path: path.join(tmpDir, 'nope'), recursive: false, maxDepth: 5 },
      makeCtx(),
    );
    expect(result.success).toBe(false);
  });

  it('should fail on file path', async () => {
    const filePath = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(filePath, 'data');

    const result = await adapter.execute(
      { path: filePath, recursive: false, maxDepth: 5 },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('not a directory');
  });

  it('should rollback as no-op', async () => {
    const result = await adapter.rollback({}, makeCtx());
    expect(result.success).toBe(true);
  });
});

describe('DirectoryCreateAdapter', () => {
  const adapter = new DirectoryCreateAdapter();

  it('should validate allowed directory create', () => {
    const result = adapter.validate(
      { path: `${tmpDir}/new-dir` },
      makePolicy(),
    );
    expect(result.verdict).toBe('allow');
  });

  it('should execute and create directory', async () => {
    const dirPath = path.join(tmpDir, 'new-dir');
    const ctx = makeCtx();

    const result = await adapter.execute(
      { path: dirPath, recursive: true },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(fs.existsSync(dirPath)).toBe(true);
    expect(fs.statSync(dirPath).isDirectory()).toBe(true);
  });

  it('should create nested directories recursively', async () => {
    const deepPath = path.join(tmpDir, 'a', 'b', 'c');
    const ctx = makeCtx();

    const result = await adapter.execute(
      { path: deepPath, recursive: true },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(fs.existsSync(deepPath)).toBe(true);
  });

  it('should succeed silently when directory already exists', async () => {
    const dirPath = path.join(tmpDir, 'existing');
    fs.mkdirSync(dirPath);

    const result = await adapter.execute(
      { path: dirPath, recursive: true },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    expect((result.output as { created: boolean }).created).toBe(false);
  });

  it('should rollback by removing created directories', async () => {
    const dirPath = path.join(tmpDir, 'rollback-dir', 'sub');
    const ctx = makeCtx();

    await adapter.execute({ path: dirPath, recursive: true }, ctx);
    expect(fs.existsSync(dirPath)).toBe(true);

    const rollbackResult = await adapter.rollback({ path: dirPath, recursive: true }, ctx);
    expect(rollbackResult.success).toBe(true);
    // The deepest directory should be removed
    expect(fs.existsSync(dirPath)).toBe(false);
  });

  it('should produce correct dry run output', async () => {
    const result = await adapter.dryRun(
      { path: path.join(tmpDir, 'new-dir'), recursive: true },
      makeCtx(),
    );
    expect(result.wouldDo).toContain('Create directory');
  });
});
