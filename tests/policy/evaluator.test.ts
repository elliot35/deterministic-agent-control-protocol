import { describe, it, expect } from 'vitest';
import { evaluateAction, evaluateSessionAction, assessRiskLevel } from '../../src/policy/evaluator.js';
import type { ActionRequest, BudgetTracker, Policy, Session } from '../../src/types.js';

function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    version: '1.0',
    name: 'test',
    capabilities: [
      { tool: 'file:read', scope: { paths: ['/data/in/**'] } },
      { tool: 'file:write', scope: { paths: ['/data/out/**'] } },
      { tool: 'command:run', scope: { binaries: ['ffmpeg', 'ffprobe'] } },
      { tool: 'http:request', scope: { domains: ['api.example.com'], methods: ['GET'] } },
    ],
    limits: { max_runtime_ms: 60000, max_files_changed: 10, max_retries: 3 },
    gates: [
      { action: 'file:delete', approval: 'human', risk_level: 'high' },
    ],
    evidence: { require: ['checksums'], format: 'jsonl' },
    forbidden: [
      { pattern: '**/.env' },
      { pattern: 'rm -rf' },
    ],
    ...overrides,
  };
}

function makeBudget(overrides: Partial<BudgetTracker> = {}): BudgetTracker {
  return {
    startedAt: Date.now(),
    filesChanged: 0,
    totalOutputBytes: 0,
    retries: 0,
    costUsd: 0,
    actionsEvaluated: 0,
    actionsDenied: 0,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  const policy = makePolicy(overrides.policy ? overrides.policy as Partial<Policy> : undefined);
  return {
    id: 'test-session',
    policy,
    state: 'active',
    budget: makeBudget(),
    actions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
    // Re-assign policy if provided via overrides
    ...(overrides.policy ? { policy: overrides.policy as Policy } : {}),
  };
}

describe('Policy Evaluator', () => {
  describe('capability checks', () => {
    it('should allow actions within scope', () => {
      const result = evaluateAction(
        { tool: 'file:read', input: { path: '/data/in/video.mp4' } },
        makePolicy(),
      );
      expect(result.verdict).toBe('allow');
    });

    it('should deny actions for unregistered tools', () => {
      const result = evaluateAction(
        { tool: 'file:delete', input: { path: '/data/in/video.mp4' } },
        makePolicy(),
      );
      // file:delete is gated but there's no capability for it
      expect(result.verdict).toBe('deny');
    });

    it('should deny actions outside path scope', () => {
      const result = evaluateAction(
        { tool: 'file:read', input: { path: '/etc/passwd' } },
        makePolicy(),
      );
      expect(result.verdict).toBe('deny');
      expect(result.reasons[0]).toContain('outside allowed scope');
    });

    it('should deny commands with disallowed binaries', () => {
      const result = evaluateAction(
        { tool: 'command:run', input: { command: 'rm -rf /', binary: 'rm -rf /' } },
        makePolicy(),
      );
      // This should be caught by the forbidden pattern
      expect(result.verdict).toBe('deny');
    });

    it('should allow commands with allowed binaries', () => {
      const result = evaluateAction(
        { tool: 'command:run', input: { command: 'ffmpeg -i test.mp4', binary: 'ffmpeg -i test.mp4' } },
        makePolicy(),
      );
      expect(result.verdict).toBe('allow');
    });
  });

  describe('forbidden patterns', () => {
    it('should deny access to .env files', () => {
      const result = evaluateAction(
        { tool: 'file:read', input: { path: '/data/in/.env' } },
        makePolicy(),
      );
      expect(result.verdict).toBe('deny');
      expect(result.reasons[0]).toContain('forbidden');
    });

    it('should deny commands containing forbidden patterns', () => {
      const result = evaluateAction(
        { tool: 'command:run', input: { command: 'rm -rf /tmp', binary: 'rm -rf /tmp' } },
        makePolicy(),
      );
      expect(result.verdict).toBe('deny');
    });
  });

  describe('HTTP scope checks', () => {
    it('should allow requests to allowed domains', () => {
      const result = evaluateAction(
        { tool: 'http:request', input: { url: 'https://api.example.com/data', method: 'GET' } },
        makePolicy(),
      );
      expect(result.verdict).toBe('allow');
    });

    it('should deny requests to disallowed domains', () => {
      const result = evaluateAction(
        { tool: 'http:request', input: { url: 'https://evil.com/data', method: 'GET' } },
        makePolicy(),
      );
      expect(result.verdict).toBe('deny');
      expect(result.reasons[0]).toContain('not in allowed list');
    });

    it('should deny disallowed HTTP methods', () => {
      const result = evaluateAction(
        { tool: 'http:request', input: { url: 'https://api.example.com/data', method: 'DELETE' } },
        makePolicy(),
      );
      expect(result.verdict).toBe('deny');
    });
  });

  describe('budget checks', () => {
    it('should deny when file change budget exceeded', () => {
      const budget = makeBudget({ filesChanged: 10 });
      const result = evaluateAction(
        { tool: 'file:write', input: { path: '/data/out/file.txt' } },
        makePolicy(),
        budget,
      );
      expect(result.verdict).toBe('deny');
      expect(result.reasons[0]).toContain('File change budget exceeded');
    });

    it('should deny when runtime budget exceeded', () => {
      const budget = makeBudget({ startedAt: Date.now() - 120000 }); // 2 minutes ago
      const result = evaluateAction(
        { tool: 'file:read', input: { path: '/data/in/file.txt' } },
        makePolicy(),
        budget,
      );
      expect(result.verdict).toBe('deny');
      expect(result.reasons[0]).toContain('Runtime budget exceeded');
    });

    it('should allow when within budget', () => {
      const budget = makeBudget();
      const result = evaluateAction(
        { tool: 'file:read', input: { path: '/data/in/file.txt' } },
        makePolicy(),
        budget,
      );
      expect(result.verdict).toBe('allow');
    });
  });

  describe('risk assessment', () => {
    it('should return high risk for file:delete', () => {
      const risk = assessRiskLevel(
        { tool: 'file:delete', input: {} },
        makePolicy(),
      );
      expect(risk).toBe('high');
    });

    it('should return low risk for file:read', () => {
      const risk = assessRiskLevel(
        { tool: 'file:read', input: {} },
        makePolicy(),
      );
      expect(risk).toBe('low');
    });

    it('should use explicit gate risk level if defined', () => {
      const risk = assessRiskLevel(
        { tool: 'file:delete', input: {} },
        makePolicy(),
      );
      expect(risk).toBe('high');
    });
  });
});

describe('Session-Aware Evaluator', () => {
  it('should deny when session is not active', () => {
    const session = makeSession({ state: 'terminated' });
    const result = evaluateSessionAction(
      { tool: 'file:read', input: { path: '/data/in/test.txt' } },
      session.policy,
      session,
    );
    expect(result.verdict).toBe('deny');
    expect(result.reasons[0]).toContain('not accepting new actions');
  });

  it('should deny when max_actions exceeded', () => {
    const policy = makePolicy({
      session: { max_actions: 5 },
    });
    const session = makeSession({
      policy,
      budget: makeBudget({ actionsEvaluated: 5 }),
    });

    const result = evaluateSessionAction(
      { tool: 'file:read', input: { path: '/data/in/test.txt' } },
      policy,
      session,
    );
    expect(result.verdict).toBe('deny');
    expect(result.reasons[0]).toContain('action limit reached');
  });

  it('should deny when max_denials exceeded', () => {
    const policy = makePolicy({
      session: { max_denials: 3 },
    });
    const session = makeSession({
      policy,
      budget: makeBudget({ actionsDenied: 3 }),
    });

    const result = evaluateSessionAction(
      { tool: 'file:read', input: { path: '/data/in/test.txt' } },
      policy,
      session,
    );
    expect(result.verdict).toBe('deny');
    expect(result.reasons[0]).toContain('denial limit reached');
  });

  it('should warn when approaching action limit', () => {
    const policy = makePolicy({
      session: { max_actions: 10 },
    });
    const session = makeSession({
      policy,
      budget: makeBudget({ actionsEvaluated: 7 }),
    });

    const result = evaluateSessionAction(
      { tool: 'file:read', input: { path: '/data/in/test.txt' } },
      policy,
      session,
    );
    expect(result.verdict).toBe('allow');
    expect(result.warnings).toBeDefined();
    expect(result.warnings![0]).toContain('Approaching action limit');
  });

  it('should allow actions within session constraints', () => {
    const policy = makePolicy({
      session: { max_actions: 100, max_denials: 10 },
    });
    const session = makeSession({ policy });

    const result = evaluateSessionAction(
      { tool: 'file:read', input: { path: '/data/in/test.txt' } },
      policy,
      session,
    );
    expect(result.verdict).toBe('allow');
  });

  it('should enforce escalation rules based on action count', () => {
    const policy = makePolicy({
      session: {
        escalation: [
          { after_actions: 5, require: 'human_checkin' },
        ],
      },
    });
    const session = makeSession({
      policy,
      budget: makeBudget({ actionsEvaluated: 5 }),
    });

    const result = evaluateSessionAction(
      { tool: 'file:read', input: { path: '/data/in/test.txt' } },
      policy,
      session,
    );
    expect(result.verdict).toBe('gate');
    expect(result.reasons[0]).toContain('Escalation');
  });
});
