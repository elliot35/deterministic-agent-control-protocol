/**
 * archive:extract — Scoped archive extraction tool adapter.
 *
 * Extracts tar and zip archives within allowed path scopes.
 * Both source archive and destination must be within policy scope.
 * Rollback support: removes extracted files.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { ToolAdapter } from './base.js';
import { evaluateAction } from '../policy/evaluator.js';
import type {
  DryRunResult,
  ExecutionContext,
  ExecutionResult,
  ExecutionArtifact,
  Policy,
  RollbackResult,
  ValidationResult,
} from '../types.js';

export const ArchiveExtractInputSchema = z.object({
  /** Path to the archive file */
  archive: z.string().min(1, 'Archive path is required'),
  /** Destination directory for extraction */
  destination: z.string().min(1, 'Destination path is required'),
  /** Archive format (auto-detected from extension if not specified) */
  format: z.enum(['tar', 'tar.gz', 'tar.bz2', 'zip']).optional(),
  /** Timeout in milliseconds */
  timeout: z.number().positive().optional().default(60000),
});

export type ArchiveExtractInput = z.infer<typeof ArchiveExtractInputSchema>;

export class ArchiveExtractAdapter extends ToolAdapter {
  readonly name = 'archive:extract';
  readonly description = 'Extract tar/zip archives within allowed path scopes';
  readonly inputSchema = ArchiveExtractInputSchema;

  validate(input: unknown, policy: Policy): ValidationResult {
    const parsed = ArchiveExtractInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        verdict: 'deny',
        tool: this.name,
        reasons: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      };
    }

    // Validate both archive (read) and destination (write) paths
    const archiveResult = evaluateAction(
      { tool: this.name, input: { ...parsed.data, path: parsed.data.archive } },
      policy,
    );
    if (archiveResult.verdict === 'deny') {
      return {
        ...archiveResult,
        reasons: archiveResult.reasons.map((r) => `Archive: ${r}`),
      };
    }

    const destResult = evaluateAction(
      { tool: this.name, input: { ...parsed.data, path: parsed.data.destination } },
      policy,
    );
    if (destResult.verdict === 'deny') {
      return {
        ...destResult,
        reasons: destResult.reasons.map((r) => `Destination: ${r}`),
      };
    }

    // Return the more restrictive result
    if (archiveResult.verdict === 'gate' || destResult.verdict === 'gate') {
      return archiveResult.verdict === 'gate' ? archiveResult : destResult;
    }

    return archiveResult;
  }

  async dryRun(input: Record<string, unknown>, _ctx: ExecutionContext): Promise<DryRunResult> {
    const { archive, destination, format } = input as ArchiveExtractInput;
    const absArchive = path.resolve(archive);
    const absDest = path.resolve(destination);
    const warnings: string[] = [];

    if (!fs.existsSync(absArchive)) {
      warnings.push(`Archive does not exist: ${absArchive}`);
    }

    if (!fs.existsSync(absDest)) {
      warnings.push(`Destination directory does not exist: ${absDest}`);
    }

    const detectedFormat = format ?? this.detectFormat(absArchive);
    if (!detectedFormat) {
      warnings.push(`Cannot detect archive format from extension: ${absArchive}`);
    }

    return {
      tool: this.name,
      wouldDo: `Extract ${absArchive} → ${absDest} (format: ${detectedFormat ?? 'unknown'})`,
      estimatedChanges: [absDest],
      warnings,
    };
  }

  async execute(input: Record<string, unknown>, ctx: ExecutionContext): Promise<ExecutionResult> {
    const start = Date.now();
    const { archive, destination, format, timeout } = input as ArchiveExtractInput;
    const absArchive = path.resolve(archive);
    const absDest = path.resolve(destination);
    const artifacts: ExecutionArtifact[] = [];

    try {
      if (!fs.existsSync(absArchive)) {
        return this.failure(`Archive does not exist: ${absArchive}`, Date.now() - start);
      }

      if (!fs.existsSync(absDest)) {
        return this.failure(`Destination directory does not exist: ${absDest}`, Date.now() - start);
      }

      // Detect format
      const archiveFormat = format ?? this.detectFormat(absArchive);
      if (!archiveFormat) {
        return this.failure(
          `Cannot detect archive format from extension: ${absArchive}`,
          Date.now() - start,
        );
      }

      // List files before extraction to track what's new
      const filesBefore = new Set(this.listFilesRecursive(absDest));

      // Compute archive checksum
      const archiveContent = fs.readFileSync(absArchive);
      const archiveChecksum = crypto.createHash('sha256').update(archiveContent).digest('hex');

      artifacts.push({
        type: 'checksum',
        value: `sha256:${archiveChecksum}`,
        description: `Archive checksum: ${absArchive}`,
      });

      // Extract
      const cmd = this.buildExtractCommand(archiveFormat, absArchive, absDest);
      const output = execSync(cmd, {
        cwd: absDest,
        encoding: 'utf-8',
        timeout,
      });

      // List files after extraction to determine what was extracted
      const filesAfter = this.listFilesRecursive(absDest);
      const extractedFiles = filesAfter.filter((f) => !filesBefore.has(f));

      artifacts.push({
        type: 'log',
        value: `Extracted ${extractedFiles.length} files from ${absArchive} to ${absDest}`,
        description: 'Extraction summary',
      });

      // Store rollback data
      const rollbackKey = `archive:extract:${absArchive}:${absDest}`;
      ctx.rollbackData[rollbackKey] = {
        archive: absArchive,
        destination: absDest,
        extractedFiles,
      };

      ctx.budget.filesChanged += extractedFiles.length;

      return this.success(
        {
          archive: absArchive,
          destination: absDest,
          format: archiveFormat,
          filesExtracted: extractedFiles.length,
          files: extractedFiles.slice(0, 100), // Limit for large archives
        },
        Date.now() - start,
        artifacts,
      );
    } catch (err) {
      return this.failure((err as Error).message, Date.now() - start);
    }
  }

  async rollback(input: Record<string, unknown>, ctx: ExecutionContext): Promise<RollbackResult> {
    const { archive, destination } = input as ArchiveExtractInput;
    const absArchive = path.resolve(archive);
    const absDest = path.resolve(destination);
    const rollbackKey = `archive:extract:${absArchive}:${absDest}`;
    const rollbackData = ctx.rollbackData[rollbackKey] as {
      archive: string;
      destination: string;
      extractedFiles: string[];
    } | undefined;

    if (!rollbackData) {
      return {
        tool: this.name,
        success: false,
        description: 'No rollback data available',
        error: 'Rollback data not found — execute() may not have been called',
      };
    }

    try {
      let removed = 0;
      // Remove extracted files in reverse order
      for (const file of [...rollbackData.extractedFiles].reverse()) {
        try {
          if (fs.existsSync(file)) {
            const stat = fs.statSync(file);
            if (stat.isFile()) {
              fs.unlinkSync(file);
              removed++;
            }
          }
        } catch {
          // Permission denied or file in use
        }
      }

      // Try to remove empty directories that were created
      for (const file of [...rollbackData.extractedFiles].reverse()) {
        try {
          const dir = path.dirname(file);
          if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
            fs.rmdirSync(dir);
          }
        } catch {
          // Not empty or permission denied
        }
      }

      return {
        tool: this.name,
        success: true,
        description: `Removed ${removed} extracted files from ${rollbackData.destination}`,
      };
    } catch (err) {
      return {
        tool: this.name,
        success: false,
        description: `Failed to rollback archive extraction`,
        error: (err as Error).message,
      };
    }
  }

  private detectFormat(archivePath: string): 'tar' | 'tar.gz' | 'tar.bz2' | 'zip' | null {
    const lower = archivePath.toLowerCase();
    if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
    if (lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2')) return 'tar.bz2';
    if (lower.endsWith('.tar')) return 'tar';
    if (lower.endsWith('.zip')) return 'zip';
    return null;
  }

  private buildExtractCommand(
    format: 'tar' | 'tar.gz' | 'tar.bz2' | 'zip',
    archivePath: string,
    destDir: string,
  ): string {
    switch (format) {
      case 'tar':
        return `tar xf "${archivePath}" -C "${destDir}"`;
      case 'tar.gz':
        return `tar xzf "${archivePath}" -C "${destDir}"`;
      case 'tar.bz2':
        return `tar xjf "${archivePath}" -C "${destDir}"`;
      case 'zip':
        return `unzip -o "${archivePath}" -d "${destDir}"`;
    }
  }

  private listFilesRecursive(dirPath: string): string[] {
    const files: string[] = [];

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          files.push(...this.listFilesRecursive(fullPath));
        } else {
          files.push(fullPath);
        }
      }
    } catch {
      // Permission denied
    }

    return files;
  }
}
