/**
 * 稳定入口壳。
 *
 * Loader 只导入这个文件，它的 URL 永远不变，所以会被 ESM 缓存——但它的 apply
 * 用**带时间戳的 URL** 动态导入真正的实现（host-real.js）。于是每次插件重载
 * （Plugins 页关掉再打开）都拿到新代码，不必改名、也不必重启应用。
 *
 * 之前的问题：直接改 host.js，模块 URL 不变 → Node 按 URL 缓存 → 重载时拿到的
 * 还是旧模块（日志里表现为 apply 的 scriptMtime 停在旧值）。
 *
 * name / inject 必须留在这一层：Loader 在 apply 之前就要读它们。
 * inject 里少写一个服务，apply 里对它的属性访问就会抛错（不是返回 undefined）。
 */
export const name = 'nextMessage';
// sessionProjections 必须声明：dsh-session-projection 的文档规定，host 读取方
// 要么在 inject 里声明，要么在注册表/键缺失时显式失败——不声明就会抛
// 「cannot get property "sessionProjections" without inject」。
export const inject = ['typert', 'llm', 'sessions', 'sessionProjections'];

export async function apply(ctx, config) {
  const url = new URL('./host-real.js', import.meta.url);
  let module;
  try {
    module = await import(`${url.href}?v=${String(Date.now())}`);
  } catch (error) {
    // 不吞：让 Loader 把这个条目标成 failed，在 Plugins 页面里可见。
    console.error('next-message: host-real.js 加载失败', error);
    throw error;
  }
  return module.apply(ctx, config);
}
