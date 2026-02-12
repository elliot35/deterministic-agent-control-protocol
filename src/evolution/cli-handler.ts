/**
 * CLI Evolution Handler — presents policy-change suggestions via the terminal.
 *
 * Uses Node readline over stderr so it does not interfere with MCP stdio
 * transport on stdout.
 */

import readline from 'node:readline';
import type { EvolutionDecision, EvolutionHandler, PolicySuggestion } from './types.js';

/**
 * Create an EvolutionHandler that prompts the user on the terminal (stderr).
 *
 * The prompt looks like:
 *
 *   [Policy Evolution] Add "file:read" capability for path "./config/**"?
 *   [A]dd to policy / allow [O]nce / [D]eny (30s timeout): _
 */
export function createCliEvolutionHandler(): EvolutionHandler {
  return (suggestion: PolicySuggestion): Promise<EvolutionDecision> => {
    return new Promise<EvolutionDecision>((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: false,
      });

      process.stderr.write(`\n[Policy Evolution] ${suggestion.description}\n`);
      process.stderr.write('[A]dd to policy / allow [O]nce / [D]eny: ');

      rl.once('line', (line) => {
        rl.close();
        const answer = line.trim().toLowerCase();

        switch (answer) {
          case 'a':
          case 'add':
            resolve('add-to-policy');
            break;
          case 'o':
          case 'once':
            resolve('allow-once');
            break;
          case 'd':
          case 'deny':
          case '':
          default:
            resolve('deny');
            break;
        }
      });

      // If stdin is closed before the user types anything, deny
      rl.once('close', () => {
        resolve('deny');
      });
    });
  };
}
