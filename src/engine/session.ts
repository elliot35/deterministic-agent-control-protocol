/**
 * Session Manager — manages the lifecycle of governance sessions.
 *
 * Replaces the batch Job model with a streaming, action-at-a-time model.
 * Each session tracks an ongoing interaction between an agent and the
 * control plane, evaluating actions one at a time against a policy.
 *
 * Key behaviors:
 *  - evaluate(): checks a single action against policy + session state
 *  - recordResult(): records the outcome of an externally-executed action
 *  - terminate(): ends the session and generates a report
 *  - Budget tracking is cumulative across the session
 */

import { nanoid } from 'nanoid';
import type {
  ActionRequest,
  ActionResult,
  BudgetSnapshot,
  BudgetTracker,
  EvaluateResponse,
  GateDecision,
  Policy,
  Session,
  SessionAction,
  SessionReport,
  SessionState,
} from '../types.js';
import { evaluateSessionAction } from '../policy/evaluator.js';
import { GateManager } from './gate.js';
import { EvidenceLedger } from '../ledger/ledger.js';

export interface SessionManagerConfig {
  /** Directory for ledger files. One file per session. */
  ledgerDir: string;
  /** Gate manager for handling approval flows */
  gateManager: GateManager;
  /** Callback invoked when a gate is requested */
  onGateRequest?: (sessionId: string, actionId: string, gate: SessionAction['validation']['gate']) => void;
  /** Callback invoked when session state changes */
  onStateChange?: (sessionId: string, from: SessionState, to: SessionState) => void;
  /** Callback invoked when a session is terminated */
  onSessionTerminated?: (sessionId: string, report: SessionReport) => void;
}

interface SessionEntry {
  session: Session;
  ledger: EvidenceLedger;
  /** Timestamps of recent actions for rate limiting */
  recentActionTimestamps: number[];
}

export class SessionManager {
  private sessions = new Map<string, SessionEntry>();
  private config: SessionManagerConfig;

  constructor(config: SessionManagerConfig) {
    this.config = config;
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Create a new session with a loaded policy.
   */
  async createSession(
    policy: Policy,
    metadata?: Record<string, unknown>,
  ): Promise<Session> {
    const id = nanoid(16);
    const now = new Date().toISOString();

    const budget: BudgetTracker = {
      startedAt: Date.now(),
      filesChanged: 0,
      totalOutputBytes: 0,
      retries: 0,
      costUsd: 0,
      actionsEvaluated: 0,
      actionsDenied: 0,
    };

    const session: Session = {
      id,
      policy,
      state: 'active',
      budget,
      actions: [],
      metadata,
      createdAt: now,
      updatedAt: now,
    };

    // Initialize ledger
    const ledger = new EvidenceLedger(`${this.config.ledgerDir}/${id}.jsonl`);
    await ledger.init();

    await ledger.append(id, 'session:start', {
      policy: policy.name,
      version: policy.version,
      metadata: metadata ?? {},
    });

    this.sessions.set(id, {
      session,
      ledger,
      recentActionTimestamps: [],
    });

    return session;
  }

  /**
   * Evaluate a single action against the session's policy + state.
   * Returns allow/deny/gate verdict without executing the action.
   */
  async evaluate(
    sessionId: string,
    action: ActionRequest,
  ): Promise<EvaluateResponse> {
    const entry = this.getEntryRequired(sessionId);
    const { session, ledger } = entry;

    // Generate action ID
    const actionId = nanoid(12);
    const actionIndex = session.actions.length;

    // Evaluate against policy + session state
    const result = evaluateSessionAction(action, session.policy, session);

    // Update budget counters
    session.budget.actionsEvaluated++;
    if (result.verdict === 'deny') {
      session.budget.actionsDenied++;
    }

    // Create session action record
    const sessionAction: SessionAction = {
      id: actionId,
      index: actionIndex,
      request: action,
      validation: result,
      timestamp: new Date().toISOString(),
    };
    session.actions.push(sessionAction);
    session.updatedAt = new Date().toISOString();

    // Track timestamp for rate limiting
    entry.recentActionTimestamps.push(Date.now());
    // Prune timestamps older than 2 minutes
    const twoMinutesAgo = Date.now() - 120_000;
    entry.recentActionTimestamps = entry.recentActionTimestamps.filter((t) => t >= twoMinutesAgo);

    // Log to ledger
    await ledger.append(sessionId, 'action:evaluate', {
      actionId,
      actionIndex,
      tool: action.tool,
      verdict: result.verdict,
      reasons: result.reasons,
    });

    // Handle gate verdict
    if (result.verdict === 'gate' && result.gate) {
      const prevState = session.state;
      session.state = 'paused';
      this.config.onStateChange?.(sessionId, prevState, 'paused');

      // Request approval through gate manager
      const gateResponse = await this.config.gateManager.requestApproval(
        sessionId,
        actionId,
        action,
        result.gate,
      );

      await ledger.append(sessionId, 'gate:requested', {
        actionId,
        tool: action.tool,
        gate: result.gate,
      });

      // If gate was auto-approved or handler-approved, resume
      if (gateResponse.decision === 'approved') {
        session.state = 'active';
        this.config.onStateChange?.(sessionId, 'paused', 'active');

        await ledger.append(sessionId, 'gate:approved', {
          actionId,
          respondedBy: gateResponse.respondedBy,
          reason: gateResponse.reason,
        });

        return {
          actionId,
          decision: 'allow',
          reasons: [`Gate approved: ${gateResponse.reason ?? 'approved'}`],
          budgetRemaining: this.getBudgetSnapshot(session),
          warnings: (result as { warnings?: string[] }).warnings,
        };
      }

      if (gateResponse.decision === 'rejected') {
        session.state = 'active';
        this.config.onStateChange?.(sessionId, 'paused', 'active');

        await ledger.append(sessionId, 'gate:rejected', {
          actionId,
          respondedBy: gateResponse.respondedBy,
          reason: gateResponse.reason,
        });

        return {
          actionId,
          decision: 'deny',
          reasons: [`Gate rejected: ${gateResponse.reason ?? 'rejected'}`],
          budgetRemaining: this.getBudgetSnapshot(session),
        };
      }

      // Decision is 'pending' — session stays paused
      this.config.onGateRequest?.(sessionId, actionId, result.gate);

      return {
        actionId,
        decision: 'gate',
        reasons: result.reasons,
        gate: result.gate,
        budgetRemaining: this.getBudgetSnapshot(session),
      };
    }

    // Check if session should be auto-terminated (max denials exceeded)
    if (
      session.policy.session?.max_denials != null &&
      session.budget.actionsDenied >= session.policy.session.max_denials
    ) {
      await this.terminate(sessionId, `Maximum denial limit reached (${session.budget.actionsDenied})`);
    }

    return {
      actionId,
      decision: result.verdict,
      reasons: result.reasons,
      budgetRemaining: this.getBudgetSnapshot(session),
      warnings: (result as { warnings?: string[] }).warnings,
    };
  }

  /**
   * Record the result of an externally-executed action.
   */
  async recordResult(
    sessionId: string,
    actionId: string,
    result: ActionResult,
  ): Promise<void> {
    const entry = this.getEntryRequired(sessionId);
    const { session, ledger } = entry;

    const action = session.actions.find((a) => a.id === actionId);
    if (!action) {
      throw new Error(`Action "${actionId}" not found in session "${sessionId}"`);
    }

    if (action.result) {
      throw new Error(`Result already recorded for action "${actionId}"`);
    }

    action.result = result;
    session.updatedAt = new Date().toISOString();

    // Update budget based on result
    if (result.artifacts) {
      for (const artifact of result.artifacts) {
        if (artifact.type === 'diff' || artifact.type === 'checksum') {
          session.budget.filesChanged++;
        }
      }
    }
    if (result.output != null) {
      const outputSize = JSON.stringify(result.output).length;
      session.budget.totalOutputBytes += outputSize;
    }

    await ledger.append(sessionId, 'action:result', {
      actionId,
      tool: action.request.tool,
      success: result.success,
      durationMs: result.durationMs,
      error: result.error,
    });
  }

  /**
   * Resolve a gate (approve or reject a pending action).
   */
  async resolveGate(
    sessionId: string,
    actionId: string,
    decision: GateDecision,
    respondedBy?: string,
    reason?: string,
  ): Promise<void> {
    const entry = this.getEntryRequired(sessionId);
    const { session, ledger } = entry;

    // Resolve through gate manager
    const response = this.config.gateManager.resolve(
      sessionId,
      actionId,
      decision,
      respondedBy,
      reason,
    );

    const eventType = decision === 'approved' ? 'gate:approved' as const : 'gate:rejected' as const;
    await ledger.append(sessionId, eventType, {
      actionId,
      respondedBy: response.respondedBy,
      reason: response.reason,
    });

    // Resume session if no more pending gates
    if (session.state === 'paused') {
      const pending = this.config.gateManager.getPendingForSession(sessionId);
      if (pending.length === 0) {
        const prevState = session.state;
        session.state = 'active';
        session.updatedAt = new Date().toISOString();
        this.config.onStateChange?.(sessionId, prevState, 'active');
      }
    }
  }

  /**
   * Terminate a session.
   */
  async terminate(
    sessionId: string,
    reason?: string,
  ): Promise<SessionReport> {
    const entry = this.getEntryRequired(sessionId);
    const { session, ledger } = entry;

    const prevState = session.state;
    session.state = 'terminated';
    session.terminatedAt = new Date().toISOString();
    session.terminationReason = reason;
    session.updatedAt = session.terminatedAt;

    this.config.onStateChange?.(sessionId, prevState, 'terminated');

    // Clear any pending gates
    this.config.gateManager.clearSession(sessionId);

    const report = this.generateReport(session);

    await ledger.append(sessionId, 'session:terminate', {
      reason,
      totalActions: report.totalActions,
      allowed: report.allowed,
      denied: report.denied,
      gated: report.gated,
      durationMs: report.durationMs,
    });

    await ledger.close();

    this.config.onSessionTerminated?.(sessionId, report);

    return report;
  }

  // ---------------------------------------------------------------------------
  // Introspection
  // ---------------------------------------------------------------------------

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)?.session;
  }

  /**
   * List all sessions.
   */
  listSessions(): Session[] {
    return Array.from(this.sessions.values()).map((e) => e.session);
  }

  /**
   * Get the ledger for a session.
   */
  getLedger(sessionId: string): EvidenceLedger | undefined {
    return this.sessions.get(sessionId)?.ledger;
  }

  /**
   * Generate a report for a session.
   */
  getReport(sessionId: string): SessionReport {
    const entry = this.getEntryRequired(sessionId);
    return this.generateReport(entry.session);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getEntryRequired(sessionId: string): SessionEntry {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`Session "${sessionId}" not found`);
    }
    return entry;
  }

  private generateReport(session: Session): SessionReport {
    const startedAt = new Date(session.createdAt).getTime();
    const endedAt = session.terminatedAt
      ? new Date(session.terminatedAt).getTime()
      : Date.now();

    let allowed = 0;
    let denied = 0;
    let gated = 0;

    for (const action of session.actions) {
      switch (action.validation.verdict) {
        case 'allow':
          allowed++;
          break;
        case 'deny':
          denied++;
          break;
        case 'gate':
          gated++;
          break;
      }
    }

    return {
      sessionId: session.id,
      state: session.state,
      totalActions: session.actions.length,
      allowed,
      denied,
      gated,
      durationMs: endedAt - startedAt,
      budgetUsed: { ...session.budget },
      actions: session.actions,
    };
  }

  private getBudgetSnapshot(session: Session): BudgetSnapshot {
    const elapsed = Date.now() - session.budget.startedAt;
    return {
      runtimeMs: elapsed,
      filesChanged: session.budget.filesChanged,
      totalOutputBytes: session.budget.totalOutputBytes,
      actionsEvaluated: session.budget.actionsEvaluated,
      actionsDenied: session.budget.actionsDenied,
      costUsd: session.budget.costUsd,
    };
  }
}
