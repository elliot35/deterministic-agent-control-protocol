import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionManager } from '../../src/engine/session.js';
import { GateManager } from '../../src/engine/gate.js';
import type { Policy, Session, ActionRequest, ValidationResult } from '../../src/types.js';

let tmpDir: string;
let ledgerDir: string;

function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    version: '1.0',
    name: 'test-evo-session',
    capabilities: [
      { tool: 'file:read', scope: { paths: ['/data/**'] } },
      { tool: 'command:run', scope: { binaries: ['ls', 'echo'] } },
    ],
    limits: { max_runtime_ms: 60000, max_files_changed: 10 },
    gates: [],
    evidence: { require: ['checksums'], format: 'jsonl' },
    forbidden: [{ pattern: '**/.env' }],
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-evo-test-'));
  ledgerDir = path.join(tmpDir, 'ledgers');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SessionManager onDenial hook', () => {
  it('re-evaluates when onDenial returns retry and policy was mutated', async () => {
    const gateManager = new GateManager();

    // onDenial handler that adds the missing capability and returns 'retry'
    const onDenial = vi.fn(
      async (session: Session, _action: ActionRequest, _result: ValidationResult) => {
        // Mutate the policy to add file:write capability
        session.policy.capabilities.push({
          tool: 'file:write',
          scope: { paths: ['/data/out/**'] },
        });
        return 'retry' as const;
      },
    );

    const mgr = new SessionManager({ ledgerDir, gateManager, onDenial });
    const session = await mgr.createSession(makePolicy());

    // Try to write — initially denied (no file:write capability)
    const result = await mgr.evaluate(session.id, {
      tool: 'file:write',
      input: { path: '/data/out/test.txt' },
    });

    // After retry, should now be allowed
    expect(result.decision).toBe('allow');
    expect(onDenial).toHaveBeenCalledOnce();

    // Budget should reflect the allow, not the intermediate deny
    const updated = mgr.getSession(session.id)!;
    expect(updated.budget.actionsDenied).toBe(0);
    expect(updated.budget.actionsEvaluated).toBe(1);
  });

  it('keeps deny when onDenial returns deny', async () => {
    const gateManager = new GateManager();

    const onDenial = vi.fn(async () => 'deny' as const);

    const mgr = new SessionManager({ ledgerDir, gateManager, onDenial });
    const session = await mgr.createSession(makePolicy());

    const result = await mgr.evaluate(session.id, {
      tool: 'file:write',
      input: { path: '/data/out/test.txt' },
    });

    expect(result.decision).toBe('deny');
    expect(onDenial).toHaveBeenCalledOnce();

    const updated = mgr.getSession(session.id)!;
    expect(updated.budget.actionsDenied).toBe(1);
  });

  it('does not call onDenial for allowed actions', async () => {
    const gateManager = new GateManager();

    const onDenial = vi.fn(async () => 'deny' as const);

    const mgr = new SessionManager({ ledgerDir, gateManager, onDenial });
    const session = await mgr.createSession(makePolicy());

    const result = await mgr.evaluate(session.id, {
      tool: 'file:read',
      input: { path: '/data/test.txt' },
    });

    expect(result.decision).toBe('allow');
    expect(onDenial).not.toHaveBeenCalled();
  });

  it('correctly adjusts deny counter on retry that results in deny again', async () => {
    const gateManager = new GateManager();

    // onDenial returns retry but does NOT fix the policy
    const onDenial = vi.fn(async () => 'retry' as const);

    const mgr = new SessionManager({ ledgerDir, gateManager, onDenial });
    const session = await mgr.createSession(makePolicy());

    const result = await mgr.evaluate(session.id, {
      tool: 'file:write',
      input: { path: '/data/out/test.txt' },
    });

    // Still denied because policy wasn't actually changed
    expect(result.decision).toBe('deny');

    // Deny counter should be exactly 1 (decremented then re-incremented)
    const updated = mgr.getSession(session.id)!;
    expect(updated.budget.actionsDenied).toBe(1);
  });

  it('works correctly without onDenial configured (default behaviour)', async () => {
    const gateManager = new GateManager();

    // No onDenial hook
    const mgr = new SessionManager({ ledgerDir, gateManager });
    const session = await mgr.createSession(makePolicy());

    const result = await mgr.evaluate(session.id, {
      tool: 'file:write',
      input: { path: '/data/out/test.txt' },
    });

    expect(result.decision).toBe('deny');

    const updated = mgr.getSession(session.id)!;
    expect(updated.budget.actionsDenied).toBe(1);
  });
});
