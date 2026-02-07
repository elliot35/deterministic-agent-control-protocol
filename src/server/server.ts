/**
 * HTTP Session Server — language-agnostic interface to the Deterministic Agent Control Protocol.
 *
 * Provides REST endpoints for:
 *  - Session creation, evaluation, result recording
 *  - Gate approval/rejection
 *  - Session termination and reporting
 *  - Ledger queries and integrity verification
 *  - Policy validation
 *  - Health checks
 */

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { AgentGateway, type GatewayConfig } from '../engine/runtime.js';
import { parsePolicyYaml, PolicyValidationError } from '../policy/loader.js';
import { EvidenceLedger } from '../ledger/ledger.js';
import { queryLedger, summarizeSessionLedger } from '../ledger/query.js';
import type {
  ActionRequest,
  ActionResult,
  CreateSessionRequest,
} from '../types.js';

export interface ServerConfig {
  host?: string;
  port?: number;
  gatewayConfig: GatewayConfig;
}

export async function createServer(config: ServerConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  // Initialize gateway
  const gateway = await AgentGateway.create(config.gatewayConfig);

  // --- Health ---

  app.get('/health', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      tools: gateway.getRegistry().listTools(),
      activeSessions: gateway.listSessions().filter((s) => s.state === 'active').length,
    };
  });

  // --- Policy Validation ---

  app.post<{ Body: { yaml: string } }>('/validate', async (request, reply) => {
    try {
      const policy = parsePolicyYaml(request.body.yaml);
      return { valid: true, policy };
    } catch (err) {
      if (err instanceof PolicyValidationError) {
        reply.status(400);
        return { valid: false, errors: err.issues };
      }
      reply.status(500);
      return { valid: false, errors: [{ path: '', message: (err as Error).message }] };
    }
  });

  // --- Session Creation ---

  app.post<{ Body: CreateSessionRequest }>('/sessions', async (request, reply) => {
    try {
      const { policy, metadata } = request.body;
      const session = await gateway.createSession(policy, metadata);
      reply.status(201);
      return { sessionId: session.id, state: session.state, session };
    } catch (err) {
      reply.status(400);
      return { error: (err as Error).message };
    }
  });

  // --- List Sessions ---

  app.get('/sessions', async () => {
    const sessions = gateway.listSessions();
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        state: s.state,
        actionsCount: s.actions.length,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
    };
  });

  // --- Get Session ---

  app.get<{ Params: { id: string } }>('/sessions/:id', async (request, reply) => {
    const session = gateway.getSession(request.params.id);
    if (!session) {
      reply.status(404);
      return { error: 'Session not found' };
    }
    return { session };
  });

  // --- Evaluate Action ---

  app.post<{
    Params: { id: string };
    Body: { action: ActionRequest };
  }>('/sessions/:id/evaluate', async (request, reply) => {
    try {
      const result = await gateway.evaluate(request.params.id, request.body.action);
      return result;
    } catch (err) {
      reply.status(400);
      return { error: (err as Error).message };
    }
  });

  // --- Record Result ---

  app.post<{
    Params: { id: string };
    Body: { actionId: string; result: ActionResult };
  }>('/sessions/:id/record', async (request, reply) => {
    try {
      await gateway.recordResult(
        request.params.id,
        request.body.actionId,
        request.body.result,
      );
      return { success: true };
    } catch (err) {
      reply.status(400);
      return { error: (err as Error).message };
    }
  });

  // --- Approve Gate ---

  app.post<{
    Params: { id: string };
    Body: { actionId: string; respondedBy?: string; reason?: string };
  }>('/sessions/:id/approve', async (request, reply) => {
    try {
      await gateway.resolveGate(
        request.params.id,
        request.body.actionId,
        'approved',
        request.body.respondedBy,
        request.body.reason,
      );
      return { approved: true };
    } catch (err) {
      reply.status(400);
      return { error: (err as Error).message };
    }
  });

  // --- Reject Gate ---

  app.post<{
    Params: { id: string };
    Body: { actionId: string; respondedBy?: string; reason: string };
  }>('/sessions/:id/reject', async (request, reply) => {
    try {
      await gateway.resolveGate(
        request.params.id,
        request.body.actionId,
        'rejected',
        request.body.respondedBy,
        request.body.reason,
      );
      return { rejected: true };
    } catch (err) {
      reply.status(400);
      return { error: (err as Error).message };
    }
  });

  // --- Terminate Session ---

  app.post<{
    Params: { id: string };
    Body: { reason?: string };
  }>('/sessions/:id/terminate', async (request, reply) => {
    try {
      const report = await gateway.terminateSession(
        request.params.id,
        request.body?.reason,
      );
      return { report };
    } catch (err) {
      reply.status(400);
      return { error: (err as Error).message };
    }
  });

  // --- Session Report ---

  app.get<{ Params: { id: string } }>('/sessions/:id/report', async (request, reply) => {
    try {
      const report = gateway.getSessionReport(request.params.id);
      return { report };
    } catch (err) {
      reply.status(400);
      return { error: (err as Error).message };
    }
  });

  // --- Session Ledger ---

  app.get<{
    Params: { id: string };
    Querystring: { types?: string; limit?: string; offset?: string };
  }>('/sessions/:id/ledger', async (request, reply) => {
    const ledger = gateway.getSessionLedger(request.params.id);
    if (!ledger) {
      reply.status(404);
      return { error: 'Session not found or ledger not available' };
    }

    const entries = ledger.readAll();
    const filtered = queryLedger(entries, {
      sessionId: request.params.id,
      types: request.query.types?.split(','),
      limit: request.query.limit ? parseInt(request.query.limit) : undefined,
      offset: request.query.offset ? parseInt(request.query.offset) : undefined,
    });

    return {
      entries: filtered,
      total: entries.length,
      returned: filtered.length,
    };
  });

  // --- Session Ledger Summary ---

  app.get<{ Params: { id: string } }>('/sessions/:id/ledger/summary', async (request, reply) => {
    const ledger = gateway.getSessionLedger(request.params.id);
    if (!ledger) {
      reply.status(404);
      return { error: 'Session not found or ledger not available' };
    }

    const entries = ledger.readAll();
    const summary = summarizeSessionLedger(entries, request.params.id);
    return { summary };
  });

  // --- Ledger Integrity Check ---

  app.get<{ Params: { id: string } }>('/sessions/:id/ledger/verify', async (request, reply) => {
    const ledger = gateway.getSessionLedger(request.params.id);
    if (!ledger) {
      reply.status(404);
      return { error: 'Session not found or ledger not available' };
    }

    const result = EvidenceLedger.verifyIntegrity(ledger.getFilePath());
    return { integrity: result };
  });

  return app;
}

/**
 * Start the session server.
 */
export async function startServer(config: ServerConfig): Promise<FastifyInstance> {
  const app = await createServer(config);
  const host = config.host ?? '127.0.0.1';
  const port = config.port ?? 3100;

  await app.listen({ host, port });
  console.log(`Deterministic Agent Control Protocol gateway running at http://${host}:${port}`);
  return app;
}
