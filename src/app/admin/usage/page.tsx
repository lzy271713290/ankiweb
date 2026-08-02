'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Database,
  RefreshCw,
  ShieldCheck,
  Sigma,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { UsageBreakdown, UsagePayload, UsageRecord, UsageSummary } from '@/lib/types';

const OPERATION_LABELS: Record<UsageRecord['operation'], string> = {
  analyze: '内容分析',
  generate: '生成卡片',
  model_test: '连通测试',
};

const EMPTY_SUMMARY: UsageSummary = {
  requestCount: 0,
  successCount: 0,
  errorCount: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  promptCacheHitTokens: 0,
  promptCacheMissTokens: 0,
  reasoningTokens: 0,
};

function number(value: number): string {
  return value.toLocaleString('zh-CN');
}

function localDay(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function detail(record: UsageRecord): string {
  const parts: string[] = [];
  if (record.metadata?.requestedCards) parts.push(`目标 ${record.metadata.requestedCards} 张`);
  if (record.metadata?.contentCharacters) parts.push(`${record.metadata.contentCharacters} 字符`);
  if (record.metadata?.cardType) parts.push(`卡型 ${record.metadata.cardType}`);
  if (record.metadata?.generationPlan) parts.push(`方案 ${record.metadata.generationPlan}`);
  if (record.metadata?.truncated) parts.push('内容已截断');
  if (record.usage?.promptCacheHitTokens) parts.push(`缓存命中 ${number(record.usage.promptCacheHitTokens)}`);
  return record.error || parts.join(' · ') || '最小测试请求';
}

function SummaryCard({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-2xl border bg-card p-4 shadow-sm">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-bold tabular-nums">{value}</p>
      {note && <p className="mt-1 text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

export default function UsageAdminPage() {
  const [payload, setPayload] = useState<UsagePayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [dayFilter, setDayFilter] = useState('all');
  const [operationFilter, setOperationFilter] = useState('all');
  const [modelFilter, setModelFilter] = useState('all');

  const loadUsage = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const response = await fetch('/api/usage?limit=500', { cache: 'no-store' });
      const data = await response.json() as UsagePayload & { error?: string };
      if (!response.ok) throw new Error(data.error || '读取用量记录失败');
      setPayload(data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '读取用量记录失败');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  const timeZone = payload?.timeZone || 'Asia/Shanghai';
  const todayKey = localDay(new Date(), timeZone);
  const today = payload?.daily.find((item) => item.key === todayKey) || ({ key: todayKey, ...EMPTY_SUMMARY } satisfies UsageBreakdown);
  const models = useMemo(
    () => [...new Set(payload?.records.map((record) => record.modelLabel) || [])],
    [payload],
  );
  const filteredRecords = useMemo(() => (
    payload?.records.filter((record) => (
      (dayFilter === 'all' || localDay(new Date(record.timestamp), timeZone) === dayFilter)
      && (operationFilter === 'all' || record.operation === operationFilter)
      && (modelFilter === 'all' || record.modelLabel === modelFilter)
    )) || []
  ), [dayFilter, modelFilter, operationFilter, payload, timeZone]);

  const successRate = payload?.summary.requestCount
    ? Math.round((payload.summary.successCount / payload.summary.requestCount) * 100)
    : 0;

  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-6">
      <div className="mx-auto max-w-[1320px]">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-indigo">
              <ShieldCheck className="h-4 w-4" /> Local admin
            </div>
            <h1 className="mt-2 text-3xl font-bold">模型 Token 用量管理</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              查看每日、每次和历史总计。时区：{timeZone}；记录不包含 Key、Webhook 或材料正文。
            </p>
          </div>
          <div className="flex gap-2">
            <Button asChild variant="outline"><Link href="/"><ArrowLeft className="mr-1.5 h-4 w-4" />返回应用</Link></Button>
            <Button onClick={() => void loadUsage()} disabled={isLoading}>
              <RefreshCw className={`mr-1.5 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />刷新
            </Button>
          </div>
        </header>

        {error && <div className="mt-6 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error}</div>}

        <section className="mt-7">
          <div className="mb-3 flex items-center gap-2"><Sigma className="h-4 w-4 text-indigo" /><h2 className="font-semibold">历史总计</h2></div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <SummaryCard label="请求次数" value={number(payload?.summary.requestCount || 0)} note={`成功率 ${successRate}%`} />
            <SummaryCard label="输入 Token" value={number(payload?.summary.promptTokens || 0)} />
            <SummaryCard label="输出 Token" value={number(payload?.summary.completionTokens || 0)} />
            <SummaryCard label="总 Token" value={number(payload?.summary.totalTokens || 0)} />
            <SummaryCard label="缓存命中" value={number(payload?.summary.promptCacheHitTokens || 0)} />
            <SummaryCard label="失败请求" value={number(payload?.summary.errorCount || 0)} />
          </div>
        </section>

        <section className="mt-7">
          <div className="mb-3 flex items-center gap-2"><CalendarDays className="h-4 w-4 text-indigo" /><h2 className="font-semibold">今日用量</h2></div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <SummaryCard label="今日请求" value={number(today.requestCount)} />
            <SummaryCard label="今日输入" value={number(today.promptTokens)} />
            <SummaryCard label="今日输出" value={number(today.completionTokens)} />
            <SummaryCard label="今日总计" value={number(today.totalTokens)} />
            <SummaryCard label="今日缓存命中" value={number(today.promptCacheHitTokens)} />
          </div>
        </section>

        <div className="mt-7 grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
          <section className="overflow-hidden rounded-2xl border bg-card shadow-sm">
            <div className="border-b p-5">
              <h2 className="font-semibold">每日汇总</h2>
              <p className="mt-1 text-xs text-muted-foreground">每天的请求量和 Token 消耗，最近日期在前。</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground"><tr>
                  <th className="px-4 py-3 font-medium">日期</th><th className="px-4 py-3 text-right font-medium">请求</th>
                  <th className="px-4 py-3 text-right font-medium">输入</th><th className="px-4 py-3 text-right font-medium">输出</th>
                  <th className="px-4 py-3 text-right font-medium">总计</th><th className="px-4 py-3 text-right font-medium">缓存命中</th>
                </tr></thead>
                <tbody>{payload?.daily.map((item) => <tr key={item.key} className="border-t">
                  <td className="px-4 py-3 font-medium">{item.key}</td><td className="px-4 py-3 text-right tabular-nums">{number(item.requestCount)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{number(item.promptTokens)}</td><td className="px-4 py-3 text-right tabular-nums">{number(item.completionTokens)}</td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums">{number(item.totalTokens)}</td><td className="px-4 py-3 text-right tabular-nums">{number(item.promptCacheHitTokens)}</td>
                </tr>)}</tbody>
              </table>
              {!payload?.daily.length && <p className="p-8 text-center text-sm text-muted-foreground">暂无每日记录。</p>}
            </div>
          </section>

          <section className="overflow-hidden rounded-2xl border bg-card shadow-sm">
            <div className="border-b p-5"><h2 className="font-semibold">按模型汇总</h2></div>
            <div className="divide-y">{payload?.byModel.map((item) => <div key={item.key} className="p-4">
              <div className="flex items-center justify-between gap-3"><span className="font-medium">{item.key}</span><span className="font-semibold tabular-nums">{number(item.totalTokens)}</span></div>
              <div className="mt-2 flex justify-between text-xs text-muted-foreground"><span>{item.requestCount} 次请求</span><span>输入 {number(item.promptTokens)} · 输出 {number(item.completionTokens)}</span></div>
            </div>)}</div>
          </section>
        </div>

        <section className="mt-7 overflow-hidden rounded-2xl border bg-card shadow-sm">
          <div className="border-b p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div><h2 className="font-semibold">每次请求明细</h2><p className="mt-1 text-xs text-muted-foreground">最多读取最近 500 条，可按日期、用途和模型筛选。</p></div>
              <div className="flex flex-wrap gap-2">
                <select value={dayFilter} onChange={(event) => setDayFilter(event.target.value)} className="h-9 rounded-md border bg-background px-3 text-xs">
                  <option value="all">全部日期</option>{payload?.daily.map((item) => <option key={item.key} value={item.key}>{item.key}</option>)}
                </select>
                <select value={operationFilter} onChange={(event) => setOperationFilter(event.target.value)} className="h-9 rounded-md border bg-background px-3 text-xs">
                  <option value="all">全部用途</option>{Object.entries(OPERATION_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                </select>
                <select value={modelFilter} onChange={(event) => setModelFilter(event.target.value)} className="h-9 rounded-md border bg-background px-3 text-xs">
                  <option value="all">全部模型</option>{models.map((model) => <option key={model} value={model}>{model}</option>)}
                </select>
              </div>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1120px] text-left text-xs">
              <thead className="bg-muted/50 text-muted-foreground"><tr>
                <th className="px-3 py-3 font-medium">时间</th><th className="px-3 py-3 font-medium">用途</th><th className="px-3 py-3 font-medium">模型</th>
                <th className="px-3 py-3 text-right font-medium">输入</th><th className="px-3 py-3 text-right font-medium">输出</th><th className="px-3 py-3 text-right font-medium">总计</th>
                <th className="px-3 py-3 text-right font-medium">缓存</th><th className="px-3 py-3 text-right font-medium">耗时</th><th className="px-3 py-3 font-medium">状态</th><th className="px-3 py-3 font-medium">参数</th>
              </tr></thead>
              <tbody>{filteredRecords.map((record) => <tr key={record.id} className="border-t align-top">
                <td className="whitespace-nowrap px-3 py-3">{new Date(record.timestamp).toLocaleString('zh-CN', { timeZone })}</td>
                <td className="px-3 py-3">{OPERATION_LABELS[record.operation]}</td><td className="px-3 py-3">{record.modelLabel}</td>
                <td className="px-3 py-3 text-right tabular-nums">{record.usage ? number(record.usage.promptTokens) : '—'}</td>
                <td className="px-3 py-3 text-right tabular-nums">{record.usage ? number(record.usage.completionTokens) : '—'}</td>
                <td className="px-3 py-3 text-right font-semibold tabular-nums">{record.usage ? number(record.usage.totalTokens) : '—'}</td>
                <td className="px-3 py-3 text-right tabular-nums">{record.usage?.promptCacheHitTokens ? number(record.usage.promptCacheHitTokens) : '—'}</td>
                <td className="px-3 py-3 text-right tabular-nums">{number(record.latencyMs)}ms</td>
                <td className={`px-3 py-3 ${record.status === 'success' ? 'text-emerald-600' : 'text-destructive'}`}>{record.status === 'success' ? <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" />成功</span> : record.status === 'cancelled' ? '已取消' : '失败'}</td>
                <td className="max-w-80 px-3 py-3 text-muted-foreground">{detail(record)}</td>
              </tr>)}</tbody>
            </table>
            {!filteredRecords.length && <p className="p-8 text-center text-sm text-muted-foreground">当前筛选条件下没有记录。</p>}
          </div>
        </section>

        <footer className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed p-4 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><Database className="h-3.5 w-3.5" />本地账本：{payload?.storage || 'data/llm-usage.jsonl'}</span>
          <span className="inline-flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5" />刷新页面即可获取最新记录</span>
        </footer>
      </div>
    </main>
  );
}
