/**
 * Shell Proxy — validates shell commands against policy before execution.
 *
 * Wraps command execution with policy enforcement:
 *   1. Parse the command to extract the binary name
 *   2. Evaluate against the session policy
 *   3. If allowed, execute and record result
 *   4. If denied, return the denial reasons without executing
 *
 * Usage:
 *   - Programmatic: `new ShellProxy(gateway, sessionId).exec('ls -la')`
 *   - CLI: `det-acp exec <policy> -- <command>`
 */

import { execSync, type ExecSyncOptions } from 'node:child_process';
import type { AgentGateway } from '../engine/runtime.js';

export interface ShellResult {
  /** Whether the action was allowed by policy */
  allowed: boolean;
  /** Exit code of the command (if executed) */
  exitCode?: number;
  /** Standard output (if executed) */
  stdout?: string;
  /** Standard error (if executed) */
  stderr?: string;
  /** Denial info (if denied) */
  denied?: { reasons: string[] };
  /** The action ID assigned by the gateway */
  actionId?: string;
}

export interface ShellExecOptions {
  /** Working directory */
  cwd?: string;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Environment variables */
  env?: Record<string, string>;
}

export class ShellProxy {
  private gateway: AgentGateway;
  private sessionId: string;

  constructor(gateway: AgentGateway, sessionId: string) {
    this.gateway = gateway;
    this.sessionId = sessionId;
  }

  /**
   * Evaluate and optionally execute a shell command.
   */
  async exec(command: string, opts?: ShellExecOptions): Promise<ShellResult> {
    // Evaluate the command against the session policy
    const evaluation = await this.gateway.evaluate(this.sessionId, {
      tool: 'command:run',
      input: { command },
    });

    if (evaluation.decision === 'deny') {
      return {
        allowed: false,
        denied: { reasons: evaluation.reasons },
        actionId: evaluation.actionId,
      };
    }

    if (evaluation.decision === 'gate') {
      return {
        allowed: false,
        denied: { reasons: [`Requires approval: ${evaluation.reasons.join('; ')}`] },
        actionId: evaluation.actionId,
      };
    }

    // Allowed — execute the command
    const execOpts: ExecSyncOptions = {
      cwd: opts?.cwd,
      timeout: opts?.timeout ?? 30_000,
      env: opts?.env ? { ...process.env, ...opts.env } : undefined,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    };

    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    try {
      const result = execSync(command, execOpts);
      stdout = typeof result === 'string' ? result : result?.toString() ?? '';
    } catch (err: unknown) {
      const execErr = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
      exitCode = execErr.status ?? 1;
      stdout = execErr.stdout?.toString() ?? '';
      stderr = execErr.stderr?.toString() ?? execErr.message ?? '';
    }

    // Record the result
    await this.gateway.recordResult(this.sessionId, evaluation.actionId, {
      success: exitCode === 0,
      output: stdout,
      error: exitCode !== 0 ? (stderr || `Exit code: ${exitCode}`) : undefined,
      durationMs: 0, // execSync is blocking, timing would need wrapping
      artifacts: [
        { type: 'exit_code', value: String(exitCode), description: 'Process exit code' },
        { type: 'log', value: stdout.slice(0, 10000), description: 'stdout (truncated)' },
      ],
    });

    return {
      allowed: true,
      exitCode,
      stdout,
      stderr,
      actionId: evaluation.actionId,
    };
  }

  /**
   * Get the session ID this proxy is associated with.
   */
  getSessionId(): string {
    return this.sessionId;
  }
}
