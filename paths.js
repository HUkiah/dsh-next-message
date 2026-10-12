/**
 * 运行时数据文件的位置 —— 全包唯一的定义处。
 *
 * 这些文件以前写在包目录里（`join(HERE, ...)`）。本地 `link:` 安装时没问题，
 * 但从 GitHub / npm 装进 profile 的 node_modules 之后：包目录会被重装和
 * 清缓存覆盖，日志和评审结果都会丢，依赖树也可能不可写。
 *
 * 所以统一放到 DSH 用户目录下，遵循 harness 自己的约定
 * （`storages` / `sessions` / `settings` / `speech-to-text` 都是 dshHomePath('<feature>')）。
 * 默认 `~/.dsh/next-message/`；设了 `DSH_HOME` 就跟过去。
 *
 * 注意：本文件是静态 import 的，改它要重启应用才生效（impl.js / host-real.js
 * 走的是带时间戳 URL 的热加载，本文件不在那条路径上）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 本插件的数据目录：`$DSH_HOME/next-message`（默认 `~/.dsh/next-message`）。 */
export const DATA_DIR = dshHomePath('next-message');
/** 逐行 JSON 的预测日志：建议、跳过原因、每轮的 outcome 对照。 */
export const LOG_FILE = join(DATA_DIR, 'next-message.log');
/** 离线评审（DIAG_VERSION 触发的 judge）的结果，跨轮次累积。 */
export const JUDGE_FILE = join(DATA_DIR, 'judge.json');

// 目录建不出来不该让插件挂掉：写的时候再失败，主流程不受影响。
try {
  mkdirSync(DATA_DIR, { recursive: true });
} catch {
  // 磁盘满 / 只读：留给 log() 与 judge 各自的 try 兜底。
}

/**
 * 逐行 JSON 的日志按时间归并，而不是简单追加。
 *
 * 旧 host 半可能在新代码生效之后才写下最后几行，那几行的时间戳比新文件里
 * 已有的行更早；直接追加会让它们排到末尾，而下游（评审配对、report 的
 * 「最近 N 对」）都按文件顺序读。时间相同的行保持各自原有顺序（稳定）。
 * @param current - 目标文件当前内容。
 * @param incoming - 旧文件内容。
 * @returns 归并后的整份内容。
 */
function mergeLines(current, incoming) {
  const split = (text) => text.split('\n').filter((line) => line.trim() !== '');
  const at = (line) => {
    try {
      const parsed = JSON.parse(line);
      return typeof parsed?.at === 'string' ? parsed.at : '';
    } catch {
      return '';
    }
  };
  // 缺时间戳的行（截断写入）跟着上一行的时间，而不是被排到最前面。
  const keyed = (lines) => {
    let last = '';
    return lines.map((line) => {
      const stamp = at(line);
      if (stamp !== '') last = stamp;
      return { line, key: stamp === '' ? last : stamp };
    });
  };
  const currentLines = keyed(split(current));
  const incomingLines = keyed(split(incoming));
  // 目标文件的行排在旧文件之前；时间相同的行按这个先后保持稳定。
  return [...currentLines, ...incomingLines]
    .map((entry, seq) => ({ ...entry, seq }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.seq - b.seq))
    .map((entry) => entry.line)
    .join('\n') + '\n';
}

/**
 * 一次性搬迁：旧版本把这两个文件写在包目录里。
 *
 * 两种情形都要照顾：
 *   - 目标不存在 → 直接 rename（保住历史与 mtime）。
 *   - 目标已存在 → 旧 host 半在新代码生效后又写过：日志按时间归并，
 *     judge.json 这种整份 JSON 则保留目标文件（它是更新的一份），旧文件删掉。
 * 幂等：搬迁完成后再加载，legacy 不存在，什么都不做。
 */
try {
  for (const name of ['next-message.log', 'judge.json']) {
    const legacy = join(HERE, name);
    if (!existsSync(legacy)) continue;
    const current = join(DATA_DIR, name);
    if (!existsSync(current)) {
      renameSync(legacy, current);
    } else if (name.endsWith('.log')) {
      const merged = mergeLines(readFileSync(current, 'utf8'), readFileSync(legacy, 'utf8'));
      writeFileSync(current, merged);
      rmSync(legacy);
    } else {
      // 整份 JSON 不能拼接；目标文件是新的，直接丢弃旧的那份。
      rmSync(legacy);
    }
  }
} catch {
  // 跨设备（旧文件不存在）或权限不足：忽略。
}
