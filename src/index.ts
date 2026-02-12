/**
 * Deterministic Agent Control Protocol — Public Library API
 *
 * Import from this module for in-process SDK usage.
 *
 * @example
 * ```typescript
 * import { AgentGateway } from '@det-acp/core';
 *
 * const gateway = await AgentGateway.create({ ledgerDir: './ledgers' });
 * const session = await gateway.createSession('./policy.yaml');
 *
 * const verdict = await gateway.evaluate(session.id, {
 *   tool: 'file:read',
 *   input: { path: '/data/in/file.txt' },
 * });
 *
 * if (verdict.decision === 'allow') {
 *   // Execute the action externally, then record the result
 *   await gateway.recordResult(session.id, verdict.actionId, {
 *     success: true,
 *     output: 'file contents...',
 *   });
 * }
 * ```
 */

// Gateway runtime
export { AgentGateway, type GatewayConfig } from './engine/runtime.js';

// Session manager
export { SessionManager, type SessionManagerConfig } from './engine/session.js';

// Policy
export { loadPolicyFromFile, parsePolicyYaml, validatePolicy, PolicyValidationError } from './policy/loader.js';
export { PolicySchema, SessionConstraintsSchema } from './policy/schema.js';
export { evaluateAction, evaluateSessionAction, assessRiskLevel } from './policy/evaluator.js';

// Tool adapters
export { ToolAdapter } from './tools/base.js';
export { FileReadAdapter } from './tools/file-read.js';
export { FileWriteAdapter } from './tools/file-write.js';
export { FileDeleteAdapter } from './tools/file-delete.js';
export { FileMoveAdapter } from './tools/file-move.js';
export { FileCopyAdapter } from './tools/file-copy.js';
export { DirectoryListAdapter } from './tools/directory-list.js';
export { DirectoryCreateAdapter } from './tools/directory-create.js';
export { CommandRunAdapter } from './tools/command-run.js';
export { HttpRequestAdapter } from './tools/http-request.js';
export { GitDiffAdapter, GitApplyAdapter } from './tools/git.js';
export { GitCommitAdapter } from './tools/git-commit.js';
export { GitStatusAdapter } from './tools/git-status.js';
export { EnvReadAdapter } from './tools/env-read.js';
export { NetworkDnsAdapter } from './tools/network-dns.js';
export { ArchiveExtractAdapter } from './tools/archive-extract.js';

// Action registry
export { ActionRegistry, createDefaultRegistry } from './engine/action-registry.js';

// Gate management
export { GateManager, createAutoApproveHandler } from './engine/gate.js';

// Rollback
export { RollbackManager } from './rollback/manager.js';

// Evidence ledger
export { EvidenceLedger } from './ledger/ledger.js';
export { queryLedger, summarizeSessionLedger } from './ledger/query.js';

// Proxies
export { MCPProxyServer } from './proxy/mcp-proxy.js';
export type { MCPProxyConfig, MCPBackendConfig } from './proxy/mcp-types.js';
export { ShellProxy } from './proxy/shell-proxy.js';

// Policy self-evolution
export { PolicyEvolutionManager } from './evolution/policy-evolution.js';
export { McpEvolutionHandler } from './evolution/mcp-handler.js';
export { suggestPolicyChange } from './evolution/suggestion.js';
export { applyPolicyChange, writePolicyToFile } from './evolution/writer.js';
export { createCliEvolutionHandler } from './evolution/cli-handler.js';
export type {
  DenialCategory,
  PolicySuggestion,
  PolicyChange,
  AddCapabilityChange,
  WidenScopeChange,
  RemoveForbiddenChange,
  EvolutionDecision,
  EvolutionResult,
  EvolutionHandler,
  PolicyEvolutionConfig,
} from './evolution/types.js';

// Server
export { createServer, startServer, type ServerConfig } from './server/server.js';

// Types
export type {
  // Policy types
  Policy,
  Capability,
  CapabilityScope,
  Gate,
  Limits,
  EvidenceConfig,
  ForbiddenPattern,
  Remediation,
  RemediationRule,
  SessionConstraints,
  RateLimitConfig,
  EscalationRule,
  ToolName,
  ApprovalMode,
  RiskLevel,
  // Action types
  ActionRequest,
  ValidationResult,
  ValidationVerdict,
  DryRunResult,
  ExecutionResult,
  ExecutionArtifact,
  RollbackResult,
  ActionResult,
  // Session types
  Session,
  SessionState,
  SessionAction,
  SessionReport,
  // Gateway API types
  EvaluateRequest,
  EvaluateResponse,
  RecordResultRequest,
  BudgetSnapshot,
  // Execution context
  ExecutionContext,
  BudgetTracker,
  // Ledger types
  LedgerEntry,
  LedgerEventType,
  // Gate types
  GateRequest,
  GateResponse,
  GateDecision,
  // Server types
  CreateSessionRequest,
  SessionStatusResponse,
} from './types.js';
