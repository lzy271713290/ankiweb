import { NextRequest } from 'next/server';
import { getConfiguredModel, streamChatCompletion } from '@/lib/server/llm';
import type {
  AnalyzedKnowledgePoint,
  CardCountSuggestions,
  ContentAnalysis,
  KnowledgeImportance,
  KnowledgeKind,
} from '@/lib/types';

const MAX_ANALYSIS_CHARS = 20_000;
const MAX_KNOWLEDGE_POINT_ITEMS = 40;
const MAX_SINGLE_BATCH_CARDS = 120;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function countMatches(content: string, pattern: RegExp): number {
  return content.match(pattern)?.length ?? 0;
}

function getDocumentSignals(content: string): {
  characters: number;
  sections: number;
  sentences: number;
  formulas: number;
  comparisons: number;
  processes: number;
  listItems: number;
} {
  const normalized = content.trim();
  const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const headingLines = lines.filter((line) =>
    /^(?:#{1,6}\s+|第[一二三四五六七八九十百\d]+[章节篇部分]|[一二三四五六七八九十\d]+[、.．]\s*)/.test(line),
  ).length;
  const sentences = normalized
    .split(/[。！？!?；;\n]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 6).length;

  return {
    characters: normalized.replace(/\s/g, '').length,
    sections: Math.max(1, headingLines || Math.ceil(lines.length / 8)),
    sentences: Math.max(1, sentences),
    formulas: countMatches(normalized, /(?:[A-Za-z]{1,8}\s*=|[+\-×÷*/]\s*\d|公式|计算)/g),
    comparisons: countMatches(normalized, /(?:区别|对比|相比|不同|相同|优于|劣于|而| versus | vs\.?)/gi),
    processes: countMatches(normalized, /(?:步骤|流程|阶段|过程组|首先|其次|然后|最后|第[一二三四五六七八九十\d]+步)/g),
    listItems: lines.filter((line) => /^(?:[-*•]\s+|\d+[、.．]\s*)/.test(line)).length,
  };
}

function buildSuggestions(
  knowledgePoints: number,
  coreKnowledgePoints: number,
  signals: { formulas: number; comparisons: number; processes: number },
): CardCountSuggestions {
  const complexityBonus =
    Math.min(12, signals.formulas) * 0.7
    + Math.min(12, signals.comparisons) * 0.45
    + Math.min(10, signals.processes) * 0.55;
  const concise = clamp(coreKnowledgePoints + complexityBonus * 0.25, 3, 80);
  const recommended = clamp(knowledgePoints * 1.12 + complexityBonus, concise, 100);
  const comprehensive = clamp(
    knowledgePoints * 1.48 + complexityBonus * 1.3,
    recommended,
    MAX_SINGLE_BATCH_CARDS,
  );

  return {
    concise,
    recommended,
    comprehensive,
    minimum: clamp(concise * 0.75, 3, concise),
    maximum: clamp(comprehensive * 1.15, comprehensive, MAX_SINGLE_BATCH_CARDS),
  };
}

function fallbackAnalysis(content: string, warning?: string): ContentAnalysis {
  const sample = content.slice(0, MAX_ANALYSIS_CHARS);
  const metrics = getDocumentSignals(sample);
  const estimatedPoints = clamp(
    metrics.sentences * 0.72
      + metrics.listItems * 0.55
      + metrics.formulas * 0.35
      + metrics.comparisons * 0.25,
    3,
    90,
  );
  const corePoints = clamp(estimatedPoints * 0.62, 2, estimatedPoints);

  return {
    mode: 'fallback',
    characters: metrics.characters,
    sections: metrics.sections,
    knowledgePoints: estimatedPoints,
    coreKnowledgePoints: corePoints,
    signals: {
      formulas: metrics.formulas,
      comparisons: metrics.comparisons,
      processes: metrics.processes,
    },
    suggestions: buildSuggestions(estimatedPoints, corePoints, metrics),
    reason: '根据段落、句子、列表和公式密度进行本地估算；生成前仍会按原子知识点原则拆分。',
    knowledgePointItems: [],
    truncated: content.length > MAX_ANALYSIS_CHARS,
    warning,
  };
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === '\\') escaped = true;
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          return JSON.parse(text.slice(start, index + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function toImportance(value: unknown): KnowledgeImportance {
  return value === 'core' || value === 'supplementary' ? value : 'important';
}

function toKnowledgeKind(value: unknown): KnowledgeKind {
  return value === 'definition'
    || value === 'comparison'
    || value === 'sequence'
    || value === 'formula'
    || value === 'application'
    ? value
    : 'fact';
}

function parseKnowledgePoints(value: unknown): AnalyzedKnowledgePoint[] {
  if (!Array.isArray(value)) return [];

  return value
    .slice(0, MAX_KNOWLEDGE_POINT_ITEMS)
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const title = typeof record.title === 'string' ? record.title.trim() : '';
      if (!title) return null;
      return {
        id: `kp-${index + 1}`,
        title: title.slice(0, 80),
        importance: toImportance(record.importance),
        knowledge_type: toKnowledgeKind(record.knowledge_type),
        suggested_cards: clamp(Number(record.suggested_cards) || 1, 1, 5),
      } satisfies AnalyzedKnowledgePoint;
    })
    .filter((item): item is AnalyzedKnowledgePoint => item !== null);
}

function buildAnalysisPrompt(content: string, local: ReturnType<typeof getDocumentSignals>): string {
  return `你是学习科学与 Anki 制卡专家。请先分析材料，不要生成卡片。

目标：识别可独立记忆的“原子知识点”，并估算合理卡片数量。数量不能只按字数决定。

【拆分原则】
1. 一个知识点只表达一个主要事实、定义、关系、公式或步骤。
2. 定义、特点、作用、原因和例子应尽量拆开。
3. 三项以上列表、复杂公式、易混概念和流程可以建议多张卡片。
4. 删除重复、铺垫、广告、修辞和不适合长期记忆的内容。
5. 不得虚构原文没有的知识。

【本地统计】
有效字符约 ${local.characters}，章节约 ${local.sections}，句子约 ${local.sentences}，
公式信号 ${local.formulas}，对比信号 ${local.comparisons}，流程信号 ${local.processes}。

【输出要求】
只返回一个 JSON 对象：
{
  "sections": 章节数,
  "knowledge_points": 原子知识点总数,
  "core_knowledge_points": 核心知识点数,
  "signals": {"formulas": 数量, "comparisons": 数量, "processes": 数量},
  "reason": "用不超过60字解释推荐依据",
  "knowledge_point_items": [
    {
      "title": "知识点标题",
      "importance": "core/important/supplementary",
      "knowledge_type": "fact/definition/comparison/sequence/formula/application",
      "suggested_cards": 1
    }
  ]
}

knowledge_point_items 最多返回 ${MAX_KNOWLEDGE_POINT_ITEMS} 项，优先列核心和重要知识点。

【材料】
${content}`;
}

export async function POST(request: NextRequest) {
  const body = await request.json() as {
    content?: string;
    modelId?: string;
  };
  const content = body.content?.trim() ?? '';

  if (content.length < 5) {
    return Response.json({ error: '内容太短，请输入更多文本' }, { status: 400 });
  }

  const analysisContent = content.slice(0, MAX_ANALYSIS_CHARS);
  const local = getDocumentSignals(analysisContent);

  if (!body.modelId) {
    return Response.json(fallbackAnalysis(content, '未选择可用模型，已使用本地估算。'));
  }

  try {
    const model = getConfiguredModel(body.modelId);
    const messages = [
      {
        role: 'system' as const,
        content: '你只输出合法 JSON。不要输出 markdown、解释、思考过程或其他文字。',
      },
      {
        role: 'user' as const,
        content: buildAnalysisPrompt(analysisContent, local),
      },
    ];
    let fullText = '';
    for await (const chunk of streamChatCompletion(model, messages, request.signal)) {
      fullText += chunk;
    }

    const parsed = extractJsonObject(fullText);
    if (!parsed) {
      return Response.json(fallbackAnalysis(content, '模型分析格式异常，已使用本地估算。'));
    }

    const items = parseKnowledgePoints(parsed.knowledge_point_items);
    const knowledgePoints = clamp(
      Number(parsed.knowledge_points) || items.length || local.sentences,
      Math.max(3, items.length),
      100,
    );
    const coreKnowledgePoints = clamp(
      Number(parsed.core_knowledge_points)
        || items.filter((item) => item.importance === 'core').length
        || knowledgePoints * 0.6,
      2,
      knowledgePoints,
    );
    const rawSignals = parsed.signals && typeof parsed.signals === 'object'
      ? parsed.signals as Record<string, unknown>
      : {};
    const signals = {
      formulas: clamp(Number(rawSignals.formulas) || local.formulas, 0, 99),
      comparisons: clamp(Number(rawSignals.comparisons) || local.comparisons, 0, 99),
      processes: clamp(Number(rawSignals.processes) || local.processes, 0, 99),
    };
    const result: ContentAnalysis = {
      mode: 'ai',
      characters: local.characters,
      sections: clamp(Number(parsed.sections) || local.sections, 1, 200),
      knowledgePoints,
      coreKnowledgePoints,
      signals,
      suggestions: buildSuggestions(knowledgePoints, coreKnowledgePoints, signals),
      reason: typeof parsed.reason === 'string' && parsed.reason.trim()
        ? parsed.reason.trim().slice(0, 120)
        : '根据原子知识点、概念密度和复杂知识类型综合推荐。',
      knowledgePointItems: items,
      truncated: content.length > MAX_ANALYSIS_CHARS,
      warning: content.length > MAX_ANALYSIS_CHARS
        ? `内容较长，本轮先分析前 ${MAX_ANALYSIS_CHARS.toLocaleString('zh-CN')} 个字符。`
        : undefined,
    };

    return Response.json(result);
  } catch (error) {
    if (request.signal.aborted) {
      return Response.json({ error: '分析已取消' }, { status: 499 });
    }
    const message = error instanceof Error ? error.message : '模型分析失败';
    return Response.json(fallbackAnalysis(content, `${message}，已使用本地估算。`));
  }
}
