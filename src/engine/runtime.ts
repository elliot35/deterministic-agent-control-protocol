/**
 * Agent Gateway — the core entry point for governing agent actions.
 *
 * The gateway operates as a policy evaluation layer that does NOT execute
 * actions itself. Instead, it evaluates each action request against the
 * session's policy and records results reported by external executors.
 *
 * This is the main entry point for both the library SDK and the sidecar server.
 *
 * Flow:
 *   Agent → gateway.evaluate(sessionId, action)
 *     → policy check → allow/deny/gate
 *   Agent executes action externally
 *   Agent → gateway.recordResult(sessionId, actionId, result)
 *     → evidence recorded in ledger
 */

import type {
  ActionRequest,
  ActionResult,
  EvaluateResponse,
  GateDecision,
  Policy,
  Session,
  SessionReport,
  SessionState,
} from '../types.js';
import { ActionRegistry, createDefaultRegistry } from './action-registry.js';
import { SessionManager, type SessionManagerConfig } from './session.js';
import { GateManager } from './gate.js';
import { EvidenceLedger } from '../ledger/ledger.js';
import { loadPolicyFromFile, parsePolicyYaml } from '../policy/loader.js';
import { PolicyEvolutionManager } from '../evolution/policy-evolution.js';
import type { PolicyEvolutionConfig } from '../evolution/types.js';

export interface GatewayConfig {
  /** Directory for ledger files. One file per session. */
  ledgerDir: string;
  /** Optional: pre-configured action registry (for tool validation). */
  registry?: ActionRegistry;
  /** Optional: pre-configured gate manager. */
  gateManager?: GateManager;
  /** Callback invoked when a session needs human approval. */
  onGateRequest?: (sessionId: string, actionId: string, gate: unknown) => void;
  /** Callback invoked on each session state transition. */
  onStateChange?: (sessionId: string, from: SessionState, to: SessionState) => void;
  /** Callback invoked when a session is terminated. */
  onSessionTerminated?: (sessionId: string, report: SessionReport) => void;
  /**
   * Optional policy self-evolution configuration.
   * When set, deny verdicts trigger a user prompt that can update the policy.
   */
  policyEvolution?: PolicyEvolutionConfig;
}

export class AgentGateway {
  private registry: ActionRegistry;
  private gateManager: GateManager;
  private sessionManager: SessionManager;
  private config: GatewayConfig;

  private constructor(config: GatewayConfig, registry: ActionRegistry) {
    this.config = config;
    this.registry = config.registry ?? registry;
    this.gateManager = config.gateManager ?? new GateManager();

    const sessionConfig: SessionManagerConfig = {
      ledgerDir: config.ledgerDir,
      gateManager: this.gateManager,
      onGateRequest: config.onGateRequest,
      onStateChange: config.onStateChange,
      onSessionTerminated: config.onSessionTerminated,
    };

    // Wire policy self-evolution if configured
    if (config.policyEvolution) {
      const evolutionManager = new PolicyEvolutionManager(config.policyEvolution);
      sessionConfig.onDenial = (session, action, result) =>
        evolutionManager.handleDenial(session, action, result);
    }

    this.sessionManager = new SessionManager(sessionConfig);
  }

  /**
   * Create and initialize a new gateway instance.
   */
  static async create(config: GatewayConfig): Promise<AgentGateway> {
    const registry = config.registry ?? await createDefaultRegistry();
    return new AgentGateway(config, registry);
  }

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  /**
   * Create a new governance session.
   * Loads the policy from a file path or inline YAML string.
   */
  async createSession(
    policySource: string,
    metadata?: Record<string, unknown>,
  ): Promise<Session> {
    const policy = this.loadPolicy(policySource);
    return this.sessionManager.createSession(policy, metadata);
  }

  /**
   * Evaluate a single action against the session's policy.
   * Returns allow/deny/gate verdict without executing the action.
   */
  async evaluate(
    sessionId: string,
    action: ActionRequest,
  ): Promise<EvaluateResponse> {
    return this.sessionManager.evaluate(sessionId, action);
  }

  /**
   * Record the result of an externally-executed action.
   */
  async recordResult(
    sessionId: string,
    actionId: string,
    result: ActionResult,
  ): Promise<void> {
    return this.sessionManager.recordResult(sessionId, actionId, result);
  }

  /**
   * Resolve a pending gate (approve or reject).
   */
  async resolveGate(
    sessionId: string,
    actionId: string,
    decision: GateDecision,
    respondedBy?: string,
    reason?: string,
  ): Promise<void> {
    return this.sessionManager.resolveGate(
      sessionId,
      actionId,
      decision,
      respondedBy,
      reason,
    );
  }

  /**
   * Terminate a session and get the final report.
   */
  async terminateSession(
    sessionId: string,
    reason?: string,
  ): Promise<SessionReport> {
    return this.sessionManager.terminate(sessionId, reason);
  }

  // ---------------------------------------------------------------------------
  // Introspection
  // ---------------------------------------------------------------------------

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): Session | undefined {
    return this.sessionManager.getSession(sessionId);
  }

  /**
   * List all sessions.
   */
  listSessions(): Session[] {
    return this.sessionManager.listSessions();
  }

  /**
   * Get a report for a session.
   */
  getSessionReport(sessionId: string): SessionReport {
    return this.sessionManager.getReport(sessionId);
  }

  /**
   * Get the evidence ledger for a session.
   */
  getSessionLedger(sessionId: string): EvidenceLedger | undefined {
    return this.sessionManager.getLedger(sessionId);
  }

  /**
   * Get the action registry (for registering custom tool adapters).
   */
  getRegistry(): ActionRegistry {
    return this.registry;
  }

  /**
   * Get the gate manager.
   */
  getGateManager(): GateManager {
    return this.gateManager;
  }

  /**
   * Get the session manager.
   */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private loadPolicy(policySource: string): Policy {
    if (this.isFilePath(policySource)) {
      return loadPolicyFromFile(policySource);
    }
    return parsePolicyYaml(policySource);
  }

  /**
   * Determine whether policySource looks like a file path rather than inline YAML.
   *
   * A file path never contains newlines and typically matches one of:
   *   - Windows absolute path  (e.g. C:\Users\...\policy.yaml  or  D:/policies/p.yaml)
   *   - Unix absolute path     (e.g. /home/user/policy.yaml)
   *   - Relative path          (e.g. ./policy.yaml  or  ../policies/p.yaml)
   *   - Bare filename / path with YAML extension  (e.g. policy.yaml)
   *   - Any single-line string without colons (can't be YAML key:value)
   *
   * The previous heuristic (`source.includes(':')` → inline YAML) broke on Windows
   * because drive letters like C: contain a colon.
   */
  private isFilePath(source: string): boolean {
    // Inline YAML always spans multiple lines; a file path never does
    if (source.includes('\n')) {
      return false;
    }

    // Windows absolute path: drive letter followed by :\ or :/
    if (/^[A-Za-z]:[/\\]/.test(source)) {
      return true;
    }

    // Unix absolute path
    if (source.startsWith('/')) {
      return true;
    }

    // Relative paths (Unix or Windows separators)
    if (
      source.startsWith('./') ||
      source.startsWith('../') ||
      source.startsWith('.\\') ||
      source.startsWith('..\\')
    ) {
      return true;
    }

    // Ends with a YAML file extension
    if (/\.ya?ml$/i.test(source)) {
      return true;
    }

    // No colons at all → cannot be a YAML key:value pair, treat as a file path
    if (!source.includes(':')) {
      return true;
    }

    return false;
  }
}
