/** 验证评审能按 primary / shadow 分组——A/B 结论就靠这个分组。 */
import { Context } from '@deepseek-ai/cordis';
import { readFileSync, writeFileSync, appendFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { JUDGE_FILE, LOG_FILE } from './paths.js';

const LOG = pathToFileURL(LOG_FILE);
const JUDGE = pathToFileURL(JUDGE_FILE);
const SID = 'TEST-variant';

// 注入一条带影子的对照记录
const row = {
  at: new Date().toISOString(), kind: 'outcome', sessionId: SID, turn: 99,
  suggested: '主建议文本', actual: '实际输入文本', similarity: 0, exact: false, close: false,
  acceptedViaTab: false, latencyMs: 1000, context: '助手上下文',
  shadow: { turn: 99, text: '影子建议文本', effort: 'default', ms: 4000 },
};
appendFileSync(LOG, `${JSON.stringify(row)}\n`);

const stashed = existsSync(JUDGE) ? `${JUDGE.pathname}.stashed` : null;
if (stashed !== null) renameSync(JUDGE, stashed);

const mod = await import('./impl.js');
const ctx = new Context();
ctx.provide('sessions', { list: () => [] });
let asked = null;
ctx.provide('llm', {
  stream: (options) => {
    asked = JSON.parse(options.messages[0].content[0].text);
    const verdicts = asked.samples.map((s) => ({
      id: s.id, sameIntent: s.suggestion.includes('影子'), sendable: true, betterThanGeneric: true, note: 'stub',
    }));
    return (async function* () {
      yield { type: 'text-delta', text: JSON.stringify({ verdicts }) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })();
  },
});

const seen = [];
await mod.diagnostics({ ctx, log: (e) => seen.push(e) });
const judge = seen.find((e) => e.kind === 'judge');

const injected = asked?.samples.filter((s) => s.actual === '实际输入文本') ?? [];
console.log('注入的样本数:', injected.length, '（应为 2：主 + 影子）');
for (const s of injected) console.log('  id', s.id, '| variant', s.variant, '| 建议:', s.suggestion);
console.log('两条共享同一 context:', injected[0]?.context === injected[1]?.context ? '✅' : '❌');
console.log('评审 byVariant:', JSON.stringify(judge?.byVariant));
// 断言「分组成立」，不写死条数：日志里的影子记录会随实验累积，
// 早期写成 === 1 的断言在攒到第二条之后就失效了，但失败原因和分组无关。
const groups = judge?.byVariant ?? {};
const ok =
  injected.length === 2 &&
  (groups.primary?.samples ?? 0) >= 1 &&
  (groups['shadow:default']?.samples ?? 0) >= 1 &&
  groups['shadow:default'].samples < groups.primary.samples;
console.log(ok ? '\n✅ 分组正确，A/B 可对比' : '\n❌ 分组有问题');

// 清理：移除注入行、恢复 judge.json
const kept = readFileSync(LOG, 'utf8').split('\n').filter((l) => l !== '' && !l.includes(SID));
writeFileSync(LOG, kept.length === 0 ? '' : `${kept.join('\n')}\n`);
if (existsSync(JUDGE)) unlinkSync(JUDGE);
if (stashed !== null) renameSync(stashed, JUDGE);
console.log('已清理注入行与临时 judge.json');
process.exitCode = ok ? 0 : 1;
