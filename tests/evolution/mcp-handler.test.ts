import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
import { McpEvolutionHandler } from '../../src/evolution/mcp-handler.js';
import { parsePolicyYaml } from '../../src/policy/loader.js';
import type { ActionRequest, Policy, Session, BudgetTracker } from '../../src/types.js';

function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    version: '1.0',
    name: 'test-mcp-evo',
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
    id: 'mcp-evo-session',
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-handler-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('McpEvolutionHandler', () => {
  // -------------------------------------------------------------------------
  // getToolDefinition
  // -------------------------------------------------------------------------

  it('returns a valid tool definition', () => {
    const handler = new McpEvolutionHandler(path.join(tmpDir, 'policy.yaml'));
    const def = handler.getToolDefinition();

    expect(def.name).toBe('policy_evolution_approve');
    expect(def.inputSchema.properties).toHaveProperty('suggestion_id');
    expect(def.inputSchema.properties).toHaveProperty('decision');
    expect(def.inputSchema.required).toContain('suggestion_id');
    expect(def.inputSchema.required).toContain('decision');
  });

  // -------------------------------------------------------------------------
  // isEvolutionTool
  // -------------------------------------------------------------------------

  it('recognises the evolution tool name', () => {
    const handler = new McpEvolutionHandler(path.join(tmpDir, 'policy.yaml'));
    expect(handler.isEvolutionTool('policy_evolution_approve')).toBe(true);
    expect(handler.isEvolutionTool('read_text_file')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // buildDenialResponse
  // -------------------------------------------------------------------------

  it('builds a denial response with suggestion ID for suggestible denials', () => {
    const handler = new McpEvolutionHandler(path.join(tmpDir, 'policy.yaml'));
    const action: ActionRequest = { tool: 'file:write', input: { path: '/data/out/result.txt' } };
    const reasons = ['No capability defined for tool "file:write"'];
    const policy = makePolicy();

    const response = handler.buildDenialResponse(action, reasons, policy, 'session-1');

    expect(response).not.toBeNull();
    expect(response!.isError).toBe(true);
    expect(response!.content).toHaveLength(1);

    const text = response!.content[0].text;
    expect(text).toContain('Action denied by policy');
    expect(text).toContain('Suggestion ID:');
    expect(text).toContain('policy_evolution_approve');
    expect(text).toContain('file:write');

    // Should have stored a pending suggestion
    expect(handler.getPendingCount()).toBe(1);
  });

  it('returns null for non-suggestible denials (budget)', () => {
    const handler = new McpEvolutionHandler(path.join(tmpDir, 'policy.yaml'));
    const action: ActionRequest = { tool: 'file:read', input: { path: '/data/test.txt' } };
    const reasons = ['Runtime budget exceeded: 70000ms > 60000ms'];
    const policy = makePolicy();

    const response = handler.buildDenialResponse(action, reasons, policy, 'session-1');

    expect(response).toBeNull();
    expect(handler.getPendingCount()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // handleApproval — add-to-policy
  // -------------------------------------------------------------------------

  it('add-to-policy: updates session policy and writes to disk', () => {
    const policyPath = path.join(tmpDir, 'policy.yaml');
    const session = makeSession();
    fs.writeFileSync(policyPath, yaml.dump(session.policy));

    const handler = new McpEvolutionHandler(policyPath);

    // Build a denial to get a suggestion ID
    const action: ActionRequest = { tool: 'file:write', input: { path: '/data/out/result.txt' } };
    const reasons = ['No capability defined for tool "file:write"'];
    const denyResponse = handler.buildDenialResponse(action, reasons, session.policy, session.id);
    expect(denyResponse).not.toBeNull();

    // Extract suggestion ID from the response text
    const match = denyResponse!.content[0].text.match(/Suggestion ID: (\S+)/);
    expect(match).not.toBeNull();
    const suggestionId = match![1];

    // Approve
    const result = handler.handleApproval(
      { suggestion_id: suggestionId, decision: 'add-to-policy' },
      session,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Policy updated and saved to disk');

    // Session policy should be mutated
    expect(session.policy.capabilities.find((c) => c.tool === 'file:write')).toBeDefined();

    // File should be written
    const ondisk = parsePolicyYaml(fs.readFileSync(policyPath, 'utf-8'));
    expect(ondisk.capabilities.find((c) => c.tool === 'file:write')).toBeDefined();

    // Pending should be cleaned up
    expect(handler.getPendingCount()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // handleApproval — allow-once
  // -------------------------------------------------------------------------

  it('allow-once: updates session policy but does NOT write to disk', () => {
    const policyPath = path.join(tmpDir, 'policy.yaml');
    const session = makeSession();
    const originalYaml = yaml.dump(session.policy);
    fs.writeFileSync(policyPath, originalYaml);

    const handler = new McpEvolutionHandler(policyPath);

    const denyResponse = handler.buildDenialResponse(
      { tool: 'file:write', input: { path: '/data/out/result.txt' } },
      ['No capability defined for tool "file:write"'],
      session.policy,
      session.id,
    );
    const suggestionId = denyResponse!.content[0].text.match(/Suggestion ID: (\S+)/)![1];

    const result = handler.handleApproval(
      { suggestion_id: suggestionId, decision: 'allow-once' },
      session,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('session only');

    // In-memory policy updated
    expect(session.policy.capabilities.find((c) => c.tool === 'file:write')).toBeDefined();

    // On-disk policy NOT updated
    expect(fs.readFileSync(policyPath, 'utf-8')).toBe(originalYaml);
  });

  // -------------------------------------------------------------------------
  // handleApproval — deny
  // -------------------------------------------------------------------------

  it('deny: keeps restriction, no mutation', () => {
    const policyPath = path.join(tmpDir, 'policy.yaml');
    const session = makeSession();
    fs.writeFileSync(policyPath, yaml.dump(session.policy));

    const handler = new McpEvolutionHandler(policyPath);
    const capCountBefore = session.policy.capabilities.length;

    const denyResponse = handler.buildDenialResponse(
      { tool: 'file:write', input: { path: '/data/out/result.txt' } },
      ['No capability defined for tool "file:write"'],
      session.policy,
      session.id,
    );
    const suggestionId = denyResponse!.content[0].text.match(/Suggestion ID: (\S+)/)![1];

    const result = handler.handleApproval(
      { suggestion_id: suggestionId, decision: 'deny' },
      session,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('restriction remains');
    expect(session.policy.capabilities).toHaveLength(capCountBefore);
  });

  // -------------------------------------------------------------------------
  // handleApproval — invalid suggestion ID
  // -------------------------------------------------------------------------

  it('returns error for unknown suggestion ID', () => {
    const handler = new McpEvolutionHandler(path.join(tmpDir, 'policy.yaml'));
    const session = makeSession();

    const result = handler.handleApproval(
      { suggestion_id: 'nonexistent-id', decision: 'add-to-policy' },
      session,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  // -------------------------------------------------------------------------
  // handleApproval — missing fields
  // -------------------------------------------------------------------------

  it('returns error for missing required fields', () => {
    const handler = new McpEvolutionHandler(path.join(tmpDir, 'policy.yaml'));
    const session = makeSession();

    const result = handler.handleApproval({}, session);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing required fields');
  });

  // -------------------------------------------------------------------------
  // handleApproval — invalid decision
  // -------------------------------------------------------------------------

  it('returns error for invalid decision value', () => {
    const policyPath = path.join(tmpDir, 'policy.yaml');
    const session = makeSession();
    fs.writeFileSync(policyPath, yaml.dump(session.policy));

    const handler = new McpEvolutionHandler(policyPath);

    const denyResponse = handler.buildDenialResponse(
      { tool: 'file:write', input: { path: '/data/out/result.txt' } },
      ['No capability defined for tool "file:write"'],
      session.policy,
      session.id,
    );
    const suggestionId = denyResponse!.content[0].text.match(/Suggestion ID: (\S+)/)![1];

    const result = handler.handleApproval(
      { suggestion_id: suggestionId, decision: 'invalid-choice' },
      session,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid decision');
  });

  // -------------------------------------------------------------------------
  // Multiple suggestions
  // -------------------------------------------------------------------------

  it('tracks multiple pending suggestions independently', () => {
    const handler = new McpEvolutionHandler(path.join(tmpDir, 'policy.yaml'));
    const policy = makePolicy();

    handler.buildDenialResponse(
      { tool: 'file:write', input: { path: '/data/a.txt' } },
      ['No capability defined for tool "file:write"'],
      policy,
      'session-1',
    );

    handler.buildDenialResponse(
      { tool: 'file:delete', input: { path: '/data/b.txt' } },
      ['No capability defined for tool "file:delete"'],
      policy,
      'session-1',
    );

    expect(handler.getPendingCount()).toBe(2);
  });
});
