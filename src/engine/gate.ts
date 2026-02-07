/**
 * Gate Manager — handles approval gates for session actions.
 *
 * When a policy gate is triggered, the gate manager determines what kind
 * of approval is needed and manages the approval lifecycle.
 *
 * Supports:
 *  - auto:    automatically approve (for low-risk actions)
 *  - human:   pause session and wait for human approval
 *  - webhook: call an external webhook for approval decision
 */

import type {
  ActionRequest,
  Gate,
  GateDecision,
  GateRequest,
  GateResponse,
  RiskLevel,
} from '../types.js';

export type GateHandler = (request: GateRequest) => Promise<GateResponse>;

export class GateManager {
  private pendingGates = new Map<string, GateRequest>();
  private responses = new Map<string, GateResponse>();
  private handlers = new Map<string, GateHandler>();

  /**
   * Register a handler for a specific approval mode.
   * The handler is called when a gate with that mode is triggered.
   */
  registerHandler(mode: string, handler: GateHandler): void {
    this.handlers.set(mode, handler);
  }

  /**
   * Request approval for a gated action.
   * Returns the gate decision.
   */
  async requestApproval(
    sessionId: string,
    actionId: string,
    action: ActionRequest,
    gate: Gate,
  ): Promise<GateResponse> {
    const gateKey = `${sessionId}:${actionId}`;

    const request: GateRequest = {
      sessionId,
      actionId,
      action,
      gate,
      requestedAt: new Date().toISOString(),
    };

    this.pendingGates.set(gateKey, request);

    // Auto-approve mode
    if (gate.approval === 'auto') {
      const response: GateResponse = {
        decision: 'approved',
        respondedBy: 'auto',
        respondedAt: new Date().toISOString(),
        reason: 'Auto-approved by policy',
      };
      this.responses.set(gateKey, response);
      this.pendingGates.delete(gateKey);
      return response;
    }

    // Check for registered handler
    const handler = this.handlers.get(gate.approval);
    if (handler) {
      const response = await handler(request);
      this.responses.set(gateKey, response);
      this.pendingGates.delete(gateKey);
      return response;
    }

    // No handler — gate stays pending
    return {
      decision: 'pending',
      reason: `Awaiting ${gate.approval} approval`,
    };
  }

  /**
   * Manually resolve a pending gate (used by server/CLI for human approval).
   */
  resolve(
    sessionId: string,
    actionId: string,
    decision: GateDecision,
    respondedBy?: string,
    reason?: string,
  ): GateResponse {
    const gateKey = `${sessionId}:${actionId}`;
    const pending = this.pendingGates.get(gateKey);

    if (!pending) {
      throw new Error(`No pending gate found for session ${sessionId} action ${actionId}`);
    }

    const response: GateResponse = {
      decision,
      respondedBy,
      respondedAt: new Date().toISOString(),
      reason,
    };

    this.responses.set(gateKey, response);
    this.pendingGates.delete(gateKey);
    return response;
  }

  /**
   * Get all pending gate requests.
   */
  getPending(): GateRequest[] {
    return Array.from(this.pendingGates.values());
  }

  /**
   * Get pending gates for a specific session.
   */
  getPendingForSession(sessionId: string): GateRequest[] {
    return Array.from(this.pendingGates.values()).filter((g) => g.sessionId === sessionId);
  }

  /**
   * Check if a gate is pending for a specific action.
   */
  isPending(sessionId: string, actionId: string): boolean {
    return this.pendingGates.has(`${sessionId}:${actionId}`);
  }

  /**
   * Get the response for a gate (if resolved).
   */
  getResponse(sessionId: string, actionId: string): GateResponse | undefined {
    return this.responses.get(`${sessionId}:${actionId}`);
  }

  /**
   * Clear all gates for a session (e.g. on session termination).
   */
  clearSession(sessionId: string): void {
    for (const key of this.pendingGates.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.pendingGates.delete(key);
      }
    }
    for (const key of this.responses.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.responses.delete(key);
      }
    }
  }
}

/**
 * Default auto-approve handler for low-risk actions.
 */
export function createAutoApproveHandler(maxRisk: RiskLevel = 'low'): GateHandler {
  const riskOrder: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
  const maxRiskIndex = riskOrder.indexOf(maxRisk);

  return async (request: GateRequest): Promise<GateResponse> => {
    const riskLevel = request.gate.risk_level ?? 'medium';
    const riskIndex = riskOrder.indexOf(riskLevel);

    if (riskIndex <= maxRiskIndex) {
      return {
        decision: 'approved',
        respondedBy: 'auto-approve-handler',
        respondedAt: new Date().toISOString(),
        reason: `Risk level "${riskLevel}" is within auto-approve threshold "${maxRisk}"`,
      };
    }

    return {
      decision: 'pending',
      reason: `Risk level "${riskLevel}" exceeds auto-approve threshold "${maxRisk}" — requires manual approval`,
    };
  };
}
