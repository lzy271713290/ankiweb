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

/** 生成数量选项 */
export const CARD_COUNT_OPTIONS = [
  { value: '3', label: '3 张' },
  { value: '6', label: '6 张' },
  { value: '10', label: '10 张' },
  { value: 'auto', label: 'AI 自动' },
] as const;

/** 难度等级 */
export const DIFFICULTY_LEVELS = ['', '轻松', '较易', '中等', '较难', '困难'] as const;

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
  difficulty?: number;
  modelId?: string;
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
  | { type: 'done'; data: { total: number } }
  | { type: 'error'; data: { message: string } };
