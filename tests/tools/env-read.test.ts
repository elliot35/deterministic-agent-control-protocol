import { describe, it, expect, afterEach } from 'vitest';
import { EnvReadAdapter } from '../../src/tools/env-read.js';
import type { ExecutionContext, Policy } from '../../src/types.js';

function makePolicy(): Policy {
  return {
    version: '1.0',
    name: 'test',
    capabilities: [
      { tool: 'env:read', scope: {} },
    ],
    limits: {},
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

describe('EnvReadAdapter', () => {
  const adapter = new EnvReadAdapter();
  const TEST_VAR = 'DET_ACP_TEST_ENV_VAR';
  const TEST_SECRET = 'DET_ACP_TEST_SECRET_KEY';

  afterEach(() => {
    delete process.env[TEST_VAR];
    delete process.env[TEST_SECRET];
  });

  it('should read an existing environment variable', async () => {
    process.env[TEST_VAR] = 'test-value';

    const result = await adapter.execute(
      { name: TEST_VAR, redact: false },
      makeCtx(),
    );
    expect(result.success).toBe(true);

    const output = result.output as { name: string; value: string; exists: boolean };
    expect(output.name).toBe(TEST_VAR);
    expect(output.value).toBe('test-value');
    expect(output.exists).toBe(true);
  });

  it('should fail for non-existent environment variable', async () => {
    const result = await adapter.execute(
      { name: 'DEFINITELY_NOT_SET_12345', redact: false },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('not set');
  });

  it('should auto-redact sensitive variables', async () => {
    process.env[TEST_SECRET] = 'super-secret-value';

    const result = await adapter.execute(
      { name: TEST_SECRET, redact: false },
      makeCtx(),
    );
    expect(result.success).toBe(true);

    // Evidence should have redacted log
    const logArtifact = result.artifacts!.find((a) => a.type === 'log');
    expect(logArtifact).toBeTruthy();
    expect(logArtifact!.value).toContain('[REDACTED]');
    expect(logArtifact!.value).not.toContain('super-secret-value');
  });

  it('should redact when redact flag is set', async () => {
    process.env[TEST_VAR] = 'should-be-hidden';

    const result = await adapter.execute(
      { name: TEST_VAR, redact: true },
      makeCtx(),
    );
    expect(result.success).toBe(true);

    const logArtifact = result.artifacts!.find((a) => a.type === 'log');
    expect(logArtifact!.value).toContain('[REDACTED]');
    expect(logArtifact!.value).not.toContain('should-be-hidden');
  });

  it('should always produce a value hash artifact', async () => {
    process.env[TEST_VAR] = 'hash-me';

    const result = await adapter.execute(
      { name: TEST_VAR, redact: false },
      makeCtx(),
    );
    expect(result.success).toBe(true);

    const checksumArtifact = result.artifacts!.find((a) => a.type === 'checksum');
    expect(checksumArtifact).toBeTruthy();
    expect(checksumArtifact!.value).toMatch(/^sha256:/);
  });

  it('should rollback as no-op', async () => {
    const result = await adapter.rollback({}, makeCtx());
    expect(result.success).toBe(true);
  });

  it('should produce correct dry run output', async () => {
    process.env[TEST_VAR] = 'dry-run-val';

    const result = await adapter.dryRun(
      { name: TEST_VAR, redact: false },
      makeCtx(),
    );
    expect(result.wouldDo).toContain('Read environment variable');
    expect(result.warnings).toHaveLength(0);
  });

  it('should warn on dry run for non-existent variable', async () => {
    const result = await adapter.dryRun(
      { name: 'DEFINITELY_NOT_SET_12345', redact: false },
      makeCtx(),
    );
    expect(result.warnings!.some((w) => w.includes('not set'))).toBe(true);
  });

  it('should warn on dry run for sensitive variable', async () => {
    process.env[TEST_SECRET] = 'sensitive';

    const result = await adapter.dryRun(
      { name: TEST_SECRET, redact: false },
      makeCtx(),
    );
    expect(result.warnings!.some((w) => w.includes('sensitive'))).toBe(true);
  });

  it('should validate input', () => {
    const result = adapter.validate(
      { name: TEST_VAR },
      makePolicy(),
    );
    expect(result.verdict).toBe('allow');
  });

  it('should deny empty name', () => {
    const result = adapter.validate(
      { name: '' },
      makePolicy(),
    );
    expect(result.verdict).toBe('deny');
  });
});
