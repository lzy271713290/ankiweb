'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  FileCheck2,
  ImageIcon,
  Loader2,
  RefreshCw,
  Save,
  Search,
  SendToBack,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type {
  ExamAssetDisplayMode,
  ExamPaperDetail,
  ExamPaperSummary,
  ExamQuestion,
} from '@/lib/types';

type QuestionFilter = 'all' | 'issues' | 'edited' | 'pending';

interface ExamReviewProps {
  onUseForGeneration: (content: string, deckName: string) => void;
  paperIds?: string[];
  onBack?: () => void;
}

async function readJson<T>(response: Response, fallbackMessage: string): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || fallbackMessage);
  return data;
}

function localIssues(question: ExamQuestion): string[] {
  const issues: string[] = [];
  if (!question.stem.trim()) issues.push('缺少题干');
  const missing = 'ABCD'.split('').filter((label) => !question.options[label]?.trim());
  if (missing.length > 0) issues.push(`选项不完整（缺 ${missing.join('、')}）`);
  if (!question.answer.trim()) issues.push('缺少答案');
  if (!question.explanation.trim()) issues.push('缺少解析');
  return issues;
}

function statusLabel(status: ExamPaperSummary['status']): string {
  if (status === 'confirmed') return '已确认，可生成';
  if (status === 'reviewing') return '审核中';
  return '待审核';
}

function questionToMaterial(question: ExamQuestion): string {
  const options = 'ABCD'.split('')
    .map((label) => `${label}. ${question.options[label] || ''}`)
    .join('\n');
  return `【第${question.number}题】\n${question.stem}\n${options}\n答案：${question.answer}\n解析：${question.explanation}`;
}

export function ExamReview({ onUseForGeneration, paperIds, onBack }: ExamReviewProps) {
  const [papers, setPapers] = useState<ExamPaperSummary[]>([]);
  const [paperId, setPaperId] = useState('');
  const [detail, setDetail] = useState<ExamPaperDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingQuestionId, setSavingQuestionId] = useState('');
  const [savingAssetId, setSavingAssetId] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [filter, setFilter] = useState<QuestionFilter>('all');
  const [search, setSearch] = useState('');
  const [selectedQuestionIds, setSelectedQuestionIds] = useState<Set<string>>(new Set());

  const loadPaper = useCallback(async (id: string) => {
    if (!id) {
      setDetail(null);
      return;
    }
    setLoading(true);
    try {
      const data = await readJson<ExamPaperDetail>(await fetch(`/api/exams/${encodeURIComponent(id)}`), '读取试卷失败');
      setDetail(data);
      setPapers((current) => current.map((paper) => paper.id === data.paper.id ? data.paper : paper));
      setSelectedQuestionIds(new Set(data.questions.slice(0, 10).map((question) => question.id)));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取试卷失败');
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPapers = useCallback(async () => {
    setLoading(true);
    try {
      const data = await readJson<{ papers: ExamPaperSummary[] }>(await fetch('/api/exams'), '读取真题库失败');
      const visiblePapers = paperIds?.length
        ? data.papers.filter((paper) => paperIds.includes(paper.id))
        : data.papers;
      setPapers(visiblePapers);
      const nextId = visiblePapers.some((paper) => paper.id === paperId) ? paperId : visiblePapers[0]?.id || '';
      setPaperId(nextId);
      if (nextId) await loadPaper(nextId);
      else setDetail(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取真题库失败');
      setPapers([]);
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [loadPaper, paperId, paperIds]);

  useEffect(() => {
    void loadPapers();
  }, [loadPapers]);

  const visibleQuestions = useMemo(() => {
    if (!detail) return [];
    const keyword = search.trim().toLowerCase();
    return detail.questions.filter((question) => {
      if (filter === 'issues' && question.issues.length === 0) return false;
      if (filter === 'edited' && question.reviewStatus !== 'edited') return false;
      if (filter === 'pending' && question.reviewStatus !== 'pending') return false;
      if (!keyword) return true;
      return question.number.includes(keyword) || question.stem.toLowerCase().includes(keyword);
    });
  }, [detail, filter, search]);

  const updateQuestion = (questionId: string, updater: (question: ExamQuestion) => ExamQuestion) => {
    setDetail((current) => {
      if (!current) return current;
      return {
        ...current,
        questions: current.questions.map((question) => {
          if (question.id !== questionId) return question;
          const updated = updater(question);
          return { ...updated, issues: localIssues(updated) };
        }),
      };
    });
  };

  const handleSaveQuestion = async (question: ExamQuestion) => {
    setSavingQuestionId(question.id);
    try {
      const data = await readJson<ExamPaperDetail>(
        await fetch(`/api/exams/questions/${encodeURIComponent(question.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            stem: question.stem,
            options: question.options,
            answer: question.answer,
            explanation: question.explanation,
          }),
        }),
        '保存题目失败',
      );
      setDetail(data);
      setPapers((current) => current.map((paper) => paper.id === data.paper.id ? data.paper : paper));
      toast.success(`第 ${question.number} 题已保存；整卷需要重新确认`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存题目失败');
    } finally {
      setSavingQuestionId('');
    }
  };

  const handleAssetMode = async (
    assetId: string,
    displayMode: ExamAssetDisplayMode,
  ) => {
    setSavingAssetId(assetId);
    try {
      const data = await readJson<ExamPaperDetail>(
        await fetch('/api/exams/assets', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: assetId, displayMode }),
        }),
        '保存图片设置失败',
      );
      setDetail(data);
      setPapers((current) => current.map((paper) => paper.id === data.paper.id ? data.paper : paper));
      toast.success(displayMode === 'source_page' ? '已改用来源整页' : displayMode === 'hidden' ? '已隐藏图片' : '已恢复裁剪图');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存图片设置失败');
    } finally {
      setSavingAssetId('');
    }
  };

  const handleConfirmPaper = async () => {
    if (!detail) return;
    if (!window.confirm('确认整卷后才能送去生成卡片。确认当前题干、选项、答案、解析和图片设置已审核完成吗？')) return;
    setConfirming(true);
    try {
      const data = await readJson<ExamPaperDetail>(
        await fetch(`/api/exams/${encodeURIComponent(detail.paper.id)}`, { method: 'POST' }),
        '确认试卷失败',
      );
      setDetail(data);
      setPapers((current) => current.map((paper) => paper.id === data.paper.id ? data.paper : paper));
      toast.success('整卷已确认，现在可以选择题目送去 AI 拆卡');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '确认试卷失败');
    } finally {
      setConfirming(false);
    }
  };

  const toggleQuestionSelection = (questionId: string) => {
    setSelectedQuestionIds((current) => {
      const next = new Set(current);
      if (next.has(questionId)) next.delete(questionId);
      else if (next.size >= 20) toast.info('为控制单次模型上下文，最多选择 20 题');
      else next.add(questionId);
      return next;
    });
  };

  const handleUseForGeneration = () => {
    if (!detail || detail.paper.status !== 'confirmed') return toast.error('请先确认整卷');
    const selected = detail.questions.filter((question) => selectedQuestionIds.has(question.id));
    if (selected.length === 0) return toast.error('请至少选择一道题');
    const chunks: string[] = [];
    let length = 0;
    for (const question of selected) {
      const chunk = questionToMaterial(question);
      if (length + chunk.length > 18_000) break;
      chunks.push(chunk);
      length += chunk.length + 2;
    }
    if (chunks.length < selected.length) toast.info(`材料较长，本次先载入前 ${chunks.length} 题`);
    onUseForGeneration(chunks.join('\n\n'), `${detail.paper.year}年${detail.paper.period}系统集成真题`);
  };

  const filterItems: Array<{ id: QuestionFilter; label: string }> = [
    { id: 'all', label: '全部' },
    { id: 'issues', label: '字段异常' },
    { id: 'edited', label: '已修改' },
    { id: 'pending', label: '待审核' },
  ];

  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 py-8 sm:px-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo">Review before generation</p>
          <h1 className="text-2xl font-bold">OCR 预审核</h1>
          <p className="mt-1 text-sm text-muted-foreground">请核对并修改识别结果；确认后才能导入首页生成卡片。</p>
        </div>
        <div className="flex gap-2">
          {onBack && (
            <Button variant="outline" className="gap-1.5" onClick={onBack}>
              <ArrowLeft className="h-4 w-4" />返回上传
            </Button>
          )}
          <Button variant="outline" className="gap-1.5" onClick={() => void loadPapers()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            刷新数据
          </Button>
        </div>
      </div>

      {papers.length === 0 && !loading ? (
        <div className="rounded-2xl border border-dashed bg-card/70 px-6 py-20 text-center">
          <FileCheck2 className="mx-auto h-10 w-10 text-muted-foreground/50" />
          <h2 className="mt-4 font-semibold">没有找到本次 PDF 的识别结果</h2>
          <p className="mt-2 text-sm text-muted-foreground">请返回上传页重新执行 OCR；若刚完成识别，也可以点击刷新数据。</p>
        </div>
      ) : (
        <>
          <section className="rounded-2xl border bg-card p-5 shadow-sm">
            <div className="flex flex-wrap items-center gap-3">
              <select
                value={paperId}
                onChange={(event) => {
                  const nextId = event.target.value;
                  setPaperId(nextId);
                  void loadPaper(nextId);
                }}
                className="h-10 min-w-64 flex-1 rounded-md border bg-background px-3 text-sm"
              >
                {papers.map((paper) => <option key={paper.id} value={paper.id}>{paper.title}</option>)}
              </select>
              <Button
                className="gap-1.5"
                disabled={!detail || detail.paper.issueCount > 0 || confirming || detail.paper.status === 'confirmed'}
                onClick={() => void handleConfirmPaper()}
              >
                {confirming ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                {detail?.paper.status === 'confirmed' ? '整卷已确认' : '确认整卷'}
              </Button>
            </div>
            {detail && (
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
                {[
                  ['状态', statusLabel(detail.paper.status)],
                  ['选择题', `${detail.paper.questionCount} 道`],
                  ['字段异常', `${detail.paper.issueCount} 道`],
                  ['已修改', `${detail.paper.editedCount} 道`],
                  ['已确认', `${detail.paper.confirmedCount} 道`],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl bg-muted/55 px-3 py-3">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
                    <div className="mt-1 text-sm font-semibold">{value}</div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <div className="my-4 flex items-start gap-2 rounded-xl border border-indigo/15 bg-indigo-soft/45 px-4 py-3 text-xs leading-relaxed text-indigo-deep">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>保存任意修改都会让“整卷确认”失效。截图不完整时可改用来源整页或隐藏图片；原始 OCR 和裁剪文件始终保留。</p>
          </div>

          <div className="sticky top-16 z-30 mb-4 rounded-xl border bg-background/95 p-3 shadow-sm backdrop-blur">
            <div className="flex flex-wrap items-center gap-2">
              {filterItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setFilter(item.id)}
                  className={`rounded-full px-3 py-1.5 text-xs transition ${filter === item.id ? 'bg-indigo text-white' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
                >
                  {item.label}
                </button>
              ))}
              <div className="relative min-w-48 flex-1 sm:max-w-72">
                <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索题号或题干" className="h-9 pl-8 text-xs" />
              </div>
              <span className="text-xs text-muted-foreground">已选 {selectedQuestionIds.size}/20 题</span>
              <Button
                className="gap-1.5"
                disabled={!detail || detail.paper.status !== 'confirmed' || selectedQuestionIds.size === 0}
                onClick={handleUseForGeneration}
              >
                <SendToBack className="h-4 w-4" />送去 AI 拆卡
              </Button>
            </div>
          </div>

          {loading ? (
            <div className="flex justify-center py-24"><Loader2 className="h-7 w-7 animate-spin text-indigo" /></div>
          ) : (
            <section className="space-y-3">
              {visibleQuestions.map((question) => (
                <details key={question.id} className={`group rounded-xl border bg-card shadow-sm ${question.issues.length > 0 ? 'border-amber/60' : ''}`}>
                  <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selectedQuestionIds.has(question.id)}
                      onChange={(event) => {
                        event.stopPropagation();
                        toggleQuestionSelection(question.id);
                      }}
                      onClick={(event) => event.stopPropagation()}
                      className="h-4 w-4 accent-[#3d3fc7]"
                    />
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-soft text-xs font-bold text-indigo">{question.number}</span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{question.stem || '题干为空'}</span>
                    {question.assets.length > 0 && <ImageIcon className="h-4 w-4 shrink-0 text-indigo" />}
                    {question.issues.length > 0 ? (
                      <span className="shrink-0 rounded-full bg-amber-soft px-2 py-1 text-[10px] text-amber-700">{question.issues.join('、')}</span>
                    ) : (
                      <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] ${question.reviewStatus === 'confirmed' ? 'bg-emerald-50 text-emerald-700' : question.reviewStatus === 'edited' ? 'bg-blue-50 text-blue-700' : 'bg-muted text-muted-foreground'}`}>
                        {question.reviewStatus === 'confirmed' ? '已确认' : question.reviewStatus === 'edited' ? '已修改' : '待审核'}
                      </span>
                    )}
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition group-open:rotate-180" />
                  </summary>
                  <div className="border-t p-4">
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
                      <span>来源 PDF 第 {question.sourcePageFrom}{question.sourcePageTo !== question.sourcePageFrom ? `-${question.sourcePageTo}` : ''} 页 · OCR {question.confidence.toFixed(3)}</span>
                      <a href={`/api/exams/pages?paperId=${encodeURIComponent(question.paperId)}&page=${question.sourcePageFrom}`} target="_blank" rel="noreferrer" className="font-medium text-indigo hover:underline">打开来源整页</a>
                    </div>
                    <label className="text-xs font-semibold">题干</label>
                    <Textarea
                      value={question.stem}
                      onChange={(event) => updateQuestion(question.id, (current) => ({ ...current, stem: event.target.value }))}
                      className="mt-1 min-h-20 bg-card-warm text-sm"
                    />
                    <div className="mt-4 grid gap-2 sm:grid-cols-2">
                      {'ABCD'.split('').map((label) => (
                        <label key={label} className="flex items-center gap-2 text-xs font-semibold">
                          <span className="w-4 text-indigo">{label}.</span>
                          <Input
                            value={question.options[label] || ''}
                            onChange={(event) => updateQuestion(question.id, (current) => ({
                              ...current,
                              options: { ...current.options, [label]: event.target.value },
                            }))}
                            className="h-9 bg-card-warm text-sm font-normal"
                          />
                        </label>
                      ))}
                    </div>
                    <div className="mt-4 grid gap-4 sm:grid-cols-[120px_1fr]">
                      <label className="text-xs font-semibold">答案
                        <select
                          value={question.answer}
                          onChange={(event) => updateQuestion(question.id, (current) => ({ ...current, answer: event.target.value }))}
                          className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm font-normal"
                        >
                          <option value="">未填写</option>
                          {'ABCD'.split('').map((label) => <option key={label} value={label}>{label}</option>)}
                        </select>
                      </label>
                      <label className="text-xs font-semibold">答案解析
                        <Textarea
                          value={question.explanation}
                          onChange={(event) => updateQuestion(question.id, (current) => ({ ...current, explanation: event.target.value }))}
                          className="mt-1 min-h-28 bg-card-warm text-sm font-normal leading-relaxed"
                        />
                      </label>
                    </div>

                    {question.assets.length > 0 && (
                      <div className="mt-4 grid gap-3 md:grid-cols-2">
                        {question.assets.map((asset) => (
                          <figure key={asset.id} className="rounded-xl border bg-muted/25 p-3">
                            <figcaption className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold">
                              <span>{asset.type === 'question_figure' ? '题目原图' : '解析原图'} · 第 {asset.sourcePage} 页</span>
                              <a href={asset.sourcePageUrl} target="_blank" rel="noreferrer" className="font-normal text-indigo hover:underline">看整页</a>
                            </figcaption>
                            {asset.displayMode === 'hidden' ? (
                              <div className="flex h-32 items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">该图片已隐藏</div>
                            ) : (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={`${asset.imageUrl}&mode=${asset.displayMode}`} alt={asset.type === 'question_figure' ? '题目原图' : '解析原图'} className="max-h-80 w-full rounded-lg bg-white object-contain" />
                            )}
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {([
                                ['crop', '裁剪图'],
                                ['source_page', '来源整页'],
                                ['hidden', '隐藏'],
                              ] as Array<[ExamAssetDisplayMode, string]>).map(([mode, label]) => (
                                <Button
                                  key={mode}
                                  variant={asset.displayMode === mode ? 'default' : 'outline'}
                                  size="sm"
                                  className="h-7 px-2 text-[11px]"
                                  disabled={savingAssetId === asset.id}
                                  onClick={() => void handleAssetMode(asset.id, mode)}
                                >
                                  {savingAssetId === asset.id && asset.displayMode !== mode ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                                  {label}
                                </Button>
                              ))}
                            </div>
                          </figure>
                        ))}
                      </div>
                    )}

                    <div className="mt-4 flex justify-end">
                      <Button className="gap-1.5" onClick={() => void handleSaveQuestion(question)} disabled={savingQuestionId === question.id}>
                        {savingQuestionId === question.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                        保存本题
                      </Button>
                    </div>
                  </div>
                </details>
              ))}
              {visibleQuestions.length === 0 && (
                <div className="rounded-xl border border-dashed py-16 text-center text-sm text-muted-foreground">当前筛选条件下没有题目。</div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
