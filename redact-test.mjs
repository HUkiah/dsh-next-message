/**
 * 脱敏测试。
 *
 * 两个方向都要挡住：
 *   - 漏报：密钥、令牌、连接串口令被原样送进模型（不可逆，代价最高）；
 *   - 误报：文件名、commit hash、base64、`maxTokens` 这类正常文本被抹掉——
 *     它们是判定里最强的具体性信号，抹了等于自降准确率。
 *
 * 规则集是「宁可多报也不漏」的取向，所以误报这一侧的用例比漏报更重要，别删。
 * 改 impl.js 的 SECRET_PATTERNS 之后跑一遍：
 *   node redact-test.mjs
 */
import { redactSecrets, SECRET_PATTERNS } from './impl.js';

let pass = 0;
let total = 0;

/** 必须命中：每个规则至少一条。 */
const positives = [
  ['private-key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234abcd\nmore\n-----END RSA PRIVATE KEY-----'],
  ['url-credentials', 'psql postgres://admin:s3cr3t-pw@db.internal:5432/prod'],
  ['bearer', 'curl -H "Authorization: Bearer abcDEF123456ghiJKL789" https://api.example.com'],
  ['openai-key', 'OPENAI_API_KEY=sk-proj-AbCdEfGh1234567890XyZ'],
  ['anthropic-key', 'key is sk-ant-api03-AbCdEfGh1234567890XyZ'],
  ['github-token', 'remote: https://ghp_AbCdEfGh1234567890XyZAbCdEfGh@github.com'],
  ['slack-token', 'token xoxb-1234567890-abcdefghijkl'],
  ['stripe-key', 'sk_live_AbCdEfGh1234567890XyZ'],
  ['aws-access-key', 'AKIAIOSFODNN7EXAMPLE'],
  ['google-api-key', 'AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'],
  ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g'],
  ['assigned-secret', 'DB_PASSWORD="hunter2hunter2hunter2"'],
  ['assigned-secret', 'export ACCESS_TOKEN=abc123def456ghi789'],
  ['assigned-secret', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY'],
  ['assigned-secret-zh', '密码：MyS3cretPass'],
];

/** 绝不能误伤：真实开发文本。 */
const negatives = [
  'maxOutputTokens: 2048, reasoningEffort: off',
  '把 refresh token 的过期时间从 7 天改成 30 天，注意别影响 refresh token 轮换',
  'const token = getToken(); // 这里 token 是变量名，不是密钥',
  '我忘了密码，帮我加一个重置流程',
  '密码强度校验要加一条：至少 12 位',
  'git commit 47f3a9b2e1c8d5a7b6f4e2d1c0a9b8c7d6e5f4a3',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  '把 findings/B-a11y-i18n.md 里聊天流式正文缺 role="log"/aria-live 的问题补进报告',
  'pnpm add github:HUkiah/dsh-next-message#v0.1.2',
  'sk- 开头的 key 不要提交到仓库',
  'password: process.env.DB_PASSWORD,  // 只是引用环境变量',
  'token: config.accessToken,',
  'apiKey: "${OPENAI_API_KEY}",',
  'secret: $SECRET_VALUE,',
  'token 预算给到 200，timeoutMs 20000',
];

console.log(`规则数 ${String(SECRET_PATTERNS.length)}：${SECRET_PATTERNS.map(([name]) => name).join(', ')}\n`);

console.log('【必须命中】');
for (const [name, input] of positives) {
  total += 1;
  const out = redactSecrets(input);
  const ok = out.includes('[redacted:');
  if (ok) pass += 1;
  console.log(`  ${ok ? '✅' : '❌'} ${name.padEnd(18)} ${out.replace(/\n/g, ' ⏎ ').slice(0, 96)}`);
}

console.log('\n【绝不能误伤】');
for (const input of negatives) {
  total += 1;
  const out = redactSecrets(input);
  const ok = out === input;
  if (ok) pass += 1;
  console.log(`  ${ok ? '✅' : '❌ 被改动'} ${(ok ? input : out).slice(0, 88)}`);
}

console.log('\n【标记形态】');
{
  total += 1;
  const out = redactSecrets('psql postgres://admin:s3cr3t-pw@db.internal:5432/prod');
  const ok = out.includes('db.internal:5432') && out.includes('[redacted:password]@');
  if (ok) pass += 1;
  console.log(`  ${ok ? '✅' : '❌'} 连接串只抹口令，保留协议与主机：${out}`);
}
{
  total += 1;
  const out = redactSecrets('  ');
  const ok = out === '  ';
  if (ok) pass += 1;
  console.log(`  ${ok ? '✅' : '❌'} 非字符串输入不抛异常：${JSON.stringify(redactSecrets(null))}`);
}

console.log('\n【端到端：真正送给模型的那份上下文】');
{
  // 直接走 buildContext，验证的不再是函数本身，而是预测实际发出去的那段文本。
  const { buildContext } = await import('./impl.js');
  const message = (role, text) => ({
    role,
    source: { kind: role === 'user' ? 'user' : 'model' },
    content: [{ type: 'text', text }],
  });
  const session = {
    deriveMessages: () => [
      message('user', '把 staging 的部署脚本改一下，密钥是 sk-proj-AbCdEfGh1234567890XyZ'),
      message('assistant', '改好了，用的连接串是 postgres://ops:hunter2hunter2@db.internal:5432/staging'),
    ],
  };
  const context = buildContext(session, { maxContextChars: 6000 }, {});
  total += 1;
  const leaked = ['sk-proj-AbCdEfGh1234567890XyZ', 'hunter2hunter2'].filter((secret) => context.includes(secret));
  const ok = context.includes('[redacted:') && leaked.length === 0;
  if (ok) pass += 1;
  console.log(`  ${ok ? '✅' : '❌'} 上下文里没有原始密钥${leaked.length > 0 ? `（泄漏：${leaked.join(', ')}）` : ''}`);
  console.log(`     命中标记数：${String((context.match(/\[redacted:/g) ?? []).length)}`);
  console.log(`     实际片段：${context.split('\n').filter((line) => line.includes('redacted')).join(' / ').trim().slice(0, 160)}`);
}

console.log(`\n${String(pass)}/${String(total)} 通过`);
if (pass !== total) process.exitCode = 1;
