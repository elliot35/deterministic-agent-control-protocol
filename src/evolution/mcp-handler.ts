/**
 * MCP-Native Evolution Handler — policy evolution via the MCP tool protocol.
 *
 * Instead of blocking on stdin (which conflicts with MCP stdio transport),
 * this handler works in two asynchronous steps:
 *
 *  1. On deny: returns a structured denial response with a suggestion ID.
 *     The agent presents the suggestion to the user in chat.
 *  2. On approve: the agent calls `policy_evolution_approve` with the
 *     suggestion ID and the user's decision. The handler applies the change.
 *
 * The agent then retries the original tool call.
 */

import { nanoid } from 'nanoid';
import type { ActionRequest, Policy, Session } from '../types.js';
import type { EvolutionDecision, PolicySuggestion } from './types.js';
import { suggestPolicyChange } from './suggestion.js';
import { applyPolicyChange, writePolicyToFile } from './writer.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingSuggestion {
  suggestion: PolicySuggestion;
  action: ActionRequest;
  sessionId: string;
  createdAt: number;
}

interface McpToolContent {
  type: 'text';
  text: string;
}

interface McpToolResponse {
  [key: string]: unknown;
  content: McpToolContent[];
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const TOOL_NAME = 'policy_evolution_approve';

const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    'Approve or deny a suggested policy change after a tool call was denied. ' +
    'Present the suggestion to the user first and relay their decision.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      suggestion_id: {
        type: 'string',
        description: 'The suggestion ID from the denial message',
      },
      decision: {
        type: 'string',
        enum: ['add-to-policy', 'allow-once', 'deny'],
        description:
          'The user\'s decision: "add-to-policy" persists to YAML, ' +
          '"allow-once" applies for this session only, "deny" keeps the block',
      },
    },
    required: ['suggestion_id', 'decision'],
  },
};

// ---------------------------------------------------------------------------
// Handler class
// ---------------------------------------------------------------------------

export class McpEvolutionHandler {
  private pendingSuggestions = new Map<string, PendingSuggestion>();
  private readonly policyPath: string;

  constructor(policyPath: string) {
    this.policyPath = policyPath;
  }

  /** The MCP tool name used by this handler. */
  static readonly TOOL_NAME = TOOL_NAME;

  /**
   * Return the MCP tool definition for `policy_evolution_approve`.
   */
  getToolDefinition(): typeof TOOL_DEFINITION {
    return TOOL_DEFINITION;
  }

  /**
   * Build a denial response that includes a policy-change suggestion.
   *
   * Called by the proxy when a tool call is denied and evolution is enabled.
   * Returns `null` if the denial is not suggestible (e.g. budget exceeded),
   * so the proxy should fall back to a plain denial message.
   */
  buildDenialResponse(
    action: ActionRequest,
    reasons: string[],
    policy: Policy,
    sessionId: string,
  ): McpToolResponse | null {
    const suggestion = suggestPolicyChange(action, reasons, policy);
    if (!suggestion) {
      return null;
    }

    const suggestionId = nanoid(12);
    this.pendingSuggestions.set(suggestionId, {
      suggestion,
      action,
      sessionId,
      createdAt: Date.now(),
    });

    const text = [
      `Action denied by policy: ${reasons.join('; ')}`,
      '',
      `[Policy Evolution] Suggested change: ${suggestion.description}`,
      `Suggestion ID: ${suggestionId}`,
      '',
      'ACTION REQUIRED: Ask the user whether to "add-to-policy", "allow-once", or "deny", then call policy_evolution_approve with the suggestion_id and their decision. If approved, retry the original tool call.',
    ].join('\n');

    return {
      content: [{ type: 'text', text }],
      isError: true,
    };
  }

  /**
   * Handle a call to `policy_evolution_approve`.
   *
   * Validates the suggestion ID, applies the policy change, and returns
   * a success or error message.
   */
  handleApproval(
    args: Record<string, unknown>,
    session: Session,
  ): McpToolResponse {
    const suggestionId = args.suggestion_id as string | undefined;
    const decision = args.decision as EvolutionDecision | undefined;

    if (!suggestionId || !decision) {
      return {
        content: [{ type: 'text', text: 'Missing required fields: suggestion_id, decision' }],
        isError: true,
      };
    }

    const validDecisions: EvolutionDecision[] = ['add-to-policy', 'allow-once', 'deny'];
    if (!validDecisions.includes(decision)) {
      return {
        content: [{
          type: 'text',
          text: `Invalid decision "${decision}". Must be one of: ${validDecisions.join(', ')}`,
        }],
        isError: true,
      };
    }

    const pending = this.pendingSuggestions.get(suggestionId);
    if (!pending) {
      return {
        content: [{
          type: 'text',
          text: `Suggestion "${suggestionId}" not found or already resolved.`,
        }],
        isError: true,
      };
    }

    // Clean up the pending suggestion
    this.pendingSuggestions.delete(suggestionId);

    if (decision === 'deny') {
      return {
        content: [{ type: 'text', text: 'Policy change denied. The restriction remains in place.' }],
      };
    }

    // Apply the change
    try {
      const updated = applyPolicyChange(session.policy, pending.suggestion);
      Object.assign(session.policy, updated);

      if (decision === 'add-to-policy') {
        writePolicyToFile(updated, this.policyPath);
        return {
          content: [{
            type: 'text',
            text: `Policy updated and saved to disk. ${pending.suggestion.description} You can now retry the original action.`,
          }],
        };
      }

      // allow-once
      return {
        content: [{
          type: 'text',
          text: `Policy updated for this session only (not saved to disk). ${pending.suggestion.description} You can now retry the original action.`,
        }],
      };
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: `Failed to apply policy change: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  }

  /**
   * Check whether a tool name is handled by this evolution handler.
   */
  isEvolutionTool(toolName: string): boolean {
    return toolName === TOOL_NAME;
  }

  /**
   * Get the number of pending suggestions (useful for testing).
   */
  getPendingCount(): number {
    return this.pendingSuggestions.size;
  }
}
