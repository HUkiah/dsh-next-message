#!/usr/bin/env node
/**
 * 下一条消息预测 —— 效果报告。
 *
 * 读 next-message.log，汇总采纳率与延迟，并列出「建议 / 实际输入」对照。
 * 对照表才是判断质量的主要依据；相似度只是粗筛，对中文语义不可靠。
 *
 * 注意：turn 只在单个会话内唯一，不同会话都从 1 开始，所以一律按 sessionId 分组。
 *
 * 用法：
 *   node report.mjs                     总览 + 最近 15 对（跨会话）
 *   node report.mjs --session 05a27f    只看某个会话（会话 id 尾号即可）
 *   node report.mjs --n 40              最近 40 对
 *   node report.mjs --all               全部对照
 */
import { readFileSync, existsSync } from 'node:fs';
import { LOG_FILE } from './paths.js';

const args = process.argv.slice(2);
const showAll = args.includes('--all');
const nIndex = args.indexOf('--n');
const limit = showAll ? Number.POSITIVE_INFINITY : nIndex >= 0 ? Number(args[nIndex + 1]) : 15;
const sIndex = args.indexOf('--session');
let sessionFilter = sIndex >= 0 ? args[sIndex + 1] : null;

if (!existsSync(LOG_FILE)) {
  console.log(`没有日志文件：${LOG_FILE}`);
  process.exit(0);
}

const rows = [];
for (const line of readFileSync(LOG_FILE, 'utf8').split('\n')) {
  if (line.trim() === '') continue;
  try {
    rows.push(JSON.parse(line));
  } catch {
    // 半行或损坏行直接跳过。
  }
}

const tail = (id) => (typeof id === 'string' ? id.slice(-6) : '--');
const allSessions = [...new Set(rows.filter((row) => row.sessionId).map((row) => row.sessionId))];
if (sessionFilter !== null) {
  const match = allSessions.find((id) => id === sessionFilter || tail(id) === sessionFilter);
  if (match === undefined) {
    console.log(`没有匹配的会话。现有会话尾号：${allSessions.map(tail).join(', ')}`);
    process.exit(0);
  }
  sessionFilter = match;
}

const filtered = sessionFilter === null ? rows : rows.filter((row) => row.sessionId === sessionFilter);
// 每次重启都会换代码，跨版本累计会把不同实现的表现混在一起。
// 汇总数字默认只看最近一次运行；对照表仍然用全量，那才是评审语料。
const applies = filtered.filter((row) => row.kind === 'apply');
const lastApply = applies.at(-1);
const since = lastApply === undefined ? -Infinity : Date.parse(lastApply.at);
const scoped = filtered.filter((row) => Date.parse(row.at) >= since);
const suggestions = scoped.filter((row) => row.kind === 'suggestion');
const accepts = scoped.filter((row) => row.kind === 'tab-accept' && typeof row.turn === 'number' && row.turn >= 0);
const diagnostic = scoped.filter((row) => row.kind === 'tab-accept' && typeof row.turn === 'number' && row.turn < 0);
const outcomes = scoped.filter((row) => row.kind === 'outcome');
const failures = scoped.filter((row) =>
  ['predict-failed', 'bad-finish', 'no-route', 'impl-load-failed'].includes(row.kind),
);
// 模型主动选择沉默（没有值得预测的下一句）。精确率提升时这个数会上升。
const silences = scoped.filter((row) => row.kind === 'abstain');

const pct = (part, whole) => (whole === 0 ? '—' : `${((part / whole) * 100).toFixed(0)}%`);
const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const latencies = suggestions.map((row) => row.ms).filter((value) => typeof value === 'number');
const accepted = outcomes.filter((row) => row.acceptedViaTab === true).length;
const similar = outcomes.filter((row) => typeof row.similarity === 'number' && row.similarity >= 0.5).length;

console.log('下一条消息预测 —— 效果报告');
console.log(`日志：${LOG_FILE}`);
console.log(sessionFilter === null ? '范围：全部会话' : `范围：会话 ${tail(sessionFilter)}（${sessionFilter}）`);
console.log(
  lastApply === undefined
    ? '统计边界：无 apply 记录，按全量'
    : `统计边界：最近一次运行（apply 于 ${lastApply.at.slice(11, 19)} UTC）`,
);
console.log('');

console.log('【产出】');
console.log(`  生成建议        ${String(suggestions.length)} 条`);
console.log(`  你按了 Tab      ${String(accepts.length)} 次（采纳率 ${pct(accepts.length, suggestions.length)}）`);
console.log(`  预测耗时        中位 ${String(median(latencies) ?? '—')} ms，最大 ${String(Math.max(...latencies, 0))} ms`);
if (latencies.length > 0) {
  console.log(`  2 秒内返回      ${pct(latencies.filter((value) => value < 2000).length, latencies.length)}`);
}
console.log('');

if (suggestions.length + silences.length > 0) {
  console.log('【沉默率】');
  console.log(
    `  模型选择不预测  ${String(silences.length)} 次（占 ${pct(silences.length, suggestions.length + silences.length)}）`,
  );
  console.log('  （会话已收尾时给出建议比不给更糟，这个数高不一定是坏事）');
  const byReason = new Map();
  for (const row of silences) byReason.set(row.reason ?? '?', (byReason.get(row.reason ?? '?') ?? 0) + 1);
  for (const [reason, count] of byReason) console.log(`    ${String(reason).padEnd(14)} ${String(count)} 次`);
  console.log('');
}

console.log('【结果】');
console.log(`  有对照记录      ${String(outcomes.length)} 条（= 你实际发出的下一句）`);
const withContext = outcomes.filter((row) => typeof row.context === 'string' && row.context !== '').length;
console.log(
  `  其中带预测上下文 ${String(withContext)} 条` +
    (withContext < outcomes.length ? '   ← 缺上下文的那些，「能否直接发送」判不准' : ''),
);
console.log(`  其中按过 Tab    ${String(accepted)}`);
console.log(`  相似度 ≥ 0.5    ${String(similar)}   ← 中文语义靠不住，别当准确率用`);
console.log('');

if (sessionFilter === null && allSessions.length > 1) {
  console.log('【分会话】');
  console.log('  会话尾号 | 建议 | Tab | 对照');
  const stats = allSessions
    .map((id) => {
      const mine = rows.filter((row) => row.sessionId === id);
      return {
        id,
        suggestions: mine.filter((row) => row.kind === 'suggestion').length,
        accepts: mine.filter((row) => row.kind === 'tab-accept' && row.turn >= 0).length,
        outcomes: mine.filter((row) => row.kind === 'outcome').length,
        last: mine.at(-1)?.at ?? '',
      };
    })
    .sort((a, b) => (a.last < b.last ? 1 : -1));
  for (const row of stats) {
    console.log(
      `  ${tail(row.id)}     | ${String(row.suggestions).padStart(4)} | ${String(row.accepts).padStart(3)} | ${String(row.outcomes).padStart(4)}`,
    );
  }
  console.log('  （session- 前缀的是你自己打开的会话；裸 uuid 的是子代理会话，跳过不预测）');
  console.log('');
}

const skipped = scoped.filter((row) => row.kind === 'skip-predict');
if (skipped.length > 0) {
  console.log('【省下的调用】');
  const byReason = new Map();
  for (const row of skipped) {
    const group = String(row.reason).replace(/\(.*\)$/, '');
    byReason.set(group, (byReason.get(group) ?? 0) + 1);
  }
  for (const [reason, count] of byReason) {
    console.log(`  ${reason.padEnd(12)} ${String(count)} 个会话被跳过`);
  }
  console.log('  （skip-predict 只在每个会话首次命中时记一条，不是每次轮次都记）');
  console.log('');
}

if (lastApply !== undefined) {
  const allOutcomes = filtered.filter((row) => row.kind === 'outcome').length;
  const allSuggestions = filtered.filter((row) => row.kind === 'suggestion').length;
  console.log(
    `全量历史：建议 ${String(allSuggestions)} 条、对照 ${String(allOutcomes)} 条（跨 ${String(applies.length)} 次运行）`,
  );
  console.log('');
}

console.log('【异常】');
if (failures.length === 0) console.log('  无');
else {
  const byKind = new Map();
  for (const row of failures) byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + 1);
  for (const [kind, count] of byKind) console.log(`  ${kind}: ${String(count)}`);
}
if (diagnostic.length > 0) console.log(`  （历史诊断行 ${String(diagnostic.length)} 条，已排除）`);
const invalidJson = silences.filter((row) => row.reason === 'invalid-json').length;
if (invalidJson > 0) console.log(`  ⚠ 无效 JSON ${String(invalidJson)} 次：模型没按 {"suggestion": ...} 输出，建议检查 prompt`);
const stale = scoped.filter((row) => row.kind === 'stale-dropped').length;
if (stale > 0) console.log(`  旧结果被丢弃 ${String(stale)} 次（轮次已翻转，属正常保护）`);
const released = scoped.filter((row) => row.kind === 'release').length;
if (released > 0) console.log(`  离开会话时释放 ${String(released)} 次`);

// 对照表用全量语料，不受最近一次运行限制。
const corpus = filtered.filter((row) => row.kind === 'outcome');
const pairs = showAll ? corpus : limit <= 0 ? [] : corpus.slice(-limit);
if (pairs.length > 0) {
  console.log('');
  console.log(`【建议 / 实际输入 对照】最近 ${String(pairs.length)} 对`);
  for (const row of pairs) {
    const mark = row.acceptedViaTab === true ? 'TAB' : row.exact === true ? '一致' : '    ';
    const who = sessionFilter === null ? ` ${tail(row.sessionId)}` : '';
    console.log(`  ${mark}${who} 建议：${row.suggested}`);
    console.log(`           实际：${row.actual}`);
    console.log('');
  }
}
