# 扫描版真题导入试验

这套脚本用于验证扫描 PDF 的离线处理链路。原始 PDF 和页面图片保存到文件目录，题目、OCR、遮罩及审核状态保存到 SQLite。RapidOCR 在本机运行，不调用 DeepSeek，不产生大模型 Token。

## 首次安装

```powershell
$env:UV_CACHE_DIR="$PWD\.cache\uv-exam"
uv python install 3.12
uv venv .venv-exam --python 3.12
uv pip install --python .venv-exam\Scripts\python.exe -r scripts\exam_pipeline\requirements.txt
```

`onnxruntime==1.28.0` 需要 Python 3.11—3.14；推荐固定使用 uv 管理的 Python 3.12，系统中只有 Python 3.10 时不要直接复用。

## 运行三套试卷

```powershell
.venv-exam\Scripts\python.exe scripts\exam_pipeline\import_exam_pdf.py `
  --source "C:\path\to\真题解析.pdf" `
  --copy-source
```

默认处理以下已人工核对的 PDF 物理页：

- 2017 年 11 月：232-256
- 2017 年 05 月：257-282
- 2016 年 11 月：283-305

可先通过 `--sample-pages 232,233,256,257,282,283,305` 只跑代表页。结果在 `data/exam-content.sqlite`，审核页在 `data/exam-assets/<文档ID>/review/index.html`。这些运行数据均已忽略，不会提交 Git。

审核页会展示结构化文字，并只对检测到的图表显示“题目原图”或“解析原图”；图片区域内的 OCR 文字会从对应文字版移除，避免重复，纯文字内容只保留 OCR 文本。OCR 原始结果保存在 `exam_questions`，人工修订保存在 `question_corrections`，重复执行 `--questions-only` 不会覆盖人工修订；题目图片及原页裁剪坐标记录在 `question_assets`。

OCR 仍作为本机离线任务运行；网页上传会先检测文字层，扫描件由用户确认后启动异步 OCR，完成后直接进入“OCR 预审核”，可修改题目字段、切换图片显示模式、确认整卷，并在确认后送入大模型拆卡。当前仍只支持下方固定的三套试卷页段；任意新 PDF 的卷别/页段配置尚未实现，后续再增加页面框选遮罩编辑器。

经原页确认、需要跨电脑保留的少量修订可写入 `corrections.json`；流水线会在重建题目和图片后应用修订种子，但不会覆盖 SQLite 中已经存在的网页人工修改。
