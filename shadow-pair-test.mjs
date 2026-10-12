/**
 * 影子建议的配对测试。
 *
 * 错配会直接污染 A/B 数据（把上一轮的影子建议配到这一轮的实际输入上），
 * 所以这里只验一件事：outcome 行里的 shadow 必须是同一轮次的。
 */
import { Context } from '@deepseek-ai/cordis';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { LOG_FILE } from './paths.js';

const SID = 'TEST-shadow-pair';
const LOG = pathToFileURL(LOG_FILE);
const mod = await import('./host-real.js');   // 测试直接导入实现，绕开入口壳
const ctx = new Context();
new mod.NextMessageService(ctx, {});
const svc = ctx.get('nextMessage');

const session = {
  id: SID,
  header: {},
  deriveMessages: () => [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '把 todo 接进上下文' }] },
    { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '接好了。' }] },
  ],
};
const lines = () => readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes(SID)).map((l) => JSON.parse(l));
const send = async (text) => {
  ctx.emit('session/event', session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } });
  await new Promise((r) => setTimeout(r, 400));
};

// 场景 A：影子与建议同轮次 → 应当配对
svc.suggestion(SID);
Object.assign(svc.channelOf(SID), {
  latest: { text: '主建议', turn: 11, at: Date.now(), context: 'ctx' },
  shadow: { turn: 11, text: '影子建议', effort: 'default', ms: 4200 },
});
await send('实际输入A');
const a = lines().filter((l) => l.kind === 'outcome').at(-1);
console.log('A 同轮次    shadow =', JSON.stringify(a?.shadow?.text ?? null), a?.shadow?.text === '影子建议' ? '✅' : '❌');

// 场景 B：影子属于上一轮 → 必须丢弃
Object.assign(svc.channelOf(SID), {
  latest: { text: '主建议2', turn: 12, at: Date.now(), context: 'ctx' },
  shadow: { turn: 3, text: '上一轮的影子', effort: 'default', ms: 900 },
});
await send('实际输入B');
const b = lines().filter((l) => l.kind === 'outcome').at(-1);
console.log('B 跨轮次    shadow =', JSON.stringify(b?.shadow ?? null), b?.shadow === null ? '✅ 已丢弃' : '❌ 错配了');

// 场景 C：没有影子 → 字段为 null，不报错
Object.assign(svc.channelOf(SID), {
  latest: { text: '主建议3', turn: 13, at: Date.now(), context: 'ctx' },
  shadow: null,
});
await send('实际输入C');
const c = lines().filter((l) => l.kind === 'outcome').at(-1);
console.log('C 无影子    shadow =', JSON.stringify(c?.shadow ?? null), c?.shadow === null ? '✅' : '❌');

// 场景 D：真实事件顺序 —— 影子已就绪，然后 agent/status running 先到，再收到用户消息。
// 这是实际发生过的失败路径：早期版本在 running 里把 shadow 清掉了，导致 A/B 数据全丢。
svc.suggestion(SID);
svc.channelOf(SID).latest = { text: '主建议4', turn: 14, at: Date.now(), context: 'ctx' };
svc.channelOf(SID).shadow = { turn: 14, text: '同轮影子', effort: 'default', ms: 1500 };
ctx.emit('agent/status', { agent: { session: { id: SID } }, status: 'running' });
const afterRunning = svc.channelOf(SID).shadow;
console.log('D running 之后 shadow 仍在:', afterRunning?.text ?? null, afterRunning?.text === '同轮影子' ? '✅' : '❌ 被清掉了');
await send('实际输入D');
const d = lines().filter((l) => l.kind === 'outcome').at(-1);
console.log('D 配对      shadow =', JSON.stringify(d?.shadow?.text ?? null), d?.shadow?.text === '同轮影子' ? '✅' : '❌');

const pass =
  a?.shadow?.text === '影子建议' &&
  b?.shadow === null &&
  c?.shadow === null &&
  afterRunning?.text === '同轮影子' &&
  d?.shadow?.text === '同轮影子';
console.log(pass ? '\n✅ 配对逻辑正确' : '\n❌ 配对逻辑有问题');

// 自清理
const raw = readFileSync(LOG, 'utf8').split('\n').filter((l) => l !== '');
const kept = raw.filter((l) => !l.includes(SID));
writeFileSync(LOG, kept.length === 0 ? '' : `${kept.join('\n')}\n`);
console.log(`已清理 ${raw.length - kept.length} 行测试数据`);
process.exitCode = pass ? 0 : 1;
