/**
 * Policy Loader — reads a YAML policy file and validates it against the Zod schema.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { PolicySchema } from './schema.js';
import type { Policy } from '../types.js';

export class PolicyValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = 'PolicyValidationError';
  }
}

/**
 * Load and validate a policy from a YAML file path.
 */
export function loadPolicyFromFile(filePath: string): Policy {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Policy file not found: ${absPath}`);
  }

  const raw = fs.readFileSync(absPath, 'utf-8');
  return parsePolicyYaml(raw);
}

/**
 * Parse and validate a policy from a YAML string.
 */
export function parsePolicyYaml(yamlString: string): Policy {
  let parsed: unknown;
  try {
    parsed = yaml.load(yamlString);
  } catch (err) {
    throw new PolicyValidationError('Invalid YAML syntax', [
      { path: '', message: (err as Error).message },
    ]);
  }

  if (parsed === null || parsed === undefined || typeof parsed !== 'object') {
    throw new PolicyValidationError('Policy must be a YAML object', [
      { path: '', message: 'Expected an object, got ' + typeof parsed },
    ]);
  }

  const result = PolicySchema.safeParse(parsed);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    throw new PolicyValidationError(
      `Policy validation failed with ${issues.length} issue(s)`,
      issues,
    );
  }

  return result.data as Policy;
}

/**
 * Validate a policy object (already parsed).
 */
export function validatePolicy(policy: unknown): Policy {
  const result = PolicySchema.safeParse(policy);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    throw new PolicyValidationError(
      `Policy validation failed with ${issues.length} issue(s)`,
      issues,
    );
  }
  return result.data as Policy;
}
