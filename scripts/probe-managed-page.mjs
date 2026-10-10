#!/usr/bin/env node
// 受管页面登录态探针（只输出布尔与标题长度，不抓取页面文本）。
// 用途：:1457 报 422 browser_not_ready(phase=prepare) 时判别「是否登录态丢失」。
// 前置：受管 Chrome 存活（有 8 个 chrome 进程不代表页面可用，要看登录态）。
// 用法：node scripts/probe-managed-page.mjs [profile-dir]
//   默认 profile：C:\Users\a\.cache\pi-chatgpt-web\profile
// 退出码：0=页面已可交互（composer 出现）；2=页面在但未登录/未就绪；1=探针自身失败。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const profile = process.argv[2] || String.raw`C:\Users\a\.cache\pi-chatgpt-web\profile`;
const portFile = path.join(profile, 'DevToolsActivePort');
if (!fs.existsSync(portFile)) {
  console.log('NO DevToolsActivePort - 受管 Chrome 未在运行');
  process.exit(1);
}
const cdpPort = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0].trim();

const tabs = await new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: cdpPort, path: '/json', timeout: 5000 }, (r) => {
    let b = '';
    r.on('data', (d) => (b += d));
    r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

const tab = tabs.find((t) => t.type === 'page' && t.url.includes('chatgpt.com'));
if (!tab) {
  console.log('NO chatgpt.com page tab - 受管 Chrome 没有打开聊天页');
  process.exit(2);
}

const expr = `JSON.stringify({
  url: location.href.slice(0, 90),
  title: document.title.slice(0, 50),
  composer: !!document.querySelector('#prompt-textarea, [contenteditable="true"]'),
  profileBtn: !!document.querySelector('[data-testid="profile-button"]'),
  loginLink: !!document.querySelector('[data-testid="login-button"], a[href*="auth/login"]'),
  ready: document.readyState
})`;

const state = await new Promise((resolve, reject) => {
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  ws.onmessage = (m) => {
    ws.close();
    try {
      const outer = JSON.parse(m.data);
      resolve(JSON.parse(outer.result.result.value));
    } catch (e) { reject(e); }
  };
  ws.onerror = () => reject(new Error('WebSocket error'));
  setTimeout(() => { try { ws.close(); } catch {} reject(new Error('WebSocket timeout')); }, 15000);
});

console.log(JSON.stringify(state));
// 登录判定：composer 出现且登录链接消失即视为已登录可用（头像按钮延迟渲染/选择器易变，不作硬条件）。
process.exit(state.composer && !state.loginLink ? 0 : 2);
