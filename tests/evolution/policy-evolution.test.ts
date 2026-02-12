import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
import { PolicyEvolutionManager } from '../../src/evolution/policy-evolution.js';
import { parsePolicyYaml } from '../../src/policy/loader.js';
import type { Policy, Session, ActionRequest, ValidationResult, BudgetTracker } from '../../src/types.js';
import type { EvolutionDecision, PolicyEvolutionConfig } from '../../src/evolution/types.js';

function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    version: '1.0',
    name: 'test-evo',
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

function makeBudget(): BudgetTracker {
  return {
    startedAt: Date.now(),
    filesChanged: 0,
    totalOutputBytes: 0,
    retries: 0,
    costUsd: 0,
    actionsEvaluated: 0,
    actionsDenied: 0,
  };
}

function makeSession(policy?: Policy): Session {
  return {
    id: 'evo-session',
    policy: policy ?? makePolicy(),
    state: 'active',
    budget: makeBudget(),
    actions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('PolicyEvolutionManager', () => {
  // -------------------------------------------------------------------------
  // Full flow: deny → add-to-policy → retry
  // -------------------------------------------------------------------------

  it('add-to-policy: mutates session policy, writes to disk, returns retry', async () => {
    const policyPath = path.join(tmpDir, 'policy.yaml');
    const session = makeSession();
    // Write initial policy
    fs.writeFileSync(policyPath, yaml.dump(session.policy));

    const handler = vi.fn<[unknown], Promise<EvolutionDecision>>().mockResolvedValue('add-to-policy');

    const mgr = new PolicyEvolutionManager({ policyPath, handler });

    const action: ActionRequest = { tool: 'file:write', input: { path: '/data/out/result.txt' } };
    const result: ValidationResult = {
      verdict: 'deny',
      tool: 'file:write',
      reasons: ['No capability defined for tool "file:write"'],
    };

    const decision = await mgr.handleDenial(session, action, result);

    // Should return retry
    expect(decision).toBe('retry');

    // Handler should have been called
    expect(handler).toHaveBeenCalledOnce();

    // Session policy should be mutated in-place
    const writeCapability = session.policy.capabilities.find((c) => c.tool === 'file:write');
    expect(writeCapability).toBeDefined();

    // File should be written
    const ondisk = parsePolicyYaml(fs.readFileSync(policyPath, 'utf-8'));
    expect(ondisk.capabilities.find((c) => c.tool === 'file:write')).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // allow-once: in-memory only, no file write
  // -------------------------------------------------------------------------

  it('allow-once: mutates session policy but does NOT write to disk', async () => {
    const policyPath = path.join(tmpDir, 'policy.yaml');
    const session = makeSession();
    const originalYaml = yaml.dump(session.policy);
    fs.writeFileSync(policyPath, originalYaml);

    const handler = vi.fn<[unknown], Promise<EvolutionDecision>>().mockResolvedValue('allow-once');

    const mgr = new PolicyEvolutionManager({ policyPath, handler });

    const action: ActionRequest = { tool: 'file:write', input: { path: '/data/out/result.txt' } };
    const result: ValidationResult = {
      verdict: 'deny',
      tool: 'file:write',
      reasons: ['No capability defined for tool "file:write"'],
    };

    const decision = await mgr.handleDenial(session, action, result);

    expect(decision).toBe('retry');

    // In-memory policy should be updated
    expect(session.policy.capabilities.find((c) => c.tool === 'file:write')).toBeDefined();

    // On-disk policy should NOT be updated
    const ondisk = fs.readFileSync(policyPath, 'utf-8');
    expect(ondisk).toBe(originalYaml);
  });

  // -------------------------------------------------------------------------
  // deny: keeps everything as-is
  // -------------------------------------------------------------------------

  it('deny decision: returns deny, no mutation, no file write', async () => {
    const policyPath = path.join(tmpDir, 'policy.yaml');
    const session = makeSession();
    fs.writeFileSync(policyPath, yaml.dump(session.policy));

    const handler = vi.fn<[unknown], Promise<EvolutionDecision>>().mockResolvedValue('deny');

    const mgr = new PolicyEvolutionManager({ policyPath, handler });

    const action: ActionRequest = { tool: 'file:write', input: { path: '/data/out/result.txt' } };
    const result: ValidationResult = {
      verdict: 'deny',
      tool: 'file:write',
      reasons: ['No capability defined for tool "file:write"'],
    };

    const capCountBefore = session.policy.capabilities.length;
    const decision = await mgr.handleDenial(session, action, result);

    expect(decision).toBe('deny');
    expect(session.policy.capabilities).toHaveLength(capCountBefore);
  });

  // -------------------------------------------------------------------------
  // Timeout
  // -------------------------------------------------------------------------

  it('returns deny on timeout without writing to disk', async () => {
    const policyPath = path.join(tmpDir, 'policy.yaml');
    const session = makeSession();
    const originalYaml = yaml.dump(session.policy);
    fs.writeFileSync(policyPath, originalYaml);

    // Handler that never resolves
    const handler = vi.fn<[unknown], Promise<EvolutionDecision>>().mockImplementation(
      () => new Promise(() => {}), // never settles
    );

    const mgr = new PolicyEvolutionManager({
      policyPath,
      handler,
      timeoutMs: 100, // 100ms timeout for test speed
    });

    const action: ActionRequest = { tool: 'file:write', input: { path: '/data/out/result.txt' } };
    const result: ValidationResult = {
      verdict: 'deny',
      tool: 'file:write',
      reasons: ['No capability defined for tool "file:write"'],
    };

    const decision = await mgr.handleDenial(session, action, result);

    expect(decision).toBe('deny');

    // Policy should not be mutated
    expect(session.policy.capabilities.find((c) => c.tool === 'file:write')).toBeUndefined();

    // File should not be changed
    expect(fs.readFileSync(policyPath, 'utf-8')).toBe(originalYaml);
  });

  // -------------------------------------------------------------------------
  // Non-suggestible denials (budget) skip the prompt entirely
  // -------------------------------------------------------------------------

  it('returns deny immediately for non-suggestible denials (budget)', async () => {
    const policyPath = path.join(tmpDir, 'policy.yaml');
    const session = makeSession();
    fs.writeFileSync(policyPath, yaml.dump(session.policy));

    const handler = vi.fn<[unknown], Promise<EvolutionDecision>>();

    const mgr = new PolicyEvolutionManager({ policyPath, handler });

    const action: ActionRequest = { tool: 'file:read', input: { path: '/data/test.txt' } };
    const result: ValidationResult = {
      verdict: 'deny',
      tool: 'file:read',
      reasons: ['Runtime budget exceeded: 70000ms > 60000ms'],
    };

    const decision = await mgr.handleDenial(session, action, result);

    expect(decision).toBe('deny');
    // Handler should NOT have been called
    expect(handler).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Handler error
  // -------------------------------------------------------------------------

  it('returns deny if handler throws an error', async () => {
    const policyPath = path.join(tmpDir, 'policy.yaml');
    const session = makeSession();
    fs.writeFileSync(policyPath, yaml.dump(session.policy));

    const handler = vi.fn<[unknown], Promise<EvolutionDecision>>().mockRejectedValue(new Error('handler broke'));

    const mgr = new PolicyEvolutionManager({ policyPath, handler });

    const action: ActionRequest = { tool: 'file:write', input: { path: '/data/out/result.txt' } };
    const result: ValidationResult = {
      verdict: 'deny',
      tool: 'file:write',
      reasons: ['No capability defined for tool "file:write"'],
    };

    const decision = await mgr.handleDenial(session, action, result);

    expect(decision).toBe('deny');
  });
});
