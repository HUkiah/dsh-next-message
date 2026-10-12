/**
 * 入口壳测试。
 *
 * 这个壳是「改完 host 半如何生效」的唯一通道：Loader 只导入 host.js（URL 不变，
 * 会被 ESM 缓存），它再用带时间戳的 URL 导入 host-real.js。如果哪天有人把壳改成
 * 静态导入，重载就会静默地继续跑旧代码——所以这里断言「两次 apply 拿到不同的模块」。
 */
import { Context } from '@deepseek-ai/cordis';

const mod = await import('./host.js');
const tick = () => new Promise((resolve) => setTimeout(resolve, 80));
const fresh = () => {
  const ctx = new Context();
  ctx.provide('typert', { register: () => {} });
  ctx.provide('llm', { stream: () => (async function* () {})() });
  ctx.provide('sessions', { list: () => [], get: () => undefined });
  // 真实运行时这个服务由 dsh-base 挂载；不 provide 的话，声明了 inject 的
  // 插件在 cordis 里会永远等不到启动。
  ctx.provide('sessionProjections', { snapshot: () => ({ values: {} }), stateOf: () => null });
  return ctx;
};

console.log('name =', mod.name, '| inject =', JSON.stringify(mod.inject));
const injectOk = Array.isArray(mod.inject) && mod.inject.includes('typert') && mod.inject.includes('llm');
// 回归守卫：dsh-session-projection 的文档规定 host 读取方必须把它声明进 inject，
// 否则属性访问会抛 "cannot get property ... without inject"。删掉它功能会静默失效，
// 但直接调用 apply 的测试察觉不到——所以这里单独断言 inject 的内容。
const projectionsDeclared = Array.isArray(mod.inject) && mod.inject.includes('sessionProjections');
console.log('inject 声明了 sessionProjections:', projectionsDeclared ? '✅' : '❌ 任务状态会静默失效');

const first = fresh();
await mod.apply(first, {});
await tick();
const svcA = first.get('nextMessage');

const second = fresh();
await mod.apply(second, {});
await tick();
const svcB = second.get('nextMessage');

const bothMounted = svcA !== undefined && svcB !== undefined;
// 关键断言：换一个时间戳 URL 必须拿到一份新的模块对象，而不是缓存里那份。
const reimported = bothMounted && svcA.constructor !== svcB.constructor;

console.log('两次 apply 都挂载成功:', bothMounted ? '✅' : '❌');
console.log('第二次拿到的是新模块:', reimported ? '✅' : '❌ 走了缓存，重载会静默失效');
console.log('apply 是异步委派:', mod.apply.constructor.name === 'AsyncFunction' ? '✅' : '❌');

const pass =
  injectOk && projectionsDeclared && bothMounted && reimported && mod.apply.constructor.name === 'AsyncFunction';
console.log(pass ? '\n✅ 入口壳可用，改 host 半只需在 Plugins 页重载' : '\n❌ 入口壳有问题');
process.exitCode = pass ? 0 : 1;
