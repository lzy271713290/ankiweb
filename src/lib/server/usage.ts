import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

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
const USAGE_FILE = path.join(USAGE_DIRECTORY, 'llm-usage.jsonl');

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '未知错误');
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/(?:sk|ds)-[A-Za-z0-9_-]{8,}/gi, '[REDACTED]')
    .slice(0, 300);
}

export async function appendUsageRecord(record: UsageRecord): Promise<void> {
  try {
    await mkdir(USAGE_DIRECTORY, { recursive: true });
    await appendFile(USAGE_FILE, `${JSON.stringify({
      ...record,
      error: record.error ? safeErrorMessage(record.error) : undefined,
    })}\n`, 'utf8');
  } catch (error) {
    console.error('写入模型用量记录失败', safeErrorMessage(error));
  }
}

export async function readUsageRecords(limit?: number): Promise<UsageRecord[]> {
  try {
    const content = await readFile(USAGE_FILE, 'utf8');
    const records = content
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as UsageRecord];
        } catch {
          return [];
        }
      });
    const selected = limit === undefined
      ? records
      : records.slice(-Math.min(Math.max(limit, 1), 500));
    return selected.reverse();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
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
