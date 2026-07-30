# AnkiCard AI 跨设备交接

> 本文件只记录项目状态、决策和待办。禁止写入 API Key、Webhook、密码或其他凭据。

## 项目目标

把教材、论文、笔记等学习材料转换为可编辑的记忆卡片，支持保存卡组、导出 Anki APKG，并通过飞书或企业微信推送学习内容。

## 技术栈

- Next.js 16（App Router）
- React 19
- TypeScript 5
- Tailwind CSS 4
- shadcn/ui
- pnpm

## 当前已经完成

- 参考 `cardflow-demo.html` 改造界面风格。
- 支持问答、填空、定义、双向、对比、步骤六种卡片。
- 支持生成后逐张编辑问题、答案和分类。
- “我的卡组”使用浏览器 LocalStorage 保存，支持重新载入和删除。
- 支持导出 `.apkg`，双向卡会生成正反两个 Anki 模板。
- 支持 DeepSeek V4 Flash、DeepSeek V4 Pro。
- 支持注册多个 OpenAI Chat Completions 兼容模型。
- 模型设置页支持服务端连通测试，密钥不会下发到浏览器。
- 支持飞书群机器人和企业微信群机器人即时推送。
- 已移除 Trae、Coze、扣子相关代码和引用。
- Windows 下可直接使用 `pnpm dev`，不再依赖 Bash。

## 当前本地配置状态

- DeepSeek 已完成连通测试。
- 飞书群机器人 Webhook 已被服务端识别。
- 企业微信群机器人尚未配置。

配置文件为 `.env.local`，该文件被 Git 忽略。跨电脑时需要分别创建，不能提交真实值。

需要使用的变量名：

```dotenv
DEEPSEEK_API_KEY=
FEISHU_WEBHOOK_URL=
WECOM_WEBHOOK_URL=
CUSTOM_LLM_PROVIDER_NAME=
CUSTOM_LLM_API_KEY=
CUSTOM_LLM_BASE_URL=
CUSTOM_LLM_MODELS=
ENABLE_DEMO_MODEL=false
```

## 已完成验证

- `pnpm validate`
- `pnpm build`
- DeepSeek V4 Flash 最小连通请求
- 示例材料生成六种卡片
- 单卡编辑、保存卡组、重新载入编辑
- APKG 文件包含 `collection.anki2` 和 `media`
- 飞书配置状态识别

## 当前限制

- “我的卡组”只保存在当前浏览器，暂不支持跨设备同步。
- 飞书和企业微信当前为群机器人即时推送。
- 暂不支持用户账号、按用户单聊、定时复习和学习记录。
- 真实密钥和 Webhook 仅存在各电脑自己的 `.env.local`。

## 建议下一阶段

1. 给项目增加用户登录和数据库。
2. 将本地卡组迁移为服务端卡组，实现跨设备同步。
3. 接入飞书应用机器人，实现按用户推送。
4. 增加定时任务和间隔重复学习计划。
5. 增加生成、编辑、推送和导出的自动化测试。

## 跨电脑工作流程

开始工作：

```powershell
git pull
pnpm install
pnpm dev
```

结束工作：

1. 更新本文件的“当前已经完成”“当前限制”和“建议下一阶段”。
2. 确认 `git status` 中没有 `.env.local` 或其他凭据文件。
3. 提交并推送：

```powershell
git add .
git commit -m "描述本次完成的内容"
git push
```

在另一台电脑开启新的 Codex 任务时，可以使用：

```text
请先阅读 AGENTS.md、README.md、HANDOFF.md 和最近的 git log，再继续这个项目。不要读取或提交 .env.local。
```
