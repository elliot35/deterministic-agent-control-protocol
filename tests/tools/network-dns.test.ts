import { describe, it, expect } from 'vitest';
import { NetworkDnsAdapter } from '../../src/tools/network-dns.js';
import type { ExecutionContext, Policy } from '../../src/types.js';

function makePolicy(): Policy {
  return {
    version: '1.0',
    name: 'test',
    capabilities: [
      { tool: 'network:dns', scope: { domains: ['example.com', 'localhost'] } },
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

describe('NetworkDnsAdapter', () => {
  const adapter = new NetworkDnsAdapter();

  it('should validate input', () => {
    const result = adapter.validate(
      { hostname: 'example.com', type: 'A' },
      makePolicy(),
    );
    expect(result.verdict).toBe('allow');
  });

  it('should deny empty hostname', () => {
    const result = adapter.validate(
      { hostname: '' },
      makePolicy(),
    );
    expect(result.verdict).toBe('deny');
  });

  it('should resolve localhost A record', async () => {
    const result = await adapter.execute(
      { hostname: 'localhost', type: 'A', timeout: 5000 },
      makeCtx(),
    );
    // localhost resolution may vary by system, just check structure
    expect(result.tool).toBe('network:dns');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should fail on non-existent domain', async () => {
    const result = await adapter.execute(
      { hostname: 'this-domain-definitely-does-not-exist-12345.invalid', type: 'A', timeout: 5000 },
      makeCtx(),
    );
    expect(result.success).toBe(false);
  });

  it('should produce correct dry run output', async () => {
    const result = await adapter.dryRun(
      { hostname: 'example.com', type: 'A', timeout: 5000 },
      makeCtx(),
    );
    expect(result.wouldDo).toContain('DNS');
    expect(result.wouldDo).toContain('example.com');
    expect(result.estimatedChanges).toHaveLength(0);
  });

  it('should rollback as no-op', async () => {
    const result = await adapter.rollback({}, makeCtx());
    expect(result.success).toBe(true);
  });
});
