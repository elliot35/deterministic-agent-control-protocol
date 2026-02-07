import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentGateway } from '../../src/engine/runtime.js';

let tmpDir: string;
let ledgerDir: string;

const POLICY_YAML = `
version: "1.0"
name: "test-gateway-policy"
capabilities:
  - tool: "file:read"
    scope:
      paths: ["/data/**"]
  - tool: "file:write"
    scope:
      paths: ["/data/out/**"]
  - tool: "command:run"
    scope:
      binaries: ["echo", "ls"]
limits:
  max_runtime_ms: 60000
  max_files_changed: 50
gates: []
evidence:
  require: ["checksums"]
  format: "jsonl"
forbidden:
  - pattern: "**/.env"
  - pattern: "rm -rf"
session:
  max_actions: 100
  max_denials: 10
`;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-test-'));
  ledgerDir = path.join(tmpDir, 'ledgers');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('AgentGateway', () => {
  it('should create a gateway with default registry', async () => {
    const gateway = await AgentGateway.create({ ledgerDir });
    const tools = gateway.getRegistry().listTools();
    expect(tools).toContain('file:read');
    expect(tools).toContain('file:write');
    expect(tools).toContain('command:run');
    expect(tools).toContain('http:request');
    expect(tools).toContain('git:diff');
    expect(tools).toContain('git:apply');
  });

  it('should create a session from inline YAML', async () => {
    const gateway = await AgentGateway.create({ ledgerDir });
    const session = await gateway.createSession(POLICY_YAML, { agent: 'test' });

    expect(session.id).toBeTruthy();
    expect(session.state).toBe('active');
    expect(session.policy.name).toBe('test-gateway-policy');
    expect(session.metadata?.agent).toBe('test');
  });

  it('should evaluate and allow an action', async () => {
    const gateway = await AgentGateway.create({ ledgerDir });
    const session = await gateway.createSession(POLICY_YAML);

    const result = await gateway.evaluate(session.id, {
      tool: 'file:read',
      input: { path: '/data/test.txt' },
    });

    expect(result.decision).toBe('allow');
    expect(result.actionId).toBeTruthy();
    expect(result.budgetRemaining).toBeDefined();
  });

  it('should evaluate and deny an action outside scope', async () => {
    const gateway = await AgentGateway.create({ ledgerDir });
    const session = await gateway.createSession(POLICY_YAML);

    const result = await gateway.evaluate(session.id, {
      tool: 'file:read',
      input: { path: '/etc/passwd' },
    });

    expect(result.decision).toBe('deny');
    expect(result.reasons[0]).toContain('outside allowed scope');
  });

  it('should deny forbidden patterns', async () => {
    const gateway = await AgentGateway.create({ ledgerDir });
    const session = await gateway.createSession(POLICY_YAML);

    const result = await gateway.evaluate(session.id, {
      tool: 'command:run',
      input: { command: 'rm -rf /tmp' },
    });

    expect(result.decision).toBe('deny');
  });

  it('should record results', async () => {
    const gateway = await AgentGateway.create({ ledgerDir });
    const session = await gateway.createSession(POLICY_YAML);

    const evaluation = await gateway.evaluate(session.id, {
      tool: 'file:read',
      input: { path: '/data/test.txt' },
    });

    await gateway.recordResult(session.id, evaluation.actionId, {
      success: true,
      output: 'file contents here',
      durationMs: 5,
    });

    const updated = gateway.getSession(session.id)!;
    expect(updated.actions[0].result!.success).toBe(true);
  });

  it('should terminate a session and get report', async () => {
    const gateway = await AgentGateway.create({ ledgerDir });
    const session = await gateway.createSession(POLICY_YAML);

    await gateway.evaluate(session.id, { tool: 'file:read', input: { path: '/data/a.txt' } });
    await gateway.evaluate(session.id, { tool: 'file:read', input: { path: '/etc/nope' } });
    await gateway.evaluate(session.id, { tool: 'file:write', input: { path: '/data/out/b.txt', content: 'hi' } });

    const report = await gateway.terminateSession(session.id, 'test done');
    expect(report.sessionId).toBe(session.id);
    expect(report.state).toBe('terminated');
    expect(report.totalActions).toBe(3);
    expect(report.allowed).toBe(2);
    expect(report.denied).toBe(1);
  });

  it('should list sessions', async () => {
    const gateway = await AgentGateway.create({ ledgerDir });
    await gateway.createSession(POLICY_YAML);
    await gateway.createSession(POLICY_YAML);

    const sessions = gateway.listSessions();
    expect(sessions).toHaveLength(2);
  });

  it('should produce ledger with integrity', async () => {
    const gateway = await AgentGateway.create({ ledgerDir });
    const session = await gateway.createSession(POLICY_YAML);

    await gateway.evaluate(session.id, { tool: 'file:read', input: { path: '/data/test.txt' } });
    await gateway.terminateSession(session.id, 'done');

    const ledger = gateway.getSessionLedger(session.id);
    expect(ledger).toBeTruthy();

    const { EvidenceLedger } = await import('../../src/ledger/ledger.js');
    const integrity = EvidenceLedger.verifyIntegrity(ledger!.getFilePath());
    expect(integrity.valid).toBe(true);
    expect(integrity.totalEntries).toBeGreaterThan(0);
  });

  it('should invoke onStateChange callback', async () => {
    const transitions: string[] = [];
    const gateway = await AgentGateway.create({
      ledgerDir,
      onStateChange: (_sessionId, from, to) => {
        transitions.push(`${from}->${to}`);
      },
    });

    const session = await gateway.createSession(POLICY_YAML);
    await gateway.terminateSession(session.id, 'test');

    expect(transitions).toContain('active->terminated');
  });

  it('should get session report', async () => {
    const gateway = await AgentGateway.create({ ledgerDir });
    const session = await gateway.createSession(POLICY_YAML);

    await gateway.evaluate(session.id, { tool: 'file:read', input: { path: '/data/test.txt' } });

    const report = gateway.getSessionReport(session.id);
    expect(report.totalActions).toBe(1);
    expect(report.allowed).toBe(1);
  });
});
