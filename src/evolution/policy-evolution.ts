/**
 * Policy Evolution Manager — orchestrates the deny → prompt → apply cycle.
 *
 * When `handleDenial` is called:
 *  1. Analyses the denial to generate a PolicySuggestion
 *  2. Races the user-provided handler against a timeout (default 30 s)
 *  3. Applies the change to the session policy (and optionally to disk)
 *  4. Returns 'retry' so the caller can re-evaluate, or 'deny' to keep the block
 */

import type { ActionRequest, Policy, Session, ValidationResult } from '../types.js';
import type { PolicyEvolutionConfig, EvolutionDecision } from './types.js';
import { suggestPolicyChange } from './suggestion.js';
import { applyPolicyChange, writePolicyToFile } from './writer.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export class PolicyEvolutionManager {
  private readonly policyPath: string;
  private readonly handler: PolicyEvolutionConfig['handler'];
  private readonly timeoutMs: number;

  constructor(config: PolicyEvolutionConfig) {
    this.policyPath = config.policyPath;
    this.handler = config.handler;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Called when an action is denied.
   *
   * Analyses the denial, optionally prompts the user, applies changes,
   * and indicates whether the caller should re-evaluate ('retry') or
   * keep the denial ('deny').
   *
   * The method mutates `session.policy` in place when the user chooses
   * 'add-to-policy' or 'allow-once' so that a subsequent re-evaluation
   * against the same session will pick up the change.
   */
  async handleDenial(
    session: Session,
    action: ActionRequest,
    result: ValidationResult,
  ): Promise<'retry' | 'deny'> {
    // 1. Generate a suggestion — bail out if the denial isn't suggestible
    const suggestion = suggestPolicyChange(action, result.reasons, session.policy);
    if (!suggestion) {
      return 'deny';
    }

    // 2. Ask the user with a timeout
    let decision: EvolutionDecision;
    try {
      decision = await withTimeout(this.handler(suggestion), this.timeoutMs);
    } catch {
      // Timeout or handler error → keep deny
      return 'deny';
    }

    // 3. Act on the decision
    switch (decision) {
      case 'add-to-policy': {
        const updated = applyPolicyChange(session.policy, suggestion);
        // Mutate session policy in-place so re-evaluation picks it up
        Object.assign(session.policy, updated);
        // Persist to disk
        writePolicyToFile(updated, this.policyPath);
        return 'retry';
      }

      case 'allow-once': {
        const updated = applyPolicyChange(session.policy, suggestion);
        // Only update in-memory — do NOT write to disk
        Object.assign(session.policy, updated);
        return 'retry';
      }

      case 'deny':
      default:
        return 'deny';
    }
  }
}

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

/**
 * Race a promise against a timeout. Rejects with an Error if the timeout
 * fires first.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Evolution prompt timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
