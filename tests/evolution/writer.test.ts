import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { applyPolicyChange, writePolicyToFile } from '../../src/evolution/writer.js';
import { parsePolicyYaml } from '../../src/policy/loader.js';
import type { Policy } from '../../src/types.js';
import type { PolicySuggestion } from '../../src/evolution/types.js';

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

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('applyPolicyChange', () => {
  it('adds a new capability (add_capability)', () => {
    const policy = makePolicy();
    const suggestion: PolicySuggestion = {
      category: 'no_capability',
      tool: 'file:write',
      description: 'Add file:write capability',
      change: {
        type: 'add_capability',
        tool: 'file:write',
        scope: { paths: ['/data/out/**'] },
      },
    };

    const updated = applyPolicyChange(policy, suggestion);

    // Original should be unchanged (deep clone)
    expect(policy.capabilities).toHaveLength(3);

    // Updated should have the new capability
    expect(updated.capabilities).toHaveLength(4);
    const newCap = updated.capabilities.find((c) => c.tool === 'file:write');
    expect(newCap).toBeDefined();
    expect(newCap!.scope.paths).toEqual(['/data/out/**']);
  });

  it('widens path scope on an existing capability (widen_scope)', () => {
    const policy = makePolicy();
    const suggestion: PolicySuggestion = {
      category: 'scope_violation',
      tool: 'file:read',
      description: 'Add path "/etc/hosts"',
      change: {
        type: 'widen_scope',
        tool: 'file:read',
        field: 'paths',
        add: ['/etc/hosts'],
      },
    };

    const updated = applyPolicyChange(policy, suggestion);

    const cap = updated.capabilities.find((c) => c.tool === 'file:read');
    expect(cap!.scope.paths).toContain('/data/**');
    expect(cap!.scope.paths).toContain('/etc/hosts');
  });

  it('widens binary scope on an existing capability', () => {
    const policy = makePolicy();
    const suggestion: PolicySuggestion = {
      category: 'scope_violation',
      tool: 'command:run',
      description: 'Add binary "curl"',
      change: {
        type: 'widen_scope',
        tool: 'command:run',
        field: 'binaries',
        add: ['curl'],
      },
    };

    const updated = applyPolicyChange(policy, suggestion);

    const cap = updated.capabilities.find((c) => c.tool === 'command:run');
    expect(cap!.scope.binaries).toContain('ls');
    expect(cap!.scope.binaries).toContain('echo');
    expect(cap!.scope.binaries).toContain('curl');
  });

  it('does not duplicate existing scope values', () => {
    const policy = makePolicy();
    const suggestion: PolicySuggestion = {
      category: 'scope_violation',
      tool: 'command:run',
      description: 'Add binary "ls" (already exists)',
      change: {
        type: 'widen_scope',
        tool: 'command:run',
        field: 'binaries',
        add: ['ls'],
      },
    };

    const updated = applyPolicyChange(policy, suggestion);

    const cap = updated.capabilities.find((c) => c.tool === 'command:run');
    const lsCount = cap!.scope.binaries!.filter((b) => b === 'ls').length;
    expect(lsCount).toBe(1);
  });

  it('removes a forbidden pattern (remove_forbidden)', () => {
    const policy = makePolicy();
    const suggestion: PolicySuggestion = {
      category: 'forbidden_match',
      tool: 'file:read',
      description: 'Remove forbidden pattern "**/.env"',
      change: {
        type: 'remove_forbidden',
        pattern: '**/.env',
      },
    };

    const updated = applyPolicyChange(policy, suggestion);

    expect(updated.forbidden).toHaveLength(1);
    expect(updated.forbidden[0].pattern).toBe('rm -rf');
  });

  it('falls back to add_capability when widen_scope tool is missing', () => {
    const policy = makePolicy();
    const suggestion: PolicySuggestion = {
      category: 'scope_violation',
      tool: 'file:delete',
      description: 'Widen scope for missing tool',
      change: {
        type: 'widen_scope',
        tool: 'file:delete',
        field: 'paths',
        add: ['/tmp/**'],
      },
    };

    const updated = applyPolicyChange(policy, suggestion);

    // Should have added a new capability as fallback
    const cap = updated.capabilities.find((c) => c.tool === 'file:delete');
    expect(cap).toBeDefined();
    expect(cap!.scope.paths).toEqual(['/tmp/**']);
  });

  it('validates the resulting policy', () => {
    const policy = makePolicy();
    const suggestion: PolicySuggestion = {
      category: 'scope_violation',
      tool: 'file:read',
      description: 'Add path',
      change: {
        type: 'widen_scope',
        tool: 'file:read',
        field: 'paths',
        add: ['/extra/**'],
      },
    };

    // Should not throw — result is a valid policy
    const updated = applyPolicyChange(policy, suggestion);
    expect(updated.name).toBe('test-policy');
  });
});

describe('writePolicyToFile', () => {
  it('writes valid YAML that round-trips through the parser', () => {
    const policy = makePolicy();
    const filePath = path.join(tmpDir, 'out.yaml');

    writePolicyToFile(policy, filePath);

    expect(fs.existsSync(filePath)).toBe(true);

    const yaml = fs.readFileSync(filePath, 'utf-8');
    const roundTripped = parsePolicyYaml(yaml);

    expect(roundTripped.name).toBe('test-policy');
    expect(roundTripped.capabilities).toHaveLength(3);
    expect(roundTripped.forbidden).toHaveLength(2);
  });

  it('creates intermediate directories if they do not exist', () => {
    const filePath = path.join(tmpDir, 'deep', 'nested', 'dir', 'policy.yaml');

    writePolicyToFile(makePolicy(), filePath);

    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('overwrites an existing file', () => {
    const filePath = path.join(tmpDir, 'overwrite.yaml');
    fs.writeFileSync(filePath, 'old content');

    writePolicyToFile(makePolicy(), filePath);

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).not.toContain('old content');
    expect(content).toContain('test-policy');
  });
});
