'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  AlertCircle,
  Bot,
  Brain,
  CheckCircle2,
  Clock3,
  Download,
  FileText,
  FileUp,
  FolderOpen,
  Layers3,
  Link2,
  Loader2,
  Moon,
  PencilLine,
  Plus,
  Save,
  Send,
  Settings2,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { AnkiCardItem } from '@/components/anki-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Toaster } from '@/components/ui/sonner';
import { Textarea } from '@/components/ui/textarea';
import { useDecks } from '@/hooks/use-decks';
import {
  CARD_TYPE_META,
  CARD_TYPE_OPTIONS,
  DIFFICULTY_LEVELS,
  type ContentAnalysis,
  type GenerationPlan,
  type KnowledgeCard,
  type ModelOption,
  type PushChannelStatus,
  type SSEMessage,
} from '@/lib/types';

const SAMPLE_TEXT = `# RAG（检索增强生成）技术详解

RAG 是一种结合检索和生成的 AI 技术架构。它先从外部知识库检索相关信息，再将检索结果作为上下文交给大语言模型。

RAG 系统主要包括文档处理、检索和生成三个模块。相比只依赖模型参数，RAG 的知识更新成本更低，可以引用来源，也有助于减少模型幻觉。

RAG 适合知识频繁变化的场景；微调更适合改变模型的行为模式。实际应用中，两者可以结合使用。`;

type CardTypeOption = (typeof CARD_TYPE_OPTIONS)[number]['value'];
type ActiveView = 'create' | 'decks' | 'push' | 'models';
type TestResult = { ok: boolean; message: string; latencyMs?: number };

const PLAN_META: Array<{
  id: Exclude<GenerationPlan, 'custom'>;
  label: string;
  description: string;
}> = [
  { id: 'concise', label: '精简复习', description: '核心与高频' },
  { id: 'recommended', label: '标准推荐', description: '覆盖与负担平衡' },
  { id: 'comprehensive', label: '全面覆盖', description: '更多细节与应用' },
];

const PLAN_LABELS: Record<GenerationPlan, string> = {
  concise: '精简复习',
  recommended: '标准推荐',
  comprehensive: '全面覆盖',
  custom: '自定义',
};

const NAV_ITEMS: Array<{ id: ActiveView; label: string; icon: typeof Sparkles }> = [
  { id: 'create', label: '生成卡片', icon: Sparkles },
  { id: 'decks', label: '我的卡组', icon: Layers3 },
  { id: 'push', label: '推送学习', icon: Send },
  { id: 'models', label: '模型设置', icon: Settings2 },
];

async function readJson<T>(response: Response, fallbackMessage: string): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || fallbackMessage);
  return data;
}

function buildAnalysisKey(
  content: string,
  modelId: string,
  cardType: CardTypeOption,
  difficulty: number,
): string {
  let hash = 2166136261;
  const value = `${modelId}\u0000${cardType}\u0000${difficulty}\u0000${content}`;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}-${(hash >>> 0).toString(16)}`;
}

export default function Home() {
  const [activeView, setActiveView] = useState<ActiveView>('create');
  const [content, setContent] = useState('');
  const [cardType, setCardType] = useState<CardTypeOption>('mixed');
  const [difficulty, setDifficulty] = useState(3);
  const [analysis, setAnalysis] = useState<ContentAnalysis | null>(null);
  const [analysisKey, setAnalysisKey] = useState('');
  const [generationPlan, setGenerationPlan] = useState<GenerationPlan>('recommended');
  const [customCardCount, setCustomCardCount] = useState('10');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [deckName, setDeckName] = useState('');
  const [cards, setCards] = useState<KnowledgeCard[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [modelTests, setModelTests] = useState<Record<string, TestResult>>({});
  const [testingModelId, setTestingModelId] = useState('');
  const [channels, setChannels] = useState<PushChannelStatus[]>([]);
  const [selectedPushDeckId, setSelectedPushDeckId] = useState('');
  const [pushingChannelId, setPushingChannelId] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { decks, saveDeck, deleteDeck } = useDecks();

  const configuredModels = useMemo(
    () => models.filter((model) => model.configured),
    [models],
  );
  const selectedModel = models.find((model) => model.id === selectedModelId);
  const selectedPushDeck = decks.find((deck) => deck.id === selectedPushDeckId);
  const currentAnalysisKey = useMemo(
    () => buildAnalysisKey(content, selectedModelId, cardType, difficulty),
    [cardType, content, difficulty, selectedModelId],
  );
  const analysisIsCurrent = analysis !== null && analysisKey === currentAnalysisKey;
  const parsedCustomCount = Number.parseInt(customCardCount, 10);
  const actualCardCount = analysis
    ? generationPlan === 'custom'
      ? Math.min(120, Math.max(1, Number.isFinite(parsedCustomCount) ? parsedCustomCount : 1))
      : analysis.suggestions[generationPlan]
    : 0;
  const customWarning = useMemo(() => {
    if (!analysis || generationPlan !== 'custom' || !Number.isFinite(parsedCustomCount)) return '';
    if (parsedCustomCount < analysis.suggestions.minimum) {
      return `低于建议下限 ${analysis.suggestions.minimum} 张，可能遗漏核心知识点。`;
    }
    if (parsedCustomCount > analysis.suggestions.maximum) {
      return `高于建议上限 ${analysis.suggestions.maximum} 张，可能出现重复；系统会优先保证质量。`;
    }
    return '';
  }, [analysis, generationPlan, parsedCustomCount]);
  const cardCounts = useMemo(
    () =>
      cards.reduce<Record<string, number>>((counts, card) => {
        counts[card.card_type] = (counts[card.card_type] || 0) + 1;
        return counts;
      }, {}),
    [cards],
  );

  const loadModels = useCallback(async () => {
    try {
      const data = await readJson<{ models: ModelOption[] }>(await fetch('/api/models'), '读取模型失败');
      setModels(data.models);
      setSelectedModelId((current) => {
        if (data.models.some((model) => model.id === current && model.configured)) return current;
        return data.models.find((model) => model.configured && model.recommended)?.id
          || data.models.find((model) => model.configured)?.id
          || '';
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取模型失败');
    }
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem('anki-theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = stored === 'dark' || (!stored && prefersDark);
    setDarkMode(isDark);
    document.documentElement.classList.toggle('dark', isDark);
    void loadModels();
    void fetch('/api/channels')
      .then((response) => readJson<{ channels: PushChannelStatus[] }>(response, '读取推送渠道失败'))
      .then((data) => setChannels(data.channels))
      .catch(() => setChannels([]));
  }, [loadModels]);

  useEffect(() => {
    if (!selectedPushDeckId && decks[0]) setSelectedPushDeckId(decks[0].id);
  }, [decks, selectedPushDeckId]);

  const toggleDarkMode = () => {
    const next = !darkMode;
    setDarkMode(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('anki-theme', next ? 'dark' : 'light');
  };

  const handleAnalyze = async () => {
    if (content.trim().length < 5) {
      toast.error('请输入更多内容（至少 5 个字符）');
      return;
    }
    if (analysisIsCurrent) {
      toast.info('当前内容已经分析过，可以直接选择方案并生成');
      return;
    }

    setIsAnalyzing(true);
    try {
      const result = await readJson<ContentAnalysis>(
        await fetch('/api/analyze-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content,
            modelId: selectedModelId || undefined,
            cardType,
            difficulty,
          }),
        }),
        '内容分析失败',
      );
      setAnalysis(result);
      setAnalysisKey(currentAnalysisKey);
      setGenerationPlan('recommended');
      setCustomCardCount(String(result.suggestions.recommended));
      if (result.mode === 'ai') {
        toast.success(`识别到约 ${result.knowledgePoints} 个知识点，建议 ${result.suggestions.recommended} 张`);
      } else {
        toast.info(`已完成本地估算，建议 ${result.suggestions.recommended} 张`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '内容分析失败');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleGenerate = async () => {
    if (content.trim().length < 5) {
      toast.error('请输入更多内容（至少 5 个字符）');
      return;
    }
    if (!selectedModelId) {
      toast.error('请先在模型设置中配置并选择一个模型');
      setActiveView('models');
      return;
    }
    if (!analysisIsCurrent || !analysis) {
      toast.error('请先分析当前内容并确认生成数量');
      return;
    }

    setIsGenerating(true);
    setCards([]);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          cardCount: actualCardCount,
          cardType,
          difficulty,
          modelId: selectedModelId,
          generationPlan,
          analysis,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const data = await readJson<{ error?: string }>(response, '生成失败');
        throw new Error(data.error || '生成失败');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('无法读取响应流');

      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim().startsWith('data: ')) continue;
          const message = JSON.parse(line.trim().slice(6)) as SSEMessage;
          if (message.type === 'card') setCards((current) => [...current, message.data]);
          if (message.type === 'done') toast.success(`成功生成 ${message.data.total} 张卡片`);
          if (message.type === 'error') toast.error(message.data.message);
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      toast.error(error instanceof Error ? error.message : '生成失败，请重试');
    } finally {
      setIsGenerating(false);
      abortRef.current = null;
    }
  };

  const exportCards = async (targetCards: KnowledgeCard[], targetDeckName: string) => {
    if (targetCards.length === 0) {
      toast.error('没有可导出的卡片');
      return;
    }
    setIsExporting(true);
    const name = targetDeckName.trim() || 'AnkiCard Deck';
    try {
      const response = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cards: targetCards, deckName: name }),
      });
      if (!response.ok) {
        const data = await readJson<{ error?: string }>(response, '导出失败');
        throw new Error(data.error || '导出失败');
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${name}.apkg`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      toast.success(`已导出 ${targetCards.length} 张卡片`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出失败');
    } finally {
      setIsExporting(false);
    }
  };

  const handleEditCard = useCallback((id: string, updates: Partial<KnowledgeCard>) => {
    setCards((current) => current.map((card) => (card.id === id ? { ...card, ...updates } : card)));
  }, []);

  const handleDeleteCard = useCallback((id: string) => {
    setCards((current) => current.filter((card) => card.id !== id));
  }, []);

  const handleSaveDeck = () => {
    if (cards.length === 0) {
      toast.error('请先生成或添加卡片');
      return;
    }
    const name = deckName.trim() || `学习卡组 ${decks.length + 1}`;
    setDeckName(name);
    saveDeck(name, cards);
    toast.success(`“${name}”已保存到我的卡组`);
  };

  const handleOpenDeck = (deckId: string) => {
    const deck = decks.find((item) => item.id === deckId);
    if (!deck) return;
    setCards(structuredClone(deck.cards));
    setDeckName(deck.name);
    setActiveView('create');
    toast.info('卡组已载入，可继续编辑');
  };

  const handleAddCard = () => {
    const type = cardType === 'mixed' ? 'qa' : cardType;
    setCards((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        question: '点击铅笔编辑问题',
        answer: type === 'cloze' ? '' : '在这里填写答案',
        category: '手动添加',
        card_type: type,
        source_section: '手动添加',
      },
    ]);
  };

  const handleFile = async (file: File) => {
    if (file.size > 20 * 1024 * 1024) {
      toast.error('文件大小超过 20MB 限制');
      return;
    }
    setIsParsing(true);
    setFileName(file.name);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const data = await readJson<{ content: string }>(
        await fetch('/api/parse-file', { method: 'POST', body: formData }),
        '文件解析失败',
      );
      setContent(data.content);
      if (!deckName.trim()) setDeckName(file.name.replace(/\.[^.]+$/, ''));
      toast.success(`已解析文件：${file.name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '文件解析失败');
      setFileName('');
    } finally {
      setIsParsing(false);
    }
  };

  const handleParseUrl = async () => {
    const url = urlInput.trim();
    if (!url) return toast.error('请输入 URL');
    setIsParsing(true);
    try {
      const data = await readJson<{ content: string; source?: string; title?: string }>(
        await fetch('/api/parse-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        }),
        'URL 解析失败',
      );
      setContent(data.content);
      setFileName(data.source || url);
      if (!deckName.trim() && data.title) setDeckName(data.title);
      setShowUrlInput(false);
      setUrlInput('');
      toast.success('已解析网页内容');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'URL 解析失败');
    } finally {
      setIsParsing(false);
    }
  };

  const handleTestModel = async (modelId: string) => {
    setTestingModelId(modelId);
    setModelTests((current) => {
      const next = { ...current };
      delete next[modelId];
      return next;
    });
    try {
      const result = await readJson<{ message: string; latencyMs: number }>(
        await fetch('/api/models/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId }),
        }),
        '模型测试失败',
      );
      setModelTests((current) => ({
        ...current,
        [modelId]: { ok: true, message: result.message, latencyMs: result.latencyMs },
      }));
      toast.success(`模型连接成功，耗时 ${result.latencyMs}ms`);
    } catch (error) {
      const message = error instanceof Error ? error.message : '模型测试失败';
      setModelTests((current) => ({ ...current, [modelId]: { ok: false, message } }));
      toast.error(message);
    } finally {
      setTestingModelId('');
    }
  };

  const handlePush = async (channelId: PushChannelStatus['id']) => {
    if (!selectedPushDeck) return toast.error('请选择需要推送的卡组');
    setPushingChannelId(channelId);
    try {
      await readJson<{ success: boolean }>(
        await fetch('/api/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel: channelId,
            deckName: selectedPushDeck.name,
            cards: selectedPushDeck.cards,
          }),
        }),
        '推送失败',
      );
      toast.success('学习卡片已推送');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '推送失败');
    } finally {
      setPushingChannelId('');
    }
  };

  return (
    <>
      <Toaster position="bottom-right" richColors />
      <header className="sticky top-0 z-50 border-b border-border bg-background/85 backdrop-blur-xl">
        <div className="mx-auto flex min-h-14 max-w-[1400px] flex-wrap items-center justify-between gap-2 px-4 py-2 sm:px-6">
          <button className="flex items-center gap-2.5" onClick={() => setActiveView('create')}>
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo text-white shadow-sm">
              <Brain className="h-5 w-5" />
            </span>
            <span className="flex items-baseline gap-2">
              <span className="text-[17px] font-bold tracking-tight">AnkiCard AI</span>
              <span className="font-mono text-[10px] text-muted-foreground">v0.4</span>
            </span>
          </button>

          <nav className="order-3 flex w-full items-center gap-1 overflow-x-auto sm:order-2 sm:w-auto">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] transition ${
                    activeView === item.id
                      ? 'bg-indigo-soft font-medium text-indigo'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                  onClick={() => setActiveView(item.id)}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {item.label}
                </button>
              );
            })}
          </nav>

          <div className="order-2 flex items-center gap-1.5 sm:order-3">
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={toggleDarkMode} aria-label="切换主题">
              {darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
            <Button
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => void exportCards(cards, deckName)}
              disabled={cards.length === 0 || isExporting}
            >
              {isExporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">导出 .apkg</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="bg-texture min-h-[calc(100vh-3.5rem)]">
        {activeView === 'create' && (
          <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6">
            <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo">Create & refine</p>
                <h1 className="text-[24px] font-bold tracking-tight">从阅读到记忆</h1>
                <p className="mt-1 text-[13px] text-muted-foreground">把材料拆成卡片，逐张微调，再保存到自己的知识卡组。</p>
              </div>
              <div className="flex items-center gap-2">
                {selectedModel && (
                  <span className="rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">
                    <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    {selectedModel.label}
                  </span>
                )}
                <Button variant="outline" size="sm" className="gap-1.5" onClick={handleAddCard}>
                  <Plus className="h-3.5 w-3.5" /> 手动加卡
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <section className="flex flex-col gap-4">
                <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <label className="text-sm font-medium">学习材料</label>
                    <div className="flex items-center gap-1">
                      {showUrlInput ? (
                        <>
                          <Input
                            value={urlInput}
                            onChange={(event) => setUrlInput(event.target.value)}
                            onKeyDown={(event) => event.key === 'Enter' && void handleParseUrl()}
                            placeholder="https://..."
                            className="h-7 w-40 text-xs"
                          />
                          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => void handleParseUrl()}>
                            {isParsing ? <Loader2 className="h-3 w-3 animate-spin" /> : '解析'}
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setShowUrlInput(false)}>
                            <X className="h-3 w-3" />
                          </Button>
                        </>
                      ) : (
                        <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs text-muted-foreground" onClick={() => setShowUrlInput(true)}>
                          <Link2 className="h-3 w-3" /> URL
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 text-xs text-muted-foreground"
                        onClick={() => {
                          setContent(SAMPLE_TEXT);
                          setDeckName('RAG 技术详解');
                          setFileName('');
                        }}
                      >
                        <FileText className="h-3 w-3" /> 示例
                      </Button>
                    </div>
                  </div>

                  <div
                    className={`group mb-2 flex cursor-pointer items-center gap-2 rounded-lg border-2 border-dashed px-3 py-2 transition ${
                      dragOver ? 'border-indigo bg-indigo-soft/40' : 'border-border hover:border-indigo/40'
                    }`}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setDragOver(true);
                    }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={(event: DragEvent<HTMLDivElement>) => {
                      event.preventDefault();
                      setDragOver(false);
                      const file = event.dataTransfer.files?.[0];
                      if (file) void handleFile(file);
                    }}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {isParsing ? <Loader2 className="h-4 w-4 animate-spin text-indigo" /> : fileName ? <FileUp className="h-4 w-4 text-indigo" /> : <Upload className="h-4 w-4 text-muted-foreground" />}
                    <span className="text-xs text-muted-foreground">{fileName || '拖入文本文件，或点击选择'}</span>
                    <input
                      ref={fileInputRef}
                      type="file"
                      className="hidden"
                      accept=".txt,.md,.markdown,.csv,.json,.html,.htm,.xml,.yaml,.yml,.log,.js,.ts,.py,.java,.c,.cpp,.h,.css,.scss,.svg,.go,.rs,.rb,.php,.sh,.sql"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void handleFile(file);
                        event.target.value = '';
                      }}
                    />
                  </div>

                  <Textarea
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    placeholder="将教材、论文、笔记、字幕粘贴进来..."
                    className="min-h-[240px] resize-y bg-card-warm text-sm leading-relaxed"
                  />
                  <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground">
                    <span>{content.length} 字</span>
                    <span>支持 txt / md / csv / json / html</span>
                  </div>
                  <Button
                    variant="outline"
                    className="mt-3 h-10 w-full gap-2 border-indigo/25 bg-indigo-soft/35 text-indigo hover:bg-indigo-soft"
                    disabled={content.trim().length < 5 || isAnalyzing || isGenerating}
                    onClick={() => void handleAnalyze()}
                  >
                    {isAnalyzing
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <Brain className="h-4 w-4" />}
                    {isAnalyzing
                      ? '正在识别原子知识点...'
                      : analysisIsCurrent
                        ? '重新分析内容'
                        : '分析内容并推荐数量'}
                  </Button>
                  {analysis && !analysisIsCurrent && (
                    <p className="mt-2 flex items-center gap-1.5 text-xs text-amber">
                      <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                      内容、模型或生成设置已变化，请重新分析。
                    </p>
                  )}
                </div>

                {(analysis || isAnalyzing) && (
                  <div className="rounded-xl border border-indigo/15 bg-card p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-indigo">智能拆卡建议</p>
                        <h2 className="mt-1 text-base font-semibold">
                          {isAnalyzing ? '正在理解材料结构' : `建议生成 ${analysis?.suggestions.recommended ?? 0} 张`}
                        </h2>
                      </div>
                      {analysis && (
                        <span className={`rounded-full px-2 py-1 text-[10px] font-medium ${
                          analysis.mode === 'ai'
                            ? 'bg-indigo-soft text-indigo'
                            : 'bg-amber-soft text-amber'
                        }`}>
                          {analysis.mode === 'ai' ? 'AI 分析' : '本地估算'}
                        </span>
                      )}
                    </div>

                    {isAnalyzing && (
                      <div className="mt-4 space-y-2">
                        <div className="h-3 w-full animate-pulse rounded bg-muted" />
                        <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
                        <div className="h-16 w-full animate-pulse rounded-lg bg-muted" />
                      </div>
                    )}

                    {analysis && !isAnalyzing && (
                      <>
                        <div className="mt-4 grid grid-cols-4 gap-2">
                          {[
                            ['有效字符', analysis.characters],
                            ['章节', analysis.sections],
                            ['知识点', analysis.knowledgePoints],
                            ['核心', analysis.coreKnowledgePoints],
                          ].map(([label, value]) => (
                            <div key={String(label)} className="rounded-lg bg-muted/60 px-2 py-2.5 text-center">
                              <div className="text-lg font-bold text-foreground">{value}</div>
                              <div className="mt-0.5 text-[10px] text-muted-foreground">{label}</div>
                            </div>
                          ))}
                        </div>

                        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{analysis.reason}</p>
                        {analysis.warning && (
                          <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-soft/70 px-3 py-2 text-xs leading-relaxed text-amber">
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            {analysis.warning}
                          </p>
                        )}

                        {analysis.knowledgePointItems.length > 0 && (
                          <div className="mt-3">
                            <div className="mb-2 flex items-center justify-between text-[11px] text-muted-foreground">
                              <span>优先识别的知识点</span>
                              <span>展示前 {Math.min(8, analysis.knowledgePointItems.length)} 项</span>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {analysis.knowledgePointItems.slice(0, 8).map((item) => (
                                <span
                                  key={item.id}
                                  className={`rounded-full border px-2 py-1 text-[11px] ${
                                    item.importance === 'core'
                                      ? 'border-indigo/20 bg-indigo-soft text-indigo'
                                      : 'border-border bg-background text-muted-foreground'
                                  }`}
                                >
                                  {item.title}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                          {PLAN_META.map((plan) => {
                            const count = analysis.suggestions[plan.id];
                            return (
                              <button
                                key={plan.id}
                                type="button"
                                onClick={() => setGenerationPlan(plan.id)}
                                className={`rounded-lg border px-2 py-3 text-left transition ${
                                  generationPlan === plan.id
                                    ? 'border-indigo bg-indigo-soft/70 ring-2 ring-indigo/10'
                                    : 'border-border bg-background hover:border-indigo/30'
                                }`}
                              >
                                <span className="block text-xs font-semibold">{plan.label}</span>
                                <span className="mt-1 block text-lg font-bold text-indigo">{count}张</span>
                                <span className="mt-0.5 block text-[10px] leading-tight text-muted-foreground">{plan.description}</span>
                              </button>
                            );
                          })}
                          <button
                            type="button"
                            onClick={() => setGenerationPlan('custom')}
                            className={`rounded-lg border px-2 py-3 text-left transition ${
                              generationPlan === 'custom'
                                ? 'border-indigo bg-indigo-soft/70 ring-2 ring-indigo/10'
                                : 'border-border bg-background hover:border-indigo/30'
                            }`}
                          >
                            <span className="block text-xs font-semibold">自定义</span>
                            <span className="mt-1 block text-lg font-bold text-indigo">
                              {generationPlan === 'custom' ? `${actualCardCount}张` : '自己定'}
                            </span>
                            <span className="mt-0.5 block text-[10px] leading-tight text-muted-foreground">单批最多120张</span>
                          </button>
                        </div>

                        {generationPlan === 'custom' && (
                          <div className="mt-3 rounded-lg border border-border bg-background p-3">
                            <div className="flex items-center gap-3">
                              <label htmlFor="custom-card-count" className="shrink-0 text-xs font-medium">自定义数量</label>
                              <Input
                                id="custom-card-count"
                                type="number"
                                min={1}
                                max={120}
                                value={customCardCount}
                                onChange={(event) => setCustomCardCount(event.target.value)}
                                className="h-8 w-24"
                              />
                              <span className="text-[11px] text-muted-foreground">
                                建议范围 {analysis.suggestions.minimum}～{analysis.suggestions.maximum} 张
                              </span>
                            </div>
                            {customWarning && (
                              <p className="mt-2 flex items-center gap-1.5 text-xs text-amber">
                                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                                {customWarning}
                              </p>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}

                <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-indigo">科学拆卡原则</p>
                      <h2 className="mt-1 text-sm font-semibold">不是越多越好，而是越容易主动回忆越好</h2>
                    </div>
                    <CheckCircle2 className="h-5 w-5 shrink-0 text-indigo" />
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    {[
                      ['一卡一知识点', '降低单次回忆负担'],
                      ['问题能独立理解', '避免“上述、它、这个”'],
                      ['答案保持最小信息', '过长内容自动拆分'],
                      ['忠于用户原文', '不补写没有依据的事实'],
                    ].map(([title, description]) => (
                      <div key={title} className="rounded-lg bg-muted/60 px-3 py-2.5">
                        <div className="text-xs font-semibold">{title}</div>
                        <div className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{description}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-4 rounded-xl border border-border bg-card p-4 shadow-sm">
                  <div>
                    <label className="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">卡片类型</label>
                    <div className="flex flex-wrap gap-2">
                      {CARD_TYPE_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          onClick={() => setCardType(option.value)}
                          className={`chip ${cardType === option.value ? 'active' : ''}`}
                          title={option.description}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">生成数量</label>
                      <div className="flex h-9 items-center justify-between rounded-md border border-input bg-background px-3">
                        <span className="text-sm">{analysisIsCurrent ? PLAN_LABELS[generationPlan] : '等待内容分析'}</span>
                        <span className="font-mono text-sm font-semibold text-indigo">
                          {analysisIsCurrent ? `${actualCardCount} 张` : '—'}
                        </span>
                      </div>
                    </div>
                    <div>
                      <label className="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">难度倾向</label>
                      <div className="flex items-center gap-3">
                        <input type="range" min={1} max={5} value={difficulty} onChange={(event) => setDifficulty(Number(event.target.value))} className="flex-1 accent-[#3d3fc7]" />
                        <span className="w-12 text-right font-mono text-[13px] text-muted-foreground">{DIFFICULTY_LEVELS[difficulty]}</span>
                      </div>
                    </div>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">卡组名称</label>
                      <Input value={deckName} onChange={(event) => setDeckName(event.target.value)} placeholder="例如：产品经理基础" className="h-9 text-sm" />
                    </div>
                    <div>
                      <label className="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">生成模型</label>
                      <div className="flex gap-2">
                        <select
                          value={selectedModelId}
                          onChange={(event) => setSelectedModelId(event.target.value)}
                          className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm"
                        >
                          {configuredModels.length === 0 && <option value="">尚未配置模型</option>}
                          {configuredModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                        </select>
                        <Button variant="outline" size="sm" className="h-9 px-3" disabled={!selectedModelId || testingModelId === selectedModelId} onClick={() => void handleTestModel(selectedModelId)}>
                          {testingModelId === selectedModelId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : '测试'}
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <Button variant="outline" className="h-11 gap-2" disabled={cards.length === 0} onClick={handleSaveDeck}>
                    <Save className="h-4 w-4" /> 保存卡组
                  </Button>
                  {isGenerating ? (
                    <Button variant="destructive" className="h-11" onClick={() => abortRef.current?.abort()}>停止生成</Button>
                  ) : (
                    <Button
                      className="btn-primary-gradient h-11 gap-2"
                      onClick={() => void handleGenerate()}
                      disabled={content.trim().length < 5 || !selectedModelId || !analysisIsCurrent || actualCardCount < 1}
                    >
                      <Sparkles className="h-4 w-4" />
                      {analysisIsCurrent ? `生成 ${actualCardCount} 张卡片` : '请先分析内容'}
                    </Button>
                  )}
                </div>
                <p className="text-center text-[11px] leading-relaxed text-muted-foreground">Key 只保存在服务端环境变量中，不会发送到浏览器。</p>
              </section>

              <section className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-5 py-4 shadow-sm">
                  <div className="flex flex-wrap items-center gap-4">
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">当前草稿</div>
                      <div className="mt-0.5 text-[22px] font-bold">{cards.length}<span className="ml-1 text-[12px] font-normal text-muted-foreground">张</span></div>
                    </div>
                    <div className="h-10 w-px bg-border" />
                    {Object.entries(CARD_TYPE_META).map(([type, meta]) => (
                      <div key={type} className="min-w-9 text-center">
                        <div className="text-[10px] text-muted-foreground">{meta.shortLabel}</div>
                        <div className="mt-1 text-sm font-semibold text-indigo">{cardCounts[type] || 0}</div>
                      </div>
                    ))}
                  </div>
                  {cards.length > 0 && (
                    <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs text-destructive" onClick={() => setCards([])}>
                      <Trash2 className="h-3.5 w-3.5" /> 清空
                    </Button>
                  )}
                </div>

                <div className="scroll-thin max-h-[calc(100vh-220px)] overflow-y-auto pr-1">
                  {cards.length === 0 && !isGenerating && (
                    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-24 text-center">
                      <div className="relative mb-5 h-28 w-32">
                        <div className="absolute inset-x-4 top-8 h-20 -rotate-6 rounded-lg border bg-card-warm shadow-sm" />
                        <div className="absolute inset-x-3 top-6 h-20 -rotate-2 rounded-lg border bg-card shadow-sm" />
                        <div className="absolute inset-x-2 top-4 flex h-20 rotate-3 flex-col justify-center gap-2 rounded-lg border bg-card px-4 shadow-md">
                          <span className="h-1.5 w-3/4 rounded bg-indigo-soft" />
                          <span className="h-1.5 w-full rounded bg-indigo-soft" />
                          <span className="h-1.5 w-1/2 rounded bg-amber-soft" />
                        </div>
                      </div>
                      <h2 className="font-semibold">桌面已就绪，等待知识入场</h2>
                      <p className="mt-2 max-w-sm text-[13px] leading-relaxed text-muted-foreground">生成后可翻面预览，点击铅笔逐张修改问题、答案与分类。</p>
                    </div>
                  )}
                  {cards.length > 0 && (
                    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                      {cards.map((card, index) => (
                        <AnkiCardItem key={card.id} card={card} index={index} onEdit={handleEditCard} onDelete={handleDeleteCard} />
                      ))}
                    </div>
                  )}
                </div>
              </section>
            </div>
          </div>
        )}

        {activeView === 'decks' && (
          <div className="mx-auto w-full max-w-[1200px] px-4 py-8 sm:px-6">
            <div className="mb-6 flex items-end justify-between gap-3">
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo">Local library</p>
                <h1 className="text-2xl font-bold">我的卡组</h1>
                <p className="mt-1 text-sm text-muted-foreground">保存在当前浏览器，可随时载入继续微调或导出。</p>
              </div>
              <Button className="gap-1.5" onClick={() => setActiveView('create')}><Plus className="h-4 w-4" /> 新建卡组</Button>
            </div>
            {decks.length === 0 ? (
              <div className="rounded-2xl border border-dashed bg-card/60 py-24 text-center">
                <FolderOpen className="mx-auto h-10 w-10 text-muted-foreground/50" />
                <h2 className="mt-4 font-semibold">还没有保存的卡组</h2>
                <p className="mt-1 text-sm text-muted-foreground">生成并微调卡片后，点击“保存卡组”。</p>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {decks.map((deck) => (
                  <article key={deck.id} className="group rounded-2xl border bg-card p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-soft text-indigo"><Layers3 className="h-5 w-5" /></div>
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive" onClick={() => {
                        deleteDeck(deck.id);
                        toast.info('卡组已删除');
                      }}><Trash2 className="h-4 w-4" /></Button>
                    </div>
                    <h2 className="mt-4 truncate text-lg font-semibold">{deck.name}</h2>
                    <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{deck.cards.length} 张卡片</span>
                      <span>·</span>
                      <span>{new Date(deck.updatedAt).toLocaleDateString('zh-CN')}</span>
                    </div>
                    <p className="mt-4 line-clamp-2 min-h-10 text-sm leading-relaxed text-muted-foreground">{deck.cards[0]?.question || '空卡组'}</p>
                    <div className="mt-5 grid grid-cols-2 gap-2">
                      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void exportCards(deck.cards, deck.name)}><Download className="h-3.5 w-3.5" /> 导出</Button>
                      <Button size="sm" className="gap-1.5" onClick={() => handleOpenDeck(deck.id)}><PencilLine className="h-3.5 w-3.5" /> 打开编辑</Button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        )}

        {activeView === 'models' && (
          <div className="mx-auto w-full max-w-[1000px] px-4 py-8 sm:px-6">
            <div className="mb-6">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo">Provider health</p>
              <h1 className="text-2xl font-bold">模型设置与连通性</h1>
              <p className="mt-1 text-sm text-muted-foreground">模型密钥由服务端读取；在这里选择模型并发起最小测试请求。</p>
            </div>
            <div className="mb-5 rounded-2xl border border-amber/30 bg-amber-soft/70 p-5">
              <div className="flex gap-3">
                <Bot className="mt-0.5 h-5 w-5 shrink-0 text-amber" />
                <div>
                  <h2 className="font-semibold">DeepSeek 配置</h2>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">在项目根目录的 <code className="rounded bg-background/70 px-1.5 py-0.5">.env.local</code> 写入 <code className="rounded bg-background/70 px-1.5 py-0.5">DEEPSEEK_API_KEY=你的Key</code>，重启服务后点击下方测试。不要把 Key 写进页面或提交到代码仓库。</p>
                </div>
              </div>
            </div>
            <div className="space-y-3">
              {models.map((model) => {
                const result = modelTests[model.id];
                return (
                  <article key={model.id} className={`rounded-xl border bg-card p-5 shadow-sm ${selectedModelId === model.id ? 'border-indigo/40 ring-2 ring-indigo/10' : ''}`}>
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <h2 className="font-semibold">{model.label}</h2>
                          {model.recommended && <span className="rounded-full bg-indigo-soft px-2 py-0.5 text-[10px] font-medium text-indigo">推荐</span>}
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${model.configured ? 'bg-emerald-50 text-emerald-700' : 'bg-muted text-muted-foreground'}`}>{model.configured ? '已配置' : '未配置'}</span>
                        </div>
                        <p className="mt-1 font-mono text-xs text-muted-foreground">{model.provider} · {model.model}</p>
                        {result && (
                          <p className={`mt-2 flex items-center gap-1.5 text-xs ${result.ok ? 'text-emerald-600' : 'text-destructive'}`}>
                            {result.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
                            {result.message}{result.latencyMs !== undefined ? ` · ${result.latencyMs}ms` : ''}
                          </p>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" disabled={!model.configured || testingModelId === model.id} onClick={() => void handleTestModel(model.id)}>
                          {testingModelId === model.id ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Clock3 className="mr-1.5 h-3.5 w-3.5" />}测试
                        </Button>
                        <Button size="sm" disabled={!model.configured} onClick={() => {
                          setSelectedModelId(model.id);
                          setActiveView('create');
                          toast.success(`已选择 ${model.label}`);
                        }}>使用此模型</Button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
            <div className="mt-5 rounded-xl border border-dashed p-5 text-sm text-muted-foreground">
              还可通过 <code>CUSTOM_LLM_API_KEY</code>、<code>CUSTOM_LLM_BASE_URL</code> 和 <code>CUSTOM_LLM_MODELS</code> 接入其他 OpenAI 兼容服务；模型之间可在生成页即时切换。
            </div>
          </div>
        )}

        {activeView === 'push' && (
          <div className="mx-auto w-full max-w-[1000px] px-4 py-8 sm:px-6">
            <div className="mb-6">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo">Learning delivery</p>
              <h1 className="text-2xl font-bold">推送学习</h1>
              <p className="mt-1 text-sm text-muted-foreground">从已保存卡组中选取内容，立即推送到飞书或企业微信群。</p>
            </div>
            <div className="grid gap-5 lg:grid-cols-[1fr_1.5fr]">
              <section className="rounded-2xl border bg-card p-5 shadow-sm">
                <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">选择卡组</label>
                <select value={selectedPushDeckId} onChange={(event) => setSelectedPushDeckId(event.target.value)} className="h-10 w-full rounded-md border bg-background px-3 text-sm">
                  {decks.length === 0 && <option value="">暂无卡组</option>}
                  {decks.map((deck) => <option key={deck.id} value={deck.id}>{deck.name}（{deck.cards.length} 张）</option>)}
                </select>
                <div className="mt-5 rounded-xl bg-card-warm p-4">
                  <p className="text-xs font-medium text-muted-foreground">推送预览</p>
                  <h2 className="mt-2 font-semibold">{selectedPushDeck?.name || '请选择卡组'}</h2>
                  <p className="mt-2 line-clamp-4 text-sm leading-relaxed text-muted-foreground">{selectedPushDeck?.cards[0]?.question || '保存卡组后即可推送。'}</p>
                  {selectedPushDeck && <p className="mt-3 text-xs text-muted-foreground">每次最多发送前 5 张，避免群消息过长。</p>}
                </div>
              </section>
              <section className="space-y-3">
                {channels.map((channel) => (
                  <article key={channel.id} className="rounded-2xl border bg-card p-5 shadow-sm">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex gap-3">
                        <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${channel.id === 'feishu' ? 'bg-blue-50 text-blue-600' : 'bg-emerald-50 text-emerald-600'}`}><Send className="h-5 w-5" /></div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h2 className="font-semibold">{channel.label}</h2>
                            <span className={`rounded-full px-2 py-0.5 text-[10px] ${channel.configured ? 'bg-emerald-50 text-emerald-700' : 'bg-muted text-muted-foreground'}`}>{channel.configured ? '已绑定' : '未绑定'}</span>
                          </div>
                          <p className="mt-1 text-sm text-muted-foreground">{channel.description}</p>
                        </div>
                      </div>
                      <Button size="sm" disabled={!channel.configured || !selectedPushDeck || pushingChannelId === channel.id} onClick={() => void handlePush(channel.id)}>
                        {pushingChannelId === channel.id ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}立即推送
                      </Button>
                    </div>
                  </article>
                ))}
                <div className="rounded-xl border border-dashed p-5 text-sm leading-relaxed text-muted-foreground">
                  飞书填写 <code>FEISHU_WEBHOOK_URL</code>，机器人安全设置建议选择“关键词”并填写 <code>AnkiCard AI</code>；企业微信填写 <code>WECOM_WEBHOOK_URL</code>。当前实现面向群机器人。若要按用户单聊、定时复习和记录学习结果，需要下一阶段接入应用机器人、用户身份和定时任务。
                </div>
              </section>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
