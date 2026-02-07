import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EvidenceLedger } from '../../src/ledger/ledger.js';
import { queryLedger, summarizeSessionLedger } from '../../src/ledger/query.js';

let tmpDir: string;
let ledgerPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
  ledgerPath = path.join(tmpDir, 'test.jsonl');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('EvidenceLedger', () => {
  it('should create a new ledger and append entries', async () => {
    const ledger = new EvidenceLedger(ledgerPath);
    await ledger.init();

    const entry = await ledger.append('session-1', 'session:start', { policy: 'test' });
    expect(entry.seq).toBe(1);
    expect(entry.sessionId).toBe('session-1');
    expect(entry.type).toBe('session:start');
    expect(entry.hash).toMatch(/^sha256:/);
    expect(entry.prev).toBe('sha256:' + '0'.repeat(64));

    const entry2 = await ledger.append('session-1', 'action:evaluate', { tool: 'file:read' });
    expect(entry2.seq).toBe(2);
    expect(entry2.prev).toBe(entry.hash);

    await ledger.close();

    // Verify file exists and has 2 lines
    const content = fs.readFileSync(ledgerPath, 'utf-8').trim();
    const lines = content.split('\n');
    expect(lines).toHaveLength(2);
  });

  it('should maintain hash chain integrity', async () => {
    const ledger = new EvidenceLedger(ledgerPath);
    await ledger.init();

    await ledger.append('session-1', 'session:start', { policy: 'test' });
    await ledger.append('session-1', 'action:evaluate', { tool: 'file:read', verdict: 'allow' });
    await ledger.append('session-1', 'action:result', { tool: 'file:read', success: true });
    await ledger.append('session-1', 'session:terminate', { reason: 'done' });
    await ledger.close();

    const integrity = EvidenceLedger.verifyIntegrity(ledgerPath);
    expect(integrity.valid).toBe(true);
    expect(integrity.totalEntries).toBe(4);
    expect(integrity.firstSeq).toBe(1);
    expect(integrity.lastSeq).toBe(4);
  });

  it('should detect tampered entries', async () => {
    const ledger = new EvidenceLedger(ledgerPath);
    await ledger.init();

    await ledger.append('session-1', 'session:start', { policy: 'test' });
    await ledger.append('session-1', 'action:evaluate', { tool: 'file:read' });
    await ledger.close();

    // Tamper with the first entry
    const content = fs.readFileSync(ledgerPath, 'utf-8');
    const lines = content.split('\n');
    const entry = JSON.parse(lines[0]);
    entry.data.policy = 'tampered';
    lines[0] = JSON.stringify(entry);
    fs.writeFileSync(ledgerPath, lines.join('\n'));

    const integrity = EvidenceLedger.verifyIntegrity(ledgerPath);
    expect(integrity.valid).toBe(false);
    expect(integrity.brokenAt).toBe(1);
    expect(integrity.error).toContain('Hash mismatch');
  });

  it('should resume from an existing ledger', async () => {
    // Write initial entries
    const ledger1 = new EvidenceLedger(ledgerPath);
    await ledger1.init();
    await ledger1.append('session-1', 'session:start', { policy: 'test' });
    await ledger1.append('session-1', 'action:evaluate', { tool: 'file:read' });
    await ledger1.close();

    // Resume
    const ledger2 = new EvidenceLedger(ledgerPath);
    await ledger2.init();
    expect(ledger2.getSeq()).toBe(2);

    await ledger2.append('session-1', 'session:terminate', { reason: 'done' });
    await ledger2.close();

    const integrity = EvidenceLedger.verifyIntegrity(ledgerPath);
    expect(integrity.valid).toBe(true);
    expect(integrity.totalEntries).toBe(3);
  });

  it('should read all entries', async () => {
    const ledger = new EvidenceLedger(ledgerPath);
    await ledger.init();
    await ledger.append('session-1', 'session:start', { policy: 'test' });
    await ledger.append('session-1', 'action:evaluate', { tool: 'file:read' });
    await ledger.close();

    const entries = ledger.readAll();
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe('session:start');
    expect(entries[1].type).toBe('action:evaluate');
  });
});

describe('Ledger Query', () => {
  it('should filter by event type', async () => {
    const ledger = new EvidenceLedger(ledgerPath);
    await ledger.init();
    await ledger.append('session-1', 'session:start', {});
    await ledger.append('session-1', 'action:evaluate', { verdict: 'allow' });
    await ledger.append('session-1', 'action:evaluate', { verdict: 'deny' });
    await ledger.append('session-1', 'session:terminate', {});
    await ledger.close();

    const entries = ledger.readAll();
    const evaluations = queryLedger(entries, { types: ['action:evaluate'] });
    expect(evaluations).toHaveLength(2);
  });

  it('should filter by session ID', async () => {
    const ledger = new EvidenceLedger(ledgerPath);
    await ledger.init();
    await ledger.append('session-1', 'session:start', {});
    await ledger.append('session-2', 'session:start', {});
    await ledger.append('session-1', 'session:terminate', {});
    await ledger.close();

    const entries = ledger.readAll();
    const session1 = queryLedger(entries, { sessionId: 'session-1' });
    expect(session1).toHaveLength(2);
  });

  it('should respect limit and offset', async () => {
    const ledger = new EvidenceLedger(ledgerPath);
    await ledger.init();
    for (let i = 0; i < 10; i++) {
      await ledger.append('session-1', 'action:evaluate', { index: i });
    }
    await ledger.close();

    const entries = ledger.readAll();
    const page = queryLedger(entries, { limit: 3, offset: 2 });
    expect(page).toHaveLength(3);
    expect(page[0].data.index).toBe(2);
  });
});

describe('Session Ledger Summary', () => {
  it('should produce a correct summary', async () => {
    const ledger = new EvidenceLedger(ledgerPath);
    await ledger.init();
    await ledger.append('session-1', 'session:start', { policy: 'test' });
    await ledger.append('session-1', 'action:evaluate', { verdict: 'allow', tool: 'file:read' });
    await ledger.append('session-1', 'action:result', { tool: 'file:read', success: true });
    await ledger.append('session-1', 'action:evaluate', { verdict: 'deny', tool: 'file:write' });
    await ledger.append('session-1', 'gate:requested', { tool: 'file:delete' });
    await ledger.append('session-1', 'gate:approved', { respondedBy: 'human' });
    await ledger.append('session-1', 'session:terminate', { reason: 'completed' });
    await ledger.close();

    const entries = ledger.readAll();
    const summary = summarizeSessionLedger(entries, 'session-1');
    expect(summary.totalEntries).toBe(7);
    expect(summary.actionsEvaluated).toBe(2);
    expect(summary.actionsAllowed).toBe(1);
    expect(summary.actionsDenied).toBe(1);
    expect(summary.resultsRecorded).toBe(1);
    expect(summary.gatesRequested).toBe(1);
    expect(summary.gatesApproved).toBe(1);
    expect(summary.errors).toEqual(['completed']);
  });
});
