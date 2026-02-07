import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runInit } from '../../src/cli/init.js';
import {
  DEFAULT_POLICY,
  GOVERNANCE_MDC,
  CLAUDE_MD,
  AGENTS_MD,
  CLAUDE_SETTINGS_JSON,
  generateCursorMcpJson,
  generateClaudeCodeMcpJson,
  generateCodexConfigToml,
} from '../../src/cli/templates.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'det-acp-init-test-'));
}

function cleanUp(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Template generator tests
// ---------------------------------------------------------------------------

describe('Template Generators', () => {
  it('generateCursorMcpJson produces valid JSON with expected fields', () => {
    const result = generateCursorMcpJson('/usr/bin/cli.js', '/home/user/project/policy.yaml');
    const parsed = JSON.parse(result);

    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers['governed-filesystem']).toBeDefined();
    expect(parsed.mcpServers['governed-filesystem'].command).toBe('node');
    expect(parsed.mcpServers['governed-filesystem'].args).toContain('/usr/bin/cli.js');
    expect(parsed.mcpServers['governed-filesystem'].args).toContain('proxy');
    expect(parsed.mcpServers['governed-filesystem'].args).toContain('--policy');
    expect(parsed.mcpServers['governed-filesystem'].args).toContain(
      '/home/user/project/policy.yaml',
    );
  });

  it('generateClaudeCodeMcpJson produces valid JSON with expected fields', () => {
    const result = generateClaudeCodeMcpJson('/usr/bin/cli.js', '/home/user/project/policy.yaml');
    const parsed = JSON.parse(result);

    expect(parsed.mcpServers['governed-filesystem']).toBeDefined();
    expect(parsed.mcpServers['governed-filesystem'].args).toContain('--policy');
  });

  it('generateCodexConfigToml includes command and policy path', () => {
    const result = generateCodexConfigToml('/usr/bin/cli.js', '/home/user/project/policy.yaml');

    expect(result).toContain('[mcp_servers.governed-filesystem]');
    expect(result).toContain('command = "node"');
    expect(result).toContain('/usr/bin/cli.js');
    expect(result).toContain('/home/user/project/policy.yaml');
    expect(result).toContain('--policy');
  });

  it('DEFAULT_POLICY contains expected sections', () => {
    expect(DEFAULT_POLICY).toContain('version: "1.0"');
    expect(DEFAULT_POLICY).toContain('capabilities:');
    expect(DEFAULT_POLICY).toContain('forbidden:');
    expect(DEFAULT_POLICY).toContain('session:');
    expect(DEFAULT_POLICY).toContain('read_text_file');
    expect(DEFAULT_POLICY).toContain('write_file');
  });

  it('GOVERNANCE_MDC contains Cursor-specific frontmatter', () => {
    expect(GOVERNANCE_MDC).toContain('alwaysApply: true');
    expect(GOVERNANCE_MDC).toContain('governed-filesystem');
    expect(GOVERNANCE_MDC).toContain('StrReplace');
  });

  it('CLAUDE_MD contains Claude Code tool names', () => {
    expect(CLAUDE_MD).toContain('governed-filesystem');
    expect(CLAUDE_MD).toContain('read_text_file');
  });

  it('AGENTS_MD contains governance instructions', () => {
    expect(AGENTS_MD).toContain('governed-filesystem');
    expect(AGENTS_MD).toContain('read_text_file');
  });

  it('CLAUDE_SETTINGS_JSON denies built-in file tools', () => {
    const parsed = JSON.parse(CLAUDE_SETTINGS_JSON);
    expect(parsed.permissions.deny).toContain('Read');
    expect(parsed.permissions.deny).toContain('Write');
    expect(parsed.permissions.allow).toContain('governed-filesystem');
  });
});

// ---------------------------------------------------------------------------
// Init command tests
// ---------------------------------------------------------------------------

describe('runInit', () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
    // Mock process.cwd to return our temp dir
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    // Mock process.argv[1] to simulate the CLI entry point
    const originalArgv = [...process.argv];
    process.argv[1] = '/mock/path/to/dist/cli/index.js';
    return () => {
      process.argv = originalArgv;
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanUp(tmpDir);
  });

  // ---- Cursor ----

  describe('cursor integration', () => {
    it('creates policy.yaml, .cursor/mcp.json, and .cursor/rules/governance.mdc', () => {
      const result = runInit('cursor', {});

      expect(result.created).toHaveLength(3);
      expect(result.skipped).toHaveLength(0);

      // Check files exist
      expect(fs.existsSync(path.join(tmpDir, 'policy.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, '.cursor', 'mcp.json'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, '.cursor', 'rules', 'governance.mdc'))).toBe(true);

      // Check policy content
      const policy = fs.readFileSync(path.join(tmpDir, 'policy.yaml'), 'utf-8');
      expect(policy).toContain('version: "1.0"');
      expect(policy).toContain('read_text_file');

      // Check mcp.json content
      const mcpJson = JSON.parse(
        fs.readFileSync(path.join(tmpDir, '.cursor', 'mcp.json'), 'utf-8'),
      );
      expect(mcpJson.mcpServers['governed-filesystem']).toBeDefined();
      expect(mcpJson.mcpServers['governed-filesystem'].args).toContain('--policy');

      // Check governance.mdc content
      const mdc = fs.readFileSync(
        path.join(tmpDir, '.cursor', 'rules', 'governance.mdc'),
        'utf-8',
      );
      expect(mdc).toContain('alwaysApply: true');
    });
  });

  // ---- Codex ----

  describe('codex integration', () => {
    it('creates policy.yaml, .codex/config.toml, and AGENTS.md', () => {
      const result = runInit('codex', {});

      expect(result.created).toHaveLength(3);
      expect(result.skipped).toHaveLength(0);

      expect(fs.existsSync(path.join(tmpDir, 'policy.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, '.codex', 'config.toml'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(true);

      const toml = fs.readFileSync(path.join(tmpDir, '.codex', 'config.toml'), 'utf-8');
      expect(toml).toContain('[mcp_servers.governed-filesystem]');
    });
  });

  // ---- Claude Code ----

  describe('claude-code integration', () => {
    it('creates policy.yaml, .mcp.json, CLAUDE.md, and .claude/settings.json', () => {
      const result = runInit('claude-code', {});

      expect(result.created).toHaveLength(4);
      expect(result.skipped).toHaveLength(0);

      expect(fs.existsSync(path.join(tmpDir, 'policy.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, '.mcp.json'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'CLAUDE.md'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, '.claude', 'settings.json'))).toBe(true);
    });
  });

  // ---- Idempotency ----

  describe('idempotency', () => {
    it('skips existing files without --force', () => {
      // First run creates everything
      const first = runInit('cursor', {});
      expect(first.created).toHaveLength(3);
      expect(first.skipped).toHaveLength(0);

      // Second run skips everything
      const second = runInit('cursor', {});
      expect(second.created).toHaveLength(0);
      expect(second.skipped).toHaveLength(3);
    });

    it('overwrites existing files with --force', () => {
      // First run
      runInit('cursor', {});

      // Modify policy to verify overwrite
      fs.writeFileSync(path.join(tmpDir, 'policy.yaml'), 'modified content');

      // Second run with --force
      const result = runInit('cursor', { force: true });
      expect(result.created).toHaveLength(3);
      expect(result.skipped).toHaveLength(0);

      // Verify content was overwritten
      const policy = fs.readFileSync(path.join(tmpDir, 'policy.yaml'), 'utf-8');
      expect(policy).toContain('version: "1.0"');
      expect(policy).not.toBe('modified content');
    });
  });

  // ---- Custom policy ----

  describe('custom policy', () => {
    it('uses custom policy path and skips generating default', () => {
      // Create a custom policy
      const customPolicyPath = path.join(tmpDir, 'my-custom-policy.yaml');
      fs.writeFileSync(customPolicyPath, 'name: custom\ncapabilities:\n  - tool: "test"\n    scope: {}');

      const result = runInit('cursor', { policy: customPolicyPath });

      // Should not create policy.yaml (using custom one)
      expect(result.created).toHaveLength(2); // mcp.json + governance.mdc
      expect(fs.existsSync(path.join(tmpDir, 'policy.yaml'))).toBe(false);

      // The mcp.json should reference the custom policy path
      const mcpJson = JSON.parse(
        fs.readFileSync(path.join(tmpDir, '.cursor', 'mcp.json'), 'utf-8'),
      );
      expect(mcpJson.mcpServers['governed-filesystem'].args).toContain(customPolicyPath);
    });

    it('throws if custom policy file does not exist', () => {
      expect(() =>
        runInit('cursor', { policy: '/nonexistent/policy.yaml' }),
      ).toThrow('Policy file not found');
    });
  });

  // ---- Path resolution ----

  describe('path resolution', () => {
    it('mcp.json contains absolute paths', () => {
      runInit('cursor', {});

      const mcpJson = JSON.parse(
        fs.readFileSync(path.join(tmpDir, '.cursor', 'mcp.json'), 'utf-8'),
      );
      const args = mcpJson.mcpServers['governed-filesystem'].args as string[];

      // CLI path should be absolute
      expect(path.isAbsolute(args[0])).toBe(true);
      // Policy path should be absolute
      const policyArgIndex = args.indexOf('--policy') + 1;
      expect(path.isAbsolute(args[policyArgIndex])).toBe(true);
    });
  });
});
