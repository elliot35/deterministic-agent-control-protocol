/**
 * command:run — Allow-listed command execution tool adapter.
 *
 * Runs shell commands with strict binary allow-listing, timeout, and output capture.
 */

import { execSync } from 'node:child_process';
import { z } from 'zod';
import { ToolAdapter } from './base.js';
import { evaluateAction } from '../policy/evaluator.js';
import type {
  DryRunResult,
  ExecutionContext,
  ExecutionResult,
  Policy,
  RollbackResult,
  ValidationResult,
} from '../types.js';

export const CommandRunInputSchema = z.object({
  command: z.string().min(1, 'Command is required'),
  cwd: z.string().optional(),
  timeout: z.number().positive().optional().default(30000),
  env: z.record(z.string(), z.string()).optional(),
});

export type CommandRunInput = z.infer<typeof CommandRunInputSchema>;

export class CommandRunAdapter extends ToolAdapter {
  readonly name = 'command:run';
  readonly description = 'Run a shell command from the allow-listed binaries';
  readonly inputSchema = CommandRunInputSchema;

  validate(input: unknown, policy: Policy): ValidationResult {
    const parsed = CommandRunInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        verdict: 'deny',
        tool: this.name,
        reasons: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      };
    }

    // The evaluator checks the binary against the scope.binaries allow-list
    // We pass input.command as input.binary for the evaluator's scope check
    return evaluateAction(
      { tool: this.name, input: { ...parsed.data, binary: parsed.data.command } },
      policy,
    );
  }

  async dryRun(input: Record<string, unknown>, _ctx: ExecutionContext): Promise<DryRunResult> {
    const { command, cwd, timeout } = input as CommandRunInput;
    const binary = command.split(/\s+/)[0];

    return {
      tool: this.name,
      wouldDo: `Run command: "${command}" (binary: ${binary}, timeout: ${timeout}ms)`,
      estimatedChanges: [],
      warnings: cwd ? [] : ['No working directory specified, using process cwd'],
    };
  }

  async execute(input: Record<string, unknown>, ctx: ExecutionContext): Promise<ExecutionResult> {
    const start = Date.now();
    const { command, cwd, timeout, env } = input as CommandRunInput;

    try {
      const stdout = execSync(command, {
        cwd: cwd ?? process.cwd(),
        timeout,
        env: env ? { ...process.env, ...env } as NodeJS.ProcessEnv : process.env,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024, // 10MB
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      return this.success(
        { stdout: stdout.toString(), command },
        Date.now() - start,
        [
          { type: 'exit_code', value: '0', description: `Command: ${command}` },
          { type: 'log', value: stdout.toString().slice(0, 4096), description: 'stdout (truncated)' },
        ],
      );
    } catch (err: unknown) {
      const execErr = err as { status?: number; stdout?: string; stderr?: string; message: string };
      const exitCode = execErr.status ?? 1;
      const stderr = execErr.stderr ?? execErr.message;

      return {
        tool: this.name,
        success: false,
        output: { stdout: execErr.stdout ?? '', stderr, exitCode },
        error: `Command failed with exit code ${exitCode}: ${stderr}`,
        artifacts: [
          { type: 'exit_code', value: String(exitCode), description: `Command: ${command}` },
        ],
        durationMs: Date.now() - start,
      };
    }
  }

  async rollback(_input: Record<string, unknown>, _ctx: ExecutionContext): Promise<RollbackResult> {
    // Command execution is generally not reversible.
    // Specific rollback logic would need to be defined at a higher level
    // (e.g., compensation actions in the job definition).
    return {
      tool: this.name,
      success: false,
      description: 'Command execution cannot be automatically rolled back. Define compensation actions at the job level.',
    };
  }
}
