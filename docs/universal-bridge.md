# 通用网页模型桥（0.3）

## 公共部分与适配器

```text
Hermes / DSH / 其他兼容客户端
           │ HTTP + Bearer（仅 loopback）
           ▼
   ChatWeb 公共协议层
   ├─ Chat Completions / Responses（受支持的子集）
   ├─ 保留完整角色、历史、工具调用 ID 与工具结果
   ├─ nonce + JSON Schema 校验的工具请求；桥本身不执行工具
   ├─ 每个网页适配器独立 FIFO、有界等待、取消、超时隔离
   └─ SSE 心跳、结构化错误、隐私日志
           │ generate(preparedRequest, context)
       ┌───┴───────────────────────┐
       ▼                           ▼
  Gemini DOM 适配器         ChatGPT runtime 适配器
  独立 Chrome profile      复用已有 patched runtime :1456
  手动登录的网页           已有浏览器认证与模型证据验证
```

旧版 `server.mjs` / `manage.mjs` / `run.ps1` 保留，避免破坏原 DSH 路线。
新通用入口是 `web-bridge.mjs`。不是给每个 Agent 写一个专用脚本：客户端只需实现受支持的 OpenAI 风格 HTTP 协议。
“支持更多网页”意味着增加适配器，**不是填一个网页地址就自动适配**。

## 安装与配置

依赖 Node.js >=22.15、已安装 Chrome；Windows 管理脚本兼容 Windows PowerShell 5.1。
源码依赖锁定在 package-lock.json。Gemini 不需要重建 ChatGPT runtime：

```powershell
npm ci --ignore-scripts
node web-bridge.mjs init --config bridge.local.json
```

`init` 只在配置不存在时创建；不会覆盖已有 token，不会把 token 打印在终端。
所有相对路径以**配置文件所在目录**为基准。根目录 `bridge.local.json` 的默认数据目录为根目录 `.state/`。

编辑配置中的 `executablePath`、网页实际可见的 `label` 和本地 model ID。参考 `examples/bridge.gemini.json`。
本地 ID 是路由名称，不是从模型自我介绍推断出的真实型号。Gemini 会校验网页可见模式；这不等于官方内部模型 ID 证明。
ChatGPT 对已审查的严格路由使用 `model-routes.mjs` 校验最终消息模型证据；保留的 legacy 路由在目录中标注为未实时验证，不作相同型号保证。

```powershell
node web-bridge.mjs serve --config C:/path/bridge.local.json
node web-bridge.mjs doctor --config C:/path/bridge.local.json
```

`serve` 先监听本机服务，浏览器按需启动；断网、未登录不会阻塞 HTTP 服务启动。
`doctor` 区分本地 HTTP 存活和网页 readiness，尚未请求过时可以是 idle，不冒充已登录/可生成。
首次登录、验证码和账号确认须由人处理；本项目不代填凭据或绕过网页验证。若专用 Chrome 留在空白页，请在这个专用窗口手动进入 Gemini 官网并完成登录，不要把日常浏览器的 Cookie 复制到配置文件。

## Windows 一键启动

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/universal-windows.ps1 `
  -Action Install -ConfigPath C:/path/bridge.local.json -TaskName chatweb-bridge `
  -DesktopShortcutName "启动Gemini网页桥"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/universal-windows.ps1 `
  -Action Start -ConfigPath C:/path/bridge.local.json -TaskName chatweb-bridge
```

安装器使用当前用户的有限权限任务与真正的 `.lnk` 快捷方式，不使用容易乱码/误报的 VBS。
快捷方式只启动托管任务，关闭启动程序不会把服务带走；重复启动不创建第二个实例。
管理动作还包括 `Status`、`Stop`、`Uninstall`。只操作校验为本配置所有的任务/进程，不按 `node.exe` 或宽泛脚本名批量杀进程。
日志与所有权记录存入配置的 stateDir。停止优先使用带认证的 `/admin/shutdown`。
卸载仅移除该托管入口，不删除登录资料和用户配置。

## 客户端接入

### Hermes

保留原本的 provider 配置即可把同一个地址升级到通用桥：

```yaml
providers:
  google-web:
    name: Gemini Web
    api: http://127.0.0.1:1458/v1
    key_env: GOOGLE_WEB_TOKEN
    discover_models: false
    models: [gemini-4-argon]
model:
  aliases:
    gemini-web: google-web/gemini-4-argon
```

密钥在对应 profile 的密钥环境中配置，不放进公开配置或 Git。现有本机迁移可继续引用旧的 auth.json，因此不必更换客户端密钥。

### DSH

`examples/dsh-universal.patch.yml` 是新增 provider 的 overlay，不改默认模型。
把 baseURL 和 apiKeyEnv 指向同一服务。建议禁用自动请求重放，网页提交不是幂等动作。

### 通用客户端

- base URL: `http://127.0.0.1:1458/v1`
- API key: 本机 authFile 内的 token（客户端读取，不写进日志/命令行/仓库）。
- model: `/v1/models` 返回的已配置 ID。
- 请求: `/v1/chat/completions`，或支持子集的 `/v1/responses`。

## 能力与明确限制

| 能力 | 说明 |
|---|---|
| 文本、多轮、系统/开发者消息 | 完整转写为带角色的会话，不再只拼接 user |
| Agent 工具调用 | 模型须遵守一次性 nonce 格式；验证名称与 schema 后才返回 tool_calls；执行者仍是 Agent |
| SSE | 先建立流并发心跳，完整生成/工具校验后发送结果；**不是原生 token-by-token 流** |
| 图像 | ChatGPT 复用已有上传管线；Gemini 明确拒绝，不静默丢弃 |
| Responses | 无状态文本、函数/自定义工具子集；不支持 previous_response_id、托管工具或服务端会话续接 |
| 采样/输出预算 | 网页没有稳定的 temperature/top_p/max_tokens 控制；这些客户端提示不等同原生 API 保障 |
| token 用量 | 不假造官方 usage；Responses 返回 null |
| 并发 | 同一个浏览器串行；不同适配器可独立运行；队列满/超时明确失败 |
| 自动恢复 | 浏览器断开后可重建；请求超时关闭请求页；不合作的适配器隔离并由服务重启处理 |
| 自动重试 | 不重放已提交或可能提交的生成；不确定失败后的相同请求短期抑制，避免 SDK 自动重复提交 |

网站 DOM、网络、登录失效、模式可用性和账号额度仍是外部依赖。这里的工程保证是：**故障可见、有界、隔离、不伪报成功**，不是永不掉线或无限额度。
不要公开监听地址、调试端口、认证文件或 Chrome profile；不提供绕过风控、登录或付费访问的功能。

## 新增网页适配器

支持 `type: "module"` 加载本地可信 ES module（路径只来自本机配置，不接受 HTTP 请求指定代码）。
模块导出 `createAdapter(options)`，返回：

- `id` 与 `models: [{id, ...}]`：唯一 provider/model；
- `capabilities.images`：未实现就 false；
- `generate(preparedRequest, {signal, requestId, deadlineMs})`：只返回 `{text, model}`；必须包含 preparedRequest 的 system 和 user 两段；
- `status()`：真实观察状态，不以 process alive 代替账号可用；
- `close()`：关闭自己创建的资源。

必须响应取消、在 deadline 内退出，并等待网页操作停止后才解除互斥。错误抛 `BridgeError`，注明 `generation_submitted: false | true | "unknown"`。
网页文本没有证明完成时，不得把半截回答作为成功返回。不能把报错塞进 assistant 文本并附 finish_reason=stop。

## 验证

全量旧路线回归还需要安装并重建 ChatGPT runtime；Windows 上旧安装器测试需要 PowerShell 7（`pwsh.exe`）。这些不是仅运行 Gemini 服务的前置条件。

```powershell
# 新公共层测试（不需要 ChatGPT 账号或 raw runtime）
npm run test:universal
# 需要全量旧路线回归时，按 INSTALL.zh-CN.md 重建 runtime 后再运行
npm test
node --test test/universal-*.test.mjs
# 隔离 Chrome + 本地 HTML fixtures；不是访问真实模型
$env:GEMINI_FIXTURE_TESTS='1'
node --test test/universal-gemini.test.mjs
```

测试报告必须区分：离线协议测试、真实 Chrome 的本地 fixture、真实网页生成、真实 Agent 调用。
仅 `/health` 成功、fixture 全绿或模型自称“我是某型号”均不算端到端验收。
真实网页验收及未覆盖范围记录在 `docs/engineering-acceptance.md`，不把尚未执行的测试写成通过。
