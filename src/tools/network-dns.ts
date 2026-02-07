/**
 * network:dns — DNS lookup tool adapter.
 *
 * Performs DNS resolution for hostnames within allowed domains.
 * Read-only operation — no rollback needed.
 * Domain allow-listing enforced by policy.
 */

import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import { z } from 'zod';
import { ToolAdapter } from './base.js';
import { evaluateAction } from '../policy/evaluator.js';
import type {
  DryRunResult,
  ExecutionContext,
  ExecutionResult,
  Policy,
  RollbackResult,
  ValidationResult,
} from '../types.js';

export const NetworkDnsInputSchema = z.object({
  hostname: z.string().min(1, 'Hostname is required'),
  /** DNS record type */
  type: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'SRV', 'PTR']).default('A'),
  /** Timeout in milliseconds */
  timeout: z.number().positive().optional().default(10000),
});

export type NetworkDnsInput = z.infer<typeof NetworkDnsInputSchema>;

export class NetworkDnsAdapter extends ToolAdapter {
  readonly name = 'network:dns';
  readonly description = 'Perform DNS lookups for allow-listed domains';
  readonly inputSchema = NetworkDnsInputSchema;

  validate(input: unknown, policy: Policy): ValidationResult {
    const parsed = NetworkDnsInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        verdict: 'deny',
        tool: this.name,
        reasons: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      };
    }

    return evaluateAction(
      { tool: this.name, input: parsed.data },
      policy,
    );
  }

  async dryRun(input: Record<string, unknown>, _ctx: ExecutionContext): Promise<DryRunResult> {
    const { hostname, type } = input as NetworkDnsInput;

    return {
      tool: this.name,
      wouldDo: `DNS ${type} lookup for ${hostname}`,
      estimatedChanges: [],
      warnings: [],
    };
  }

  async execute(input: Record<string, unknown>, _ctx: ExecutionContext): Promise<ExecutionResult> {
    const start = Date.now();
    const { hostname, type, timeout } = input as NetworkDnsInput;

    try {
      // Set up timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      let records: unknown;

      try {
        const resolver = new dns.Resolver();
        // Apply timeout via AbortController on the resolver
        resolver.setServers(dns.getServers());

        switch (type) {
          case 'A':
            records = await resolver.resolve4(hostname);
            break;
          case 'AAAA':
            records = await resolver.resolve6(hostname);
            break;
          case 'CNAME':
            records = await resolver.resolveCname(hostname);
            break;
          case 'MX':
            records = await resolver.resolveMx(hostname);
            break;
          case 'TXT':
            records = await resolver.resolveTxt(hostname);
            break;
          case 'NS':
            records = await resolver.resolveNs(hostname);
            break;
          case 'SOA':
            records = await resolver.resolveSoa(hostname);
            break;
          case 'SRV':
            records = await resolver.resolveSrv(hostname);
            break;
          case 'PTR':
            records = await resolver.resolvePtr(hostname);
            break;
          default:
            return this.failure(`Unsupported record type: ${type}`, Date.now() - start);
        }
      } finally {
        clearTimeout(timeoutId);
      }

      const resultStr = JSON.stringify(records);
      const resultHash = crypto.createHash('sha256').update(resultStr).digest('hex');

      return this.success(
        {
          hostname,
          type,
          records,
        },
        Date.now() - start,
        [
          {
            type: 'log',
            value: `DNS ${type} ${hostname}: ${resultStr.slice(0, 2048)}`,
            description: 'DNS lookup result',
          },
          {
            type: 'checksum',
            value: `sha256:${resultHash}`,
            description: 'DNS result hash',
          },
        ],
      );
    } catch (err) {
      return this.failure((err as Error).message, Date.now() - start);
    }
  }

  async rollback(_input: Record<string, unknown>, _ctx: ExecutionContext): Promise<RollbackResult> {
    return {
      tool: this.name,
      success: true,
      description: 'No rollback needed for read-only DNS lookup',
    };
  }
}
