import { Context } from '@deepseek-ai/cordis';
const mod = await import('./impl.js');
const ctx = new Context();
const seen = [];
// 用捕获式 log，避免污染真实日志
const log = (entry) => seen.push(entry);
try {
  await mod.diagnostics({ ctx, log });
  console.log('✅ diagnostics 未抛出');
} catch (error) {
  console.log('❌ diagnostics 抛出了：', String(error));
}
console.log('记录到的诊断条目：', seen.map((e) => e.kind + (e.reason ? `(${e.reason})` : '')).join(', '));
console.log('');
console.log('判定：');
console.log('  runJudge 是函数        →', typeof mod.diagnostics === 'function');
console.log('  缺 ctx.llm 时优雅退出   →', seen.some((e) => e.kind === 'judge-skip' && e.reason === 'llm-unavailable'));
