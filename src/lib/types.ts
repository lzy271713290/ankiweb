/** 卡片类型 */
export type CardType = 'qa' | 'cloze' | 'def' | 'reverse' | 'compare' | 'sequence';

/** 卡片类型选项 */
export const CARD_TYPE_OPTIONS = [
  { value: 'mixed', label: '混合模式', description: 'AI 自动选择最合适的类型' },
  { value: 'qa', label: '问答卡', description: '问题-答案形式' },
  { value: 'cloze', label: 'Cloze 填空', description: '填空形式，主动检索' },
  { value: 'def', label: '定义卡', description: '概念定义形式' },
  { value: 'reverse', label: '双向卡', description: '正反两个方向都可复习' },
  { value: 'compare', label: '对比卡', description: '比较两个相近概念' },
  { value: 'sequence', label: '步骤卡', description: '记忆流程、顺序和阶段' },
] as const;

export const CARD_TYPE_META: Record<CardType, { label: string; shortLabel: string }> = {
  qa: { label: '问答卡', shortLabel: '问答' },
  cloze: { label: 'Cloze 填空', shortLabel: '填空' },
  def: { label: '定义卡', shortLabel: '定义' },
  reverse: { label: '双向卡', shortLabel: '双向' },
  compare: { label: '对比卡', shortLabel: '对比' },
  sequence: { label: '步骤卡', shortLabel: '步骤' },
};

/** 难度等级 */
export const DIFFICULTY_LEVELS = ['', '轻松', '较易', '中等', '较难', '困难'] as const;

export type GenerationPlan = 'concise' | 'recommended' | 'comprehensive' | 'custom';
export type KnowledgeImportance = 'core' | 'important' | 'supplementary';
export type KnowledgeKind =
  | 'fact'
  | 'definition'
  | 'comparison'
  | 'sequence'
  | 'formula'
  | 'application';

export interface AnalyzedKnowledgePoint {
  id: string;
  title: string;
  importance: KnowledgeImportance;
  knowledge_type: KnowledgeKind;
  suggested_cards: number;
}

export interface CardCountSuggestions {
  concise: number;
  recommended: number;
  comprehensive: number;
  minimum: number;
  maximum: number;
}

export interface ContentAnalysis {
  mode: 'ai' | 'fallback';
  characters: number;
  sections: number;
  knowledgePoints: number;
  coreKnowledgePoints: number;
  signals: {
    formulas: number;
    comparisons: number;
    processes: number;
  };
  suggestions: CardCountSuggestions;
  reason: string;
  knowledgePointItems: AnalyzedKnowledgePoint[];
  truncated: boolean;
  warning?: string;
}

/** 知识卡片数据结构 */
export interface KnowledgeCard {
  id: string;
  question: string;
  answer: string;
  category: string;
  card_type: CardType;
  source_section: string;
}

/** 卡片生成请求参数 */
export interface GenerateRequest {
  content: string;
  deckName?: string;
  cardCount?: number;
  preferCloze?: boolean;
  coverAll?: boolean;
  cardType?: (typeof CARD_TYPE_OPTIONS)[number]['value'];
  cardTypes?: CardType[];
  difficulty?: number;
  modelId?: string;
  generationPlan?: GenerationPlan;
  analysis?: ContentAnalysis;
}

export interface SavedDeck {
  id: string;
  name: string;
  cards: KnowledgeCard[];
  createdAt: string;
  updatedAt: string;
}

export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  model: string;
  configured: boolean;
  recommended?: boolean;
}

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
  operation: 'analyze' | 'generate' | 'model_test';
  status: 'success' | 'error' | 'cancelled';
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

export interface UsagePayload {
  summary: UsageSummary;
  daily: UsageBreakdown[];
  byModel: UsageBreakdown[];
  byOperation: UsageBreakdown[];
  records: UsageRecord[];
  storage: string;
  timeZone: string;
}

export interface PushChannelStatus {
  id: 'feishu' | 'wecom';
  label: string;
  configured: boolean;
  description: string;
}

/** 导出请求参数 */
export interface ExportRequest {
  cards: KnowledgeCard[];
  deckName: string;
}

/** 卡片统计信息 */
export interface CardStats {
  totalCards: number;
  byCategory: Record<string, number>;
  byType: Record<string, number>;
}

/** SSE 消息类型 */
export type SSEMessage =
  | { type: 'card'; data: KnowledgeCard }
  | { type: 'progress'; data: { current: number; total: number } }
  | { type: 'done'; data: { total: number; requested?: number; complete?: boolean } }
  | { type: 'error'; data: { message: string } };
