/**
 * 评审干跑：用桩 ctx 走完整条评审路径，不调用真实模型。
 * 目的：验证读日志、取模型、还原上下文、解析判决、写 judge.json 都不出错。
 * 会临时写 judge.json，跑完删除，避免和真实评审结果混淆。
 */
import { readFileSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { JUDGE_FILE, LOG_FILE } from './paths.js';

const LOG = pathToFileURL(LOG_FILE);
const JUDGE = pathToFileURL(JUDGE_FILE);
const mod = await import('./impl.js');

// 真实评审也写这个文件，干跑绝不能覆盖它：有就先挪走，跑完还原。
const stashed = existsSync(JUDGE) ? `${JUDGE.pathname}.stashed` : null;
if (stashed !== null) renameSync(JUDGE, stashed);

const rows = readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const outcomes = rows.filter((r) => r.kind === 'outcome');
const last = outcomes.at(-1);
console.log('日志里的对照记录数：', outcomes.length);
if (last === undefined) { console.log('没有对照记录，干跑无意义'); process.exit(0); }

// 桩会话：包含一条内容等于 last.actual 的用户消息，前面放一条助手消息
const fakeSession = {
  id: last.sessionId,
  deriveMessages: () => [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '（更早的用户消息）' }] },
    { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '这是预测时看到的上一条助手消息。' }] },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: last.actual }] },
  ],
};

let captured = null;
const ctx = {
  sessions: { list: () => [fakeSession] },
  llm: {
    stream: (options) => {
      captured = options;
      const n = outcomes.slice(-20).length;
      const verdicts = Array.from({ length: n }, (_, id) => ({ id, sameIntent: id % 2 === 0, sendable: true, betterThanGeneric: id % 3 === 0, note: 'stub' }));
      const chunks = [
        { type: 'text-delta', text: '```json\n' + JSON.stringify({ verdicts }) + '\n```' },
        { type: 'finish', reason: { kind: 'stop' } },
      ];
      return (async function* () { for (const c of chunks) yield c; })();
    },
  },
};

const seen = [];
await mod.diagnostics({ ctx, log: (e) => seen.push(e) });

console.log('诊断条目：', seen.map((e) => e.kind + (e.reason ? `(${e.reason})` : '')).join(', '));
const judge = seen.find((e) => e.kind === 'judge');
console.log('评审汇总：', judge ? JSON.stringify({ samples: judge.samples, sameIntent: judge.sameIntent, sendable: judge.sendable, betterThanGeneric: judge.betterThanGeneric }) : '❌ 没有');
console.log('调用参数：', captured ? `model=${captured.model} maxTokens=${captured.maxTokens} temp=${captured.temperature}` : '❌ 未调用模型');
console.log('judge.json 已写：', existsSync(JUDGE));
if (existsSync(JUDGE)) {
  const doc = JSON.parse(readFileSync(JUDGE, 'utf8'));
  console.log('  结构：summary 键 =', Object.keys(doc.summary).join(','), '| items =', doc.items.length);
  console.log('  首条 context 是否还原：', JSON.stringify(String(doc.items[0].context).slice(0, 30)));
  unlinkSync(JUDGE);
  console.log('  已删除干跑产生的 judge.json');
}
if (stashed !== null) {
  renameSync(stashed, JUDGE);
  console.log('  已还原真实 judge.json');
}
console.log('');
console.log(judge ? '✅ 评审路径干跑通过' : '❌ 评审路径有问题');
