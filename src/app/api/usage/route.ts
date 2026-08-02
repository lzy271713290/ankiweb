import { NextRequest } from 'next/server';
import { groupUsage, readUsageRecords, summarizeUsage } from '@/lib/server/usage';

export const runtime = 'nodejs';

const USAGE_TIME_ZONE = process.env.USAGE_TIME_ZONE?.trim() || 'Asia/Shanghai';

function usageDay(timestamp: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: USAGE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export async function GET(request: NextRequest) {
  const requestedLimit = Number(request.nextUrl.searchParams.get('limit') || 100);
  const limit = Number.isFinite(requestedLimit) ? requestedLimit : 100;
  const allRecords = await readUsageRecords();
  const records = allRecords.slice(0, Math.min(Math.max(limit, 1), 500));

  return Response.json({
    summary: summarizeUsage(allRecords),
    daily: groupUsage(allRecords, (record) => usageDay(record.timestamp))
      .sort((left, right) => right.key.localeCompare(left.key)),
    byModel: groupUsage(allRecords, (record) => record.modelLabel)
      .sort((left, right) => right.totalTokens - left.totalTokens),
    byOperation: groupUsage(allRecords, (record) => record.operation)
      .sort((left, right) => right.totalTokens - left.totalTokens),
    records,
    storage: 'data/llm-usage.jsonl',
    timeZone: USAGE_TIME_ZONE,
  });
}
