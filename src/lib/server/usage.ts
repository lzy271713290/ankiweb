import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Database, SqlJsStatic } from 'sql.js';

export type UsageOperation = 'analyze' | 'generate' | 'model_test';
export type UsageStatus = 'success' | 'error' | 'cancelled';

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
  reasoningTokens?: number;
}

export interface UsageRecord {
  id: string;
  timestamp: string;
  operation: UsageOperation;
  status: UsageStatus;
  provider: string;
  modelId: string;
  model: string;
  modelLabel: string;
  latencyMs: number;
  usage?: TokenUsage;
  metadata?: Record<string, string | number | boolean>;
  error?: string;
}

export interface UsageSummary {
  requestCount: number;
  successCount: number;
  errorCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  reasoningTokens: number;
}

export interface UsageBreakdown extends UsageSummary {
  key: string;
}

const USAGE_DIRECTORY = path.join(process.cwd(), 'data');
const USAGE_FILE = path.join(USAGE_DIRECTORY, 'llm-usage.sqlite');
const SQL_WASM_FILE = path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
let sqlPromise: Promise<SqlJsStatic> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '未知错误');
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/(?:sk|ds)-[A-Za-z0-9_-]{8,}/gi, '[REDACTED]')
    .slice(0, 300);
}

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

function createSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      operation TEXT NOT NULL,
      status TEXT NOT NULL,
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model TEXT NOT NULL,
      model_label TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      prompt_cache_hit_tokens INTEGER,
      prompt_cache_miss_tokens INTEGER,
      reasoning_tokens INTEGER,
      metadata_json TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS usage_records_timestamp_idx
      ON usage_records(timestamp DESC);
  `);
}

async function openDatabase(): Promise<Database> {
  const SQL = await getSQL();
  try {
    const bytes = await readFile(USAGE_FILE);
    const db = new SQL.Database(new Uint8Array(bytes));
    createSchema(db);
    return db;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const db = new SQL.Database();
    createSchema(db);
    return db;
  }
}

async function persistDatabase(db: Database): Promise<void> {
  await mkdir(USAGE_DIRECTORY, { recursive: true });
  const temporaryFile = `${USAGE_FILE}.${process.pid}.tmp`;
  await writeFile(temporaryFile, Buffer.from(db.export()));
  await rename(temporaryFile, USAGE_FILE);
}

function parseMetadata(value: unknown): Record<string, string | number | boolean> | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object'
      ? parsed as Record<string, string | number | boolean>
      : undefined;
  } catch {
    return undefined;
  }
}

function numberValue(value: unknown): number {
  return typeof value === 'number' ? value : Number(value) || 0;
}

export async function appendUsageRecord(record: UsageRecord): Promise<void> {
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    const db = await openDatabase();
    try {
      const usage = record.usage;
      db.run(
        `INSERT OR REPLACE INTO usage_records (
          id, timestamp, operation, status, provider, model_id, model, model_label, latency_ms,
          prompt_tokens, completion_tokens, total_tokens, prompt_cache_hit_tokens,
          prompt_cache_miss_tokens, reasoning_tokens, metadata_json, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.timestamp,
          record.operation,
          record.status,
          record.provider,
          record.modelId,
          record.model,
          record.modelLabel,
          record.latencyMs,
          usage?.promptTokens ?? null,
          usage?.completionTokens ?? null,
          usage?.totalTokens ?? null,
          usage?.promptCacheHitTokens ?? null,
          usage?.promptCacheMissTokens ?? null,
          usage?.reasoningTokens ?? null,
          record.metadata ? JSON.stringify(record.metadata) : null,
          record.error ? safeErrorMessage(record.error) : null,
        ],
      );
      await persistDatabase(db);
    } finally {
      db.close();
    }
  });

  try {
    await writeQueue;
  } catch (error) {
    console.error('写入模型用量记录失败', safeErrorMessage(error));
  }
}

export async function readUsageRecords(limit?: number): Promise<UsageRecord[]> {
  await writeQueue.catch(() => undefined);
  const db = await openDatabase();
  try {
    const boundedLimit = limit === undefined ? undefined : Math.min(Math.max(limit, 1), 500);
    const statement = db.prepare(`
      SELECT * FROM usage_records
      ORDER BY timestamp DESC
      ${boundedLimit === undefined ? '' : 'LIMIT ?'}
    `);
    if (boundedLimit !== undefined) statement.bind([boundedLimit]);
    const records: UsageRecord[] = [];
    while (statement.step()) {
      const row = statement.getAsObject();
      const hasUsage = row.total_tokens !== null && row.total_tokens !== undefined;
      records.push({
        id: String(row.id),
        timestamp: String(row.timestamp),
        operation: String(row.operation) as UsageOperation,
        status: String(row.status) as UsageStatus,
        provider: String(row.provider),
        modelId: String(row.model_id),
        model: String(row.model),
        modelLabel: String(row.model_label),
        latencyMs: numberValue(row.latency_ms),
        usage: hasUsage ? {
          promptTokens: numberValue(row.prompt_tokens),
          completionTokens: numberValue(row.completion_tokens),
          totalTokens: numberValue(row.total_tokens),
          promptCacheHitTokens: numberValue(row.prompt_cache_hit_tokens),
          promptCacheMissTokens: numberValue(row.prompt_cache_miss_tokens),
          reasoningTokens: numberValue(row.reasoning_tokens),
        } : undefined,
        metadata: parseMetadata(row.metadata_json),
        error: typeof row.error === 'string' && row.error ? row.error : undefined,
      });
    }
    statement.free();
    return records;
  } finally {
    db.close();
  }
}

export function summarizeUsage(records: UsageRecord[]): UsageSummary {
  return records.reduce<UsageSummary>((summary, record) => {
    summary.requestCount += 1;
    if (record.status === 'success') summary.successCount += 1;
    if (record.status === 'error') summary.errorCount += 1;
    summary.promptTokens += record.usage?.promptTokens ?? 0;
    summary.completionTokens += record.usage?.completionTokens ?? 0;
    summary.totalTokens += record.usage?.totalTokens ?? 0;
    summary.promptCacheHitTokens += record.usage?.promptCacheHitTokens ?? 0;
    summary.promptCacheMissTokens += record.usage?.promptCacheMissTokens ?? 0;
    summary.reasoningTokens += record.usage?.reasoningTokens ?? 0;
    return summary;
  }, {
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    reasoningTokens: 0,
  });
}

export function groupUsage(
  records: UsageRecord[],
  getKey: (record: UsageRecord) => string,
): UsageBreakdown[] {
  const groups = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const key = getKey(record);
    groups.set(key, [...(groups.get(key) || []), record]);
  }

  return [...groups.entries()].map(([key, groupRecords]) => ({
    key,
    ...summarizeUsage(groupRecords),
  }));
}
