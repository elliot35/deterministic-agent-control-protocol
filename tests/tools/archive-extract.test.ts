import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ArchiveExtractAdapter } from '../../src/tools/archive-extract.js';
import type { ExecutionContext, Policy } from '../../src/types.js';

let tmpDir: string;

function makePolicy(): Policy {
  return {
    version: '1.0',
    name: 'test',
    capabilities: [
      { tool: 'archive:extract', scope: { paths: [`${tmpDir}/**`] } },
    ],
    limits: { max_files_changed: 50 },
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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ArchiveExtractAdapter', () => {
  const adapter = new ArchiveExtractAdapter();

  it('should validate input', () => {
    const result = adapter.validate(
      { archive: `${tmpDir}/test.tar.gz`, destination: `${tmpDir}/out` },
      makePolicy(),
    );
    expect(result.verdict).toBe('allow');
  });

  it('should deny empty archive path', () => {
    const result = adapter.validate(
      { archive: '', destination: `${tmpDir}/out` },
      makePolicy(),
    );
    expect(result.verdict).toBe('deny');
  });

  it('should extract a tar.gz archive', async () => {
    // Create test files and archive
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'file1.txt'), 'Content 1');
    fs.writeFileSync(path.join(srcDir, 'file2.txt'), 'Content 2');

    const archivePath = path.join(tmpDir, 'test.tar.gz');
    execSync(`tar czf "${archivePath}" -C "${srcDir}" .`, { stdio: 'pipe' });

    const destDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(destDir);

    const ctx = makeCtx();
    const result = await adapter.execute(
      { archive: archivePath, destination: destDir, timeout: 30000 },
      ctx,
    );
    expect(result.success).toBe(true);

    const output = result.output as { filesExtracted: number };
    expect(output.filesExtracted).toBeGreaterThanOrEqual(2);

    // Verify files were extracted
    expect(fs.existsSync(path.join(destDir, 'file1.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(destDir, 'file1.txt'), 'utf-8')).toBe('Content 1');
  });

  it('should fail on non-existent archive', async () => {
    const destDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(destDir);

    const result = await adapter.execute(
      { archive: path.join(tmpDir, 'nope.tar.gz'), destination: destDir, timeout: 30000 },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('does not exist');
  });

  it('should fail on non-existent destination', async () => {
    const archivePath = path.join(tmpDir, 'test.tar.gz');
    fs.writeFileSync(archivePath, ''); // Dummy file

    const result = await adapter.execute(
      { archive: archivePath, destination: path.join(tmpDir, 'nope'), timeout: 30000 },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('does not exist');
  });

  it('should rollback by removing extracted files', async () => {
    // Create test archive
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'extracted.txt'), 'Delete me');

    const archivePath = path.join(tmpDir, 'rollback.tar.gz');
    execSync(`tar czf "${archivePath}" -C "${srcDir}" .`, { stdio: 'pipe' });

    const destDir = path.join(tmpDir, 'rollback-dest');
    fs.mkdirSync(destDir);

    const ctx = makeCtx();
    await adapter.execute(
      { archive: archivePath, destination: destDir, timeout: 30000 },
      ctx,
    );
    expect(fs.existsSync(path.join(destDir, 'extracted.txt'))).toBe(true);

    const rollbackResult = await adapter.rollback(
      { archive: archivePath, destination: destDir, timeout: 30000 },
      ctx,
    );
    expect(rollbackResult.success).toBe(true);
    expect(fs.existsSync(path.join(destDir, 'extracted.txt'))).toBe(false);
  });

  it('should produce correct dry run output', async () => {
    const archivePath = path.join(tmpDir, 'test.tar.gz');
    fs.writeFileSync(archivePath, '');
    const destDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(destDir);

    const result = await adapter.dryRun(
      { archive: archivePath, destination: destDir, timeout: 30000 },
      makeCtx(),
    );
    expect(result.wouldDo).toContain('Extract');
  });

  it('should produce checksum artifact for archive', async () => {
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'file.txt'), 'Data');

    const archivePath = path.join(tmpDir, 'checksum.tar.gz');
    execSync(`tar czf "${archivePath}" -C "${srcDir}" .`, { stdio: 'pipe' });

    const destDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(destDir);

    const result = await adapter.execute(
      { archive: archivePath, destination: destDir, timeout: 30000 },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    expect(result.artifacts!.some((a) => a.type === 'checksum')).toBe(true);
  });
});
