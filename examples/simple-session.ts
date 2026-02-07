/**
 * Example: Simple Session Gateway Usage
 *
 * Demonstrates the core gateway API — creating a session, evaluating actions,
 * recording results, and terminating with a report.
 *
 * Run: npx tsx examples/simple-session.ts
 */

import { AgentGateway } from '../src/index.js';

const POLICY_YAML = `
version: "1.0"
name: "simple-session-example"

capabilities:
  - tool: "file:read"
    scope:
      paths: ["/tmp/det-acp-demo/**"]
  - tool: "file:write"
    scope:
      paths: ["/tmp/det-acp-demo/**"]
  - tool: "command:run"
    scope:
      binaries: ["echo", "ls", "cat"]

limits:
  max_runtime_ms: 60000
  max_files_changed: 10

gates: []

evidence:
  require: ["checksums"]
  format: "jsonl"

forbidden:
  - pattern: "**/.env"
  - pattern: "rm -rf"

session:
  max_actions: 20
  max_denials: 5
`;

async function main() {
  // 1. Create the gateway
  const gateway = await AgentGateway.create({
    ledgerDir: '/tmp/det-acp-demo/ledgers',
    onStateChange: (sessionId, from, to) => {
      console.log(`  [${sessionId.slice(0, 8)}] ${from} → ${to}`);
    },
  });

  console.log('=== Deterministic Agent Control Protocol — Session Gateway Demo ===\n');

  // 2. Create a session
  const session = await gateway.createSession(POLICY_YAML, {
    agent: 'demo-agent',
    purpose: 'demonstrate session API',
  });
  console.log(`Session created: ${session.id}`);
  console.log(`Policy: ${session.policy.name}\n`);

  // 3. Evaluate some actions
  console.log('--- Evaluating actions ---\n');

  // Allowed: read within scope
  const read = await gateway.evaluate(session.id, {
    tool: 'file:read',
    input: { path: '/tmp/det-acp-demo/data.txt' },
  });
  console.log(`file:read /tmp/det-acp-demo/data.txt → ${read.decision}`);

  // Record result (simulating external execution)
  if (read.decision === 'allow') {
    await gateway.recordResult(session.id, read.actionId, {
      success: true,
      output: 'Hello from data.txt',
      durationMs: 5,
    });
    console.log(`  Result recorded: success\n`);
  }

  // Allowed: write within scope
  const write = await gateway.evaluate(session.id, {
    tool: 'file:write',
    input: { path: '/tmp/det-acp-demo/output.txt', content: 'Agent wrote this' },
  });
  console.log(`file:write /tmp/det-acp-demo/output.txt → ${write.decision}`);

  if (write.decision === 'allow') {
    await gateway.recordResult(session.id, write.actionId, {
      success: true,
      output: { path: '/tmp/det-acp-demo/output.txt', bytesWritten: 15 },
      durationMs: 3,
    });
    console.log(`  Result recorded: success\n`);
  }

  // Denied: read outside scope
  const deniedRead = await gateway.evaluate(session.id, {
    tool: 'file:read',
    input: { path: '/etc/passwd' },
  });
  console.log(`file:read /etc/passwd → ${deniedRead.decision}`);
  console.log(`  Reasons: ${deniedRead.reasons.join('; ')}\n`);

  // Denied: forbidden command
  const deniedCmd = await gateway.evaluate(session.id, {
    tool: 'command:run',
    input: { command: 'rm -rf /tmp' },
  });
  console.log(`command:run "rm -rf /tmp" → ${deniedCmd.decision}`);
  console.log(`  Reasons: ${deniedCmd.reasons.join('; ')}\n`);

  // Allowed: safe command
  const echoCmd = await gateway.evaluate(session.id, {
    tool: 'command:run',
    input: { command: 'echo "hello from agent"' },
  });
  console.log(`command:run "echo hello" → ${echoCmd.decision}`);

  if (echoCmd.decision === 'allow') {
    await gateway.recordResult(session.id, echoCmd.actionId, {
      success: true,
      output: 'hello from agent',
      durationMs: 10,
    });
    console.log(`  Result recorded: success\n`);
  }

  // 4. Get intermediate report
  console.log('--- Session Report ---\n');
  const report = gateway.getSessionReport(session.id);
  console.log(`Total actions: ${report.totalActions}`);
  console.log(`  Allowed: ${report.allowed}`);
  console.log(`  Denied: ${report.denied}`);
  console.log(`  Gated: ${report.gated}`);
  console.log(`Budget used:`);
  console.log(`  Actions evaluated: ${report.budgetUsed.actionsEvaluated}`);
  console.log(`  Actions denied: ${report.budgetUsed.actionsDenied}`);
  console.log('');

  // 5. Terminate the session
  const finalReport = await gateway.terminateSession(session.id, 'Demo complete');
  console.log(`Session terminated: ${finalReport.state}`);
  console.log(`Duration: ${finalReport.durationMs}ms`);

  // 6. Verify ledger integrity
  const ledger = gateway.getSessionLedger(session.id);
  if (ledger) {
    const { EvidenceLedger } = await import('../src/ledger/ledger.js');
    const integrity = EvidenceLedger.verifyIntegrity(ledger.getFilePath());
    console.log(`\nLedger integrity: ${integrity.valid ? 'VALID' : 'BROKEN'}`);
    console.log(`Ledger entries: ${integrity.totalEntries}`);
    console.log(`Ledger path: ${ledger.getFilePath()}`);
  }
}

main().catch(console.error);
