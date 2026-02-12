/**
 * Types for the Policy Self-Evolution system.
 *
 * When a policy denial occurs, the evolution system can:
 *  1. Analyse the denial reasons to suggest a policy change
 *  2. Prompt the user (with a configurable timeout)
 *  3. Apply the change to the in-memory policy and optionally persist to YAML
 */

import type { ActionRequest, Policy, Session, ValidationResult } from '../types.js';

// ---------------------------------------------------------------------------
// Denial categories
// ---------------------------------------------------------------------------

/**
 * Broad category of why a policy denied an action.
 * Used to decide what kind of policy change could fix it.
 */
export type DenialCategory =
  | 'no_capability'
  | 'scope_violation'
  | 'forbidden_match'
  | 'budget_exceeded'
  | 'session_constraint'
  | 'unknown';

// ---------------------------------------------------------------------------
// Policy suggestion
// ---------------------------------------------------------------------------

/**
 * A proposed policy change that would allow a previously denied action.
 */
export interface PolicySuggestion {
  /** What kind of denial triggered this suggestion */
  category: DenialCategory;
  /** The tool that was denied */
  tool: string;
  /** Human-readable description of the proposed change */
  description: string;
  /** Detailed change payload — depends on category */
  change: PolicyChange;
}

export type PolicyChange =
  | AddCapabilityChange
  | WidenScopeChange
  | RemoveForbiddenChange;

export interface AddCapabilityChange {
  type: 'add_capability';
  tool: string;
  scope: {
    paths?: string[];
    binaries?: string[];
    domains?: string[];
    methods?: string[];
    repos?: string[];
  };
}

export interface WidenScopeChange {
  type: 'widen_scope';
  tool: string;
  /** Which scope field to extend */
  field: 'paths' | 'binaries' | 'domains' | 'methods' | 'repos';
  /** Values to add */
  add: string[];
}

export interface RemoveForbiddenChange {
  type: 'remove_forbidden';
  pattern: string;
}

// ---------------------------------------------------------------------------
// Evolution decision & result
// ---------------------------------------------------------------------------

/**
 * What the user decided when prompted about a denied action.
 *
 * - `add-to-policy` — mutate policy in memory AND write to disk
 * - `allow-once`    — mutate policy in memory only (one-session override)
 * - `deny`          — keep the original denial, change nothing
 */
export type EvolutionDecision = 'add-to-policy' | 'allow-once' | 'deny';

/**
 * Outcome of the evolution handler after the user has responded (or timed out).
 */
export interface EvolutionResult {
  decision: EvolutionDecision;
  suggestion: PolicySuggestion;
}

// ---------------------------------------------------------------------------
// Handler callback
// ---------------------------------------------------------------------------

/**
 * Pluggable callback that presents a PolicySuggestion to the user and
 * returns their decision. Implementations may use readline, a GUI dialog,
 * a webhook, etc.
 */
export type EvolutionHandler = (suggestion: PolicySuggestion) => Promise<EvolutionDecision>;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PolicyEvolutionConfig {
  /** Absolute or relative path to the policy YAML file on disk */
  policyPath: string;
  /** Handler that asks the user for a decision */
  handler: EvolutionHandler;
  /** Timeout in milliseconds for the user prompt (default: 30 000) */
  timeoutMs?: number;
}
