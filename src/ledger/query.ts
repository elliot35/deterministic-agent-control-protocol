/**
 * Ledger Query — filter and search ledger entries.
 */

import type { LedgerEntry } from '../types.js';
import type { LedgerQueryOptions } from './types.js';

/**
 * Filter ledger entries based on query options.
 */
export function queryLedger(
  entries: LedgerEntry[],
  options: LedgerQueryOptions = {},
): LedgerEntry[] {
  let filtered = entries;

  if (options.sessionId) {
    filtered = filtered.filter((e) => e.sessionId === options.sessionId);
  }

  if (options.types && options.types.length > 0) {
    filtered = filtered.filter((e) => options.types!.includes(e.type));
  }

  if (options.after) {
    const afterDate = new Date(options.after).getTime();
    filtered = filtered.filter((e) => new Date(e.ts).getTime() > afterDate);
  }

  if (options.before) {
    const beforeDate = new Date(options.before).getTime();
    filtered = filtered.filter((e) => new Date(e.ts).getTime() < beforeDate);
  }

  if (options.offset) {
    filtered = filtered.slice(options.offset);
  }

  if (options.limit) {
    filtered = filtered.slice(0, options.limit);
  }

  return filtered;
}

/**
 * Get a summary of a session's ledger entries.
 */
export function summarizeSessionLedger(
  entries: LedgerEntry[],
  sessionId: string,
): {
  sessionId: string;
  totalEntries: number;
  stateChanges: string[];
  actionsEvaluated: number;
  actionsAllowed: number;
  actionsDenied: number;
  actionsGated: number;
  resultsRecorded: number;
  actionsRolledBack: number;
  gatesRequested: number;
  gatesApproved: number;
  gatesRejected: number;
  escalationsTriggered: number;
  errors: string[];
} {
  const sessionEntries = entries.filter((e) => e.sessionId === sessionId);

  const actionEvals = sessionEntries.filter((e) => e.type === 'action:evaluate');
  const actionsAllowed = actionEvals.filter((e) => e.data.verdict === 'allow').length;
  const actionsDenied = actionEvals.filter((e) => e.data.verdict === 'deny').length;
  const actionsGated = actionEvals.filter((e) => e.data.verdict === 'gate').length;

  return {
    sessionId,
    totalEntries: sessionEntries.length,
    stateChanges: sessionEntries
      .filter((e) => e.type === 'session:state_change')
      .map((e) => `${e.data.from} → ${e.data.to}`),
    actionsEvaluated: actionEvals.length,
    actionsAllowed,
    actionsDenied,
    actionsGated,
    resultsRecorded: sessionEntries.filter((e) => e.type === 'action:result').length,
    actionsRolledBack: sessionEntries.filter((e) => e.type === 'action:rollback').length,
    gatesRequested: sessionEntries.filter((e) => e.type === 'gate:requested').length,
    gatesApproved: sessionEntries.filter((e) => e.type === 'gate:approved').length,
    gatesRejected: sessionEntries.filter((e) => e.type === 'gate:rejected').length,
    escalationsTriggered: sessionEntries.filter((e) => e.type === 'escalation:triggered').length,
    errors: sessionEntries
      .filter((e) => e.type === 'session:terminate' && e.data.reason)
      .map((e) => e.data.reason as string),
  };
}
