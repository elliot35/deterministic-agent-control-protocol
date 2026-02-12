import { describe, it, expect } from 'vitest';
import { suggestPolicyChange } from '../../src/evolution/suggestion.js';
import type { ActionRequest, Policy } from '../../src/types.js';

function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    version: '1.0',
    name: 'test-policy',
    capabilities: [
      { tool: 'file:read', scope: { paths: ['/data/**'] } },
      { tool: 'command:run', scope: { binaries: ['ls', 'echo'] } },
      { tool: 'http:request', scope: { domains: ['api.example.com'], methods: ['GET'] } },
    ],
    limits: { max_runtime_ms: 60000, max_files_changed: 10 },
    gates: [],
    evidence: { require: ['checksums'], format: 'jsonl' },
    forbidden: [{ pattern: '**/.env' }, { pattern: 'rm -rf' }],
    ...overrides,
  };
}

describe('suggestPolicyChange', () => {
  // -------------------------------------------------------------------------
  // No capability
  // -------------------------------------------------------------------------

  it('suggests adding a capability when tool is unknown', () => {
    const action: ActionRequest = {
      tool: 'file:write',
      input: { path: '/data/out/result.txt' },
    };
    const reasons = ['No capability defined for tool "file:write"'];

    const suggestion = suggestPolicyChange(action, reasons, makePolicy());

    expect(suggestion).not.toBeNull();
    expect(suggestion!.category).toBe('no_capability');
    expect(suggestion!.tool).toBe('file:write');
    expect(suggestion!.change.type).toBe('add_capability');
    if (suggestion!.change.type === 'add_capability') {
      expect(suggestion!.change.scope.paths).toEqual(['/data/out/result.txt']);
    }
    expect(suggestion!.description).toContain('file:write');
  });

  it('infers binary scope for command:run capability suggestion', () => {
    const action: ActionRequest = {
      tool: 'git:commit',
      input: { command: 'git commit -m "test"' },
    };
    const reasons = ['No capability defined for tool "git:commit"'];

    const suggestion = suggestPolicyChange(action, reasons, makePolicy());

    expect(suggestion).not.toBeNull();
    expect(suggestion!.category).toBe('no_capability');
    if (suggestion!.change.type === 'add_capability') {
      expect(suggestion!.change.scope.binaries).toEqual(['git']);
    }
  });

  // -------------------------------------------------------------------------
  // Scope violations
  // -------------------------------------------------------------------------

  it('suggests widening path scope', () => {
    const action: ActionRequest = {
      tool: 'file:read',
      input: { path: '/etc/hosts' },
    };
    const reasons = ['Path "/etc/hosts" is outside allowed scope: [/data/**]'];

    const suggestion = suggestPolicyChange(action, reasons, makePolicy());

    expect(suggestion).not.toBeNull();
    expect(suggestion!.category).toBe('scope_violation');
    expect(suggestion!.change.type).toBe('widen_scope');
    if (suggestion!.change.type === 'widen_scope') {
      expect(suggestion!.change.field).toBe('paths');
      expect(suggestion!.change.add).toEqual(['/etc/hosts']);
    }
  });

  it('suggests widening binary scope', () => {
    const action: ActionRequest = {
      tool: 'command:run',
      input: { binary: 'curl' },
    };
    const reasons = ['Binary "curl" is not in allowed list: [ls, echo]'];

    const suggestion = suggestPolicyChange(action, reasons, makePolicy());

    expect(suggestion).not.toBeNull();
    expect(suggestion!.category).toBe('scope_violation');
    if (suggestion!.change.type === 'widen_scope') {
      expect(suggestion!.change.field).toBe('binaries');
      expect(suggestion!.change.add).toEqual(['curl']);
    }
  });

  it('suggests widening domain scope', () => {
    const action: ActionRequest = {
      tool: 'http:request',
      input: { url: 'https://other.example.com/api' },
    };
    const reasons = ['Domain "other.example.com" is not in allowed list: [api.example.com]'];

    const suggestion = suggestPolicyChange(action, reasons, makePolicy());

    expect(suggestion).not.toBeNull();
    expect(suggestion!.category).toBe('scope_violation');
    if (suggestion!.change.type === 'widen_scope') {
      expect(suggestion!.change.field).toBe('domains');
      expect(suggestion!.change.add).toEqual(['other.example.com']);
    }
  });

  it('suggests widening HTTP method scope', () => {
    const action: ActionRequest = {
      tool: 'http:request',
      input: { url: 'https://api.example.com/data', method: 'POST' },
    };
    const reasons = ['HTTP method "POST" is not in allowed list: [GET]'];

    const suggestion = suggestPolicyChange(action, reasons, makePolicy());

    expect(suggestion).not.toBeNull();
    expect(suggestion!.category).toBe('scope_violation');
    if (suggestion!.change.type === 'widen_scope') {
      expect(suggestion!.change.field).toBe('methods');
      expect(suggestion!.change.add).toEqual(['POST']);
    }
  });

  it('suggests widening repository scope', () => {
    const action: ActionRequest = {
      tool: 'git:diff',
      input: { repo: '/home/user/other-repo' },
    };
    const reasons = ['Repository "/home/user/other-repo" is outside allowed scope: [.]'];

    const suggestion = suggestPolicyChange(action, reasons, makePolicy());

    expect(suggestion).not.toBeNull();
    expect(suggestion!.category).toBe('scope_violation');
    if (suggestion!.change.type === 'widen_scope') {
      expect(suggestion!.change.field).toBe('repos');
      expect(suggestion!.change.add).toEqual(['/home/user/other-repo']);
    }
  });

  // -------------------------------------------------------------------------
  // Forbidden patterns
  // -------------------------------------------------------------------------

  it('suggests removing a forbidden pattern (path match)', () => {
    const action: ActionRequest = {
      tool: 'file:read',
      input: { path: '.env' },
    };
    const reasons = ['Path ".env" matches forbidden pattern "**/.env"'];

    const suggestion = suggestPolicyChange(action, reasons, makePolicy());

    expect(suggestion).not.toBeNull();
    expect(suggestion!.category).toBe('forbidden_match');
    if (suggestion!.change.type === 'remove_forbidden') {
      expect(suggestion!.change.pattern).toBe('**/.env');
    }
    expect(suggestion!.description).toContain('Warning');
  });

  it('suggests removing a forbidden pattern (command match)', () => {
    const action: ActionRequest = {
      tool: 'command:run',
      input: { command: 'rm -rf /tmp' },
    };
    const reasons = ['Command contains forbidden pattern "rm -rf"'];

    const suggestion = suggestPolicyChange(action, reasons, makePolicy());

    expect(suggestion).not.toBeNull();
    expect(suggestion!.category).toBe('forbidden_match');
    if (suggestion!.change.type === 'remove_forbidden') {
      expect(suggestion!.change.pattern).toBe('rm -rf');
    }
  });

  it('suggests removing a forbidden pattern (URL match)', () => {
    const action: ActionRequest = {
      tool: 'http:request',
      input: { url: 'http://evil.com/malware' },
    };
    const reasons = ['URL "http://evil.com/malware" matches forbidden pattern "http://evil.com/**"'];

    const suggestion = suggestPolicyChange(action, reasons, makePolicy());

    expect(suggestion).not.toBeNull();
    expect(suggestion!.category).toBe('forbidden_match');
    if (suggestion!.change.type === 'remove_forbidden') {
      expect(suggestion!.change.pattern).toBe('http://evil.com/**');
    }
  });

  // -------------------------------------------------------------------------
  // Non-suggestible denials
  // -------------------------------------------------------------------------

  it('returns null for budget exceeded denials', () => {
    const action: ActionRequest = {
      tool: 'file:read',
      input: { path: '/data/test.txt' },
    };
    const reasons = ['Runtime budget exceeded: 70000ms > 60000ms'];

    expect(suggestPolicyChange(action, reasons, makePolicy())).toBeNull();
  });

  it('returns null for file change budget exceeded', () => {
    const action: ActionRequest = {
      tool: 'file:write',
      input: { path: '/data/out/test.txt' },
    };
    const reasons = ['File change budget exceeded: 10 >= 10'];

    expect(suggestPolicyChange(action, reasons, makePolicy())).toBeNull();
  });

  it('returns null for rate limit exceeded', () => {
    const action: ActionRequest = {
      tool: 'file:read',
      input: { path: '/data/test.txt' },
    };
    const reasons = ['Rate limit exceeded: 61 actions in the last minute (limit: 60)'];

    expect(suggestPolicyChange(action, reasons, makePolicy())).toBeNull();
  });

  it('returns null for session action limit', () => {
    const action: ActionRequest = {
      tool: 'file:read',
      input: { path: '/data/test.txt' },
    };
    const reasons = ['Session action limit reached: 200 >= 200'];

    expect(suggestPolicyChange(action, reasons, makePolicy())).toBeNull();
  });

  it('returns null for session denial limit', () => {
    const action: ActionRequest = {
      tool: 'file:read',
      input: { path: '/data/test.txt' },
    };
    const reasons = ['Session denial limit reached: 20 >= 20. Session should be terminated.'];

    expect(suggestPolicyChange(action, reasons, makePolicy())).toBeNull();
  });

  it('returns null for session state denials', () => {
    const action: ActionRequest = {
      tool: 'file:read',
      input: { path: '/data/test.txt' },
    };
    const reasons = ['Session is terminated, not accepting new actions'];

    expect(suggestPolicyChange(action, reasons, makePolicy())).toBeNull();
  });

  it('returns null for unknown/unrecognised reasons', () => {
    const action: ActionRequest = {
      tool: 'file:read',
      input: { path: '/data/test.txt' },
    };
    const reasons = ['Something completely unexpected happened'];

    expect(suggestPolicyChange(action, reasons, makePolicy())).toBeNull();
  });
});
