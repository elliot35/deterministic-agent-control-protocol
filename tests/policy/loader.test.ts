import { describe, it, expect } from 'vitest';
import { parsePolicyYaml, PolicyValidationError } from '../../src/policy/loader.js';

const VALID_POLICY = `
version: "1.0"
name: "test-policy"
description: "A test policy"

capabilities:
  - tool: "file:read"
    scope:
      paths: ["/data/**"]

limits:
  max_runtime_ms: 60000
  max_files_changed: 10

gates:
  - action: "file:delete"
    approval: "human"
    risk_level: "high"

evidence:
  require: ["checksums"]
  format: "jsonl"

forbidden:
  - pattern: "**/.env"
`;

describe('Policy Loader', () => {
  it('should parse a valid policy YAML', () => {
    const policy = parsePolicyYaml(VALID_POLICY);
    expect(policy.name).toBe('test-policy');
    expect(policy.version).toBe('1.0');
    expect(policy.capabilities).toHaveLength(1);
    expect(policy.capabilities[0].tool).toBe('file:read');
    expect(policy.capabilities[0].scope.paths).toEqual(['/data/**']);
    expect(policy.limits.max_runtime_ms).toBe(60000);
    expect(policy.limits.max_files_changed).toBe(10);
    expect(policy.gates).toHaveLength(1);
    expect(policy.gates[0].action).toBe('file:delete');
    expect(policy.gates[0].approval).toBe('human');
    expect(policy.forbidden).toHaveLength(1);
  });

  it('should apply defaults for optional fields', () => {
    const minimal = `
name: "minimal"
capabilities:
  - tool: "file:read"
    scope:
      paths: ["/tmp"]
`;
    const policy = parsePolicyYaml(minimal);
    expect(policy.version).toBe('1.0');
    expect(policy.gates).toEqual([]);
    expect(policy.forbidden).toEqual([]);
    expect(policy.evidence.format).toBe('jsonl');
  });

  it('should reject a policy with no capabilities', () => {
    const noCapabilities = `
name: "bad-policy"
capabilities: []
`;
    expect(() => parsePolicyYaml(noCapabilities)).toThrow(PolicyValidationError);
  });

  it('should reject a policy with no name', () => {
    const noName = `
capabilities:
  - tool: "file:read"
    scope:
      paths: ["/tmp"]
`;
    expect(() => parsePolicyYaml(noName)).toThrow(PolicyValidationError);
  });

  it('should reject invalid YAML', () => {
    expect(() => parsePolicyYaml('{{{')).toThrow(PolicyValidationError);
  });

  it('should reject non-object YAML', () => {
    expect(() => parsePolicyYaml('"just a string"')).toThrow(PolicyValidationError);
  });

  it('should validate remediation rules', () => {
    const withRemediation = `
name: "remediation-test"
capabilities:
  - tool: "command:run"
    scope:
      binaries: ["ffmpeg"]
remediation:
  rules:
    - match: "CUDA out of memory"
      action: "fallback:vulkan"
  fallback_chain: ["cuda", "vulkan", "cpu"]
`;
    const policy = parsePolicyYaml(withRemediation);
    expect(policy.remediation?.rules).toHaveLength(1);
    expect(policy.remediation?.fallback_chain).toEqual(['cuda', 'vulkan', 'cpu']);
  });
});
