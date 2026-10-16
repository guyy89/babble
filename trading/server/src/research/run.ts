// Research CLI.
//   npm run research -w server -- grid <family>               tune on IN-SAMPLE only; writes results/<family>-is.json
//   npm run research -w server -- validate <family> <configs>  ≤3 configs (JSON file: [{...params}]); runs
//                                                              out-of-sample + quarters + double-cost stress once; logged
// A family is server/src/research/strategies/<family>.ts exporting
//   default { strategy: Strategy<P>, grid: { [param]: values[] }, rules?: { maxTrades?, maxLosses?, lastEntryMinute? } }
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { accept, PERIODS, runPeriod, type Metrics } from './evaluate.js';
import { DEFAULT_COSTS, DEFAULT_RULES } from './sim.js';
import type { Rules, Strategy } from './types.js';

type Family = { strategy: Strategy<Record<string, unknown>>; grid: Record<string, unknown[]>; rules?: Partial<Pick<Rules, 'maxTrades' | 'maxLosses' | 'lastEntryMinute'>> };

const OUT = resolve(config.dataDir, 'research', 'results');
mkdirSync(OUT, { recursive: true });

function combos(grid: Record<string, unknown[]>): Record<string, unknown>[] {
  return Object.entries(grid).reduce<Record<string, unknown>[]>(
    (acc, [k, vals]) => acc.flatMap((c) => vals.map((v) => ({ ...c, [k]: v }))),
    [{}],
  );
}

const row = (m: Metrics) =>
  `n=${String(m.trades).padStart(4)} win=${m.winRate.toFixed(2)} net=${m.net.toFixed(0).padStart(7)} /day=${m.avgPerDay.toFixed(1).padStart(6)} pf=${m.profitFactor.toFixed(2)} R=${m.avgR.toFixed(2)} dd=${m.maxDrawdown.toFixed(0)} sharpe=${m.sharpe.toFixed(2)}`;

async function load(family: string): Promise<Family> {
  const mod = await import(pathToFileURL(resolve(import.meta.dirname, 'strategies', `${family}.ts`)).href);
  return mod.default as Family;
}

async function main() {
  const [cmd, family, configsFile] = process.argv.slice(2);
  if (!cmd || !family) throw new Error('usage: grid <family> | validate <family> <configs.json>');
  const fam = await load(family);
  const rules: Rules = { ...DEFAULT_RULES, ...(fam.rules ?? {}) };

  if (cmd === 'grid') {
    const all = combos(fam.grid);
    console.log(`${family}: ${all.length} configurations on in-sample ${PERIODS.inSample.from}..${PERIODS.inSample.to}`);
    const results = all.map((params, i) => {
      const { metrics } = runPeriod(fam.strategy, params, PERIODS.inSample, rules);
      if ((i + 1) % 10 === 0) process.stdout.write(`\r${i + 1}/${all.length}`);
      return { params, metrics };
    });
    process.stdout.write('\n');
    results.sort((a, b) => b.metrics.net - a.metrics.net);
    writeFileSync(resolve(OUT, `${family}-is.json`), JSON.stringify({ rules, results }, null, 1));
    for (const r of results.slice(0, 15)) console.log(row(r.metrics), JSON.stringify(r.params));
    return;
  }

  if (cmd === 'validate') {
    const configs = JSON.parse(readFileSync(resolve(configsFile), 'utf8')) as Record<string, unknown>[];
    if (!Array.isArray(configs) || configs.length < 1 || configs.length > 3) throw new Error('validate takes 1–3 configurations');
    const out = configs.map((params) => {
      const is = runPeriod(fam.strategy, params, PERIODS.inSample, rules).metrics;
      const oosRun = runPeriod(fam.strategy, params, PERIODS.outOfSample, rules);
      const oosA = runPeriod(fam.strategy, params, PERIODS.oosA, rules).metrics;
      const oosB = runPeriod(fam.strategy, params, PERIODS.oosB, rules).metrics;
      const stress = runPeriod(fam.strategy, params, PERIODS.outOfSample, rules, { ...DEFAULT_COSTS, slippagePct: DEFAULT_COSTS.slippagePct * 2, feeMultiplier: 2 }).metrics;
      const verdict = accept(is, oosRun.metrics, oosA, oosB, stress);
      console.log(`\n${JSON.stringify(params)}\n  IS     ${row(is)}\n  OOS    ${row(oosRun.metrics)}\n  OOS-A  ${row(oosA)}\n  OOS-B  ${row(oosB)}\n  STRESS ${row(stress)}\n  ${verdict.passed ? 'PASSED' : 'FAILED'} ${JSON.stringify(verdict.checks)}`);
      return { params, is, oos: oosRun.metrics, oosA, oosB, stress, verdict, oosTrades: oosRun.trades };
    });
    writeFileSync(resolve(OUT, `${family}-oos.json`), JSON.stringify({ rules, out }, null, 1));
    appendFileSync(resolve(OUT, 'oos-log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), family, configs }) + '\n');
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
