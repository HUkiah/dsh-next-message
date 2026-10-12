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
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
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
 * 一次性搬迁：旧版本把这两个文件写在包目录里。
 *
 * 两种情形都要照顾：
 *   - 目标不存在 → 直接 rename（保住历史与 mtime）。
 *   - 目标已存在 → 说明换到新路径之后，还在跑的旧 host 半又往包目录写了几行，
 *     追加进去而不是丢掉，然后删掉旧文件。
 * 幂等：搬迁完成后再加载，legacy 不存在，什么都不做。
 */
try {
  for (const name of ['next-message.log', 'judge.json']) {
    const legacy = join(HERE, name);
    if (!existsSync(legacy)) continue;
    const current = join(DATA_DIR, name);
    if (existsSync(current)) {
      appendFileSync(current, readFileSync(legacy));
      rmSync(legacy);
    } else {
      renameSync(legacy, current);
    }
  }
} catch {
  // 跨设备（旧文件不存在）或权限不足：忽略。
}
