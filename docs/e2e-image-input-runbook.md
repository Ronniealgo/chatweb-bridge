# 图片输入 E2E 操作手册

> 目标：把一张含指定中文的 PNG 通过 `http://127.0.0.1:1457/v1/chat/completions` 发给受管网页，
> 验证回复包含该文字。
> 前置条件：`127.0.0.1:1457`（桥）与 `127.0.0.1:1456`（适配器）均已启动，
> 环境变量 `$env:DSH_BRIDGE_TOKEN` 已设置为本地凭据（本文不写任何真实 token）。

## 0. 健康检查

```powershell
(Invoke-WebRequest -Uri 'http://127.0.0.1:1457/health' -UseBasicParsing).StatusCode
(Invoke-WebRequest -Uri 'http://127.0.0.1:1456/health' -UseBasicParsing).StatusCode
```

期望：两行都是 `200`。任一不是 200，先按第 4 节排查，不要继续。

## 1. 生成测试图片（PowerShell + System.Drawing）

完整脚本，保存到 `%TEMP%\pcw-e2e-image.png`：

```powershell
Add-Type -AssemblyName System.Drawing
$out = Join-Path $env:TEMP 'pcw-e2e-image.png'
$bmp = New-Object System.Drawing.Bitmap 900, 240
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$font = New-Object System.Drawing.Font('Microsoft YaHei', 34, [System.Drawing.FontStyle]::Bold)
$g.DrawString('图里第一行字是：晴空一鹤排云上', $font, [System.Drawing.Brushes]::Black, 24, 40)
$g.DrawString('第二行只是陪衬：另一句无关文字', $font, [System.Drawing.Brushes]::Black, 24, 140)
$g.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Test-Path $out   # 期望 True
```

> 本机只有 Windows PowerShell 5.1（实测 `pwsh.exe` 不在 PATH，勿照抄"用 pwsh 运行"的说法）：
> 把本节脚本存成**带 BOM 的 UTF-8** `.ps1` 文件后再用 `powershell -ExecutionPolicy Bypass -File` 运行；
> 若只复制命令交互执行，中文字符串需先 `[Console]::OutputEncoding=[Text.Encoding]::UTF8`。

## 2. 发送请求（Node）

把下面内容保存为 `%TEMP%\pcw-e2e-post.js`，然后运行 `node "$env:TEMP\pcw-e2e-post.js"`：

```js
const fs = require('fs');
const os = require('os');
const path = require('path');

const png = path.join(os.tmpdir(), 'pcw-e2e-image.png');
const dataUrl = 'data:image/png;base64,' + fs.readFileSync(png).toString('base64');
const body = {
  model: 'gpt-5-6-thinking',
  messages: [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: dataUrl } },
      { type: 'text', text: '图里第一行字是什么' }
    ]
  }]
};

fetch('http://127.0.0.1:1457/v1/chat/completions', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: 'Bearer ' + (process.env.DSH_BRIDGE_TOKEN || '')
  },
  body: JSON.stringify(body)
}).then(async (res) => {
  const text = await res.text();
  console.log('HTTP', res.status);
  console.log(text);
  const pass = text.includes('晴空一鹤排云上');
  console.log(pass ? 'E2E PASS' : 'E2E FAIL');
  process.exit(pass ? 0 : 1);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
```

发送前确认凭据已注入（PowerShell）：

```powershell
$env:DSH_BRIDGE_TOKEN   # 打印占位/本机凭据；本手册不提供任何真实 token
node "$env:TEMP\pcw-e2e-post.js"
```

## 3. 判定标准

- **通过（PASS）**：HTTP `200`，且回复文本中包含 `晴空一鹤排云上`（脚本输出 `E2E PASS`，退出码 0）。
- **不通过（FAIL）**：HTTP 非 200，或 200 但回复不含 `晴空一鹤排云上`（脚本输出 `E2E FAIL`，退出码 1）。
- 转写文本里应出现 `[图片 #1]` 标记；没有标记说明图片未被桥解析。
- 每次判定都要同时满足第 0 节两个 health 为 200，否则结果无效。

## 4. 失败排查表

| 现象 | 常见原因 | 处理 |
| --- | --- | --- |
| `413`（Request too large） | 请求体超过 32 MiB（图片或转写过大） | 减少图片数量/尺寸后重试 |
| `400 invalid_request`（图片校验） | 用了 http/https 图片 URL、非 `data:image/(png\|jpeg\|webp\|gif);base64,` 前缀、单张 >20 MiB、单请求 >8 张（去重后）、数据为空 | 只发 base64 data-URL，且在 8 张 / 20 MiB / 32 MiB 限额内 |
| 上游 `422` | 适配器在 chatgpt.com 页面上传失败（登录态/页面流程变化），或相同请求近期失败被本地抑制（`recent_failed_request`，响应带 `retry_after_ms`） | 查 `:1456` 侧日志与网页登录态；按 `retry_after_ms` 等待，或改动一点内容后重发 |
| `422 browser_not_ready`（phase=prepare，连发都同样失败） | **重启受管 Chrome 后 ChatGPT 登录态丢失**：页面停在未登录落地页（2026-10-10 实测） | 无法由桥自动恢复，也禁止脚本代替登录：请人工在受管 Chrome 窗口（当前只开着 chatgpt.com 首页）登录 ChatGPT 账号；先跑 `node scripts\probe-managed-page.mjs` 判定（退出码 0=可交互、2=未登录/未就绪，输出各入口布尔值），确认 0 后再重发 |
| Chrome 未就绪（health 不通、启动超时） | `:1456` 未启动、仍在启动中、受管 Chrome 异常退出 | `node manage.mjs status` 查状态；看生产目录 `.runtime\startup.jsonl` 与 `.runtime\1456.log`；重启 `.\stop.ps1` → `node manage.mjs start` |
| `401` 未授权 | `$env:DSH_BRIDGE_TOKEN` 未设置或与服务端不一致 | 在当前会话设置正确凭据后重试 |
| `200` 但回复不含目标文字 | 网页未回读/模型改写/图片不可读 | 确认第 1 脚本生成的 PNG 能看到目标文字；重跑一次，仍失败则按上游 422 排查 |
