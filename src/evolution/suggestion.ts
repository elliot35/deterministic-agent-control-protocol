/**
 * Suggestion Engine — analyses denial reasons and proposes policy changes.
 *
 * Each denial reason string produced by the evaluator is pattern-matched to
 * determine what single policy edit would resolve it. Budget and session-level
 * denials are intentionally not suggestible (they represent hard limits, not
 * missing permissions).
 */

import type { ActionRequest, Policy } from '../types.js';
import type { DenialCategory, PolicySuggestion, PolicyChange } from './types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Given a denied action and its denial reasons, produce a PolicySuggestion
 * describing the minimal policy change that would allow the action.
 *
 * Returns `null` when the denial is not fixable via policy evolution
 * (e.g. budget exceeded, session constraints).
 */
export function suggestPolicyChange(
  action: ActionRequest,
  reasons: string[],
  policy: Policy,
): PolicySuggestion | null {
  for (const reason of reasons) {
    const suggestion = analyseReason(reason, action, policy);
    if (suggestion) return suggestion;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reason analysers
// ---------------------------------------------------------------------------

function analyseReason(
  reason: string,
  action: ActionRequest,
  policy: Policy,
): PolicySuggestion | null {
  // 1. No capability defined for tool "X"
  const noCapMatch = reason.match(/^No capability defined for tool "(.+)"$/);
  if (noCapMatch) {
    return buildNoCapabilitySuggestion(noCapMatch[1], action);
  }

  // 2. Path "X" is outside allowed scope: [...]
  const pathScopeMatch = reason.match(/^Path "(.+)" is outside allowed scope:/);
  if (pathScopeMatch) {
    return buildWidenScopeSuggestion(action.tool, 'paths', pathScopeMatch[1]);
  }

  // 3. Binary "X" is not in allowed list: [...]
  const binaryMatch = reason.match(/^Binary "(.+)" is not in allowed list:/);
  if (binaryMatch) {
    return buildWidenScopeSuggestion(action.tool, 'binaries', binaryMatch[1]);
  }

  // 4. Domain "X" is not in allowed list: [...]
  const domainMatch = reason.match(/^Domain "(.+)" is not in allowed list:/);
  if (domainMatch) {
    return buildWidenScopeSuggestion(action.tool, 'domains', domainMatch[1]);
  }

  // 5. HTTP method "X" is not in allowed list: [...]
  const methodMatch = reason.match(/^HTTP method "(.+)" is not in allowed list:/);
  if (methodMatch) {
    return buildWidenScopeSuggestion(action.tool, 'methods', methodMatch[1]);
  }

  // 6. Repository "X" is outside allowed scope: [...]
  const repoMatch = reason.match(/^Repository "(.+)" is outside allowed scope:/);
  if (repoMatch) {
    return buildWidenScopeSuggestion(action.tool, 'repos', repoMatch[1]);
  }

  // 7. Path/Command/URL matches forbidden pattern "X"
  const forbiddenPathMatch = reason.match(/^Path "(.+)" matches forbidden pattern "(.+)"$/);
  if (forbiddenPathMatch) {
    return buildRemoveForbiddenSuggestion(action.tool, forbiddenPathMatch[2]);
  }
  const forbiddenCmdMatch = reason.match(/^Command contains forbidden pattern "(.+)"$/);
  if (forbiddenCmdMatch) {
    return buildRemoveForbiddenSuggestion(action.tool, forbiddenCmdMatch[1]);
  }
  const forbiddenUrlMatch = reason.match(/^URL "(.+)" matches forbidden pattern "(.+)"$/);
  if (forbiddenUrlMatch) {
    return buildRemoveForbiddenSuggestion(action.tool, forbiddenUrlMatch[2]);
  }

  // 8. Budget / session violations — not suggestible
  if (
    reason.includes('budget exceeded') ||
    reason.includes('Budget exceeded') ||
    reason.includes('Rate limit exceeded') ||
    reason.includes('Session action limit') ||
    reason.includes('Session denial limit') ||
    reason.startsWith('Session is ')
  ) {
    return null;
  }

  // Unknown denial reason — not suggestible
  return null;
}

// ---------------------------------------------------------------------------
// Suggestion builders
// ---------------------------------------------------------------------------

function buildNoCapabilitySuggestion(
  tool: string,
  action: ActionRequest,
): PolicySuggestion {
  const scope = inferScopeFromInput(tool, action.input);
  const scopeDesc = describeScopeChange(scope);

  return {
    category: 'no_capability',
    tool,
    description: `Add "${tool}" capability${scopeDesc} to the policy?`,
    change: {
      type: 'add_capability',
      tool,
      scope,
    },
  };
}

function buildWidenScopeSuggestion(
  tool: string,
  field: 'paths' | 'binaries' | 'domains' | 'methods' | 'repos',
  value: string,
): PolicySuggestion {
  const fieldLabel: Record<string, string> = {
    paths: 'path',
    binaries: 'binary',
    domains: 'domain',
    methods: 'HTTP method',
    repos: 'repository',
  };

  return {
    category: 'scope_violation',
    tool,
    description: `Add ${fieldLabel[field]} "${value}" to "${tool}" scope?`,
    change: {
      type: 'widen_scope',
      tool,
      field,
      add: [value],
    },
  };
}

function buildRemoveForbiddenSuggestion(
  tool: string,
  pattern: string,
): PolicySuggestion {
  return {
    category: 'forbidden_match',
    tool,
    description: `Remove forbidden pattern "${pattern}" from the policy? (Warning: this loosens security restrictions)`,
    change: {
      type: 'remove_forbidden',
      pattern,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a reasonable initial scope object from action input fields.
 */
function inferScopeFromInput(
  tool: string,
  input: Record<string, unknown>,
): Record<string, string[]> {
  const scope: Record<string, string[]> = {};

  // Path-like input
  const pathValue = (input.path ?? input.file ?? input.target) as string | undefined;
  if (pathValue) {
    scope.paths = [pathValue];
  }

  // Binary / command input
  const binary = (input.binary ?? input.command) as string | undefined;
  if (binary) {
    const baseBinary = binary.split(/\s+/)[0];
    const baseName = baseBinary.split('/').pop() ?? baseBinary;
    scope.binaries = [baseName];
  }

  // URL / domain input
  const url = (input.url ?? input.endpoint) as string | undefined;
  if (url) {
    try {
      const parsed = new URL(url);
      scope.domains = [parsed.hostname];
    } catch {
      // Non-URL value — skip domain inference
    }
  }

  // HTTP method
  const method = input.method as string | undefined;
  if (method) {
    scope.methods = [method.toUpperCase()];
  }

  // Repository
  const repo = (input.repo ?? input.repository) as string | undefined;
  if (repo) {
    scope.repos = [repo];
  }

  return scope;
}

/**
 * Build a short human-readable suffix describing a scope, e.g.
 * ` for path "./config/app.ts"`.
 */
function describeScopeChange(scope: Record<string, string[]>): string {
  const parts: string[] = [];
  if (scope.paths?.length) parts.push(`path "${scope.paths[0]}"`);
  if (scope.binaries?.length) parts.push(`binary "${scope.binaries[0]}"`);
  if (scope.domains?.length) parts.push(`domain "${scope.domains[0]}"`);
  if (scope.methods?.length) parts.push(`method ${scope.methods[0]}`);
  if (scope.repos?.length) parts.push(`repo "${scope.repos[0]}"`);
  return parts.length > 0 ? ` for ${parts.join(', ')}` : '';
}
