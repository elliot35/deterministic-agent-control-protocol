/**
 * Ledger-specific types (re-exported from main types for convenience).
 */

export type { LedgerEntry, LedgerEventType } from '../types.js';

export interface LedgerQueryOptions {
  /** Filter by session ID */
  sessionId?: string;
  /** Filter by event type(s) */
  types?: string[];
  /** Filter entries after this timestamp (ISO string) */
  after?: string;
  /** Filter entries before this timestamp (ISO string) */
  before?: string;
  /** Maximum number of entries to return */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

export interface LedgerIntegrityReport {
  valid: boolean;
  totalEntries: number;
  firstSeq: number;
  lastSeq: number;
  brokenAt?: number;
  error?: string;
}
