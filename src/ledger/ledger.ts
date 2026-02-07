/**
 * Evidence Ledger — append-only JSONL log with SHA-256 hash chaining.
 *
 * Every action the agent takes produces an immutable record.
 * Entries are chained: each entry's hash includes the previous entry's hash,
 * forming a tamper-evident chain.
 *
 * Rule: If it's not in the ledger, it didn't happen.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { LedgerEntry, LedgerEventType } from '../types.js';

const GENESIS_HASH = 'sha256:' + '0'.repeat(64);

export class EvidenceLedger {
  private filePath: string;
  private seq: number = 0;
  private lastHash: string = GENESIS_HASH;
  private writeStream: fs.WriteStream | null = null;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  /**
   * Initialize the ledger. If the file exists, reads the last entry
   * to continue the hash chain. If not, creates a new file.
   */
  async init(): Promise<void> {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(this.filePath)) {
      // Resume from existing ledger
      const content = fs.readFileSync(this.filePath, 'utf-8').trim();
      if (content.length > 0) {
        const lines = content.split('\n');
        const lastLine = lines[lines.length - 1];
        try {
          const lastEntry = JSON.parse(lastLine) as LedgerEntry;
          this.seq = lastEntry.seq;
          this.lastHash = lastEntry.hash;
        } catch {
          throw new Error(`Corrupted ledger: cannot parse last entry in ${this.filePath}`);
        }
      }
    }

    this.writeStream = fs.createWriteStream(this.filePath, { flags: 'a' });
  }

  /**
   * Append an entry to the ledger.
   */
  async append(
    sessionId: string,
    type: LedgerEventType,
    data: Record<string, unknown>,
  ): Promise<LedgerEntry> {
    if (!this.writeStream) {
      throw new Error('Ledger not initialized. Call init() first.');
    }

    this.seq++;
    const ts = new Date().toISOString();
    const prev = this.lastHash;

    // Compute hash: sha256(seq + ts + prev + type + JSON(data))
    const hashInput = `${this.seq}|${ts}|${prev}|${type}|${JSON.stringify(data)}`;
    const hash = 'sha256:' + crypto.createHash('sha256').update(hashInput).digest('hex');

    const entry: LedgerEntry = {
      seq: this.seq,
      ts,
      hash,
      prev,
      sessionId,
      type,
      data,
    };

    this.lastHash = hash;

    // Write as JSONL (one JSON object per line)
    return new Promise((resolve, reject) => {
      this.writeStream!.write(JSON.stringify(entry) + '\n', (err) => {
        if (err) reject(err);
        else resolve(entry);
      });
    });
  }

  /**
   * Read all entries from the ledger file.
   */
  readAll(): LedgerEntry[] {
    if (!fs.existsSync(this.filePath)) return [];

    const content = fs.readFileSync(this.filePath, 'utf-8').trim();
    if (content.length === 0) return [];

    return content.split('\n').map((line) => JSON.parse(line) as LedgerEntry);
  }

  /**
   * Get current sequence number.
   */
  getSeq(): number {
    return this.seq;
  }

  /**
   * Get last hash in the chain.
   */
  getLastHash(): string {
    return this.lastHash;
  }

  /**
   * Close the write stream.
   */
  async close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.writeStream) {
        this.writeStream.end(() => resolve());
        this.writeStream = null;
      } else {
        resolve();
      }
    });
  }

  /**
   * Get the file path of the ledger.
   */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Verify the integrity of the entire hash chain.
   */
  static verifyIntegrity(filePath: string): {
    valid: boolean;
    totalEntries: number;
    firstSeq: number;
    lastSeq: number;
    brokenAt?: number;
    error?: string;
  } {
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) {
      return { valid: false, totalEntries: 0, firstSeq: 0, lastSeq: 0, error: 'File not found' };
    }

    const content = fs.readFileSync(absPath, 'utf-8').trim();
    if (content.length === 0) {
      return { valid: true, totalEntries: 0, firstSeq: 0, lastSeq: 0 };
    }

    const lines = content.split('\n');
    let prevHash = GENESIS_HASH;

    for (let i = 0; i < lines.length; i++) {
      let entry: LedgerEntry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        return {
          valid: false,
          totalEntries: lines.length,
          firstSeq: 1,
          lastSeq: lines.length,
          brokenAt: i + 1,
          error: `Cannot parse entry at line ${i + 1}`,
        };
      }

      // Check prev hash link
      if (entry.prev !== prevHash) {
        return {
          valid: false,
          totalEntries: lines.length,
          firstSeq: 1,
          lastSeq: lines.length,
          brokenAt: entry.seq,
          error: `Hash chain broken at seq ${entry.seq}: expected prev=${prevHash}, got prev=${entry.prev}`,
        };
      }

      // Recompute hash
      const hashInput = `${entry.seq}|${entry.ts}|${entry.prev}|${entry.type}|${JSON.stringify(entry.data)}`;
      const expectedHash = 'sha256:' + crypto.createHash('sha256').update(hashInput).digest('hex');

      if (entry.hash !== expectedHash) {
        return {
          valid: false,
          totalEntries: lines.length,
          firstSeq: 1,
          lastSeq: lines.length,
          brokenAt: entry.seq,
          error: `Hash mismatch at seq ${entry.seq}: expected ${expectedHash}, got ${entry.hash}`,
        };
      }

      prevHash = entry.hash;
    }

    return {
      valid: true,
      totalEntries: lines.length,
      firstSeq: 1,
      lastSeq: lines.length,
    };
  }
}
