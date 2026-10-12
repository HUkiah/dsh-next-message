import { readFileSync, writeFileSync } from 'node:fs';
import { JUDGE_FILE, LOG_FILE } from './paths.js';

/**
 * 预测策略 —— 这一层是可以随时改、不用重启 App 的部分。
 *
 * 还包含离线评审：改 DIAG_VERSION 即触发一次，结果写 judge.json。
 *
 * host 外壳（host.js）每轮都用带时间戳的 URL 重新 import 本文件，
 * 所以调 prompt、上下文裁剪、归一化规则、相似度算法改完即生效。
 * 影响准确率的改动基本都在这里，请优先改这个文件。
 */

/**
 * 预测指令。
 *
 * 标定参照：Codex 在真实会话里给出的是
 *   「继续推进下一步，帮我落实测试环境的可信代理方案，保持现有 HTTPS 和安全校验，涉及集群变更先告诉我。」
 * 也就是一条点名了具体对象、并且带上用户既有约束的完整指令。
 * 所以这里刻意不鼓励「继续」「好的」这类通用短答：那类建议没有价值，用户不会按 Tab。
 */
export const SYSTEM = [
  'You write the one message a developer is about to type into the input box of an AI coding',
  'assistant. The assistant just finished its turn; the developer is deciding what to say.',
  '',
  'Your main job is ONE thing. Work happens in steps: a step finishes, and the developer wants to',
  'tell the assistant to carry on with the next one. Hand them that sentence. They will press Tab',
  'and send it instead of typing it themselves. So, in order of preference:',
  '',
  ' 1. THE NEXT UNFINISHED STEP, worded as the instruction the developer would send. A [TASK STATE]',
  '    list may appear at the top of the conversation; when it does, the next step is the first',
  '    unfinished item there. Otherwise use the step the assistant just proposed or left open.',
  ' 2. The developer\u2019s ANSWER, when the assistant ended by asking them something or offering options.',
  ' 3. THE DOUBT, when the developer would more likely question the assistant than instruct it:',
  '    something the assistant left vague, decided silently, or a risk it glossed over. Write it the',
  '    way the developer would ask it out loud \u2014 not as a summary or a status report.',
  '',
  'Reply with ONE JSON object and nothing else. No fences, no explanation:',
  '  {"suggestion": "<the message>"}',
  '  {"suggestion": null}',
  '',
  'STAY SILENT unless you can point at the specific step or the specific question in the conversation.',
  'A wrong suggestion costs the developer attention every time it appears; silence costs nothing.',
  'Return {"suggestion": null} when any of these holds:',
  '  - there is no unfinished step and no open question;',
  '  - the assistant reported the work finished and nothing remains;',
  '  - the developer\u2019s last message declined further work or closed the exchange',
  '    ("that is all", "no need", "thanks", "never mind");',
  '  - you would only be restating the assistant\u2019s own sentence without adding the instruction.',
  'Do not invent work to have something to say. Not every turn has a follow-up.',
  '',
  'Naming the same step the assistant named is EXPECTED and good \u2014 the developer will refer to that',
  'same step, so carry its concrete subject forward (the file, service, environment or artifact).',
  'Do not copy a whole sentence of the assistant\u2019s prose verbatim, though: write it as the developer',
  'would say it. Carry their standing constraints along when they bear on that step, for example',
  '"keep the existing HTTPS and safety checks" or "ask me before changing the cluster".',
  'Never a bare "\u7ee7\u7eed" or "ok": a complete, actionable instruction beats a vague fragment,',
  'as long as it needs, up to about 45 characters.',
  'Never output a message the developer already sent earlier in this conversation.',
  'Never output a greeting, thanks, or filler acknowledgement.',
  'Write in the same language as the developer\u2019s most recent message, and match their tone.',
].join('\n');

/** 明确的「没有建议」标记：模型偶尔不按 JSON 输出，用这些兜一层。 */
const NO_SUGGESTION = new Set(['（无）', '(无)', '无建议', 'none', 'n/a', 'null', '<empty>', 'no suggestion']);

/** 一条消息在预测上下文里的紧凑表示。工具调用的名字和参数都要留：文件名是最强的具体性信号。 */
function renderMessage(message) {
  const parts = [];
  for (const block of message.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      parts.push(block.text.trim());
    } else if (block.type === 'tool-call') {
      const name = String(block.name ?? 'unknown');
      const raw = block.arguments ?? block.args ?? block.input;
      const args = typeof raw === 'string' ? raw : raw === undefined ? '' : JSON.stringify(raw);
      parts.push(`[tool call: ${name}${args === '' ? '' : ` ${args.slice(0, 160)}`}]`);
    }
  }
  return parts.join('\n');
}

/**
 * 组装预测上下文。
 *
 * 只收真实用户消息（source.kind === 'user'）。agent.inject() 塞进来的合成上下文
 * （AGENTS.md、文件变更通知、skill 正文）的 role 也是 user，混进去会让模型以为
 * 开发者说过那些话，是准确率的主要杀手之一。
 *
 * 结构上分两段：开头始终保留原始任务陈述，后面接最近对话。
 * 只取尾部会把会话早期的约束挤出窗口，而「保持 HTTPS 和安全校验」这类约束
 * 恰恰是让建议从空泛变具体的关键。
 */
export function buildContext(session, config, extra = {}) {
  const budget = config.maxContextChars ?? 6000;
  // 未完成的 todo 就是「任务状态」最直接的载体：整份列表由 todo_write 整体替换，
  // 每轮开始时清空，所以 turn/end 时读到的就是本轮实际在做的事。
  const taskState = renderTaskState(extra.todos);
  const messages = session.deriveMessages();
  const lines = [];
  const firstUser = [];
  for (const message of messages) {
    if (message.role === 'user' && message.source?.kind !== 'user') continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = renderMessage(message);
    if (text === '') continue;
    const label = message.role === 'user' ? 'USER' : 'ASSISTANT';
    const line = `${label}: ${text.slice(0, 2000)}`;
    lines.push(line);
    if (message.role === 'user' && firstUser.length === 0) firstUser.push(line);
  }
  if (lines.length === 0) return null;

  const joined = lines.join('\n\n');
  const tailBudget = Math.max(1200, budget - 1000);
  const truncated = joined.length > tailBudget;
  const tail = truncated ? joined.slice(joined.length - tailBudget) : joined;
  // 只有真的被裁掉时才补 [TASK]，否则首条用户消息会重复出现两遍。
  const taskBlock = !truncated || firstUser.length === 0 ? '' : `[TASK]\n${firstUser[0].slice(0, 900)}\n\n[RECENT]\n`;
  const head = taskState === null ? '' : `${taskState}\n\n`;
  return `${head}${taskBlock}${tail}\n\nWrite the developer\u2019s next message.`;
}

/** 把未完成的 todo 渲染成一个独立块；没有就返回 null（宁缺毋滥）。 */
function renderTaskState(todos) {
  if (!Array.isArray(todos)) return null;
  const open = todos
    .filter((item) => item !== null && typeof item === 'object' && item.status !== 'completed')
    .map((item) => (typeof item.content === 'string' ? item.content.trim() : ''))
    .filter((text) => text !== '');
  if (open.length === 0) return null;
  const lines = open.slice(0, 8).map((text) => `- ${text.slice(0, 120)}`);
  return `[TASK STATE]\n${lines.join('\n')}`;
}

/** 未完成 todo 的条数，供日志核对这次预测到底有没有吃到任务状态。 */
export function openTodoCount(todos) {
  if (!Array.isArray(todos)) return 0;
  return todos.filter((item) => item !== null && typeof item === 'object' && item.status !== 'completed').length;
}

/**
 * 纯文本清洗：去掉包裹的引号、代码标记、列表符号，只留第一行。
 * JSON 解析、放弃建议、回收检测都在 finalizeSuggestion 里做。
 */
export function normalizeSuggestion(raw) {
  let text = String(raw ?? '').trim();
  text = text.split('\n').find((line) => line.trim() !== '') ?? '';
  text = text.trim();
  text = text.replace(/^[-*•]\s+/, '');
  text = text.replace(/^["'“”‘’`]+/, '').replace(/["'“”‘’`]+$/, '');
  return text.trim();
}

/**
 * 取模型输出里最外层的 JSON 对象。
 * 容错只针对代码块围栏和前后多余的散文：那不是「无效 JSON」，只是多包了一层。
 */
function outerJson(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return null;
  const bare = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = bare.indexOf('{');
  const end = bare.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(bare.slice(start, end + 1));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 解析 {"suggestion": string|null} 信封。返回 {kind:'ok',value} 或 {kind:'invalid'}。 */
function parseEnvelope(raw) {
  const parsed = outerJson(raw);
  if (parsed === null) return { kind: 'invalid' };
  const value = parsed.suggestion;
  if (value === null || value === undefined) return { kind: 'ok', value: null };
  if (typeof value !== 'string') return { kind: 'invalid' };
  return { kind: 'ok', value };
}

/**
 * 预测当时看到的上一条助手消息。
 *
 * 写进 outcome 日志，供离线评审判断「这条建议能不能直接发送」——
 * 只看「建议 vs 实际」两个字符串判不了这件事，需要知道助手当时说了什么。
 */
export function lastAssistantMessage(session) {
  try {
    const messages = session.deriveMessages();
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'assistant') continue;
      // 只取文本。纯工具调用型的消息对「这条建议能不能直接发送」没有信息量，
      // 喂给评审反而会让它以为助手只说了 "[tool call: bash]"。
      const text = (message.content ?? [])
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text.trim())
        .filter((value) => value !== '')
        .join('\n');
      if (text !== '') return text.slice(0, 600);
    }
  } catch {
    // 取不到就留空，不影响预测本身。
  }
  return null;
}

/** 会话里最近两条真实用户消息，用于回收检测。 */
function recentUserMessages(session) {
  const out = [];
  for (const message of session.deriveMessages()) {
    if (message.role !== 'user' || message.source?.kind !== 'user') continue;
    const text = renderMessage(message);
    if (text !== '') out.push(text);
  }
  return out.slice(-2);
}

/**
 * 把模型原始输出变成最终建议。
 *
 * 这是唯一的判定入口，返回值里的 reason 会写进日志，方便统计「为什么没有建议」：
 *   ok           有建议
 *   abstained    模型明确返回 null（规格允许放弃）
 *   invalid-json 不符合 {"suggestion": ...} 信封
 *   marker       输出成了「（无）」这类标记
 *   recycled     与最近两条用户消息高度重合（回收开发者自己的话）
 *   empty        清洗后为空
 *
 * @param raw - 模型原始输出
 * @param session - 当前会话，用于回收检测
 * @param config - 插件配置，提供 maxSuggestionChars
 * @returns {{ text: string | null, reason: string }}
 */
export function finalizeSuggestion(raw, session, config) {
  const envelope = parseEnvelope(raw);
  if (envelope.kind === 'invalid') return { text: null, reason: 'invalid-json' };
  if (envelope.value === null) return { text: null, reason: 'abstained' };
  const text = normalizeSuggestion(envelope.value).slice(0, config?.maxSuggestionChars ?? 60);
  if (text === '') return { text: null, reason: 'empty' };
  if (NO_SUGGESTION.has(text.toLowerCase())) return { text: null, reason: 'marker' };
  for (const earlier of recentUserMessages(session)) {
    if (similarity(text, earlier) >= 0.9) return { text: null, reason: 'recycled' };
  }
  return { text, reason: 'ok' };
}

/** 归一化后做字符二元组 Jaccard，中英文都能用。 */
export function similarity(a, b) {
  const clean = (value) =>
    String(value ?? '')
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]/gu, '');
  const left = clean(a);
  const right = clean(b);
  if (left === '' || right === '') return 0;
  if (left === right) return 1;
  const grams = (value) => {
    const set = new Set();
    for (let index = 0; index < value.length - 1; index += 1) set.add(value.slice(index, index + 2));
    if (set.size === 0) set.add(value);
    return set;
  };
  const leftGrams = grams(left);
  const rightGrams = grams(right);
  let shared = 0;
  for (const gram of leftGrams) if (rightGrams.has(gram)) shared += 1;
  return (2 * shared) / (leftGrams.size + rightGrams.size);
}

/**
 * 组装 LLM 调用参数。放在这一层是为了能随时调延迟与质量的权衡，不用重启 App。
 *
 * reasoningEffort 是准确率和延迟的主要旋钮：
 *  - 'off'  预测约 1 秒返回，建议简短直接，适合「边读回复边看到建议」
 *  - 省略   继承会话默认（DeepSeek 常为 high），更会推理，但可能慢到没意义
 * 想比较两者，把 reasoningEffort 改成 undefined 观察 next-message.log 里的 ms 与命中率。
 */
export function buildOptions({ provider, model, system, context, config, signal }) {
  const effort = config.reasoningEffort === undefined ? 'off' : config.reasoningEffort;
  const thinking = effort !== undefined && effort !== null && effort !== 'off' && effort !== 'none';
  const base = config.maxOutputTokens ?? 96;
  const options = {
    provider,
    model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: context }] }],
    // 开启 thinking 时必须给足预算：思维链先消耗 token，预算太小会把 JSON
    // 截断，最终表现为 invalid-json——这不是模型不会答，而是我们没给它地方答。
    // A/B 实验里影子两次 invalid-json 就是这个原因。
    maxTokens: thinking ? Math.max(base, THINKING_MAX_TOKENS) : base,
    temperature: 0,
    signal,
  };
  if (effort !== undefined && effort !== null && effort !== 'default') options.reasoningEffort = effort;
  return options;
}

/**
 * 值不值得为这个会话花一次 LLM 调用。
 *
 * 两条规则：
 *  1. 子代理会话不预测。子会话由父代理驱动，人类不会在里面输入，
 *     而且实测中子代理会话数量远多于会话数，白跑的调用是真实成本。
 *     判据用 SessionHeader 的两个显式字段，不靠会话 id 的形状。
 *  2. 没有客户端近期轮询过的会话不预测。客户端每 700 ms 轮询一次，
 *     没人看着的会话预测出来也没人看。窗口给得很宽也不会误杀。
 *
 * 判定放在热加载层，窗口大小和规则都能随时改，不用重启 App。
 */
export const CLIENT_TTL_MS = 10000;

/** 开启 thinking 时的最小输出预算。见 buildOptions 里的说明。 */
export const THINKING_MAX_TOKENS = 2000;

/**
 * A/B 实验：影子预测用的 reasoningEffort。
 *
 * 每一轮除了主调用（界面显示的那条），再并行跑一次影子调用，只记日志不显示。
 * 两个建议面对同一个上下文、同一个实际输入，所以是配对数据，可以直接比
 * sameIntent 与延迟——不存在「先跑 20 轮再换设置」那种前后对话不同的混淆。
 *
 * 设为 null 即关闭影子调用（本文件热加载，改完立刻生效，不用重启）。
 *
 * 2026-10-12 已关闭，结论：选 'off'。13 对严格配对里只有 1 对是 off 独对、
 * 1 对是 default 独对，85% 是「两个都错」——因为没有区分度，不是平局。
 * 逐字命中 1:0，代价 0.8s vs 4.2s。没有证据支持付这个代价。
 * 真正的问题在上下文里没有任务状态，不在这个旋钮上。
 */
export const SHADOW_EFFORT = null;

export function shouldPredict({ header, lastPollAt, now }) {
  const origin = header?.origin ?? null;
  const depth = header?.delegationDepth ?? null;
  if (origin === 'subagent') return { predict: false, reason: 'subagent(origin)' };
  if (typeof depth === 'number' && depth > 0) return { predict: false, reason: `subagent(depth=${String(depth)})` };
  if (lastPollAt === null || lastPollAt === undefined) return { predict: false, reason: 'no-client(never)' };
  const age = now - lastPollAt;
  if (age > CLIENT_TTL_MS) return { predict: false, reason: `no-client(${String(Math.round(age / 1000))}s)` };
  return { predict: true, reason: 'ok' };
}

/**
 * 热诊断通道。
 *
 * host 外壳每次被客户端轮询时都会重新 import 本文件；DIAG_VERSION 变化时执行一次
 * diagnostics()。加或改诊断只需要动这个文件，不用重启 App。改完把 DIAG_VERSION 加一。
 */
export const DIAG_VERSION = 10;

export async function diagnostics({ ctx, log }) {
  const report = { kind: 'diag' };
  try {
    const rows = ctx.loader?.entries?.() ?? [];
    report.loaderRows = rows
      .filter((entry) => String(entry.options?.name ?? '').includes('dsh-next-message'))
      .map((entry) => ({
        name: entry.options?.name,
        disabled: entry.disabled === true,
        hasFiber: entry.fiber !== undefined,
      }));
  } catch (error) {
    report.loaderError = String(error);
  }
  try {
    const modules = ctx.get('clientModules');
    if (modules === undefined) report.clientModules = 'service absent';
    else {
      const graph = modules.graph();
      const entries = graph.entries.map((entry) => entry.id);
      report.clientPath = modules.clientPath('@local/dsh-next-message') ?? null;
      report.entryCount = entries.length;
      report.hasOurs = entries.includes('@local/dsh-next-message');
      report.tail = entries.slice(-8);
      report.batches = graph.batches.length;
    }
  } catch (error) {
    report.clientModulesError = String(error);
  }
  log(report);
  // 评审是诊断的附加动作。它失败绝不能让 diagnostics reject——
  // 调用方是 fire-and-forget，未处理的 rejection 会直接杀掉 host 进程。
  try {
    await runJudge({ ctx, log });
  } catch (error) {
    log({ kind: 'judge-failed', message: String(error) });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 离线评审
//
// 目的：把「准不准」变成可测量的数字，替代那个对中文无效的字符相似度。
// 触发：把 DIAG_VERSION 加一。本文件是热加载的，host 每次轮询都会重新导入，
//       版本变化时执行一次 diagnostics，于是顺带跑一遍评审。不需要重启 App。
// 模型：复用日志里最近一条建议记录用过的 provider/model。
// 产物：judge.json（逐条判定）+ 一行 judge 汇总日志。
//
// 注意：本模块被 fire-and-forget 调用，任何抛出都会变成未处理 rejection 并杀掉
// host 进程。所有可能失败的地方都必须自己吞掉。
// ─────────────────────────────────────────────────────────────────────────────

const JUDGE_LIMIT = 20;

const JUDGE_SYSTEM = [
  'You grade a "predict the developer\u2019s next message" feature for a coding assistant.',
  'Each sample gives the assistant message the prediction was based on (context), the predicted',
  'message (suggestion), and what the developer actually typed (actual).',
  '',
  'Judge three things per sample:',
  '1. sameIntent: does the suggestion ask for or answer the same thing as actual? Judge meaning,',
  '   not wording. Different length or phrasing still counts as the same intent.',
  '2. sendable: would the suggestion, sent as-is, be a sensible message for the developer to send?',
  '3. betterThanGeneric: is the suggestion more useful than a generic short reply such as',
  '   "\u7ee7\u7eed" or "ok"? Answer false when a generic reply would have served just as well.',
  '',
  'Return ONE JSON object and nothing else:',
  '{"verdicts":[{"id":0,"sameIntent":true,"sendable":true,"betterThanGeneric":false,"note":"why"}]}',
].join('\n');

/** 读日志，跳过坏行。 */
function readRows() {
  try {
    return readFileSync(LOG_FILE, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 从日志里最近一条建议记录取回 provider/model。 */
function pickJudgeModel(rows) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.kind !== 'suggestion' || typeof row.model !== 'string') continue;
    const at = row.model.indexOf('/');
    if (at > 0) return { provider: row.model.slice(0, at), model: row.model.slice(at + 1) };
  }
  return null;
}

/**
 * 还原某条对照记录当时看到的上一条助手消息。
 * 用作评审的 context：没有它，「这条建议能不能直接发送」无法判断。
 */
function contextFor(ctx, sessionId, actual) {
  let sessions;
  try {
    sessions = ctx.sessions?.list?.();
  } catch {
    return null;
  }
  if (!Array.isArray(sessions)) return null;
  const session = sessions.find((candidate) => String(candidate.id) === String(sessionId));
  if (session === undefined) return null;
  let messages;
  try {
    messages = session.deriveMessages();
  } catch {
    return null;
  }
  const squash = (value) => String(value ?? '').replace(/\s+/g, '');
  const target = squash(actual);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user' || message.source?.kind !== 'user') continue;
    if (squash(renderMessage(message)) !== target) continue;
    for (let back = index - 1; back >= 0; back -= 1) {
      if (messages[back].role === 'assistant') return renderMessage(messages[back]).slice(0, 600);
    }
    return null;
  }
  return null;
}

async function collectText(ctx, options) {
  let text = '';
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text;
    else if (chunk.type === 'finish' && chunk.reason?.kind !== 'stop' && chunk.reason?.kind !== 'max-tokens') {
      return null;
    }
  }
  return text;
}

async function runJudge({ ctx, log }) {
  try {
    const rows = readRows();
    const outcomes = rows.filter((row) => row.kind === 'outcome').slice(-JUDGE_LIMIT);
    if (outcomes.length === 0) {
      log({ kind: 'judge-skip', reason: 'no-outcomes' });
      return;
    }
    const route = pickJudgeModel(rows);
    if (route === null) {
      log({ kind: 'judge-skip', reason: 'no-model-in-log' });
      return;
    }
    if (typeof ctx.llm?.stream !== 'function') {
      log({ kind: 'judge-skip', reason: 'llm-unavailable' });
      return;
    }

    // 主建议与影子建议各自成为一条样本，共享同一个 context 与 actual，天然配对。
    const samples = [];
    for (const row of outcomes) {
      const shared = {
        session: String(row.sessionId ?? '').slice(-6),
        context: row.context ?? contextFor(ctx, row.sessionId, row.actual) ?? '(context unavailable)',
        actual: row.actual,
        userPressedTab: row.acceptedViaTab === true,
      };
      samples.push({ ...shared, id: samples.length, variant: 'primary', suggestion: row.suggested });
      const shadow = row.shadow;
      if (shadow !== null && typeof shadow === 'object' && typeof shadow.text === 'string' && shadow.text !== '') {
        samples.push({
          ...shared,
          id: samples.length,
          variant: `shadow:${String(shadow.effort ?? '?')}`,
          suggestion: shadow.text,
        });
      }
    }

    const startedAt = Date.now();
    let raw;
    try {
      raw = await collectText(ctx, {
        provider: route.provider,
        model: route.model,
        system: JUDGE_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify({ samples }) }] }],
        maxTokens: 2500,
        temperature: 0,
        reasoningEffort: 'off',
      });
    } catch (error) {
      log({ kind: 'judge-failed', stage: 'call', message: String(error) });
      return;
    }
    if (raw === null) {
      log({ kind: 'judge-failed', stage: 'stream', message: 'stream did not finish cleanly' });
      return;
    }

    const parsed = outerJson(raw);
    const verdicts = Array.isArray(parsed?.verdicts) ? parsed.verdicts : null;
    if (verdicts === null) {
      log({ kind: 'judge-failed', stage: 'parse', raw: raw.slice(0, 300) });
      return;
    }

    const byId = new Map(verdicts.map((verdict) => [verdict?.id, verdict]));
    const merged = samples.map((sample) => {
      const verdict = byId.get(sample.id) ?? {};
      return {
        ...sample,
        sameIntent: verdict.sameIntent === true,
        sendable: verdict.sendable === true,
        betterThanGeneric: verdict.betterThanGeneric === true,
        note: typeof verdict.note === 'string' ? verdict.note : '',
      };
    });
    const count = (key) => merged.filter((item) => item[key]).length;
    // 分会话统计：元讨论型会话（讨论这个功能本身）永远比真实工作会话差，
    // 混在一起会低估真实水平，所以两个维度都给出。
    const bySession = {};
    for (const item of merged) {
      const bucket = (bySession[item.session] ??= { samples: 0, sameIntent: 0, sendable: 0, betterThanGeneric: 0 });
      bucket.samples += 1;
      if (item.sameIntent) bucket.sameIntent += 1;
      if (item.sendable) bucket.sendable += 1;
      if (item.betterThanGeneric) bucket.betterThanGeneric += 1;
    }
    // A/B 用：按 primary / shadow 分组，这才是能直接对比的两组数。
    const byVariant = {};
    for (const item of merged) {
      const key = String(item.variant ?? 'primary');
      const bucket = (byVariant[key] ??= { samples: 0, sameIntent: 0, sendable: 0, betterThanGeneric: 0 });
      bucket.samples += 1;
      if (item.sameIntent) bucket.sameIntent += 1;
      if (item.sendable) bucket.sendable += 1;
      if (item.betterThanGeneric) bucket.betterThanGeneric += 1;
    }
    const summary = {
      at: new Date().toISOString(),
      model: `${route.provider}/${route.model}`,
      samples: merged.length,
      sameIntent: count('sameIntent'),
      sendable: count('sendable'),
      betterThanGeneric: count('betterThanGeneric'),
      userPressedTab: merged.filter((item) => item.userPressedTab).length,
      bySession,
      byVariant,
    };

    try {
      writeFileSync(JUDGE_FILE, `${JSON.stringify({ summary, items: merged }, null, 2)}\n`);
    } catch (error) {
      log({ kind: 'judge-write-failed', message: String(error) });
    }
    log({ kind: 'judge', ...summary, ms: Date.now() - startedAt });
  } catch (error) {
    // 兜底：诊断路径绝不向外抛。
    try {
      log({ kind: 'judge-failed', stage: 'unknown', message: String(error) });
    } catch {
      // 连日志都写不了就只能放弃。
    }
  }
}
