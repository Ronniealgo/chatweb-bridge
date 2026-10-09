import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = mkdtempSync(join(tmpdir(), 'dsh-bridge-offline-'));
const env = { ...process.env,
  PI_CHATGPT_WEB_AUTH_FILE: join(data, 'absent-auth.json'),
  PI_CHATGPT_WEB_CACHE_DIR: join(data, 'cache'),
  PI_CHATGPT_WEB_PROFILE_DIR: join(data, 'profile'),
  PCW_CAPTURE_DIR: '',
  DSH_CHAT_API_TOKEN: '', DSH_CHAT_API_TOKEN_FILE: '', PCW_INTERNAL_TOKEN: '', PCW_INTERNAL_TOKEN_FILE: '', PCW_LOCAL_KEY: '',
  NODE_OPTIONS: '',
};
for (const key of ['DSH_CHAT_API_TOKEN','DSH_CHAT_API_TOKEN_FILE','PCW_INTERNAL_TOKEN','PCW_INTERNAL_TOKEN_FILE','PCW_LOCAL_KEY']) delete env[key];
const files = readdirSync(join(root, 'test')).filter(name => name.endsWith('.test.mjs')).sort().map(name => join(root, 'test', name));
const result = spawnSync(process.execPath, ['--require', join(root, 'scripts/offline-guard.cjs'), '--test', '--test-concurrency=1', ...files], {
  cwd: root, env, stdio: 'inherit', windowsHide: true, timeout: 180000,
});
if (result.error) console.error('Offline suite failed to start or exceeded its 180-second deadline.');
process.exitCode = result.status ?? 1;
