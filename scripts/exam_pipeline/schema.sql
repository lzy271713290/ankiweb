PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS source_documents (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL,
  page_count INTEGER NOT NULL,
  stored_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'registered',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exam_papers (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  year INTEGER NOT NULL,
  period TEXT NOT NULL,
  pdf_page_from INTEGER NOT NULL,
  pdf_page_to INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'registered',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exam_pages (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES exam_papers(id) ON DELETE CASCADE,
  pdf_page INTEGER NOT NULL,
  printed_page INTEGER,
  page_kind TEXT NOT NULL DEFAULT 'unknown',
  source_image_path TEXT,
  processed_image_path TEXT,
  ocr_text TEXT,
  ocr_json TEXT,
  ocr_mean_confidence REAL,
  ocr_status TEXT NOT NULL DEFAULT 'pending',
  review_status TEXT NOT NULL DEFAULT 'pending',
  updated_at TEXT NOT NULL,
  UNIQUE(paper_id, pdf_page)
);

CREATE TABLE IF NOT EXISTS page_masks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  pdf_page_from INTEGER NOT NULL,
  pdf_page_to INTEGER NOT NULL,
  x1 REAL NOT NULL,
  y1 REAL NOT NULL,
  x2 REAL NOT NULL,
  y2 REAL NOT NULL,
  label TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'preset',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exam_questions (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES exam_papers(id) ON DELETE CASCADE,
  question_type TEXT NOT NULL,
  section TEXT,
  question_no TEXT NOT NULL,
  stem TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '{}',
  answer TEXT,
  explanation TEXT,
  source_page_from INTEGER NOT NULL,
  source_page_to INTEGER NOT NULL,
  source_text TEXT NOT NULL,
  confidence REAL,
  review_status TEXT NOT NULL DEFAULT 'pending',
  updated_at TEXT NOT NULL
);

-- 人工审核修订与 OCR 原始结果分离保存，重新拆题时不会覆盖用户确认内容。
CREATE TABLE IF NOT EXISTS question_corrections (
  question_id TEXT PRIMARY KEY,
  stem TEXT,
  options_json TEXT,
  answer TEXT,
  explanation TEXT,
  review_status TEXT NOT NULL DEFAULT 'edited',
  note TEXT,
  updated_at TEXT NOT NULL
);

-- 保存题干图、选项图、解析图等题目级媒体及其原页裁剪坐标。
CREATE TABLE IF NOT EXISTS question_assets (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES exam_questions(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL,
  source_page INTEGER NOT NULL,
  x1 REAL NOT NULL,
  y1 REAL NOT NULL,
  x2 REAL NOT NULL,
  y2 REAL NOT NULL,
  file_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 审核页可保留裁剪图、改用来源整页或隐藏误判图片，不改写原始识别资产。
CREATE TABLE IF NOT EXISTS question_asset_overrides (
  asset_id TEXT PRIMARY KEY,
  display_mode TEXT NOT NULL DEFAULT 'crop',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (asset_id) REFERENCES question_assets(id) ON DELETE CASCADE
);

-- 保留 OCR 原始文字，同时给网页审核层保存移除图中重复 OCR 后的展示文字。
CREATE TABLE IF NOT EXISTS question_display_text (
  question_id TEXT PRIMARY KEY,
  stem TEXT NOT NULL,
  explanation TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (question_id) REFERENCES exam_questions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_exam_pages_paper_page
  ON exam_pages(paper_id, pdf_page);
CREATE INDEX IF NOT EXISTS idx_exam_questions_paper_no
  ON exam_questions(paper_id, question_type, question_no);
CREATE INDEX IF NOT EXISTS idx_question_assets_question
  ON question_assets(question_id, asset_type);
CREATE INDEX IF NOT EXISTS idx_page_masks_document_pages
  ON page_masks(document_id, pdf_page_from, pdf_page_to);
