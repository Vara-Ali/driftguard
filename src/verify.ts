import 'dotenv/config';

import { summarizeChange } from './llm-client';
import type { AffectedMethod, Confidence, Verdict } from './llm-client';

/**
 * Day 3 ground-truth validator.
 *
 * Runs the real summarizer against the known demo case (whatsapp-web.js
 * 1.34.6 -> 1.34.7) and prints the LLM's verdict next to a hand-written
 * expected answer, field by field, so it is visually obvious whether the
 * model agrees with what we already know to be true.
 *
 * Runs a single real version pair today. Designed so adding more cases
 * later is just pushing another entry into the CASES array.
 */

interface ExpectedVerdict {
  breaking: boolean;
  /** Free-text confidence we would hope the LLM reaches. */
  confidence: Confidence;
  /** Set of names that MUST appear in `affectedMethods` for the test to pass. */
  mustMention: string[];
  /** True when the maintainer's release notes are expected to understate breakage. */
  expectsDiscrepancyNote: boolean;
  oneLineTruth: string;
  /** Expected summary for visual comparison. */
  summary: string;
  /** Expected discrepancy note. Empty string = none expected. */
  discrepancyNote: string;
  /** Expected affectedMethods for visual comparison. */
  affectedMethods: AffectedMethod[];
}

interface VerifierCase {
  packageName: string;
  oldVersion: string;
  newVersion: string;
  expected: ExpectedVerdict;
}

const CASES: VerifierCase[] = [
  {
    packageName: 'whatsapp-web.js',
    oldVersion: '1.34.6',
    newVersion: '1.34.7',
    expected: {
      // The release notes read as a list of bug fixes. The type diff removes
      // eight top-level exports, including the entire legacy session-auth
      // surface. That is unambiguously breaking.
      breaking: true,
      confidence: 'high',
      mustMention: ['LegacySessionAuth', 'ClientSession', 'WABrowserId'],
      expectsDiscrepancyNote: true,
      oneLineTruth:
        'Breaking patch: legacy session-auth API removed in a release whose notes describe it as routine fixes.',
      summary:
        'whatsapp-web.js 1.34.7 deletes the entire LegacySessionAuth surface ' +
        'in a release whose notes describe it as routine fixes.',
      discrepancyNote:
        'Release notes are framed as bug fixes and feature additions; the type ' +
        'diff shows the public LegacySessionAuth API removed with no migration ' +
        'mentioned.',
      affectedMethods: [
        { name: 'LegacySessionAuth', reason: 'export removed entirely' },
        { name: 'ClientSession', reason: 'export removed entirely' },
        { name: 'WABrowserId', reason: 'export removed entirely' },
        { name: 'WASecretBundle', reason: 'export removed entirely' },
        { name: 'WAToken1', reason: 'export removed entirely' },
        { name: 'WAToken2', reason: 'export removed entirely' },
        { name: 'restartOnAuthFail', reason: 'export removed entirely' },
        { name: 'ClientOptions.session', reason: 'public option removed' },
      ],
    },
  },
];

/** Print the two verdicts side by side and report field-level agreement. */
function compareVerdicts(
  caseEntry: VerifierCase,
  actual: Verdict,
): { passed: boolean; checks: { label: string; ok: boolean; detail: string }[] } {
  const checks: { label: string; ok: boolean; detail: string }[] = [];

  checks.push({
    label: 'breaking',
    ok: actual.breaking === caseEntry.expected.breaking,
    detail: `expected=${actual.breaking} got=${caseEntry.expected.breaking}`,
  });

  const mentioned = new Set(actual.affectedMethods.map((m) => m.name));
  const missing = caseEntry.expected.mustMention.filter((name) => !mentioned.has(name));
  checks.push({
    label: 'must-mention',
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? `all of [${caseEntry.expected.mustMention.join(', ')}] named`
        : `missing required names: [${missing.join(', ')}]`,
  });

  if (caseEntry.expected.expectsDiscrepancyNote) {
    checks.push({
      label: 'discrepancy-note',
      ok: Boolean(actual.discrepancyNote),
      detail: actual.discrepancyNote
        ? `populated (${actual.discrepancyNote.length} chars)`
        : 'EMPTY — model failed to flag the maintainer-vs-diff mismatch',
    });
  } else {
    checks.push({
      label: 'discrepancy-note',
      ok: true,
      detail: '(not required for this case)',
    });
  }

  return {
    passed: checks.every((c) => c.ok),
    checks,
  };
}

function renderVerdict(label: string, v: Verdict | ExpectedVerdict, isExpected: boolean): string {
  const lines: string[] = [];
  const prefix = isExpected ? 'EXPECTED' : 'GOT     ';
  lines.push(`${prefix} | ${label}`);
  lines.push(`${prefix} | breaking       : ${v.breaking}`);
  lines.push(`${prefix} | confidence     : ${v.confidence}`);
  lines.push(`${prefix} | discrepancy    : ${v.discrepancyNote || '(null)'}`);
  lines.push(`${prefix} | affectedMethods:`);
  if (v.affectedMethods.length === 0) {
    lines.push(`${prefix} |   (none)`);
  } else {
    for (const m of v.affectedMethods) {
      lines.push(`${prefix} |   - ${m.name}  (${m.reason})`);
    }
  }
  lines.push(`${prefix} | summary:`);
  lines.push(`${prefix} |   ${v.summary}`);
  return lines.join('\n');
}

function runCase(entry: VerifierCase): Promise<{ passed: boolean; raw: unknown }> {
  const banner = '='.repeat(72);
  console.log(banner);
  console.log(`CASE: ${entry.packageName} ${entry.oldVersion} -> ${entry.newVersion}`);
  console.log(`KNOWN TRUTH: ${entry.expected.oneLineTruth}`);
  console.log(banner);

  return summarizeChange(entry.packageName, entry.oldVersion, entry.newVersion)
    .then(({ verdict }) => {
      if (!verdict.ok) {
        console.log(`\nVERDICT FAILED: ${verdict.error}`);
        if (verdict.rawOutput) {
          console.log('--- raw model output ---');
          console.log(verdict.rawOutput.slice(0, 2000));
        }
        console.log('');
        console.log(renderVerdict('expected', entry.expected, true));
        return { passed: false, raw: verdict };
      }

      const comparison = compareVerdicts(entry, verdict.verdict);

      console.log('');
      console.log(renderVerdict('llm', verdict.verdict, false));
      console.log('');
      console.log(renderVerdict('expected', entry.expected, true));

      console.log('');
      console.log('--- field-level checks ---');
      for (const check of comparison.checks) {
        const mark = check.ok ? 'OK  ' : 'FAIL';
        console.log(`  [${mark}] ${check.label.padEnd(16)} ${check.detail}`);
      }

      console.log('');
      console.log(
        `latency : ${verdict.latencyMs} ms  |  tokens : ${verdict.totalTokens}  |  retried : ${verdict.retried}  |  model : ${verdict.model}`,
      );

      return { passed: comparison.passed, raw: verdict };
    });
}

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;

  for (const entry of CASES) {
    const result = await runCase(entry);
    if (result.passed) {
      passed += 1;
    } else {
      failed += 1;
    }
  }

  console.log('');
  console.log('='.repeat(72));
  console.log(`VERIFIER: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(72));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Verifier crashed:', error);
  process.exit(1);
});