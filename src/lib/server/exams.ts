import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Database, SqlJsStatic } from 'sql.js';
import type {
  ExamAssetDisplayMode,
  ExamPaperDetail,
  ExamPaperStatus,
  ExamPaperSummary,
  ExamQuestion,
  ExamQuestionAsset,
  ExamReviewStatus,
} from '@/lib/types';

interface SaveExamQuestionInput {
  stem: string;
  options: Record<string, string>;
  answer: string;
  explanation: string;
}

interface ExamAssetFile {
  path: string;
  mimeType: string;
}

const DATA_DIRECTORY = path.join(process.cwd(), 'data');
const EXAMS_FILE = path.join(DATA_DIRECTORY, 'exam-content.sqlite');
const SQL_WASM_FILE = path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
const EXAM_ASSETS_DIRECTORY = path.join(DATA_DIRECTORY, 'exam-assets');

let sqlPromise: Promise<SqlJsStatic> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

async function getSQL(): Promise<SqlJsStatic> {
  if (sqlPromise) return sqlPromise;
  sqlPromise = (async () => {
    const initModule = await import('sql.js');
    const initSqlJs = initModule.default || initModule;
    const wasm = await readFile(SQL_WASM_FILE);
    const wasmBinary = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer;
    return initSqlJs({ wasmBinary });
  })();
  return sqlPromise;
}

function createWebSchema(db: Database): void {
  db.run(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS question_asset_overrides (
      asset_id TEXT PRIMARY KEY,
      display_mode TEXT NOT NULL DEFAULT 'crop',
      updated_at TEXT NOT NULL,
      FOREIGN KEY (asset_id) REFERENCES question_assets(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS question_display_text (
      question_id TEXT PRIMARY KEY,
      stem TEXT NOT NULL,
      explanation TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (question_id) REFERENCES exam_questions(id) ON DELETE CASCADE
    );
  `);
}

async function openDatabase(): Promise<Database | null> {
  const SQL = await getSQL();
  try {
    const bytes = await readFile(EXAMS_FILE);
    const db = new SQL.Database(new Uint8Array(bytes));
    createWebSchema(db);
    return db;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function persistDatabase(db: Database): Promise<void> {
  await mkdir(DATA_DIRECTORY, { recursive: true });
  const temporaryFile = `${EXAMS_FILE}.${process.pid}.tmp`;
  await writeFile(temporaryFile, Buffer.from(db.export()));
  await rename(temporaryFile, EXAMS_FILE);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value || 0);
}

function parseJsonObject(value: unknown): Record<string, string> {
  try {
    const parsed = JSON.parse(asString(value)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).map(([key, item]) => [key, asString(item)]),
    );
  } catch {
    return {};
  }
}

function normalizePaperStatus(value: unknown): ExamPaperStatus {
  return value === 'confirmed' ? 'confirmed' : value === 'reviewing' ? 'reviewing' : 'registered';
}

function normalizeReviewStatus(value: unknown): ExamReviewStatus {
  return value === 'confirmed' ? 'confirmed' : value === 'edited' ? 'edited' : 'pending';
}

function normalizeDisplayMode(value: unknown): ExamAssetDisplayMode {
  return value === 'source_page' ? 'source_page' : value === 'hidden' ? 'hidden' : 'crop';
}

function questionIssues(question: Pick<ExamQuestion, 'stem' | 'options' | 'answer' | 'explanation'>): string[] {
  const issues: string[] = [];
  if (!question.stem.trim()) issues.push('缺少题干');
  const missingOptions = 'ABCD'.split('').filter((label) => !question.options[label]?.trim());
  if (missingOptions.length > 0) issues.push(`选项不完整（缺 ${missingOptions.join('、')}）`);
  if (!question.answer.trim()) issues.push('缺少答案');
  if (!question.explanation.trim()) issues.push('缺少解析');
  return issues;
}

function readAssets(db: Database, paperId: string): Map<string, ExamQuestionAsset[]> {
  const statement = db.prepare(`
    SELECT a.id, a.question_id, a.asset_type, a.source_page,
           COALESCE(o.display_mode, 'crop') AS display_mode
    FROM question_assets a
    LEFT JOIN question_asset_overrides o ON o.asset_id=a.id
    JOIN exam_questions q ON q.id=a.question_id
    WHERE q.paper_id=?
    ORDER BY a.source_page, a.id
  `);
  const assets = new Map<string, ExamQuestionAsset[]>();
  try {
    statement.bind([paperId]);
    while (statement.step()) {
      const row = statement.getAsObject();
      const questionId = asString(row.question_id);
      const id = asString(row.id);
      const sourcePage = asNumber(row.source_page);
      const item: ExamQuestionAsset = {
        id,
        type: row.asset_type === 'question_figure' ? 'question_figure' : 'explanation_figure',
        sourcePage,
        displayMode: normalizeDisplayMode(row.display_mode),
        imageUrl: `/api/exams/assets?id=${encodeURIComponent(id)}`,
        sourcePageUrl: `/api/exams/pages?paperId=${encodeURIComponent(paperId)}&page=${sourcePage}`,
      };
      assets.set(questionId, [...(assets.get(questionId) || []), item]);
    }
  } finally {
    statement.free();
  }
  return assets;
}

function readQuestions(db: Database, paperId: string): ExamQuestion[] {
  const assets = readAssets(db, paperId);
  const statement = db.prepare(`
    SELECT q.id, q.paper_id, q.question_no,
           COALESCE(c.stem, d.stem, q.stem) AS stem,
           COALESCE(c.options_json, q.options_json) AS options_json,
           COALESCE(c.answer, q.answer, '') AS answer,
           COALESCE(c.explanation, d.explanation, q.explanation, '') AS explanation,
           q.source_page_from, q.source_page_to, q.confidence,
           COALESCE(c.review_status, q.review_status) AS review_status
    FROM exam_questions q
    LEFT JOIN question_corrections c ON c.question_id=q.id
    LEFT JOIN question_display_text d ON d.question_id=q.id
    WHERE q.paper_id=? AND q.question_type='choice'
    ORDER BY CAST(q.question_no AS INTEGER)
  `);
  const questions: ExamQuestion[] = [];
  try {
    statement.bind([paperId]);
    while (statement.step()) {
      const row = statement.getAsObject();
      const id = asString(row.id);
      const question: ExamQuestion = {
        id,
        paperId: asString(row.paper_id),
        number: asString(row.question_no),
        stem: asString(row.stem),
        options: parseJsonObject(row.options_json),
        answer: asString(row.answer),
        explanation: asString(row.explanation),
        sourcePageFrom: asNumber(row.source_page_from),
        sourcePageTo: asNumber(row.source_page_to),
        confidence: asNumber(row.confidence),
        reviewStatus: normalizeReviewStatus(row.review_status),
        issues: [],
        assets: assets.get(id) || [],
      };
      question.issues = questionIssues(question);
      questions.push(question);
    }
  } finally {
    statement.free();
  }
  return questions;
}

function readPaperRow(db: Database, paperId: string): Record<string, unknown> | undefined {
  const statement = db.prepare(`
    SELECT id, title, year, period, status, pdf_page_from, pdf_page_to
    FROM exam_papers WHERE id=? LIMIT 1
  `);
  try {
    statement.bind([paperId]);
    return statement.step() ? statement.getAsObject() : undefined;
  } finally {
    statement.free();
  }
}

function makePaperSummary(row: Record<string, unknown>, questions: ExamQuestion[]): ExamPaperSummary {
  return {
    id: asString(row.id),
    title: asString(row.title),
    year: asNumber(row.year),
    period: asString(row.period),
    status: normalizePaperStatus(row.status),
    pageFrom: asNumber(row.pdf_page_from),
    pageTo: asNumber(row.pdf_page_to),
    questionCount: questions.length,
    issueCount: questions.filter((question) => question.issues.length > 0).length,
    editedCount: questions.filter((question) => question.reviewStatus === 'edited').length,
    confirmedCount: questions.filter((question) => question.reviewStatus === 'confirmed').length,
  };
}

function readPaperDetailFromDatabase(db: Database, paperId: string): ExamPaperDetail | undefined {
  const row = readPaperRow(db, paperId);
  if (!row) return undefined;
  const questions = readQuestions(db, paperId);
  return { paper: makePaperSummary(row, questions), questions };
}

export async function readExamPapers(): Promise<ExamPaperSummary[]> {
  await writeQueue.catch(() => undefined);
  const db = await openDatabase();
  if (!db) return [];
  try {
    const statement = db.prepare(`
      SELECT id, title, year, period, status, pdf_page_from, pdf_page_to
      FROM exam_papers ORDER BY pdf_page_from
    `);
    const papers: ExamPaperSummary[] = [];
    try {
      while (statement.step()) {
        const row = statement.getAsObject();
        papers.push(makePaperSummary(row, readQuestions(db, asString(row.id))));
      }
    } finally {
      statement.free();
    }
    return papers;
  } finally {
    db.close();
  }
}

export async function readExamPaper(paperId: string): Promise<ExamPaperDetail | undefined> {
  await writeQueue.catch(() => undefined);
  const db = await openDatabase();
  if (!db) return undefined;
  try {
    return readPaperDetailFromDatabase(db, paperId);
  } finally {
    db.close();
  }
}

export async function saveExamQuestion(
  questionId: string,
  input: SaveExamQuestionInput,
): Promise<ExamPaperDetail> {
  let result: ExamPaperDetail | undefined;
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    const db = await openDatabase();
    if (!db) throw new Error('尚未导入真题数据');
    try {
      const paperStatement = db.prepare('SELECT paper_id FROM exam_questions WHERE id=? LIMIT 1');
      let paperId = '';
      try {
        paperStatement.bind([questionId]);
        if (paperStatement.step()) paperId = asString(paperStatement.getAsObject().paper_id);
      } finally {
        paperStatement.free();
      }
      if (!paperId) throw new Error('题目不存在');
      const now = new Date().toISOString();
      db.run('BEGIN');
      try {
        db.run(
          `INSERT INTO question_corrections (
             question_id, stem, options_json, answer, explanation,
             review_status, note, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'edited', '网页审核修改', ?)
           ON CONFLICT(question_id) DO UPDATE SET
             stem=excluded.stem,
             options_json=excluded.options_json,
             answer=excluded.answer,
             explanation=excluded.explanation,
             review_status='edited',
             note='网页审核修改',
             updated_at=excluded.updated_at`,
          [
            questionId,
            input.stem.trim(),
            JSON.stringify(input.options),
            input.answer.trim().toUpperCase(),
            input.explanation.trim(),
            now,
          ],
        );
        db.run("UPDATE exam_papers SET status='reviewing', updated_at=? WHERE id=?", [now, paperId]);
        db.run('COMMIT');
      } catch (error) {
        db.run('ROLLBACK');
        throw error;
      }
      await persistDatabase(db);
      result = readPaperDetailFromDatabase(db, paperId);
    } finally {
      db.close();
    }
  });
  await writeQueue;
  if (!result) throw new Error('保存题目失败');
  return result;
}

export async function confirmExamPaper(paperId: string): Promise<ExamPaperDetail> {
  let result: ExamPaperDetail | undefined;
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    const db = await openDatabase();
    if (!db) throw new Error('尚未导入真题数据');
    try {
      const detail = readPaperDetailFromDatabase(db, paperId);
      if (!detail) throw new Error('试卷不存在');
      const issueQuestions = detail.questions.filter((question) => question.issues.length > 0);
      if (issueQuestions.length > 0) {
        throw new Error(`还有 ${issueQuestions.length} 道题字段不完整，不能确认整卷`);
      }
      const now = new Date().toISOString();
      db.run('BEGIN');
      try {
        db.run(
          "UPDATE exam_questions SET review_status='confirmed', updated_at=? WHERE paper_id=? AND question_type='choice'",
          [now, paperId],
        );
        db.run(
          `UPDATE question_corrections SET review_status='confirmed', updated_at=?
           WHERE question_id IN (SELECT id FROM exam_questions WHERE paper_id=? AND question_type='choice')`,
          [now, paperId],
        );
        db.run("UPDATE exam_papers SET status='confirmed', updated_at=? WHERE id=?", [now, paperId]);
        db.run('COMMIT');
      } catch (error) {
        db.run('ROLLBACK');
        throw error;
      }
      await persistDatabase(db);
      result = readPaperDetailFromDatabase(db, paperId);
    } finally {
      db.close();
    }
  });
  await writeQueue;
  if (!result) throw new Error('确认试卷失败');
  return result;
}

export async function setExamAssetDisplayMode(
  assetId: string,
  displayMode: ExamAssetDisplayMode,
): Promise<ExamPaperDetail> {
  let result: ExamPaperDetail | undefined;
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    const db = await openDatabase();
    if (!db) throw new Error('尚未导入真题数据');
    try {
      const statement = db.prepare(`
        SELECT q.paper_id
        FROM question_assets a
        JOIN exam_questions q ON q.id=a.question_id
        WHERE a.id=? LIMIT 1
      `);
      let paperId = '';
      try {
        statement.bind([assetId]);
        if (statement.step()) paperId = asString(statement.getAsObject().paper_id);
      } finally {
        statement.free();
      }
      if (!paperId) throw new Error('图片不存在');
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO question_asset_overrides (asset_id, display_mode, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(asset_id) DO UPDATE SET
           display_mode=excluded.display_mode,
           updated_at=excluded.updated_at`,
        [assetId, displayMode, now],
      );
      db.run("UPDATE exam_papers SET status='reviewing', updated_at=? WHERE id=?", [now, paperId]);
      await persistDatabase(db);
      result = readPaperDetailFromDatabase(db, paperId);
    } finally {
      db.close();
    }
  });
  await writeQueue;
  if (!result) throw new Error('保存图片设置失败');
  return result;
}

function ensureAssetPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const root = path.resolve(EXAM_ASSETS_DIRECTORY);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('图片路径不在真题资源目录中');
  }
  return resolved;
}

function mimeTypeFor(filePath: string): string {
  return path.extname(filePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
}

export async function readExamAssetFile(assetId: string): Promise<ExamAssetFile | undefined> {
  await writeQueue.catch(() => undefined);
  const db = await openDatabase();
  if (!db) return undefined;
  try {
    const statement = db.prepare(`
      SELECT a.file_path, a.source_page, q.paper_id,
             COALESCE(o.display_mode, 'crop') AS display_mode
      FROM question_assets a
      JOIN exam_questions q ON q.id=a.question_id
      LEFT JOIN question_asset_overrides o ON o.asset_id=a.id
      WHERE a.id=? LIMIT 1
    `);
    try {
      statement.bind([assetId]);
      if (!statement.step()) return undefined;
      const row = statement.getAsObject();
      const displayMode = normalizeDisplayMode(row.display_mode);
      if (displayMode === 'hidden') return undefined;
      let filePath = asString(row.file_path);
      if (displayMode === 'source_page') {
        filePath = readSourcePagePath(db, asString(row.paper_id), asNumber(row.source_page)) || '';
      }
      if (!filePath) return undefined;
      const safePath = ensureAssetPath(filePath);
      return { path: safePath, mimeType: mimeTypeFor(safePath) };
    } finally {
      statement.free();
    }
  } finally {
    db.close();
  }
}

function readSourcePagePath(db: Database, paperId: string, page: number): string | undefined {
  const statement = db.prepare(`
    SELECT source_image_path FROM exam_pages
    WHERE paper_id=? AND pdf_page=? LIMIT 1
  `);
  try {
    statement.bind([paperId, page]);
    if (!statement.step()) return undefined;
    return asString(statement.getAsObject().source_image_path) || undefined;
  } finally {
    statement.free();
  }
}

export async function readExamSourcePageFile(
  paperId: string,
  page: number,
): Promise<ExamAssetFile | undefined> {
  await writeQueue.catch(() => undefined);
  const db = await openDatabase();
  if (!db) return undefined;
  try {
    const filePath = readSourcePagePath(db, paperId, page);
    if (!filePath) return undefined;
    const safePath = ensureAssetPath(filePath);
    return { path: safePath, mimeType: mimeTypeFor(safePath) };
  } finally {
    db.close();
  }
}

export const EXAM_STORAGE_PATH = 'data/exam-content.sqlite';
