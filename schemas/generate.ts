/**
 * Generate JSON Schema from Zod policy schema.
 * Run: npx tsx schemas/generate.ts
 */

import { zodToJsonSchema } from 'zod-to-json-schema';
import { PolicySchema } from '../src/policy/schema.js';
import fs from 'node:fs';
import path from 'node:path';

const jsonSchema = zodToJsonSchema(PolicySchema, {
  name: 'AgentPolicy',
  $refStrategy: 'none',
});

const outputPath = path.resolve(import.meta.dirname, 'policy.schema.json');
fs.writeFileSync(outputPath, JSON.stringify(jsonSchema, null, 2) + '\n');
console.log(`Generated JSON Schema at ${outputPath}`);
