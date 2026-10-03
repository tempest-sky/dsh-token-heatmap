<div align="center">

# dsh-token-heatmap

**DSH 的轻量 Token 用量热力图 —— 侧边栏底部一枚迷你方格条，点开是铺满中央列的全宽面板。**

纯 token 计数 · 只读本地会话日志 · 零网络外呼 · 零运行时依赖

[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/dsh--plugin-%E2%9C%85-green)](https://github.com/topics/dsh-plugin)
[![node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen)](package.json)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-desktop%20%7C%20web-4176E6)](https://github.com/deepseek-ai/deepseek-harness)
[![stars](https://img.shields.io/github/stars/tempest-sky/dsh-token-heatmap?color=f9c74f)](https://github.com/tempest-sky/dsh-token-heatmap/stargazers)

[功能](#功能) · [三档粒度](#三档粒度) · [安装](#安装) · [数据来源](#数据来源) · [配置](#配置) · [已知限制](#已知限制)

</div>

---

## 功能

| 位置 | 内容 |
|---|---|
| **全宽主面板** | 日 / 周 / 月三档粒度、6 项 KPI、Token / 调用次数双口径、模型用量 Top 5 |
| **侧边栏导航行** | 一个图标入口，点击切换到全宽主面板 |
| **侧边栏底部** | 迷你方格 + 今日用量，整块可点击打开主面板 |
| **设置页 → Token 热力图** | 同一套完整面板 |

六项 KPI：累计 Tokens、调用次数、活跃天数、当前连续、最长连续、峰值日。

**明确不做**：费用估算、余额查询、导出、网络请求。

---

## 三档粒度

| 档位 | 形态 | 说明 |
|---|---|---|
| **日** | 53 周 × 7 行网格 | 与 GitHub 贡献图一致 |
| **周** | 柱形图 | 柱高按当档峰值归一；时间轴至少覆盖 26 周 |
| **月** | 柱形图 | 按 `YYYY-MM` 折叠；时间轴至少覆盖 12 个月 |

周 / 月采用柱形图而非方格：会话历史可能只覆盖几天，而那几天往往落在同一周内，
方格图会只剩孤零零一格。柱形图配合最小时间跨度，让「只有一个数据点」
也能呈现出一条可读的时间轴。

柱形图为**双编码**：柱高表示绝对量级，颜色表示相对冷热（按分位数分档）。

侧边栏底部只有**一种形态**：迷你方格 + 今日用量，两者始终同时显示。
侧栏折叠为 56px 轨道时不会退化成单格，而是收窄到 5 周并居中。

---

## 安装

`dsh plugin` 是 pnpm 直通。下列方式任选其一，把 `<profile>` 换成你的 profile 名（如 `desktop`）。

### 从 GitHub 安装

```bash
dsh plugin --profile <profile> add github:tempest-sky/dsh-token-heatmap
```

本插件**不需要任何构建步骤**（`lib/` 内即为可加载产物），因此无需开启 `allowBuilds`。

### 本地目录（link）

```bash
dsh plugin --profile <profile> add "link:<本仓库绝对路径>"
```

### 从 npm 安装（若已发布）

```bash
dsh plugin --profile <profile> add dsh-token-heatmap
```

安装后重启 DSH 即可生效。查看插件是否成功挂载：

```bash
dsh --profile <profile> --dump-config
```

### 卸载

```bash
dsh plugin --profile <profile> remove dsh-token-heatmap
```

---

## 数据来源

```
%DSH_HOME%/sessions/<project-slug>/<session-id>/session.vN.jsonl[.zstd]
```

两个关键处理：

1. **多帧 zstd** —— 日志由多个 zstd 帧拼接而成。整文件一次性解压
   **只能得到第一条记录**，因此按帧 magic `28 B5 2F FD` 逐帧解压再拼接。
2. **`(turn, step)` 去重** —— 同一轮次会同时出现流式 chunk 与最终
   `assistant/message` 的 usage，按 `(turn, step)` last-wins 折叠，
   与宿主 token-meter 口径一致。

抽取的字段：

```json
{ "type": "assistant/message", "time": 1700000000000,
  "data": { "usage": { "inputTokens": 1200, "outputTokens": 300, "cacheReadTokens": 900 },
            "message": { "source": { "provider": "<provider>", "model": "<model>" } } } }
```

---

## HTTP API

同源只读：`GET /api/token-heatmap`

```jsonc
{
  "range": { "from": "2025-01-10", "to": "2025-01-12" },
  "days": { "2025-01-10": { "tokens": 2400, "calls": 12, "models": { "<provider>:<model>": 2400 } } },
  "totals": { "tokens": 7400, "calls": 38, "activeDays": 3 },
  "streaks": { "current": 3, "longest": 3 },
  "peak": { "date": "2025-01-11", "tokens": 3600 },
  "scan": { "sessions": 5, "unreadable": 0, "reused": 0, "partial": false }
}
```

> 上例为**示意值**，不是任何真实机器的用量。

端点只提供**按天**的原始数据；周 / 月档由客户端本地折叠，
因此切换粒度是纯前端计算，不会额外触发扫描。

**隐私**：响应只含日期、计数与模型名，不含提示词、消息正文、工具参数或工作区路径。

---

## 配置

无需配置。可选环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | 会话日志根目录的父目录 |
| `DSH_TOKEN_HEATMAP_TTL_MS` | `60000` | 聚合结果的内存缓存时长 |

---

## 实现说明

- **宿主半边**（`lib/index.js`）用 `ctx.inject(['webServer'], …)` 而非顶层 `inject`
  声明依赖：webServer 可能晚于插件激活，也可能不存在（headless profile）。
  缺失时插件保持激活并静默降级，而不是加载失败。
- **客户端半边**（`lib/client.js`）是自注册 bundle
  （`window.__ModuleLoader__.load({ id, factory })`，且 `id` 必须等于包名），
  只 require 平台种子词，无需额外声明依赖。
  它注册四个 slot：`main`（全宽主面板）、`sidebar.panellist`（导航行）、
  `settings.section`、`sidebar.footer.action`。
- **资源占用**：聚合走分片让出事件循环 + 按文件 `mtime + size` 的增量缓存。
  宿主与 UI 共用同一个事件循环，长时间同步扫描会让界面失去响应，
  因此解压走异步 zstd（交给线程池），解析按字节切片让出；
  未变动的历史日志二次扫描直接复用，不再重复解压。
- **色阶**：用非零日的**分位数**切分而非最大值线性切分 ——
  真实用量长尾极重，线性切分会让绝大多数日子挤在第 1 档、看不出差别。
- **主题**：颜色取宿主设计令牌 `--dsw-alias-*`，绿色沿用 GitHub 贡献图语义，
  深浅主题各一套。

---

## 已知限制

- **历史长度取决于本机日志**。日志被清理过的话，热力图初期会明显稀疏 ——
  这是数据现状而非插件缺陷；面板会如实展示覆盖区间。
- 只统计 `assistant/message` 的 usage；若某轮用量只存在于内嵌流中则不计入
  （与宿主 token-meter 口径一致）。
- 会话日志中的 `cacheWriteTokens` / `reasoningTokens` 可能不出现，缺失时按 0 处理。
- 日志可能存在单行极长的记录（正文 / 推理文本可达数 MB），其 JSON 解析无法切分，
  单次约数十毫秒。仅在日志有变动的冷扫描时出现一次；未变动时走增量缓存，
  二次扫描在毫秒级。

---

## License

[MIT](LICENSE)
