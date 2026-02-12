#!/usr/bin/env node

/**
 * Deterministic Agent Control Protocol CLI
 *
 * Commands:
 *   init <integration>                    Set up governance for cursor, codex, or claude-code
 *   validate <policy.yaml>                Validate a policy file
 *   serve                                 Start the HTTP session server
 *   proxy [config.yaml]                   Start the MCP proxy server
 *   proxy --policy <policy.yaml>          Start MCP proxy with auto-configured defaults
 *   exec <policy.yaml> -- <command>       Execute a command through the shell proxy
 *   report <ledger-file>                  Show ledger summary
 */

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { loadPolicyFromFile, PolicyValidationError } from '../policy/loader.js';
import { AgentGateway } from '../engine/runtime.js';
import type { GatewayConfig } from '../engine/runtime.js';
import { EvidenceLedger } from '../ledger/ledger.js';
import { summarizeSessionLedger } from '../ledger/query.js';
import { ShellProxy } from '../proxy/shell-proxy.js';
import { MCPProxyServer } from '../proxy/mcp-proxy.js';
import { MCPProxyConfigSchema } from '../proxy/mcp-types.js';
import type { MCPProxyConfig } from '../proxy/mcp-types.js';
import { registerInitCommand } from './init.js';

const program = new Command();

program
  .name('det-acp')
  .description('Deterministic Agent Control Protocol — Agent Governance Gateway')
  .version('0.4.2');

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

program
  .command('validate')
  .description('Validate a policy YAML file')
  .argument('<policy>', 'Path to policy YAML file')
  .action(async (policyPath: string) => {
    try {
      const policy = loadPolicyFromFile(policyPath);
      console.log('Policy is valid.');
      console.log(`  Name: ${policy.name}`);
      console.log(`  Version: ${policy.version}`);
      console.log(`  Capabilities: ${policy.capabilities.length}`);
      console.log(`  Gates: ${policy.gates.length}`);
      console.log(`  Forbidden patterns: ${policy.forbidden.length}`);

      if (policy.limits.max_runtime_ms) {
        console.log(`  Max runtime: ${policy.limits.max_runtime_ms}ms`);
      }
      if (policy.limits.max_files_changed) {
        console.log(`  Max files changed: ${policy.limits.max_files_changed}`);
      }

      if (policy.session) {
        console.log('  Session constraints:');
        if (policy.session.max_actions) {
          console.log(`    Max actions: ${policy.session.max_actions}`);
        }
        if (policy.session.max_denials) {
          console.log(`    Max denials: ${policy.session.max_denials}`);
        }
        if (policy.session.rate_limit) {
          console.log(`    Rate limit: ${policy.session.rate_limit.max_per_minute}/min`);
        }
        if (policy.session.escalation) {
          console.log(`    Escalation rules: ${policy.session.escalation.length}`);
        }
      }

      process.exit(0);
    } catch (err) {
      if (err instanceof PolicyValidationError) {
        console.error('Policy validation failed:');
        for (const issue of err.issues) {
          console.error(`  ${issue.path ? issue.path + ': ' : ''}${issue.message}`);
        }
      } else {
        console.error(`Error: ${(err as Error).message}`);
      }
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// exec
// ---------------------------------------------------------------------------

program
  .command('exec')
  .description('Execute a command through the shell proxy (validates against policy)')
  .argument('<policy>', 'Path to policy YAML file')
  .argument('<command...>', 'Command to execute')
  .option('--ledger-dir <dir>', 'Directory for ledger files', '.det-acp/ledgers')
  .action(async (policyPath: string, commandParts: string[], opts: { ledgerDir: string }) => {
    try {
      const command = commandParts.join(' ');
      const ledgerDir = path.resolve(opts.ledgerDir);

      const gateway = await AgentGateway.create({ ledgerDir });
      const session = await gateway.createSession(policyPath);
      const shell = new ShellProxy(gateway, session.id);

      console.log(`Session: ${session.id}`);
      console.log(`Command: ${command}`);
      console.log('');

      const result = await shell.exec(command);

      if (!result.allowed) {
        console.error('DENIED by policy:');
        for (const reason of result.denied?.reasons ?? []) {
          console.error(`  ${reason}`);
        }
        await gateway.terminateSession(session.id, 'Command denied');
        process.exit(1);
      }

      if (result.stdout) {
        process.stdout.write(result.stdout);
      }
      if (result.stderr) {
        process.stderr.write(result.stderr);
      }

      await gateway.terminateSession(session.id, 'Command completed');
      process.exit(result.exitCode ?? 0);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// proxy
// ---------------------------------------------------------------------------

program
  .command('proxy')
  .description('Start the MCP proxy server')
  .argument('[config]', 'Path to MCP proxy config YAML file')
  .option(
    '--policy <path>',
    'Path to policy YAML file (simplified mode — auto-configures filesystem backend at cwd)',
  )
  .option('--dir <path>', 'Project directory for filesystem backend (default: policy file parent dir)')
  .option('--ledger-dir <dir>', 'Directory for ledger files (default: .det-acp/ledgers in project dir)')
  .option('--evolve', 'Enable policy self-evolution (prompt on deny to update policy)')
  .action(
    async (
      configPath: string | undefined,
      opts: { policy?: string; dir?: string; ledgerDir?: string; evolve?: boolean },
    ) => {
      try {
        let proxyConfig: MCPProxyConfig;

        if (opts.policy) {
          // ----- Simplified mode: --policy flag ---------------------------------
          const policyPath = path.resolve(opts.policy);
          if (!fs.existsSync(policyPath)) {
            console.error(`Policy file not found: ${policyPath}`);
            process.exit(1);
          }

          const projectDir = opts.dir
            ? path.resolve(opts.dir)
            : path.dirname(policyPath);
          const ledgerDir = opts.ledgerDir
            ? path.resolve(opts.ledgerDir)
            : path.resolve(projectDir, '.det-acp', 'ledgers');

          proxyConfig = {
            policy: policyPath,
            ledgerDir,
            transport: 'stdio',
            backends: [
              {
                name: 'filesystem',
                transport: 'stdio',
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-filesystem', projectDir],
              },
            ],
          };
        } else if (configPath) {
          // ----- Config file mode (existing behaviour) --------------------------
          const absPath = path.resolve(configPath);
          if (!fs.existsSync(absPath)) {
            console.error(`Config file not found: ${absPath}`);
            process.exit(1);
          }

          const rawYaml = fs.readFileSync(absPath, 'utf-8');
          const parsed = yaml.load(rawYaml);
          const validated = MCPProxyConfigSchema.parse(parsed);

          proxyConfig = {
            policy: path.resolve(path.dirname(absPath), validated.policy),
            ledgerDir: path.resolve(validated.ledger_dir),
            backends: validated.backends,
            transport: validated.transport,
            port: validated.port,
            host: validated.host,
            sessionMetadata: validated.session_metadata as Record<string, unknown> | undefined,
          };
        } else {
          console.error('Either <config> argument or --policy <path> option is required.');
          console.error('');
          console.error('  Usage:');
          console.error('    det-acp proxy <config.yaml>          # Full config file');
          console.error('    det-acp proxy --policy <policy.yaml> # Simplified mode');
          process.exit(1);
          return; // unreachable but helps TS narrow types
        }

        // Enable MCP-native evolution on the proxy (not gateway-level CLI handler)
        if (opts.evolve) {
          proxyConfig.enableEvolution = true;
        }

        const gateway = await AgentGateway.create({
          ledgerDir: proxyConfig.ledgerDir,
        });

        const proxy = new MCPProxyServer(proxyConfig, gateway);

        console.error('Starting MCP proxy server...');
        console.error(`  Transport: ${proxyConfig.transport}`);
        console.error(`  Backends: ${proxyConfig.backends.map((b) => b.name).join(', ')}`);
        if (opts.evolve) {
          console.error('  Policy evolution: enabled');
        }

        await proxy.start();

        // Handle graceful shutdown
        const shutdown = async () => {
          console.error('\nShutting down MCP proxy...');
          await proxy.stop();
          process.exit(0);
        };

        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    },
  );

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

program
  .command('report')
  .description('Show the ledger summary for a session')
  .argument('<ledger-file>', 'Path to the session ledger JSONL file')
  .action(async (ledgerPath: string) => {
    try {
      const absPath = path.resolve(ledgerPath);
      if (!fs.existsSync(absPath)) {
        console.error(`Ledger file not found: ${absPath}`);
        process.exit(1);
      }

      // Verify integrity
      const integrity = EvidenceLedger.verifyIntegrity(absPath);
      console.log('--- Ledger Integrity ---');
      console.log(`Valid: ${integrity.valid}`);
      console.log(`Entries: ${integrity.totalEntries}`);
      if (!integrity.valid) {
        console.log(`Broken at: seq ${integrity.brokenAt}`);
        console.log(`Error: ${integrity.error}`);
      }

      // Read and summarize
      const content = fs.readFileSync(absPath, 'utf-8').trim();
      if (content.length === 0) {
        console.log('Ledger is empty.');
        process.exit(0);
      }

      const entries = content.split('\n').map((line) => JSON.parse(line));
      const sessionId = entries[0]?.sessionId;

      if (sessionId) {
        const summary = summarizeSessionLedger(entries, sessionId);
        console.log(`\n--- Session Summary (${sessionId}) ---`);
        console.log(`Total entries: ${summary.totalEntries}`);
        console.log(`Actions evaluated: ${summary.actionsEvaluated}`);
        console.log(`  Allowed: ${summary.actionsAllowed}`);
        console.log(`  Denied: ${summary.actionsDenied}`);
        console.log(`  Gated: ${summary.actionsGated}`);
        console.log(`Results recorded: ${summary.resultsRecorded}`);
        console.log(`Actions rolled back: ${summary.actionsRolledBack}`);
        console.log(`Gates requested: ${summary.gatesRequested}`);
        console.log(`Gates approved: ${summary.gatesApproved}`);
        console.log(`Gates rejected: ${summary.gatesRejected}`);
        console.log(`Escalations triggered: ${summary.escalationsTriggered}`);
        if (summary.stateChanges.length > 0) {
          console.log(`State changes: ${summary.stateChanges.join(' → ')}`);
        }
        if (summary.errors.length > 0) {
          console.log(`Errors: ${summary.errors.join('; ')}`);
        }
      }

      process.exit(0);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

program
  .command('serve')
  .description('Start the HTTP session server')
  .option('-h, --host <host>', 'Host to bind to', '127.0.0.1')
  .option('-p, --port <port>', 'Port to listen on', '3100')
  .option('--ledger-dir <dir>', 'Directory for ledger files', '.det-acp/ledgers')
  .action(async (opts: { host: string; port: string; ledgerDir: string }) => {
    try {
      const { startServer } = await import('../server/server.js');
      await startServer({
        host: opts.host,
        port: parseInt(opts.port),
        gatewayConfig: {
          ledgerDir: path.resolve(opts.ledgerDir),
        },
      });
    } catch (err) {
      console.error(`Failed to start server: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

registerInitCommand(program);

// ---------------------------------------------------------------------------
// Parse and execute
// ---------------------------------------------------------------------------

program.parse();
