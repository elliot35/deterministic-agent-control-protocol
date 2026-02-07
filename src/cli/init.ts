/**
 * `det-acp init <integration>` command.
 *
 * Scaffolds all required files for a given integration (cursor, codex,
 * claude-code) so users can get started with a single command.
 *
 * The only file a user may want to customize afterwards is policy.yaml.
 */

import type { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_POLICY,
  GOVERNANCE_MDC,
  CLAUDE_MD,
  AGENTS_MD,
  CLAUDE_SETTINGS_JSON,
  generateCursorMcpJson,
  generateClaudeCodeMcpJson,
  generateCodexConfigToml,
} from './templates.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Integration = 'cursor' | 'codex' | 'claude-code';

interface FileToWrite {
  /** Absolute path */
  path: string;
  /** File content */
  content: string;
  /** Short label for display (relative to project root) */
  label: string;
  /** Description shown next to the file in output */
  description: string;
}

interface InitResult {
  created: FileToWrite[];
  skipped: FileToWrite[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to the CLI entry point (dist/cli/index.js).
 * This is used when generating mcp.json / config.toml so the MCP server
 * can be spawned with `node <cliPath> proxy --policy <policy>`.
 */
function resolveCliPath(): string {
  // process.argv[1] is the script being executed, which is dist/cli/index.js
  // when run via `node dist/cli/index.js` or via the `det-acp` bin link.
  return path.resolve(process.argv[1]);
}

/**
 * Ensure a directory exists, creating intermediate dirs as needed.
 */
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Write a file only if it doesn't exist or --force is set.
 * Returns true if the file was written, false if skipped.
 */
function writeIfNeeded(file: FileToWrite, force: boolean): boolean {
  if (fs.existsSync(file.path) && !force) {
    return false;
  }
  ensureDir(path.dirname(file.path));
  fs.writeFileSync(file.path, file.content, 'utf-8');
  return true;
}

// ---------------------------------------------------------------------------
// File manifests per integration
// ---------------------------------------------------------------------------

function cursorFiles(projectDir: string, policyAbsPath: string, cliPath: string): FileToWrite[] {
  return [
    {
      path: policyAbsPath,
      content: DEFAULT_POLICY,
      label: path.relative(projectDir, policyAbsPath),
      description: 'governance policy (edit to customize)',
    },
    {
      path: path.join(projectDir, '.cursor', 'mcp.json'),
      content: generateCursorMcpJson(cliPath, policyAbsPath),
      label: '.cursor/mcp.json',
      description: 'MCP server registration',
    },
    {
      path: path.join(projectDir, '.cursor', 'rules', 'governance.mdc'),
      content: GOVERNANCE_MDC,
      label: '.cursor/rules/governance.mdc',
      description: 'agent governance rule',
    },
  ];
}

function codexFiles(projectDir: string, policyAbsPath: string, cliPath: string): FileToWrite[] {
  return [
    {
      path: policyAbsPath,
      content: DEFAULT_POLICY,
      label: path.relative(projectDir, policyAbsPath),
      description: 'governance policy (edit to customize)',
    },
    {
      path: path.join(projectDir, '.codex', 'config.toml'),
      content: generateCodexConfigToml(cliPath, policyAbsPath),
      label: '.codex/config.toml',
      description: 'Codex config with MCP server registration',
    },
    {
      path: path.join(projectDir, 'AGENTS.md'),
      content: AGENTS_MD,
      label: 'AGENTS.md',
      description: 'agent governance instructions',
    },
  ];
}

function claudeCodeFiles(projectDir: string, policyAbsPath: string, cliPath: string): FileToWrite[] {
  return [
    {
      path: policyAbsPath,
      content: DEFAULT_POLICY,
      label: path.relative(projectDir, policyAbsPath),
      description: 'governance policy (edit to customize)',
    },
    {
      path: path.join(projectDir, '.mcp.json'),
      content: generateClaudeCodeMcpJson(cliPath, policyAbsPath),
      label: '.mcp.json',
      description: 'MCP server registration',
    },
    {
      path: path.join(projectDir, 'CLAUDE.md'),
      content: CLAUDE_MD,
      label: 'CLAUDE.md',
      description: 'agent governance instructions',
    },
    {
      path: path.join(projectDir, '.claude', 'settings.json'),
      content: CLAUDE_SETTINGS_JSON,
      label: '.claude/settings.json',
      description: 'deny built-in file tools (semi-hard enforcement)',
    },
  ];
}

// ---------------------------------------------------------------------------
// Core init logic
// ---------------------------------------------------------------------------

export interface InitOptions {
  policy?: string;
  force?: boolean;
}

export function runInit(integration: Integration, opts: InitOptions): InitResult {
  const projectDir = process.cwd();
  const cliPath = resolveCliPath();

  // Determine the policy file path
  let policyAbsPath: string;
  let customPolicy = false;

  if (opts.policy) {
    policyAbsPath = path.resolve(opts.policy);
    customPolicy = true;
    if (!fs.existsSync(policyAbsPath)) {
      throw new Error(`Policy file not found: ${policyAbsPath}`);
    }
  } else {
    policyAbsPath = path.join(projectDir, 'policy.yaml');
  }

  // Get the file manifest for this integration
  let files: FileToWrite[];
  switch (integration) {
    case 'cursor':
      files = cursorFiles(projectDir, policyAbsPath, cliPath);
      break;
    case 'codex':
      files = codexFiles(projectDir, policyAbsPath, cliPath);
      break;
    case 'claude-code':
      files = claudeCodeFiles(projectDir, policyAbsPath, cliPath);
      break;
    default:
      throw new Error(`Unknown integration: ${integration}`);
  }

  // If a custom policy was provided, skip writing the default policy
  if (customPolicy) {
    files = files.filter((f) => f.path !== policyAbsPath);
  }

  // Write files
  const created: FileToWrite[] = [];
  const skipped: FileToWrite[] = [];

  for (const file of files) {
    const written = writeIfNeeded(file, opts.force ?? false);
    if (written) {
      created.push(file);
    } else {
      skipped.push(file);
    }
  }

  return { created, skipped };
}

// ---------------------------------------------------------------------------
// CLI command registration
// ---------------------------------------------------------------------------

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Set up governance for an AI agent integration')
    .argument('<integration>', 'Integration to set up: cursor, codex, or claude-code')
    .option('--policy <path>', 'Path to an existing policy.yaml (skip generating default)')
    .option('--force', 'Overwrite existing files', false)
    .action((integration: string, opts: { policy?: string; force?: boolean }) => {
      const validIntegrations: Integration[] = ['cursor', 'codex', 'claude-code'];

      if (!validIntegrations.includes(integration as Integration)) {
        console.error(
          `Unknown integration: "${integration}". Valid options: ${validIntegrations.join(', ')}`,
        );
        process.exit(1);
      }

      try {
        const result = runInit(integration as Integration, opts);
        const projectDir = process.cwd();

        console.log('');
        console.log(`  Deterministic Agent Control Protocol -- init (${integration})`);
        console.log(`  Project: ${projectDir}`);
        console.log('');

        if (result.created.length > 0) {
          console.log('  Created:');
          for (const file of result.created) {
            console.log(`    + ${file.label.padEnd(36)} ${file.description}`);
          }
        }

        if (result.skipped.length > 0) {
          console.log('');
          console.log('  Skipped (already exist, use --force to overwrite):');
          for (const file of result.skipped) {
            console.log(`    - ${file.label.padEnd(36)} ${file.description}`);
          }
        }

        console.log('');

        if (opts.policy) {
          console.log(`  Using custom policy: ${opts.policy}`);
        } else {
          console.log('  Next steps:');
          console.log('    1. Review and customize policy.yaml for your needs');
        }

        switch (integration) {
          case 'cursor':
            console.log('    2. Restart Cursor to pick up the MCP server');
            break;
          case 'codex':
            console.log('    2. Run codex to pick up the MCP server');
            break;
          case 'claude-code':
            console.log('    2. Restart Claude Code to pick up the MCP server');
            break;
        }

        console.log('');
        console.log('  The agent will now route file operations through governance.');
        console.log('');
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
