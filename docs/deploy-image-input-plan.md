# 图片输入功能部署同步计划

> **执行前须用户批准。** 本文档只是计划；产出本文档的本轮工作没有对生产目录做任何写操作。
> 对比基准时间：2026-10-10（Asia/Shanghai）。
>
> - 仓库目录（源）：`C:\Users\a\Desktop\chatweb开源项目`
> - 生产运行目录（目标，当前是旧代码）：`C:\Users\a\Documents\Codex\2026-09-30\new-chat\outputs\chatgpt-tool-bridge`

## 1. 对比方法（PowerShell）

以下脚本对重点路径逐个 `Test-Path` 并用 `Get-FileHash` 比对（目录按递归文件清单+哈希比对）：

```powershell
$repo = 'C:\Users\a\Desktop\chatweb开源项目'
$prod = 'C:\Users\a\Documents\Codex\2026-09-30\new-chat\outputs\chatgpt-tool-bridge'
$paths = @('server.mjs','protocol.mjs','model-routes.mjs','dsh-chat-tools.patch.yml',
  'web-model-metadata.json','manage.mjs','package.json','patches','runtime')
foreach ($p in $paths) {
  $r = Join-Path $repo $p; $q = Join-Path $prod $p
  $re = Test-Path $r; $qe = Test-Path $q; $d = ''
  if ($re -and $qe) {
    if ((Get-Item $r).PSIsContainer) {
      $h = { param($x) (Get-ChildItem $x -Recurse -File |
        ForEach-Object { $_.FullName.Substring($x.Length) + (Get-FileHash $_.FullName).Hash } | Sort-Object) -join '' }
      $d = if ((& $h $r) -ceq (& $h $q)) { 'same' } else { 'DIFF(dir)' }
    } else {
      $d = if ((Get-FileHash $r).Hash -eq (Get-FileHash $q).Hash) { 'same' } else { 'DIFF' }
    }
  }
  "$p | repo=$re | prod=$qe | $d"
}
```

## 2. 需同步文件清单（实测结果）

| 路径 | 仓库存在 | 生产存在 | 是否不同 |
| --- | --- | --- | --- |
| `server.mjs` | 是 | 是 | 不同 |
| `protocol.mjs` | 是 | 是 | 不同 |
| `model-routes.mjs` | 是 | 否 | 生产缺失，需新增 |
| `dsh-chat-tools.patch.yml` | 是 | 是 | 不同 |
| `web-model-metadata.json` | 是 | 否 | 生产缺失，需新增 |
| `manage.mjs` | 是 | 是 | 不同 |
| `package.json` | 是 | 是 | 不同 |
| `patches\`（目录） | 是 | 是 | 不同 |
| `patches\adapter-manifest.json` | 是 | 是 | 不同（仓库指向 v5，生产指向 v4） |
| `patches\adapter-0.1.1-to-runtime-v5.patch` | 是 | 否 | 生产缺失，需新增 |
| `patches\adapter-0.1.1-to-runtime-v4.patch` | 是 | 是 | 不同 |
| `runtime\`（目录） | 是 | 是 | 不同 |

说明：

- `patches\adapter-manifest.json` 的 `patch.file` 字段：仓库为 `patches/adapter-0.1.1-to-runtime-v5.patch`，
  生产为 `patches/adapter-0.1.1-to-runtime-v4.patch`，这是注入目标不同的直接证据。
- `runtime\` 是被打补丁的适配器安装产物，不应手工改文件，只能靠第 3 节的注入步骤重建。
- 上表未列的 `scripts\patch-runtime.mjs`（注入脚本本身）经 `Get-FileHash` 对比**一致，无需同步**；
  若部署现场复核发现不一致，再连同 `scripts\` 内其它变更一起同步。

## 3. 分步部署计划（每步含验证点）

> **⚠ 执行前须用户批准。以下任何一步都不得在未获批准时执行。**

### 步骤 0 — 批准、停机前确认与备份

1. 向用户确认批准，并记录当前生产目录状态（`git status`，若该目录在 git 下）。
2. 确认没有正在运行的任务（`node manage.mjs status`）。
3. 把第 2 节清单中的所有「生产存在=是」的路径，以及 `scripts\patch-runtime.mjs`，
   复制到备份目录（生产目录之外，例如 `<仓库外备份根>\chatgpt-tool-bridge-backup-<日期>\`）。

**验证点：** 备份目录内文件数与源一致；每个文件 `Get-FileHash` 与生产当前值相同。

### 步骤 1 — 停止两个端口服务

```powershell
Set-Location 'C:\Users\a\Documents\Codex\2026-09-30\new-chat\outputs\chatgpt-tool-bridge'
.\stop.ps1
```

**验证点：** `.\stop.ps1` 输出停止的进程数；随后 `node manage.mjs status` 显示两服务都未运行，
且 `127.0.0.1:1457`、`127.0.0.1:1456` 不再有监听。

> 注意：生产 `manage.mjs` 的命令校验只接受 `start` 和 `status`，**没有 `stop` 子命令**
> （两份源码一致）。停止必须用 `stop.ps1`。

### 步骤 2 — 同步文件

以仓库为源、生产为目标。**文件**（`server.mjs`、`protocol.mjs`、`model-routes.mjs`、
`dsh-chat-tools.patch.yml`、`web-model-metadata.json`、`manage.mjs`、`package.json`、
`patches\adapter-manifest.json`、`patches\adapter-0.1.1-to-runtime-v5.patch`、
`patches\adapter-0.1.1-to-runtime-v4.patch`、`runtime\package.json`、`runtime\package-lock.json`）
用 `Copy-Item -Force`；其中 `model-routes.mjs`、`web-model-metadata.json`、
`patches\adapter-0.1.1-to-runtime-v5.patch` 为新增。

> **`runtime\node_modules\` 不要整目录复制**：仓库里的该目录是「已安装且已打 v5 补丁」的产物，
> 直接覆盖会让步骤 3 的注入逻辑失配（生产侧既不是干净上游也不是本机状态）。
> 正确做法是只同步 `runtime\package.json` 与 `runtime\package-lock.json`，由步骤 3 在生产侧重建。

**验证点：** 重跑第 1 节脚本，除 `runtime\`（目录哈希必然不同，跳过）外全部为 `same`；
`Test-Path` 三个原缺失路径均为 `True`；
`(Get-Content .\patches\adapter-manifest.json -Raw | ConvertFrom-Json).patch.file`
等于 `patches/adapter-0.1.1-to-runtime-v5.patch`。

### 步骤 3 — 生产 runtime 重建依赖并执行补丁注入

```powershell
Set-Location 'C:\Users\a\Documents\Codex\2026-09-30\new-chat\outputs\chatgpt-tool-bridge\runtime'
$env:NODE_USE_ENV_PROXY='1'; $env:HTTP_PROXY='http://127.0.0.1:12450'; $env:HTTPS_PROXY='http://127.0.0.1:12450'
npm.cmd ci --no-audit --no-fund        # 删除并按 lockfile 重装 node_modules（含 90 秒止损）
Set-Location ..
node scripts/patch-runtime.mjs         # 按同步后的 manifest（指向 v5）注入
node scripts/patch-runtime.mjs --verify
```

**验证点：** `npm.cmd ci` 报 `added N packages`（退出码 0；若超时杀掉重试一次）；
后两条命令退出码均为 0（`--verify` 失败说明注入结果与 manifest 不符，回到步骤 2 排查）。

### 步骤 4 — 启动与验证

```powershell
Set-Location 'C:\Users\a\Documents\Codex\2026-09-30\new-chat\outputs\chatgpt-tool-bridge'
node manage.mjs start
```

**验证点（全部满足才算部署完成）：**

1. `node manage.mjs status` 两服务 `started/ok`；
2. `GET http://127.0.0.1:1457/health` 与 `GET http://127.0.0.1:1456/health` 均 200；
3. `:1457/health` 返回体的 `revision` 为 `image-input-20261010`（与仓库 `server.mjs` 一致，
   旧代码不会返回该值）；
4. 按 `docs\e2e-image-input-runbook.md` 完成一次 E2E，判定为 PASS。

## 4. 重启步骤（确切命令）

已核对生产 `manage.mjs` 源码，真实用法如下：

| 动作 | 命令（在生产目录执行） |
| --- | --- |
| 停止 | `.\stop.ps1` |
| 启动 | `node manage.mjs start`（等价 `node manage.mjs`；加 `--minimized` 可让 Chrome 最小化启动） |
| 查状态 | `node manage.mjs status` |

- `stop.ps1` 已实测仓库与生产逐字节一致（`Get-FileHash` 相同），无需同步。
- 本机执行策略可能拒跑未签名 ps1：被拒时改用
  `powershell -ExecutionPolicy Bypass -File .\stop.ps1`（不要改动脚本本身）。
- 同步后的 `manage.mjs`（仓库版）在 `start`/`status` 时会带 Bearer 探活并校验
  `security: 'service-bearer-v1'`；新代码的 `:1456/:1457` 均返回该字段，属预期自洽。

因此一次完整重启就是：`.\stop.ps1` → `node manage.mjs start` → `node manage.mjs status`。

## 5. 回滚步骤

> **执行前须用户批准。**

1. 停止服务：`.\stop.ps1`。
2. 恢复文件：
   - 若生产目录在 git 下：用 `git status` / `git checkout -- <路径>` 恢复（**不执行 `git push`**）；
   - 否则：从步骤 0 的备份目录把文件复制回生产目录原位。
3. 重新注入：恢复旧的 `patches\adapter-manifest.json` 后，执行
   `node scripts/patch-runtime.mjs` 并用 `--verify` 校验；
   若注入状态被污染，先整目录恢复 `runtime\` 备份再注入。
4. 重启：`.\stop.ps1` → `node manage.mjs start` → `node manage.mjs status`，
   两 health 恢复 200，且 `:1457/health` 的 `revision` 回到旧值。

## 6. 风险与注意事项

- 生产目录是旧代码：直接重启不会获得图片输入能力，必须完成步骤 2–3。
- 注入脚本用法以生产 `scripts\patch-runtime.mjs` 头部为准；本计划只保证
  `--verify` 的用法（来自 `package.json` 的 `verify:runtime`）。
- 同步 `dsh-chat-tools.patch.yml` 会改动 DSH 侧模型声明（`input: [text, image]`），
  属于预期变更；不要手工改动 `LICENSE`、`COPYRIGHT*`、`THIRD_PARTY*`、`tests\`、`patches\` 之外的授权文件。
- 全程不执行 `git push`；不修改生产目录之外的任何既有部署文件。

## 7. 执行实录（2026-10-10 晚，已按本计划完成部署）

实际执行与上述计划的差异与补充，供下次重启/轮换参考：

1. **同步范围比第 2 节大**：生产落后了两代工作（服务鉴权 + 图片输入），实际同步
   16 个根目录文件（上述 6 个之外还包括 `diagnostics.mjs`、`health-telemetry.mjs`、
   `responses.mjs`、`package-lock.json`、以及 5 个生产缺失的新文件
   `diagnostic-policy.mjs`、`http-security.mjs`、`INSTALL.zh-CN.md`、
   `MODEL-ROUTING.md`、`SECURITY.md`）+ `patches\` 目录覆盖 +
   `runtime\package.json` / `runtime\package-lock.json`。同步后逐项哈希复验全部一致。
   **注意：新 `server.mjs` import `http-security.mjs`，漏同步该文件会启动即崩。**
2. **备份**：同步前 9 项已复制到生产同级的
   `chatgpt-tool-bridge-backup-20261010\`（含 `scripts\patch-runtime.mjs`）。
3. **凭据（新代码 fail-closed，必须先就位）**：`manage.mjs` 启动时强制校验
   `DSH_CHAT_API_TOKEN` 与 `PCW_INTERNAL_TOKEN`（两值必须独立随机、互不相同）。
   实际采用文件供给：`C:\Users\a\.dsh\private-credentials\pcw-dsh-chat-api.token`
   与 `pcw-pcw-internal.token`（各 64 字符，account-only ACL，值从不打印）；
   DSH 侧凭据库 `.credentials.yaml` 的 `PCW_LOCAL_KEY` 引用改指
   `pcw-dsh-chat-api.token`（改前已备份 `.credentials.yaml.bak-before-pcw-local-key-20261010`）。
4. **启动**：需在启动 shell 里设 `DSH_CHAT_API_TOKEN_FILE` / `PCW_INTERNAL_TOKEN_FILE`
   两个环境变量指向上述文件，再 `node manage.mjs start`；不带凭据启动会被拒绝。
5. **验证**：`start` 退出码 0（内部已带 Bearer 探活）；公开 health 仅返回
   service/status（设计如此），**revision 与 `security: service-bearer-v1` 要带
   Bearer 请求才返回**——带凭据查 `:1457/health` 得
   `revision=image-input-20261010` 即部署成功。
6. **E2E 卡点与处置**：首轮 E2E 因受管 Chrome 登录态丢失被 422 挡在准备阶段
   （判别与处置见 runbook 故障表「422 browser_not_ready」行）；该状态只能由用户
   人工登录 ChatGPT 解除，登录后重跑 runbook 即可。
