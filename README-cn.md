# Jev Skill Router for Codex

[English](README.md) | **简体中文**

## 运行要求

- 支持插件 hooks、`UserPromptSubmit` 和 app-server `skills/list` 的 Codex CLI；开发基于 **0.154.0**。
- Codex 进程能够找到 **Node.js 22+**。
- 具有 Jev 访问权限的 TypeSafe API Key。

仓库已包含打包后的 hook。安装使用时**不需要** `npm install`、Python、MCP 服务或独立后台服务。

## 安装

```sh
codex plugin marketplace add https://github.com/droid-Q/jev-skill-router.git
codex plugin add jev-skill-router@jev-skill-router
```

按下文配置密钥。在 Codex CLI 中打开 `/hooks`，审查并信任该插件的 `UserPromptSubmit` 命令。安装插件不会自动信任其 hooks。安装后新建 Codex 任务；桌面端与 CLI 需要使用同一份本机 Codex 配置。

## 配置

在启动 Codex 的环境中设置 `TYPESAFE_API_KEY`，或创建 `~/.config/jev-skill-router/config.json`：

```json
{
  "apiKey": "YOUR_TYPESAFE_API_KEY",
  "model": "jev-latest",
  "threshold": 0.8,
  "maxSkills": 3,
  "timeoutMs": 12000,
  "codexBin": "codex"
}
```

将配置文件放在仓库之外，并限制访问权限：

```sh
chmod 600 ~/.config/jev-skill-router/config.json
```

桌面端建议使用配置文件：从 Finder 启动的应用可能不会继承终端环境变量。如果通过环境变量提供密钥，可以不创建配置文件；但显式指定一个不存在的配置文件会报错。

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `apiKey` | 空 | 密钥；`TYPESAFE_API_KEY` 环境变量优先。 |
| `model` | `jev-latest` | Jev 模型别名或固定版本标识。 |
| `threshold` | `0.8` | 最低相关性概率，必须大于 `0.5` 且不大于 `1`。 |
| `maxSkills` | `3` | 最多选择的可选 skills 数量，范围 `1`～`20`。 |
| `timeoutMs` | `12000` | skill 发现和 API 调用共用的总超时，范围 `100`～`20000` 毫秒。 |
| `codexBin` | `codex` | 可执行程序名或绝对路径，不包含 shell 参数；`JEV_CODEX_BIN` 优先。 |

通过 `JEV_SKILL_ROUTER_CONFIG` 指定其他配置文件，或设置 `JEV_SKILL_ROUTER_DISABLED=1` 停用选择功能。插件不会自行写入配置或保存用户消息。

## 工作方式

- 根据 hook 的工作目录查询 Codex 实际加载的 skill 目录，包含启用的插件，不扫描插件缓存中的历史版本。
- 排除禁用、文件缺失、配置无效及禁止隐式调用的 skills（`agents/openai.yaml` 中 `policy.allow_implicit_invocation: false`），并通过真实文件路径去除符号链接别名。
- 为每个候选项提交独立的 [Noul 问题](https://docs.typesafe.ai/primitives/noul)。Noul 表示相关性概率，**不是**额外的 confidence 分数；可选择多个 skills，也不受 Choice 单题最多 255 个选项的限制。
- 将全部候选项分批发送，最多同时请求三批。使用保守的 UTF-8 字节限制控制 Jev 上下文大小，不预先按关键词截取前几个候选项。
- 从达到阈值的候选项中按概率选取；全部未达到阈值时，不增加可选 skills。
- 保留用户明确指定的 skills、更高优先级的要求，以及当前任务已经需要的 skills。选择结果不会扩大工具执行或其他操作权限。
- 缺少密钥、接口错误、限流、超时、输入过大或响应无效时，保留 Codex 原有选择流程并显示简短状态信息。任意批次失败都不会注入不完整的选择结果；hook 内不自动重试。

只评估最新提交的消息，不读取此前的对话记录。过短的跟进消息可能缺少足够的推荐上下文。独立的目录查询进程使用已保存的 Codex 配置，不会继承仅当前任务持有的额外 skill 根目录或尚未保存的配置覆盖。

## 发送给 TypeSafe 的数据

当前消息及候选 skill 的名称、描述会发送到 `https://api.typesafe.ai/v1/systemone`。插件不读取完整 skill 正文或历史对话，目录中的路径字段保留在本机。消息或描述中原本包含的敏感文字仍会发送，因此应在适合由你的 TypeSafe 账户处理的任务中启用。

密钥只通过 API 认证请求头发送，拒绝 HTTP 重定向。错误输出不包含密钥、用户消息、服务端响应正文或 app-server 日志。

## 本地开发与验证

```sh
git clone git@github.com:droid-Q/jev-skill-router.git
cd jev-skill-router
npm ci
npm run build
npm test
npm run skills
```

`npm run skills` 列出可选候选项及密钥是否配置，**不会请求 Jev**。源码使用 Node.js 原生网络及进程接口，并用 `yaml` 正确解析 skill 策略。`esbuild` 生成已经纳入版本管理的独立脚本；修改源码后需重新打包并一并提交。

配置密钥后，在仓库根目录执行以下命令，可以验证真实 Jev 调用：

```sh
node -e 'process.stdout.write(JSON.stringify({hook_event_name:"UserPromptSubmit",cwd:process.cwd(),prompt:"Review the JavaScript code and its tests."}))' \
  | node plugins/jev-skill-router/scripts/router.mjs
```

这会将示例消息和本机符合条件的 skill 元数据发送给 TypeSafe。成功时返回 `hookSpecificOutput.additionalContext`，降级时返回 `systemMessage`。hook 降级时仍以成功状态退出，让原任务继续进行。

自检使用合成 Jev 响应，覆盖 app-server 协议、策略过滤、链接去重、打包后 CLI、请求结构、多 skill 选择、分批、无效响应、超时和安全降级。它**不代表** Jev 选择准确率评测或真实 API 访问验证。

## 参考资料

- [Codex hooks](https://developers.openai.com/codex/hooks)
- [插件打包与 hook 发现](https://developers.openai.com/plugins/build/plugins)
- [TypeSafe HTTP API](https://docs.typesafe.ai/api)
- [Jev 模型限制](https://docs.typesafe.ai/models)
