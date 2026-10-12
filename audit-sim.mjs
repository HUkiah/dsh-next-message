/**
 * 审计恢复模拟。
 *
 * 在 profile 的一份副本上调用应用自己的 sanitizeProfile()——也就是崩溃恢复
 * 那个「禁用第三方插件」按钮执行的同一个函数——然后按 dsh-plugin-manager
 * 的 listBundles() 判定规则，算出插件会以什么状态出现在 Plugins 页面。
 * 只操作 /tmp 下的副本，绝不碰正在使用的 profile。
 */
import { cpSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { PROFILE_TEMPLATES, sanitizeProfile, readProfileManifest, writeProfileBundles, resolveBundleDir } from '@deepseek-ai/dsh-app-boot';

const SRC = '/Users/h/.dsh/profiles/desktop';
const DST = '/tmp/dsh-profile-sim';
const NAME = '@local/dsh-next-message';

rmSync(DST, { recursive: true, force: true });
cpSync(SRC, DST, { recursive: true, verbatimSymlinks: true });
console.log('已复制 profile 到', DST, '（保留符号链接）\n');

/** 按 listBundles() 的判定规则读状态。 */
function state(label) {
  const manifest = JSON.parse(readFileSync(`${DST}/package.json`, 'utf8'));
  const selected = manifest.dsh?.profile?.bundles ?? [];
  const deps = Object.keys(manifest.dependencies ?? {});
  const enabled = selected.includes(NAME);
  const installed = deps.includes(NAME);
  console.log(label);
  console.log('  bundles      :', JSON.stringify(selected));
  console.log('  dependencies :', JSON.stringify(deps));
  console.log('  → 会出现在插件列表:', enabled || installed ? '是' : '否');
  console.log('  → enabled =', enabled, '| installed =', installed);
  return { selected, enabled, installed };
}

state('=== ① 恢复前（当前状态）===');

console.log('\n=== ② 执行应用自己的 sanitizeProfile() ===');
const backup = sanitizeProfile('dsh', DST, PROFILE_TEMPLATES.web.bundles);
console.log('  profile patch 备份到:', backup ?? '(本来就不存在)');

console.log('');
const after = state('=== ③ 恢复后 ===');
console.log('  profile patch 还在原位:', existsSync(`${DST}/cordis.patch.yml`) ? '在' : '否（已被挪走）');

let dir = null;
try {
  dir = resolveBundleDir('dsh', NAME, '/tmp/no-such-anchor.json', DST);
  console.log('  包仍可被解析:', dir);
  console.log('  包内 patch 可读:', existsSync(`${dir}/cordis.patch.yml`) ? '是' : '否');
} catch (error) {
  console.log('  包解析失败:', String(error).slice(0, 140));
}

console.log('\n=== ④ 模拟「在 Plugins 页面点一下启用」===');
const manifest = readProfileManifest('dsh', DST);
writeProfileBundles(DST, manifest, [...after.selected, NAME]);
state('启用后');

console.log('\n=== 结论 ===');
console.log(after.installed && !after.enabled
  ? '恢复后：插件仍被列为已安装、未启用 → 界面上一键可恢复'
  : '恢复后状态与预期不符，需要复查');
console.log('路径说明：本次只改动了 /tmp/dsh-profile-sim，你正在用的 profile 未被触碰。');
