/**
 * Core types for the Deterministic Agent Control Protocol.
 *
 * These types are the shared vocabulary used across the entire framework:
 * policy engine, tool adapters, session manager, ledger, and gateway runtime.
 */

// ---------------------------------------------------------------------------
// Policy Types
// ---------------------------------------------------------------------------

export type ToolName = 'file:read' | 'file:write' | 'file:delete' | 'command:run' | 'http:request' | 'git:diff' | 'git:apply' | (string & {});

export type ApprovalMode = 'auto' | 'human' | 'webhook';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface CapabilityScope {
  /** Glob patterns for allowed file paths */
  paths?: string[];
  /** Allowed binary names for command execution */
  binaries?: string[];
  /** Allowed domain names for HTTP requests */
  domains?: string[];
  /** Allowed HTTP methods */
  methods?: string[];
  /** Allowed git repository paths */
  repos?: string[];
}

export interface Capability {
  tool: ToolName;
  scope: CapabilityScope;
}

export interface Gate {
  action: ToolName;
  approval: ApprovalMode;
  risk_level?: RiskLevel;
  condition?: string;
}

export interface Limits {
  max_runtime_ms?: number;
  max_output_bytes?: number;
  max_files_changed?: number;
  max_retries?: number;
  max_cost_usd?: number;
}

export interface EvidenceConfig {
  require: string[];
  format: 'jsonl';
}

export interface ForbiddenPattern {
  pattern: string;
}

export interface RemediationRule {
  match: string;
  action: string;
}

export interface Remediation {
  rules: RemediationRule[];
  fallback_chain?: string[];
}

// ---------------------------------------------------------------------------
// Session Constraints (policy-level)
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  max_per_minute: number;
}

export interface EscalationRule {
  /** Trigger after N actions evaluated */
  after_actions?: number;
  /** Trigger after N minutes elapsed */
  after_minutes?: number;
  /** What to require when triggered */
  require: 'human_checkin';
}

export interface SessionConstraints {
  /** Maximum actions per session */
  max_actions?: number;
  /** Terminate session after N denials */
  max_denials?: number;
  /** Rate limiting for actions */
  rate_limit?: RateLimitConfig;
  /** Escalation rules based on thresholds */
  escalation?: EscalationRule[];
}

// ---------------------------------------------------------------------------
// Policy (top-level)
// ---------------------------------------------------------------------------

export interface Policy {
  version: string;
  name: string;
  description?: string;
  capabilities: Capability[];
  limits: Limits;
  gates: Gate[];
  evidence: EvidenceConfig;
  forbidden: ForbiddenPattern[];
  remediation?: Remediation;
  /** Session-level constraints for the gateway model */
  session?: SessionConstraints;
}

// ---------------------------------------------------------------------------
// Action / Execution Types
// ---------------------------------------------------------------------------

export interface ActionRequest {
  /** The tool to invoke, e.g. "file:read" */
  tool: ToolName;
  /** Tool-specific input parameters */
  input: Record<string, unknown>;
  /** Optional idempotency key provided by caller */
  idempotencyKey?: string;
}

export type ValidationVerdict = 'allow' | 'deny' | 'gate';

export interface ValidationResult {
  verdict: ValidationVerdict;
  tool: ToolName;
  reasons: string[];
  /** If verdict is 'gate', which gate triggered */
  gate?: Gate;
}

export interface DryRunResult {
  tool: ToolName;
  wouldDo: string;
  estimatedChanges?: string[];
  warnings?: string[];
}

export interface ExecutionResult {
  tool: ToolName;
  success: boolean;
  output?: unknown;
  artifacts?: ExecutionArtifact[];
  error?: string;
  durationMs: number;
}

export interface ExecutionArtifact {
  type: 'diff' | 'checksum' | 'log' | 'snapshot' | 'exit_code';
  value: string;
  description?: string;
}

export interface RollbackResult {
  tool: ToolName;
  success: boolean;
  description: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Execution Context (used by tool adapters)
// ---------------------------------------------------------------------------

export interface ExecutionContext {
  sessionId: string;
  actionIndex: number;
  dryRun: boolean;
  policy: Policy;
  /** Scratch data that tools can use to stash rollback info (e.g. backup paths) */
  rollbackData: Record<string, unknown>;
  /** Runtime budget tracking */
  budget: BudgetTracker;
}

export interface BudgetTracker {
  startedAt: number;
  filesChanged: number;
  totalOutputBytes: number;
  retries: number;
  costUsd: number;
  /** Number of actions evaluated in this session */
  actionsEvaluated: number;
  /** Number of actions denied in this session */
  actionsDenied: number;
}

// ---------------------------------------------------------------------------
// Session Types (replaces Job types)
// ---------------------------------------------------------------------------

export type SessionState = 'active' | 'paused' | 'terminated';

export interface Session {
  id: string;
  policy: Policy;
  state: SessionState;
  budget: BudgetTracker;
  actions: SessionAction[];
  /** Optional metadata about the agent/source */
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  terminatedAt?: string;
  terminationReason?: string;
}

export interface SessionAction {
  id: string;
  index: number;
  request: ActionRequest;
  validation: ValidationResult;
  /** Recorded after external execution */
  result?: ActionResult;
  timestamp: string;
}

export interface ActionResult {
  success: boolean;
  output?: unknown;
  artifacts?: ExecutionArtifact[];
  error?: string;
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Gateway API Types
// ---------------------------------------------------------------------------

export interface EvaluateRequest {
  sessionId: string;
  action: ActionRequest;
}

export interface BudgetSnapshot {
  runtimeMs: number;
  filesChanged: number;
  totalOutputBytes: number;
  actionsEvaluated: number;
  actionsDenied: number;
  costUsd: number;
}

export interface EvaluateResponse {
  actionId: string;
  decision: ValidationVerdict;
  reasons: string[];
  gate?: Gate;
  budgetRemaining?: BudgetSnapshot;
  warnings?: string[];
}

export interface RecordResultRequest {
  sessionId: string;
  actionId: string;
  result: ActionResult;
}

export interface SessionReport {
  sessionId: string;
  state: SessionState;
  totalActions: number;
  allowed: number;
  denied: number;
  gated: number;
  durationMs: number;
  budgetUsed: BudgetTracker;
  actions: SessionAction[];
}

// ---------------------------------------------------------------------------
// Ledger Types
// ---------------------------------------------------------------------------

export type LedgerEventType =
  | 'session:start'
  | 'session:state_change'
  | 'session:terminate'
  | 'action:evaluate'
  | 'action:result'
  | 'action:rollback'
  | 'gate:requested'
  | 'gate:approved'
  | 'gate:rejected'
  | 'budget:warning'
  | 'budget:exceeded'
  | 'escalation:triggered';

export interface LedgerEntry {
  seq: number;
  ts: string;
  hash: string;
  prev: string;
  sessionId: string;
  type: LedgerEventType;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Gate / Approval Types
// ---------------------------------------------------------------------------

export type GateDecision = 'approved' | 'rejected' | 'pending';

export interface GateRequest {
  sessionId: string;
  actionId: string;
  action: ActionRequest;
  gate: Gate;
  requestedAt: string;
}

export interface GateResponse {
  decision: GateDecision;
  respondedBy?: string;
  respondedAt?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Server Types
// ---------------------------------------------------------------------------

export interface CreateSessionRequest {
  policy: string; // path to policy file or inline YAML
  metadata?: Record<string, unknown>;
}

export interface SessionStatusResponse {
  session: Session;
}

export interface ApproveRequest {
  actionId: string;
  respondedBy?: string;
  reason?: string;
}

export interface RejectRequest {
  actionId: string;
  respondedBy?: string;
  reason: string;
}
