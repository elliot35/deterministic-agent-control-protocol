/**
 * Policy Writer — applies suggested changes to a Policy object and persists to YAML.
 *
 * All mutations operate on a deep clone so the caller can choose whether to
 * adopt the changes (assign back to session.policy) or discard them.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { validatePolicy } from '../policy/loader.js';
import type { Policy, Capability } from '../types.js';
import type { PolicySuggestion, AddCapabilityChange, WidenScopeChange, RemoveForbiddenChange } from './types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply a PolicySuggestion to a deep-cloned copy of the given policy.
 * The returned policy is validated before being returned.
 *
 * Throws `PolicyValidationError` if the resulting policy is invalid.
 */
export function applyPolicyChange(policy: Policy, suggestion: PolicySuggestion): Policy {
  const clone = structuredClone(policy);

  switch (suggestion.change.type) {
    case 'add_capability':
      applyAddCapability(clone, suggestion.change);
      break;
    case 'widen_scope':
      applyWidenScope(clone, suggestion.change);
      break;
    case 'remove_forbidden':
      applyRemoveForbidden(clone, suggestion.change);
      break;
  }

  // Validate the result to guarantee the policy is still well-formed
  return validatePolicy(clone);
}

/**
 * Serialize a Policy object to YAML and write it to disk.
 */
export function writePolicyToFile(policy: Policy, filePath: string): void {
  const absPath = path.resolve(filePath);
  const dir = path.dirname(absPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const yamlString = yaml.dump(policy, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
    quotingType: '"',
    forceQuotes: false,
  });

  fs.writeFileSync(absPath, yamlString, 'utf-8');
}

// ---------------------------------------------------------------------------
// Mutation helpers (operate on the clone in-place)
// ---------------------------------------------------------------------------

function applyAddCapability(policy: Policy, change: AddCapabilityChange): void {
  const newCapability: Capability = {
    tool: change.tool,
    scope: {
      paths: change.scope.paths,
      binaries: change.scope.binaries,
      domains: change.scope.domains,
      methods: change.scope.methods,
      repos: change.scope.repos,
    },
  };

  // Clean up undefined fields so the YAML stays tidy
  for (const key of Object.keys(newCapability.scope) as Array<keyof typeof newCapability.scope>) {
    if (newCapability.scope[key] === undefined) {
      delete newCapability.scope[key];
    }
  }

  policy.capabilities.push(newCapability);
}

function applyWidenScope(policy: Policy, change: WidenScopeChange): void {
  const capability = policy.capabilities.find((c) => c.tool === change.tool);
  if (!capability) {
    // The tool must already exist for a scope-widen — fall back to adding it
    applyAddCapability(policy, {
      type: 'add_capability',
      tool: change.tool,
      scope: { [change.field]: change.add },
    });
    return;
  }

  const existing = capability.scope[change.field] ?? [];
  const merged = [...existing, ...change.add.filter((v) => !existing.includes(v))];
  capability.scope[change.field] = merged;
}

function applyRemoveForbidden(policy: Policy, change: RemoveForbiddenChange): void {
  policy.forbidden = policy.forbidden.filter((f) => f.pattern !== change.pattern);
}
