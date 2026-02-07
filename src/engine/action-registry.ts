/**
 * Action Registry — central registry of all available tool adapters.
 *
 * Tools must be registered before the runtime can dispatch actions to them.
 * The registry validates action requests against the policy before dispatching.
 */

import type { ToolAdapter } from '../tools/base.js';
import type { ActionRequest, Policy, ValidationResult } from '../types.js';
import { evaluateAction } from '../policy/evaluator.js';

export class ActionRegistry {
  private adapters = new Map<string, ToolAdapter>();

  /**
   * Register a tool adapter.
   */
  register(adapter: ToolAdapter): void {
    if (this.adapters.has(adapter.name)) {
      throw new Error(`Tool adapter "${adapter.name}" is already registered`);
    }
    this.adapters.set(adapter.name, adapter);
  }

  /**
   * Unregister a tool adapter by name.
   */
  unregister(name: string): boolean {
    return this.adapters.delete(name);
  }

  /**
   * Get a registered tool adapter by name.
   */
  get(name: string): ToolAdapter | undefined {
    return this.adapters.get(name);
  }

  /**
   * Check if a tool adapter is registered.
   */
  has(name: string): boolean {
    return this.adapters.has(name);
  }

  /**
   * Get all registered tool adapter names.
   */
  listTools(): string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Validate an action request: check the tool exists, parse input, and
   * evaluate against the policy.
   */
  validateAction(request: ActionRequest, policy: Policy): ValidationResult {
    const adapter = this.adapters.get(request.tool);
    if (!adapter) {
      return {
        verdict: 'deny',
        tool: request.tool,
        reasons: [`Unknown tool: "${request.tool}". Available: [${this.listTools().join(', ')}]`],
      };
    }

    // Let the adapter validate its own input + policy
    return adapter.validate(request.input, policy);
  }

  /**
   * Get the adapter for an action, throwing if not found.
   */
  getRequired(name: string): ToolAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      throw new Error(`Tool adapter "${name}" is not registered. Available: [${this.listTools().join(', ')}]`);
    }
    return adapter;
  }

  /**
   * Create a registry pre-loaded with the standard tool adapters.
   */
  static createDefault(): ActionRegistry {
    // Lazy imports to avoid circular deps
    const registry = new ActionRegistry();
    return registry;
  }
}

/**
 * Create a registry with all built-in tool adapters.
 */
export async function createDefaultRegistry(): Promise<ActionRegistry> {
  const { FileReadAdapter } = await import('../tools/file-read.js');
  const { FileWriteAdapter } = await import('../tools/file-write.js');
  const { CommandRunAdapter } = await import('../tools/command-run.js');
  const { HttpRequestAdapter } = await import('../tools/http-request.js');
  const { GitDiffAdapter, GitApplyAdapter } = await import('../tools/git.js');

  const registry = new ActionRegistry();
  registry.register(new FileReadAdapter());
  registry.register(new FileWriteAdapter());
  registry.register(new CommandRunAdapter());
  registry.register(new HttpRequestAdapter());
  registry.register(new GitDiffAdapter());
  registry.register(new GitApplyAdapter());

  return registry;
}
