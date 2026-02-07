/**
 * Rollback Manager — generates compensation plans for session actions.
 *
 * In the gateway model, the control plane does not execute actions directly,
 * so it cannot directly rollback. Instead, it provides:
 *  - A compensation plan listing actions that should be undone
 *  - Integration with the ShellProxy or MCP proxy to execute compensating actions
 *
 * All rollback actions are recorded in the evidence ledger.
 */

import type { ActionRegistry } from '../engine/action-registry.js';
import type { EvidenceLedger } from '../ledger/ledger.js';
import type {
  ExecutionContext,
  SessionAction,
  RollbackResult,
} from '../types.js';

export interface CompensationStep {
  actionId: string;
  actionIndex: number;
  tool: string;
  input: Record<string, unknown>;
  /** Whether this action was successfully executed (and thus may need rollback) */
  wasExecuted: boolean;
  /** Whether the tool adapter supports rollback */
  canRollback: boolean;
}

export interface CompensationPlan {
  sessionId: string;
  /** Steps in reverse order (last executed = first to compensate) */
  steps: CompensationStep[];
}

export interface RollbackReport {
  totalSteps: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: Array<{
    actionId: string;
    actionIndex: number;
    tool: string;
    result: RollbackResult;
  }>;
}

export class RollbackManager {
  constructor(
    private registry: ActionRegistry,
    private ledger: EvidenceLedger,
  ) {}

  /**
   * Build a compensation plan from session actions.
   * Returns steps in reverse order (last executed = first to compensate).
   */
  buildCompensationPlan(
    sessionId: string,
    actions: SessionAction[],
  ): CompensationPlan {
    const steps: CompensationStep[] = [];

    for (let i = actions.length - 1; i >= 0; i--) {
      const action = actions[i];
      const wasExecuted = action.result?.success === true;
      const adapter = this.registry.get(action.request.tool);

      steps.push({
        actionId: action.id,
        actionIndex: action.index,
        tool: action.request.tool,
        input: action.request.input,
        wasExecuted,
        canRollback: adapter != null,
      });
    }

    return { sessionId, steps };
  }

  /**
   * Execute a compensation plan using registered tool adapters.
   * Only works for tools that have adapters with rollback support.
   * Continues even if individual rollbacks fail (best-effort).
   */
  async execute(
    plan: CompensationPlan,
    ctx: ExecutionContext,
  ): Promise<RollbackReport> {
    const results: RollbackReport['results'] = [];
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    for (const step of plan.steps) {
      // Skip steps that were not successfully executed
      if (!step.wasExecuted) {
        skipped++;
        results.push({
          actionId: step.actionId,
          actionIndex: step.actionIndex,
          tool: step.tool,
          result: {
            tool: step.tool,
            success: true,
            description: 'Skipped — action was not successfully executed',
          },
        });
        continue;
      }

      const adapter = this.registry.get(step.tool);
      if (!adapter) {
        failed++;
        const result: RollbackResult = {
          tool: step.tool,
          success: false,
          description: `Cannot rollback — tool adapter "${step.tool}" not found`,
          error: 'Tool adapter not registered',
        };
        results.push({
          actionId: step.actionId,
          actionIndex: step.actionIndex,
          tool: step.tool,
          result,
        });

        await this.ledger.append(ctx.sessionId, 'action:rollback', {
          actionId: step.actionId,
          actionIndex: step.actionIndex,
          tool: step.tool,
          success: false,
          error: result.error,
        });
        continue;
      }

      try {
        const result = await adapter.rollback(step.input, ctx);
        results.push({
          actionId: step.actionId,
          actionIndex: step.actionIndex,
          tool: step.tool,
          result,
        });

        if (result.success) {
          succeeded++;
        } else {
          failed++;
        }

        await this.ledger.append(ctx.sessionId, 'action:rollback', {
          actionId: step.actionId,
          actionIndex: step.actionIndex,
          tool: step.tool,
          success: result.success,
          description: result.description,
          error: result.error,
        });
      } catch (err) {
        failed++;
        const result: RollbackResult = {
          tool: step.tool,
          success: false,
          description: 'Rollback threw an exception',
          error: (err as Error).message,
        };
        results.push({
          actionId: step.actionId,
          actionIndex: step.actionIndex,
          tool: step.tool,
          result,
        });

        await this.ledger.append(ctx.sessionId, 'action:rollback', {
          actionId: step.actionId,
          actionIndex: step.actionIndex,
          tool: step.tool,
          success: false,
          error: (err as Error).message,
        });
      }
    }

    return {
      totalSteps: plan.steps.length,
      succeeded,
      failed,
      skipped,
      results,
    };
  }

  /**
   * Get a compensation plan without executing it.
   * Useful for the gateway model where the caller handles execution.
   */
  getCompensationPlan(
    sessionId: string,
    actions: SessionAction[],
  ): CompensationPlan {
    return this.buildCompensationPlan(sessionId, actions);
  }
}
