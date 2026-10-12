/** lastAssistantMessage：取最后一条非空助手消息，截断到 600 字，异常时返回 null。 */
const m = await import('./impl.js');
const mk = (role, text) => ({ role, source: { kind: role === 'user' ? 'user' : 'model' }, content: [{ type: 'text', text }] });

const cases = [
  ['取最后一条助手消息', { deriveMessages: () => [mk('user','a'), mk('assistant','第一句'), mk('user','b'), mk('assistant','最后一句')] }, '最后一句'],
  ['跳过工具调用型空消息', { deriveMessages: () => [mk('assistant','有内容'), { role:'assistant', source:{kind:'model'}, content:[{type:'tool-call', name:'bash'}] }] }, '有内容'],
  ['没有助手消息时返回 null', { deriveMessages: () => [mk('user','只有用户')] }, null],
  ['deriveMessages 抛错时返回 null', { deriveMessages: () => { throw new Error('boom'); } }, null],
  ['超长截断到 600', { deriveMessages: () => [mk('assistant','x'.repeat(1000))] }, 'x'.repeat(600)],
];
let pass = 0;
for (const [label, session, expected] of cases) {
  const got = m.lastAssistantMessage(session);
  const ok = got === expected;
  if (ok) pass++;
  console.log(ok ? '✅' : '❌', label.padEnd(22), ok ? '' : `期望 ${String(expected).slice(0,20)} 实得 ${String(got).slice(0,20)}`);
}
console.log(`\n${pass}/${cases.length} 通过`);
process.exitCode = pass === cases.length ? 0 : 1;
