/**
 * Policy Evaluator — runtime enforcement of policy rules.
 *
 * Given an ActionRequest and a loaded Policy, determines:
 *  - allow: action is permitted
 *  - deny:  action is blocked
 *  - gate:  action requires approval before execution
 *
 * Supports both stateless (single action) and stateful (session-aware) evaluation.
 */

import { minimatch } from 'minimatch';
import type {
  ActionRequest,
  BudgetTracker,
  Capability,
  Gate,
  Limits,
  Policy,
  RiskLevel,
  Session,
  ValidationResult,
  ValidationVerdict,
} from '../types.js';

// ---------------------------------------------------------------------------
// Main evaluation entry point (stateless — single action)
// ---------------------------------------------------------------------------

export function evaluateAction(
  request: ActionRequest,
  policy: Policy,
  budget?: BudgetTracker,
): ValidationResult {
  // 1. Check forbidden patterns
  const forbiddenCheck = checkForbiddenPatterns(request, policy);
  if (forbiddenCheck) {
    return {
      verdict: 'deny',
      tool: request.tool,
      reasons: [forbiddenCheck],
    };
  }

  // 2. Check capability exists for this tool
  const capability = findCapability(request.tool, policy);
  if (!capability) {
    return {
      verdict: 'deny',
      tool: request.tool,
      reasons: [`No capability defined for tool "${request.tool}"`],
    };
  }

  // 3. Check scope constraints
  const scopeViolations = checkScope(request, capability);
  if (scopeViolations.length > 0) {
    return {
      verdict: 'deny',
      tool: request.tool,
      reasons: scopeViolations,
    };
  }

  // 4. Check budget limits
  if (budget) {
    const budgetViolations = checkBudget(policy.limits, budget);
    if (budgetViolations.length > 0) {
      return {
        verdict: 'deny',
        tool: request.tool,
        reasons: budgetViolations,
      };
    }
  }

  // 5. Check if a gate applies
  const gate = findGate(request, policy);
  if (gate) {
    return {
      verdict: 'gate',
      tool: request.tool,
      reasons: [`Gate required: ${gate.approval} approval for "${gate.action}" (risk: ${gate.risk_level ?? 'unspecified'})`],
      gate,
    };
  }

  return {
    verdict: 'allow',
    tool: request.tool,
    reasons: ['Action permitted by policy'],
  };
}

// ---------------------------------------------------------------------------
// Session-aware evaluation (stateful)
// ---------------------------------------------------------------------------

/**
 * Evaluate an action in the context of an active session.
 * Checks session-level constraints on top of the standard policy checks.
 */
export function evaluateSessionAction(
  request: ActionRequest,
  policy: Policy,
  session: Session,
): ValidationResult & { warnings?: string[] } {
  const warnings: string[] = [];

  // 1. Check if session is still active
  if (session.state !== 'active') {
    return {
      verdict: 'deny',
      tool: request.tool,
      reasons: [`Session is ${session.state}, not accepting new actions`],
    };
  }

  // 2. Check session constraints before standard policy checks
  const sessionConstraints = policy.session;
  if (sessionConstraints) {
    // Max actions per session
    if (sessionConstraints.max_actions != null) {
      if (session.budget.actionsEvaluated >= sessionConstraints.max_actions) {
        return {
          verdict: 'deny',
          tool: request.tool,
          reasons: [`Session action limit reached: ${session.budget.actionsEvaluated} >= ${sessionConstraints.max_actions}`],
        };
      }

      // Warn when approaching limit
      const remaining = sessionConstraints.max_actions - session.budget.actionsEvaluated;
      if (remaining <= 5) {
        warnings.push(`Approaching action limit: ${remaining} actions remaining`);
      }
    }

    // Max denials — terminate session if too many denials
    if (sessionConstraints.max_denials != null) {
      if (session.budget.actionsDenied >= sessionConstraints.max_denials) {
        return {
          verdict: 'deny',
          tool: request.tool,
          reasons: [`Session denial limit reached: ${session.budget.actionsDenied} >= ${sessionConstraints.max_denials}. Session should be terminated.`],
        };
      }
    }

    // Rate limiting
    if (sessionConstraints.rate_limit) {
      const rateLimitViolation = checkRateLimit(session, sessionConstraints.rate_limit.max_per_minute);
      if (rateLimitViolation) {
        return {
          verdict: 'deny',
          tool: request.tool,
          reasons: [rateLimitViolation],
        };
      }
    }

    // Escalation rules
    if (sessionConstraints.escalation) {
      const escalation = checkEscalation(session, sessionConstraints.escalation);
      if (escalation) {
        return {
          verdict: 'gate',
          tool: request.tool,
          reasons: [escalation.reason],
          gate: {
            action: request.tool,
            approval: 'human',
            risk_level: 'medium',
            condition: escalation.trigger,
          },
          warnings,
        };
      }
    }
  }

  // 3. Run standard policy checks (with session budget)
  const result = evaluateAction(request, policy, session.budget);

  // Attach warnings
  if (warnings.length > 0) {
    return { ...result, warnings };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

function checkRateLimit(session: Session, maxPerMinute: number): string | null {
  const now = Date.now();
  const oneMinuteAgo = now - 60_000;

  // Count actions in the last minute
  const recentActions = session.actions.filter((a) => {
    const actionTime = new Date(a.timestamp).getTime();
    return actionTime >= oneMinuteAgo;
  });

  if (recentActions.length >= maxPerMinute) {
    return `Rate limit exceeded: ${recentActions.length} actions in the last minute (limit: ${maxPerMinute})`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Escalation checks
// ---------------------------------------------------------------------------

interface EscalationTrigger {
  reason: string;
  trigger: string;
}

function checkEscalation(
  session: Session,
  rules: NonNullable<NonNullable<Policy['session']>['escalation']>,
): EscalationTrigger | null {
  const elapsedMinutes = (Date.now() - session.budget.startedAt) / 60_000;

  for (const rule of rules) {
    if (rule.after_actions != null && session.budget.actionsEvaluated >= rule.after_actions) {
      // Check if a human check-in has already been done after this threshold
      // by looking for a recent gate approval in the session history
      const lastCheckinIndex = findLastCheckin(session, rule.after_actions);
      if (lastCheckinIndex === -1) {
        return {
          reason: `Escalation: ${session.budget.actionsEvaluated} actions evaluated, human check-in required after ${rule.after_actions}`,
          trigger: `after_actions:${rule.after_actions}`,
        };
      }
    }

    if (rule.after_minutes != null && elapsedMinutes >= rule.after_minutes) {
      const lastTimeCheckin = findLastTimeCheckin(session, rule.after_minutes);
      if (lastTimeCheckin === -1) {
        return {
          reason: `Escalation: ${Math.floor(elapsedMinutes)} minutes elapsed, human check-in required after ${rule.after_minutes} minutes`,
          trigger: `after_minutes:${rule.after_minutes}`,
        };
      }
    }
  }

  return null;
}

/**
 * Find the last action index where a human check-in gate was approved
 * after the given threshold was crossed.
 */
function findLastCheckin(session: Session, threshold: number): number {
  // Look for any gated action (with human approval) that was resolved
  // after the threshold was reached
  for (let i = session.actions.length - 1; i >= 0; i--) {
    const action = session.actions[i];
    if (
      action.index >= threshold &&
      action.validation.verdict === 'gate' &&
      action.result !== undefined
    ) {
      return i;
    }
  }
  return -1;
}

function findLastTimeCheckin(session: Session, _afterMinutes: number): number {
  // Look for any gated action that was a time-based escalation and was resolved
  for (let i = session.actions.length - 1; i >= 0; i--) {
    const action = session.actions[i];
    if (
      action.validation.verdict === 'gate' &&
      action.validation.gate?.condition?.startsWith('after_minutes:') &&
      action.result !== undefined
    ) {
      return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Forbidden pattern checks
// ---------------------------------------------------------------------------

function checkForbiddenPatterns(request: ActionRequest, policy: Policy): string | null {
  const input = request.input;

  for (const forbidden of policy.forbidden) {
    const pattern = forbidden.pattern;

    // Check against path-like inputs
    const pathValue = (input.path ?? input.file ?? input.target) as string | undefined;
    if (pathValue && minimatch(pathValue, pattern)) {
      return `Path "${pathValue}" matches forbidden pattern "${pattern}"`;
    }

    // Check against command inputs
    const command = (input.command ?? input.cmd) as string | undefined;
    if (command && command.includes(pattern)) {
      return `Command contains forbidden pattern "${pattern}"`;
    }

    // Check against URL inputs
    const url = (input.url ?? input.endpoint) as string | undefined;
    if (url && minimatch(url, pattern)) {
      return `URL "${url}" matches forbidden pattern "${pattern}"`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Capability lookup
// ---------------------------------------------------------------------------

function findCapability(tool: string, policy: Policy): Capability | undefined {
  return policy.capabilities.find((cap) => cap.tool === tool);
}

// ---------------------------------------------------------------------------
// Scope validation
// ---------------------------------------------------------------------------

function checkScope(request: ActionRequest, capability: Capability): string[] {
  const violations: string[] = [];
  const input = request.input;
  const scope = capability.scope;

  // Path scope
  if (scope.paths) {
    const pathValue = (input.path ?? input.file ?? input.target) as string | undefined;
    if (pathValue) {
      const allowed = scope.paths.some((pattern) => minimatch(pathValue, pattern));
      if (!allowed) {
        violations.push(`Path "${pathValue}" is outside allowed scope: [${scope.paths.join(', ')}]`);
      }
    }
  }

  // Binary scope (for command:run)
  if (scope.binaries) {
    const binary = (input.binary ?? input.command) as string | undefined;
    if (binary) {
      // Extract the base binary name (first word of the command)
      const baseBinary = binary.split(/\s+/)[0];
      const baseName = baseBinary.split('/').pop() ?? baseBinary;
      if (!scope.binaries.includes(baseName)) {
        violations.push(`Binary "${baseName}" is not in allowed list: [${scope.binaries.join(', ')}]`);
      }
    }
  }

  // Domain scope (for http:request)
  if (scope.domains) {
    const url = (input.url ?? input.endpoint) as string | undefined;
    if (url) {
      try {
        const parsed = new URL(url);
        if (!scope.domains.includes(parsed.hostname)) {
          violations.push(`Domain "${parsed.hostname}" is not in allowed list: [${scope.domains.join(', ')}]`);
        }
      } catch {
        violations.push(`Invalid URL: "${url}"`);
      }
    }
  }

  // Method scope (for http:request)
  if (scope.methods) {
    const method = ((input.method as string) ?? 'GET').toUpperCase();
    if (!scope.methods.includes(method)) {
      violations.push(`HTTP method "${method}" is not in allowed list: [${scope.methods.join(', ')}]`);
    }
  }

  // Repo scope (for git operations)
  if (scope.repos) {
    const repo = (input.repo ?? input.repository) as string | undefined;
    if (repo) {
      const allowed = scope.repos.some((pattern) => minimatch(repo, pattern));
      if (!allowed) {
        violations.push(`Repository "${repo}" is outside allowed scope: [${scope.repos.join(', ')}]`);
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Budget checks
// ---------------------------------------------------------------------------

function checkBudget(limits: Limits, budget: BudgetTracker): string[] {
  const violations: string[] = [];

  if (limits.max_runtime_ms != null) {
    const elapsed = Date.now() - budget.startedAt;
    if (elapsed > limits.max_runtime_ms) {
      violations.push(`Runtime budget exceeded: ${elapsed}ms > ${limits.max_runtime_ms}ms`);
    }
  }

  if (limits.max_files_changed != null && budget.filesChanged >= limits.max_files_changed) {
    violations.push(`File change budget exceeded: ${budget.filesChanged} >= ${limits.max_files_changed}`);
  }

  if (limits.max_output_bytes != null && budget.totalOutputBytes >= limits.max_output_bytes) {
    violations.push(`Output size budget exceeded: ${budget.totalOutputBytes} >= ${limits.max_output_bytes}`);
  }

  if (limits.max_retries != null && budget.retries >= limits.max_retries) {
    violations.push(`Retry budget exceeded: ${budget.retries} >= ${limits.max_retries}`);
  }

  if (limits.max_cost_usd != null && budget.costUsd >= limits.max_cost_usd) {
    violations.push(`Cost budget exceeded: $${budget.costUsd} >= $${limits.max_cost_usd}`);
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Gate lookup
// ---------------------------------------------------------------------------

function findGate(request: ActionRequest, policy: Policy): Gate | undefined {
  return policy.gates.find((gate) => {
    if (gate.action !== request.tool) return false;

    // If gate has a condition, evaluate it
    if (gate.condition === 'outside_scope') {
      // This gate fires only if the action targets something outside scope
      const capability = findCapability(request.tool, policy);
      if (capability) {
        const scopeViolations = checkScope(request, capability);
        return scopeViolations.length > 0;
      }
    }

    // No condition or unknown condition — gate always applies
    return !gate.condition;
  });
}

// ---------------------------------------------------------------------------
// Utility: assess risk level for an action
// ---------------------------------------------------------------------------

export function assessRiskLevel(request: ActionRequest, policy: Policy): RiskLevel {
  // Check if there's an explicit gate with a risk level
  const gate = policy.gates.find((g) => g.action === request.tool);
  if (gate?.risk_level) return gate.risk_level;

  // Heuristic risk assessment
  const tool = request.tool;
  if (tool === 'file:delete' || tool === 'command:run') return 'high';
  if (tool === 'file:write' || tool === 'git:apply') return 'medium';
  if (tool === 'http:request') return 'medium';
  if (tool === 'file:read' || tool === 'git:diff') return 'low';

  return 'medium';
}
