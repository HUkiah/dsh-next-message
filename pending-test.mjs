import { Context } from '@deepseek-ai/cordis';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { LOG_FILE } from './paths.js';

const SID = 'TEST-pending-fix';
const LOG = pathToFileURL(LOG_FILE);

const mod = await import('./host-real.js');   // 测试直接导入实现，绕开入口壳
const ctx = new Context();
new mod.NextMessageService(ctx, {});

const session = {
  id: SID,
  header: {},
  deriveMessages: () => [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我把可信代理方案落地' }] },
    { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '诊断完成，下一步是改 Ingress。' }] },
  ],
};

const lines = () => readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes(SID)).map((l) => JSON.parse(l));

const svc = ctx.get('nextMessage') ?? null;
// 直接从注册表拿实例：Service 构造时已按 key 注册
const service = svc ?? (await import('./host.js'), null);
const svcRef = ctx.reflect?.props?.nextMessage !== undefined ? ctx.get('nextMessage') : undefined;
const target = svcRef ?? ctx.nextMessage;

target.suggestion(SID);
target.channelOf(SID).latest = { text: '继续推进，先改 Ingress 那一处', turn: 7, at: Date.now(), context: '预测当时的上一条助手消息' };
console.log('步骤1  建议入缓存      latest =', JSON.stringify(target.channelOf(SID).latest.text));

ctx.emit('agent/status', { agent: { session: { id: SID } }, status: 'running' });
const ch = target.channelOf(SID);
console.log('步骤2  新一轮开始      latest =', ch.latest, '| pending =', JSON.stringify(ch.pending?.text ?? null));

ctx.emit('session/event', session, {
  type: 'user/message',
  data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续推进，先改 Ingress 那一处' }] },
});
await new Promise((r) => setTimeout(r, 600));

const outcome = lines().find((l) => l.kind === 'outcome');
console.log('步骤3  outcome 行      ', outcome ? JSON.stringify({ suggested: outcome.suggested, actual: outcome.actual, context: outcome.context }) : '❌ 丢失');
console.log('       上下文随行落盘   ', outcome && outcome.context === '预测当时的上一条助手消息' ? '✅' : '❌');
console.log('');
console.log(outcome ? '✅ 配对保住：新一轮清除不再吃掉准确率数据' : '❌ 仍然丢失');

ctx.emit('session/event', session, {
  type: 'user/message',
  data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二条真实输入' }] },
});
await new Promise((r) => setTimeout(r, 300));
console.log('场景B 无建议可配对时 outcome 条数 =', lines().filter((l) => l.kind === 'outcome').length, '（应为 1）');

// 自清理：这个测试会写真实日志，跑完把自己的行删掉，避免污染报告。
const raw = readFileSync(LOG, 'utf8').split('\n').filter((line) => line !== '');
const kept = raw.filter((line) => !line.includes(SID));
writeFileSync(LOG, kept.length === 0 ? '' : `${kept.join('\n')}\n`);
console.log(`\n已清理本次测试写入的 ${raw.length - kept.length} 行日志`);
