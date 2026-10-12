/**
 * 下一条消息预测 —— host 半外壳。
 *
 * 这个文件是稳定层：注册 typert manifest、持有每个会话的建议缓存、监听会话事件。
 * 真正决定准确率的策略（prompt、上下文裁剪、归一化、相似度）在 impl.js，
 * 每轮都用带时间戳的 URL 重新 import，所以改策略不用重启 App。
 *
 * 不写 session log：自定义事件类型需要重新生成持久化目录，否则会话无法再加载，
 * 所以建议只留在内存里，由浏览器轮询。
 */
import { Service } from '@deepseek-ai/cordis';
import { bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol';
import { appendFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { LOG_FILE } from './paths.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 加载时本文件的修改时间。用来无条件证明「当前运行的到底是哪一版」，
 *  不再依赖手写的 version 常量（它曾经落后于实际改动，造成过两次误判）。 */
const scriptMtime = (() => {
  try {
    return new Date(statSync(fileURLToPath(import.meta.url)).mtimeMs).toISOString();
  } catch {
    return 'unknown';
  }
})();
const IMPL_FILE = join(HERE, 'impl.js');

const PKG = '@local/dsh-next-message';
const NS = 'nextMessage';

export const name = NS;
export const inject = ['typert', 'llm', 'sessions', 'sessionProjections'];

/** 逐行 JSON 落盘，事后可以算准确率。 */
function log(entry) {
  try {
    appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    // 日志失败不影响主流程。
  }
}

/**
 * 重新加载策略模块。Node 按 URL 缓存 ESM，加时间戳才能拿到新版本。
 * 加载失败时保留上一份可用实现，避免一次手误让功能整个消失。
 */
let lastGoodImpl;
async function loadImpl() {
  try {
    const module = await import(`${pathToFileURL(IMPL_FILE).href}?v=${String(Date.now())}`);
    lastGoodImpl = module;
    return module;
  } catch (error) {
    log({ kind: 'impl-load-failed', message: String(error) });
    return lastGoodImpl ?? null;
  }
}

/** 手写 typert manifest。校验只看字段形状，strict codec 只需一个有 parse 的对象。 */
const jsonCodec = (typeSymbol) => ({
  mode: 'strict',
  typeSymbol,
  create: () => ({ parse: (value) => value }),
});

const TYPERT = {
  package: PKG,
  face: 'host',
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: [
    {
      id: `${PKG}#${NS}/suggestion`,
      service: NS,
      namespace: NS,
      method: 'suggestion',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'sessionId', wire: 'sessionId', source: 'json', codec: jsonCodec('string') },
      ],
      result: { mode: 'strict', typeSymbol: `${PKG}#Suggestion`, create: () => ({ parse: (v) => v }) },
    },
    {
      id: `${PKG}#${NS}/release`,
      service: NS,
      namespace: NS,
      method: 'release',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'sessionId', wire: 'sessionId', source: 'json', codec: jsonCodec('string') },
      ],
      result: { mode: 'strict', typeSymbol: `${PKG}#Ack`, create: () => ({ parse: (v) => v }) },
    },
    {
      id: `${PKG}#${NS}/accepted`,
      service: NS,
      namespace: NS,
      method: 'accepted',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'sessionId', wire: 'sessionId', source: 'json', codec: jsonCodec('string') },
        { name: 'turn', wire: 'turn', source: 'json', codec: jsonCodec('number') },
        { name: 'text', wire: 'text', source: 'json', codec: jsonCodec('string') },
      ],
      result: { mode: 'strict', typeSymbol: `${PKG}#Ack`, create: () => ({ parse: (v) => v }) },
    },
  ],
};

/** 会话实际发出过的路由最准，其次是 agent 的默认模型。 */
function resolveRoute(ctx, session, config) {
  if (config.provider && config.model) return { provider: config.provider, model: config.model };
  try {
    const logged = session.requestHeader?.()?.config;
    if (logged?.provider && logged?.model) return { provider: logged.provider, model: logged.model };
  } catch {
    // 继续回退。
  }
  try {
    const request = session.requestContext?.();
    if (request?.provider && request?.model) return { provider: request.provider, model: request.model };
  } catch {
    // 继续回退。
  }
  try {
    const fallback = ctx.agentDefaultModel?.currentSelection?.();
    if (fallback?.provider && fallback?.model) return { provider: fallback.provider, model: fallback.model };
  } catch {
    // 放弃。
  }
  return null;
}

class NextMessageService extends Service {
  constructor(ctx, config) {
    super(ctx, NS);
    // 网关的 validateBinding 要求目标 Service 带 typertRemote 绑定，
    // 只有 manifest 是不够的。namespace 必须等于 descriptor.namespace。
    this.typertRemote = bindTypertRemote(this, NS);
    this.config = config ?? {};
    /** sessionId -> { latest, lastTurn, acceptedTurns, inflight } */
    this.channels = new Map();
    /** 同一会话同一原因只记一次跳过日志，避免刷屏。 */
    this.skipLogged = new Set();
    this.diagVersion = -1;
    this.lifetime = new AbortController();

    ctx.effect(
      () => () => {
        this.lifetime.abort(new Error('next-message disposed'));
        for (const channel of this.channels.values()) channel.inflight?.abort();
        this.channels.clear();
      },
      'next-message: lifecycle',
    );

    // 新一轮开始：上一轮的建议立刻作废，在飞请求也取消。
    // agent/status 的 'running' 表示「唤醒输入开始走预处理」，正是轮次开始。
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'running') return;
      const channel = this.channels.get(String(agent.session.id));
      if (channel === undefined) return;
      const had = channel.latest !== null;
      channel.rev += 1;
      channel.inflight?.abort(new Error('a new turn started'));
      channel.inflight = undefined;
      channel.shadowInflight?.abort(new Error('a new turn started'));
      channel.shadowInflight = undefined;
      // 关键：不能在这里清 shadow。agent/status 的 running 早于 user/message，
      // 在这里清就等于在 settle 配对之前把影子丢掉（上一版就是这么错的）。
      // 跨轮次的错配由 settle 里的 turn 比对挡住，predict 开局也会清一次。
      // 界面上要立刻消失（规格要求），但配对数据不能丢：
      // agent/status 的 running 常常早于 user/message，直接丢弃会让 outcome 永远记不上。
      if (had) channel.pending = channel.latest;
      channel.latest = null;
      if (had) log({ kind: 'cleared-new-turn', sessionId: String(agent.session.id) });
    });

    ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/end') {
        if (event.data?.reason?.kind !== 'completed') return;
        void this.predict(session, event.data.turn).catch((error) => {
          log({ kind: 'predict-failed', sessionId: String(session.id), message: String(error) });
        });
        return;
      }
      if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
        void this.settle(session, event.data).catch(() => {});
      }
    });
  }

  channelOf(sessionId) {
    const key = String(sessionId);
    let channel = this.channels.get(key);
    if (channel === undefined) {
      channel = { latest: null, pending: null, shadow: null, lastTurn: -1, lastPollAt: 0, rev: 0, acceptedTurns: new Set(), inflight: undefined, shadowInflight: undefined };
      this.channels.set(key, channel);
    }
    return channel;
  }

  /** 客户端轮询入口。顺带驱动热诊断（impl.DIAG_VERSION 变化时执行一次）。 */
  suggestion(sessionId) {
    void this.maybeDiagnose();
    const channel = this.channelOf(sessionId);
    // 轮询即心跳：说明这个会话在某个客户端窗口里开着，预测才有意义。
    channel.lastPollAt = Date.now();
    // 投影探针：客户端一开始轮询就记一次，不必等一轮结束才知道 todos 单元在不在。
    if (channel.probed !== true) {
      channel.probed = true;
      this.probeProjections(sessionId);
    }
    return channel.latest;
  }

  /**
   * 记录该会话上已注册的投影键，以及 todos 的值形状。
   *
   * 用来区分「todos 单元没注册」和「单元在、值为 null」——这两种情况在
   * openTodos=0 上长得一模一样，而解法完全不同。
   */
  probeProjections(sessionId) {
    let result;
    try {
      const registry = this.ctx.sessionProjections;
      if (registry === undefined) {
        result = { probe: 'no-registry' };
      } else {
        const session = this.ctx.sessions.get(sessionId);
        if (session === undefined) {
          result = { probe: 'no-session' };
        } else {
          const snapshot = registry.snapshot(session);
          const keys = Object.keys(snapshot?.values ?? {});
          const todos = registry.stateOf(session, 'todos');
          result = {
            probe: 'ok',
            keys,
            hasTodosUnit: keys.includes('todos'),
            todosValue: todos === null ? 'null' : Array.isArray(todos) ? `array(${String(todos.length)})` : typeof todos,
          };
        }
      }
    } catch (error) {
      result = { probe: `threw:${String(error).slice(0, 80)}` };
    }
    log({ kind: 'projection-probe', sessionId: String(sessionId), ...result });
  }

  /**
   * A/B 影子预测：同上下文、同模型，只换 reasoningEffort，结果不显示只记账。
   * 与主调用并行跑，失败静默。
   */
  async runShadow(session, turn, { provider, model, context, shadowEffort }) {
    const channel = this.channelOf(session.id);
    channel.shadowInflight?.abort(new Error('superseded by a newer turn'));
    const controller = new AbortController();
    channel.shadowInflight = controller;
    const timer = setTimeout(
      () => controller.abort(new Error('shadow timeout')),
      this.config.timeoutMs ?? 20000,
    );
    const startedAt = Date.now();
    try {
      const impl = await loadImpl();
      if (impl === null) return;
      const options = impl.buildOptions({
        provider,
        model,
        system: impl.SYSTEM,
        context,
        // 只改 effort，其余沿用主调用的配置。
        config: { ...this.config, reasoningEffort: shadowEffort },
        signal: controller.signal,
      });
      let raw = '';
      let finish = 'stop';
      for await (const chunk of this.ctx.llm.stream(options)) {
        if (chunk.type === 'text-delta') raw += chunk.text;
        else if (chunk.type === 'finish') finish = chunk.reason?.kind ?? 'stop';
      }
      if (finish !== 'stop' && finish !== 'max-tokens') {
        log({ kind: 'shadow-bad-finish', turn, effort: shadowEffort, finish });
        return;
      }
      const verdict = impl.finalizeSuggestion(raw, session, this.config);
      const ms = Date.now() - startedAt;
      if (verdict.text === null) {
        log({ kind: 'shadow-abstain', turn, effort: shadowEffort, reason: verdict.reason, ms });
        return;
      }
      channel.shadow = { turn, text: verdict.text, effort: shadowEffort, ms };
      log({ kind: 'shadow', turn, effort: shadowEffort, text: verdict.text, ms, chars: verdict.text.length });
    } catch (error) {
      log({ kind: 'shadow-failed', turn, effort: shadowEffort, message: String(error) });
    } finally {
      clearTimeout(timer);
      if (channel.shadowInflight === controller) channel.shadowInflight = undefined;
    }
  }

  async maybeDiagnose() {
    try {
      const impl = await loadImpl();
      if (impl === null || impl.DIAG_VERSION === undefined) return;
      if (impl.DIAG_VERSION === this.diagVersion) return;
      this.diagVersion = impl.DIAG_VERSION;
      // 必须挂 catch：这是 fire-and-forget 调用，未处理的 rejection 会杀掉 host 进程。
      // 上一次崩溃就是这么来的。
      void Promise.resolve(impl.diagnostics({ ctx: this.ctx, log })).catch((error) => {
        log({ kind: 'diag-trigger-failed', message: String(error) });
      });
    } catch (error) {
      log({ kind: 'diag-trigger-failed', message: String(error) });
    }
  }

  /**
   * 客户端离开这个会话：清掉建议并取消在飞请求。
   * rev 自增，让已经返回但还没写入的结果在上面的复核里被丢掉。
   */
  release(sessionId) {
    const key = String(sessionId);
    const channel = this.channels.get(key);
    if (channel === undefined) return true;
    channel.rev += 1;
    channel.inflight?.abort(new Error('client left the conversation'));
    channel.inflight = undefined;
    channel.shadowInflight?.abort(new Error('client left the conversation'));
    channel.shadowInflight = undefined;
    channel.latest = null;
    channel.pending = null;
    channel.shadow = null;
    log({ kind: 'release', sessionId: key });
    return true;
  }

  /** 客户端报告 Tab 采纳。 */
  accepted(sessionId, turn, text) {
    this.channelOf(sessionId).acceptedTurns.add(turn);
    log({ kind: 'tab-accept', sessionId: String(sessionId), turn, text });
    return true;
  }

  /** 真实用户消息到达：与上一条建议比对，记录命中情况，这是准确率的数据源。 */
  async settle(session, data) {
    const channel = this.channelOf(session.id);
    // 无论有没有建议可对照，用户已经发出下一句，之前的结果一律作废。
    channel.rev += 1;
    // pending 优先：新一轮开始已经把界面上的建议清掉了，但配对仍要记。
    const suggested = channel.pending ?? channel.latest;
    channel.pending = null;
    if (suggested === null) return;
    const impl = await loadImpl();
    const actual = (data.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .trim();
    const score = impl === null ? 0 : impl.similarity(suggested.text, actual);
    log({
      kind: 'outcome',
      sessionId: String(session.id),
      turn: suggested.turn,
      suggested: suggested.text,
      actual,
      similarity: Number(score.toFixed(3)),
      exact: score === 1,
      close: score >= 0.5,
      acceptedViaTab: channel.acceptedTurns.has(suggested.turn),
      latencyMs: Date.now() - suggested.at,
      // 影子建议必须属于同一轮次，否则可能是上一轮的残值，直接丢弃。
      shadow: channel.shadow !== null && channel.shadow.turn === suggested.turn ? channel.shadow : null,
      // 评审用的上下文。旧记录没有这个字段，评审会退回按会话重建。
      context: suggested.context ?? null,
    });
    channel.latest = null;
    channel.pending = null;
    channel.shadow = null;
  }

  async predict(session, turn) {
    if (this.config.enabled === false) return;
    const impl = await loadImpl();
    if (impl === null) return;

    const channel = this.channelOf(session.id);
    // 上一轮的影子结果如果没等到实际输入，就作废，避免错配。
    channel.shadow = null;

    // 值不值得为这个会话花一次 LLM 调用。判定规则放在 impl.js（热加载），
    // 子代理会话和没人看着的会话在这里被挡掉。
    if (typeof impl.shouldPredict === 'function') {
      const verdict = impl.shouldPredict({
        header: session.header ?? {},
        lastPollAt: channel.lastPollAt === 0 ? null : channel.lastPollAt,
        now: Date.now(),
      });
      if (verdict.predict !== true) {
        const key = `${String(session.id)}|${verdict.reason}`;
        if (!this.skipLogged.has(key)) {
          this.skipLogged.add(key);
          log({ kind: 'skip-predict', sessionId: String(session.id), turn, reason: verdict.reason });
        }
        return;
      }
    }

    if (turn <= channel.lastTurn) return;
    channel.lastTurn = turn;
    // 轮次快照。返回后如果这个值变了（用户已发新消息、或客户端离开），结果必须丢弃。
    channel.rev += 1;
    const rev = channel.rev;

    channel.inflight?.abort(new Error('superseded by a newer turn'));
    const controller = new AbortController();
    channel.inflight = controller;
    const onLifetimeAbort = () => controller.abort(this.lifetime.signal.reason);
    this.lifetime.signal.addEventListener('abort', onLifetimeAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error('next-message timeout')),
      this.config.timeoutMs ?? 20000,
    );

    const startedAt = Date.now();
    try {
      // 未完成的 todo：host 侧从会话投影零 IO 读到。投影可能没注册（tool-todo 被禁用），
      // 读不到就不加块——宁缺毋滥。
      let todos = null;
      let todoProbe = 'unknown';
      try {
        const registry = this.ctx.sessionProjections;
        if (registry === undefined) {
          todoProbe = 'no-registry';
        } else {
          // 列出这个会话上已注册的投影键，用来判断 todos 单元到底在不在。
          const snapshot = registry.snapshot?.(session);
          const keys = Object.keys(snapshot?.values ?? {});
          todoProbe = `keys:${keys.join('|')}`;
          todos = registry.stateOf?.(session, 'todos') ?? null;
          if (todos === null) todoProbe += ' todos:null';
          else if (Array.isArray(todos)) todoProbe += ` todos:${String(todos.length)}`;
        }
      } catch (error) {
        todoProbe = `threw:${String(error).slice(0, 70)}`;
        todos = null;
      }
      const openTodos = typeof impl.openTodoCount === 'function' ? impl.openTodoCount(todos) : 0;

      const context = impl.buildContext(session, this.config, { todos });
      if (context === null) return;
      // 预测当时的上一条助手消息，跟着建议一起缓存，最后写进 outcome 供评审使用。
      const lastAssistant =
        typeof impl.lastAssistantMessage === 'function' ? impl.lastAssistantMessage(session) : null;
      const route = resolveRoute(this.ctx, session, this.config);
      if (route === null) {
        log({ kind: 'no-route', sessionId: String(session.id) });
        return;
      }

      const options = impl.buildOptions({
        provider: route.provider,
        model: route.model,
        system: impl.SYSTEM,
        context,
        config: this.config,
        signal: controller.signal,
      });

      let raw = '';
      let finish = 'stop';
      for await (const chunk of this.ctx.llm.stream(options)) {
        if (chunk.type === 'text-delta') raw += chunk.text;
        else if (chunk.type === 'finish') finish = chunk.reason?.kind ?? 'stop';
      }
      // max-tokens 只说明被截断，模型已经写出的部分通常仍是可用的一句话，
      // 整条丢弃会让用户看到「没有建议」。error / aborted / tool-calls 才真的要放弃。
      if (finish !== 'stop' && finish !== 'max-tokens') {
        log({ kind: 'bad-finish', sessionId: String(session.id), finish });
        return;
      }
      const truncated = finish === 'max-tokens';

      // 返回时再次核对会话与轮次：旧结果绝不能覆盖当前状态。
      if (channel.inflight !== controller || channel.rev !== rev) {
        log({ kind: 'stale-dropped', sessionId: String(session.id), turn, ms: Date.now() - startedAt });
        return;
      }

      const verdict = impl.finalizeSuggestion(raw, session, this.config);
      if (verdict.text === null) {
        log({
          kind: 'abstain',
          reason: verdict.reason,
          sessionId: String(session.id),
          turn,
          ms: Date.now() - startedAt,
          raw: raw.slice(0, 200),
        });
        return;
      }
      channel.latest = { text: verdict.text, turn, at: Date.now(), context: lastAssistant };
      log({
        kind: 'suggestion',
        sessionId: String(session.id),
        turn,
        text: verdict.text,
        model: `${route.provider}/${route.model}`,
        ms: Date.now() - startedAt,
        contextChars: context.length,
        chars: verdict.text.length,
        truncated,
        openTodos,
        todoProbe,
      });

      // A/B 影子调用：同一个上下文、同一个模型，只换 reasoningEffort。
      // 结果不显示，只与主建议一起写进 outcome，形成配对数据。
      const shadowEffort =
        typeof impl.SHADOW_EFFORT === 'string' && impl.SHADOW_EFFORT !== '' ? impl.SHADOW_EFFORT : null;
      if (shadowEffort !== null) {
        void this.runShadow(session, turn, {
          provider: route.provider,
          model: route.model,
          context,
          shadowEffort,
        });
      }
    } finally {
      clearTimeout(timer);
      this.lifetime.signal.removeEventListener('abort', onLifetimeAbort);
      if (channel.inflight === controller) channel.inflight = undefined;
    }
  }
}

/** 导出仅为测试可注入：真实加载路径只用 apply。 */
export { NextMessageService };

export function apply(ctx, config) {
  log({ kind: 'apply', version: 5, scriptMtime, config: config ?? {} });
  try {
    ctx.typert.register(TYPERT);
    log({ kind: 'registered', endpoints: TYPERT.invocations.map((item) => `${item.namespace}/${item.method}`) });
  } catch (error) {
    log({ kind: 'typert-register-failed', message: String(error) });
    throw error;
  }
  ctx.plugin(NextMessageService, config ?? {});

  // 诊断：确认本包的浏览器行是否进了客户端模块图。没有这一行客户端就永远不会加载。
  ctx.inject(['clientModules'], (scope) => {
    const dump = () => {
      try {
        const modules = scope.clientModules;
        const entries = modules.graph().entries.map((entry) => entry.id);
        log({
          kind: 'diag-graph',
          pending: scope.clientModules.clientPath(PKG) !== undefined,
          clientPath: scope.clientModules.clientPath(PKG) ?? null,
          entryCount: entries.length,
          hasOurs: entries.includes(PKG),
          tail: entries.slice(-6),
        });
      } catch (error) {
        log({ kind: 'diag-failed', message: String(error) });
      }
    };
    dump();
    // 不再注册 onGraphChanged：每次 bundle 重载都会新建一个 fiber，而这个监听器
    // 从不释放，于是每次重载泄漏一个——日志里那几条重复的 diag-failed 就是它们
    // 在旧 fiber 失效后触发。一次性的 apply 快照已经够用。
  });
}
