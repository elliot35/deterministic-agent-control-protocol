/**
 * http:request — Allow-listed HTTP request tool adapter.
 *
 * Makes HTTP requests with strict domain and method allow-listing.
 */

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

export const HttpRequestInputSchema = z.object({
  url: z.string().url('Must be a valid URL'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).optional().default('GET'),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  timeout: z.number().positive().optional().default(30000),
});

export type HttpRequestInput = z.infer<typeof HttpRequestInputSchema>;

export class HttpRequestAdapter extends ToolAdapter {
  readonly name = 'http:request';
  readonly description = 'Make HTTP requests to allow-listed domains';
  readonly inputSchema = HttpRequestInputSchema;

  validate(input: unknown, policy: Policy): ValidationResult {
    const parsed = HttpRequestInputSchema.safeParse(input);
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
    const { url, method, body } = input as HttpRequestInput;
    const parsed = new URL(url);

    return {
      tool: this.name,
      wouldDo: `${method} ${parsed.hostname}${parsed.pathname}`,
      estimatedChanges: method !== 'GET' && method !== 'HEAD' ? [`HTTP ${method} to ${parsed.hostname}`] : [],
      warnings: body ? [`Request has a body (${Buffer.byteLength(body)} bytes)`] : [],
    };
  }

  async execute(input: Record<string, unknown>, ctx: ExecutionContext): Promise<ExecutionResult> {
    const start = Date.now();
    const { url, method, headers, body, timeout } = input as HttpRequestInput;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        method,
        headers: headers ? new Headers(headers as Record<string, string>) : undefined,
        body: body ?? undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const responseBody = await response.text();
      const bodyHash = crypto.createHash('sha256').update(responseBody).digest('hex');
      const payloadHash = body
        ? crypto.createHash('sha256').update(body).digest('hex')
        : 'none';

      ctx.budget.totalOutputBytes += Buffer.byteLength(responseBody);

      return this.success(
        {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          body: responseBody,
        },
        Date.now() - start,
        [
          {
            type: 'log',
            value: `${method} ${url} → ${response.status} ${response.statusText}`,
            description: 'HTTP request/response',
          },
          {
            type: 'checksum',
            value: `request:sha256:${payloadHash} response:sha256:${bodyHash}`,
            description: 'Payload hashes',
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
      success: false,
      description: 'HTTP requests cannot be automatically rolled back. Define compensation actions at the job level.',
    };
  }
}
