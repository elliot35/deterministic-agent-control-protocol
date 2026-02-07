import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionManager } from '../../src/engine/session.js';
import { GateManager } from '../../src/engine/gate.js';
import type { Policy } from '../../src/types.js';

let tmpDir: string;
let ledgerDir: string;

function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    version: '1.0',
    name: 'test-session-policy',
    capabilities: [
      { tool: 'file:read', scope: { paths: ['/data/**'] } },
      { tool: 'file:write', scope: { paths: ['/data/out/**'] } },
      { tool: 'command:run', scope: { binaries: ['ls', 'echo'] } },
    ],
    limits: { max_runtime_ms: 60000, max_files_changed: 10 },
    gates: [],
    evidence: { require: ['checksums'], format: 'jsonl' },
    forbidden: [{ pattern: '**/.env' }, { pattern: 'rm -rf' }],
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-test-'));
  ledgerDir = path.join(tmpDir, 'ledgers');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SessionManager', () => {
  it('should create a session', async () => {
    const gateManager = new GateManager();
    const mgr = new SessionManager({ ledgerDir, gateManager });

    const session = await mgr.createSession(makePolicy(), { agent: 'test-agent' });
    expect(session.id).toBeTruthy();
    expect(session.state).toBe('active');
    expect(session.actions).toHaveLength(0);
    expect(session.metadata?.agent).toBe('test-agent');
  });

  it('should evaluate and allow an action', async () => {
    const gateManager = new GateManager();
    const mgr = new SessionManager({ ledgerDir, gateManager });

    const session = await mgr.createSession(makePolicy());
    const result = await mgr.evaluate(session.id, {
      tool: 'file:read',
      input: { path: '/data/test.txt' },
    });

    expect(result.decision).toBe('allow');
    expect(result.actionId).toBeTruthy();
    expect(result.budgetRemaining).toBeDefined();

    // Session should have one action
    const updated = mgr.getSession(session.id)!;
    expect(updated.actions).toHaveLength(1);
    expect(updated.budget.actionsEvaluated).toBe(1);
  });

  it('should evaluate and deny an action outside scope', async () => {
    const gateManager = new GateManager();
    const mgr = new SessionManager({ ledgerDir, gateManager });

    const session = await mgr.createSession(makePolicy());
    const result = await mgr.evaluate(session.id, {
      tool: 'file:read',
      input: { path: '/etc/passwd' },
    });

    expect(result.decision).toBe('deny');

    const updated = mgr.getSession(session.id)!;
    expect(updated.budget.actionsDenied).toBe(1);
  });

  it('should deny forbidden patterns', async () => {
    const gateManager = new GateManager();
    const mgr = new SessionManager({ ledgerDir, gateManager });

    const session = await mgr.createSession(makePolicy());
    const result = await mgr.evaluate(session.id, {
      tool: 'command:run',
      input: { command: 'rm -rf /tmp' },
    });

    expect(result.decision).toBe('deny');
  });

  it('should record action results', async () => {
    const gateManager = new GateManager();
    const mgr = new SessionManager({ ledgerDir, gateManager });

    const session = await mgr.createSession(makePolicy());
    const evaluation = await mgr.evaluate(session.id, {
      tool: 'file:read',
      input: { path: '/data/test.txt' },
    });

    await mgr.recordResult(session.id, evaluation.actionId, {
      success: true,
      output: 'file contents',
      durationMs: 15,
    });

    const updated = mgr.getSession(session.id)!;
    expect(updated.actions[0].result).toBeDefined();
    expect(updated.actions[0].result!.success).toBe(true);
  });

  it('should reject duplicate result recording', async () => {
    const gateManager = new GateManager();
    const mgr = new SessionManager({ ledgerDir, gateManager });

    const session = await mgr.createSession(makePolicy());
    const evaluation = await mgr.evaluate(session.id, {
      tool: 'file:read',
      input: { path: '/data/test.txt' },
    });

    await mgr.recordResult(session.id, evaluation.actionId, {
      success: true,
      output: 'data',
    });

    await expect(
      mgr.recordResult(session.id, evaluation.actionId, { success: true }),
    ).rejects.toThrow('Result already recorded');
  });

  it('should terminate a session and produce a report', async () => {
    const gateManager = new GateManager();
    const mgr = new SessionManager({ ledgerDir, gateManager });

    const session = await mgr.createSession(makePolicy());
    await mgr.evaluate(session.id, { tool: 'file:read', input: { path: '/data/a.txt' } });
    await mgr.evaluate(session.id, { tool: 'file:read', input: { path: '/etc/nope' } }); // denied

    const report = await mgr.terminate(session.id, 'test complete');

    expect(report.sessionId).toBe(session.id);
    expect(report.state).toBe('terminated');
    expect(report.totalActions).toBe(2);
    expect(report.allowed).toBe(1);
    expect(report.denied).toBe(1);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);

    const updated = mgr.getSession(session.id)!;
    expect(updated.state).toBe('terminated');
    expect(updated.terminationReason).toBe('test complete');
  });

  it('should list sessions', async () => {
    const gateManager = new GateManager();
    const mgr = new SessionManager({ ledgerDir, gateManager });

    await mgr.createSession(makePolicy());
    await mgr.createSession(makePolicy());

    const sessions = mgr.listSessions();
    expect(sessions).toHaveLength(2);
  });

  it('should enforce session max_actions constraint', async () => {
    const gateManager = new GateManager();
    const mgr = new SessionManager({ ledgerDir, gateManager });

    const policy = makePolicy({ session: { max_actions: 2 } });
    const session = await mgr.createSession(policy);

    await mgr.evaluate(session.id, { tool: 'file:read', input: { path: '/data/a.txt' } });
    await mgr.evaluate(session.id, { tool: 'file:read', input: { path: '/data/b.txt' } });

    // Third action should be denied
    const result = await mgr.evaluate(session.id, { tool: 'file:read', input: { path: '/data/c.txt' } });
    expect(result.decision).toBe('deny');
    expect(result.reasons[0]).toContain('action limit reached');
  });

  it('should handle gates with auto-approve', async () => {
    const gateManager = new GateManager();
    const mgr = new SessionManager({ ledgerDir, gateManager });

    const policy = makePolicy({
      gates: [{ action: 'file:write', approval: 'auto', risk_level: 'medium' }],
    });

    const session = await mgr.createSession(policy);
    const result = await mgr.evaluate(session.id, {
      tool: 'file:write',
      input: { path: '/data/out/test.txt', content: 'data' },
    });

    // Auto-approved gate should return 'allow'
    expect(result.decision).toBe('allow');
  });

  it('should produce ledger with integrity', async () => {
    const gateManager = new GateManager();
    const mgr = new SessionManager({ ledgerDir, gateManager });

    const session = await mgr.createSession(makePolicy());
    await mgr.evaluate(session.id, { tool: 'file:read', input: { path: '/data/test.txt' } });
    await mgr.terminate(session.id, 'done');

    const ledger = mgr.getLedger(session.id);
    expect(ledger).toBeTruthy();

    const { EvidenceLedger } = await import('../../src/ledger/ledger.js');
    const integrity = EvidenceLedger.verifyIntegrity(ledger!.getFilePath());
    expect(integrity.valid).toBe(true);
    expect(integrity.totalEntries).toBeGreaterThan(0);
  });
});
