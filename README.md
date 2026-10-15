# ChatWeb — 网页模型与本地 Agent 之间的桥

把正常登录的模型网页接到 Hermes、DSH 和其他兼容 OpenAI 风格接口的客户端。
模型负责返回文本或工具请求；实际工具依然由本地 Agent 执行。

```text
Agent → 本机认证 API → 通用协议 / 独立队列 / 超时取消 → 网页适配器
                                                         ├─ Gemini
                                                         └─ ChatGPT（复用现有 runtime）
```

**新入口：[`web-bridge.mjs`](web-bridge.mjs)，完整文档：[通用桥使用与开发](docs/universal-bridge.md)。**
原有 ChatGPT → DSH 入口仍保留，不要求现有用户直接覆盖原运行环境。

## 这次不再是几个启动脚本拼起来

- 公共 API 支持 Chat Completions 和 Responses 的明确子集，保留全部会话角色和工具结果。
- 工具请求经一次性 nonce 和 JSON Schema 校验，不执行模型返回的任意代码。
- 每个适配器独立有界 FIFO；取消和超时不释放仍在操作浏览器的任务。
- SSE 保持连接，错误走错误事件，绝不伪装成成功回答。
- `/health` 仅表示服务存活；`/ready` 单独报告网页状态。
- Windows 提供隐藏托管、单实例、防误关的桌面快捷方式和安全停止入口。
- 只监听本机；日志不记录令牌、原始提示词、响应正文或浏览器账号资料。

## 从这里开始

```powershell
npm ci --ignore-scripts
node web-bridge.mjs init --config bridge.local.json
# 按文档填写 Chrome 路径和网页真实模式标签
node web-bridge.mjs serve --config bridge.local.json
```

首次网页登录须由本人完成。示例配置见 [`examples/`](examples/)；Windows 桌面启动方式、Hermes / DSH 配置、适配器接口见[完整指南](docs/universal-bridge.md)。
ChatGPT 仍依赖重建后的本地适配器 runtime；原安装步骤见[旧路线文档](docs/legacy-chatgpt-readme.md)和 [INSTALL.zh-CN.md](INSTALL.zh-CN.md)。

## 能力边界

这是**非官方网页自动化桥**，不是官方 API 或可承诺 SLA 的服务。
网页改版、网络故障、登录过期、账号额度仍会导致失败；工程目标是故障可诊断、有界且不串请求，而非永不掉线。

- Gemini：文本与经过校验的工具协议；图像暂不支持，明确报错。
- ChatGPT：复用既有文本、工具和图片管线，以及已审查的模型路由规则。
- SSE 是完整结果校验后的缓冲式发送，不冒充原生逐 token 流。
- 更多网页需要实现适配器；更多 Agent 必须兼容文档列出的 API 子集。
- 不绕登录、验证码、风控或额度；不自动切换到付费 API；不要开放到公网。

## 验证与发布

`npm run test:universal` 覆盖新协议、队列、配置和生命周期。`npm test` 的全量旧路线回归还需要按安装文档重建 ChatGPT runtime；Windows 旧安装器测试另需 PowerShell 7。
真实网页、真实 Agent、进程恢复的验收与未覆盖范围见 [engineering-acceptance.md](docs/engineering-acceptance.md)。
fixture 测试通过不代表真实网页已通过；健康检查也不等于模型调用成功。

原创部分 MIT，署名 **うんけん**。第三方代码与依赖保留原许可，见 [LICENSE-SCOPE.md](LICENSE-SCOPE.md)、[THIRD_PARTY.md](THIRD_PARTY.md)。
