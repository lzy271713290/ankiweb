import { NextRequest } from 'next/server';
import { getConfiguredModel, streamChatCompletion } from '@/lib/server/llm';
import type {
  CardType,
  ContentAnalysis,
  GenerationPlan,
  KnowledgeCard,
  SSEMessage,
} from '@/lib/types';

const MAX_GENERATION_CHARS = 20_000;
const MAX_SINGLE_BATCH_CARDS = 120;
const MAX_CARDS_PER_MODEL_CALL = 24;
const VALID_CARD_TYPES: CardType[] = ['qa', 'cloze', 'def', 'reverse', 'compare', 'sequence'];

function toCardType(value: unknown): CardType {
  return value === 'cloze' ||
    value === 'def' ||
    value === 'reverse' ||
    value === 'compare' ||
    value === 'sequence'
    ? value
    : 'qa';
}

function normalizeRequestedCardTypes(cardTypes: unknown, legacyCardType: unknown): CardType[] {
  const requested = Array.isArray(cardTypes)
    ? cardTypes.filter((type): type is CardType => VALID_CARD_TYPES.includes(type as CardType))
    : [];
  if (requested.length > 0) return [...new Set(requested)];
  return VALID_CARD_TYPES.includes(legacyCardType as CardType) ? [legacyCardType as CardType] : [];
}

function enforceRequestedCardType(value: unknown, requestedTypes: CardType[], index: number): CardType {
  const modelType = toCardType(value);
  if (requestedTypes.length === 0 || requestedTypes.includes(modelType)) return modelType;
  return requestedTypes[index % requestedTypes.length];
}

/**
 * 从流式文本中提取完整的 JSON 对象
 */
function extractCompleteObjects(
  text: string,
): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  let i = 0;
  let depth = 0;
  let inString = false;
  let escape = false;
  let objStart = -1;

  while (i < text.length) {
    const char = text[i];

    if (escape) {
      escape = false;
      i++;
      continue;
    }

    if (inString) {
      if (char === '\\') {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        const objStr = text.substring(objStart, i + 1);
        try {
          objects.push(JSON.parse(objStr));
        } catch {
          // 忽略解析错误
        }
        objStart = -1;
      }
    }
    i++;
  }

  return objects;
}

/**
 * 构建 LLM prompt
 */
function buildPrompt(
  content: string,
  cardCount: number,
  requestedTypes: CardType[],
  difficulty: number,
  generationPlan: GenerationPlan,
  previousQuestions: string[],
  analysis?: ContentAnalysis,
): string {
  const diffLabels = ['', '轻松', '较易', '中等', '较难', '困难'];
  const diffLabel = diffLabels[difficulty] || '中等';

  const typeDetails: Record<CardType, string> = {
    qa: 'qa：问题放 question，答案放 answer',
    cloze: 'cloze：question 必须包含 {{c1::答案}}，answer 留空',
    def: 'def：用于概念定义，question 询问“什么是 XX”',
    reverse: 'reverse：question 与 answer 均适合独立作为提示',
    compare: 'compare：明确比较两个概念的相同点和不同点',
    sequence: 'sequence：用于流程、步骤或有序列表',
  };
  const typeInstruction = requestedTypes.length === 0
    ? `采用混合模式，根据每个知识点的结构，在 ${VALID_CARD_TYPES.join('、')} 中选择最合适的类型。不要机械地全部使用同一种类型。`
    : `用户只允许以下卡片类型：${requestedTypes.join('、')}。每张卡片的 card_type 必须是这些值之一，绝对不得输出其他类型。${requestedTypes.map((type) => typeDetails[type]).join('；')}。${requestedTypes.length > 1 ? '在内容适合且数量足够时，应覆盖用户选择的每一种类型。' : ''}`;

  const countInstruction = `本批必须生成恰好 ${cardCount} 张高质量学习卡片。先规划 ${cardCount} 个互不重复的原子知识点，再一次性输出全部卡片。`;

  const difficultyInstruction = `难度倾向：${diffLabel}（1=轻松，5=困难）。`;
  const planLabels: Record<GenerationPlan, string> = {
    concise: '精简复习：只保留核心、高频和最值得主动回忆的内容',
    recommended: '标准推荐：覆盖核心知识点，并保留重要辨析、公式和流程',
    comprehensive: '全面覆盖：在避免重复的前提下覆盖核心、重要和补充知识点',
    custom: '自定义数量：在保持原子性和有效性的前提下达到用户指定数量',
  };
  const analyzedKnowledgePoints = analysis?.knowledgePointItems
    .map((item) => `- [${item.importance}/${item.knowledge_type}] ${item.title}（建议 ${item.suggested_cards} 张）`)
    .join('\n');
  const analysisInstruction = analysis
    ? `【内容分析结果】
识别到约 ${analysis.knowledgePoints} 个原子知识点，其中 ${analysis.coreKnowledgePoints} 个核心知识点。
生成方案：${planLabels[generationPlan]}。
${analyzedKnowledgePoints ? `优先参考的知识点：\n${analyzedKnowledgePoints}` : ''}
分析结果只用于规划，最终答案必须以待处理原文为依据。`
    : `【生成方案】
${planLabels[generationPlan]}。`;
  const deduplicationInstruction = previousQuestions.length > 0
    ? `【前面批次已经生成的问题】
${previousQuestions.slice(-30).map((question) => `- ${question}`).join('\n')}
本批不得重复考查这些问题或仅做同义改写。`
    : '';

  return `你是一个专业的 Anki 记忆卡片生成器。${countInstruction}${difficultyInstruction}

【科学拆卡规则】
1. ${typeInstruction}
2. 一张卡片只测试一个主要事实、定义、关系、公式或步骤；定义、特点、作用、原因和例子不要混在同一张卡里
3. 问题必须脱离原文仍能独立理解，避免“它、上述、这种情况”等模糊指代
4. 普通答案优先控制在 40 个汉字以内；超过 80 个汉字时必须拆卡，除非是不可再拆的步骤或对比
5. 先在内部把原文拆成原子知识点，再生成卡片；不要输出拆分过程或思考过程
6. 问题不能无意泄露答案，答案不得补充原文没有依据的事实
7. 不要制造同义改写或低价值重复；通过拆分定义、职责、关系、步骤、原因、示例和易混点达到本批指定数量
8. 三项以上列表、易混概念、公式含义与应用可以拆成多张互补卡片
9. 根据内容自动判断分类（category），并填写能定位原文的 source_section
10. 遇到 ASCII、Mermaid 或文字架构图，禁止生成“画出/复现/默写完整架构图”这类卡；必须拆成“某层职责是什么”“A 层如何调用 B 层”“一条请求经过哪些层”等可独立回答的小卡

${analysisInstruction}

${deduplicationInstruction}

【卡片类型说明】
- cloze（填空题）：在 question 字段中用 {{c1::答案}} 标记需要填空的部分，answer 字段留空
- qa（问答题）：question 字段放问题，answer 字段放答案
- def（定义卡）：question 字段放"什么是 XX？"形式的问题，answer 字段放详细定义和解释
- reverse（双向卡）：问题与答案均应适合独立作为提示，导入 Anki 后会生成正反两张卡
- compare（对比卡）：聚焦两个概念的异同点
- sequence（步骤卡）：用于流程、阶段和有序列表

【优质示例】
内容："RAG（Retrieval-Augmented Generation）是一种结合检索和生成的 AI 技术架构。"
生成：{"question": "RAG 的全称是 {{c1::Retrieval-Augmented Generation}}", "answer": "", "card_type": "cloze", "category": "AI概念", "source_section": "RAG定义"}

内容："机器学习的三种主要类型是监督学习、无监督学习和强化学习。"
生成：{"question": "机器学习的三种主要类型是什么？", "answer": "监督学习、无监督学习和强化学习", "card_type": "qa", "category": "机器学习", "source_section": "机器学习分类"}

内容："范围基准由项目范围说明书、WBS和WBS词典组成。"
生成：{"question": "范围基准由哪三部分组成？", "answer": "项目范围说明书、WBS和WBS词典。", "card_type": "qa", "category": "范围管理", "source_section": "范围基准"}

内容："风险是尚未发生的不确定事件；问题是已经发生、需要处理的现实情况。"
生成：{"question": "项目管理中，风险与问题的核心区别是什么？", "answer": "风险尚未发生；问题已经发生。", "card_type": "compare", "category": "风险管理", "source_section": "风险与问题"}

【反例】
不要生成把定义、特点、作用和例子全部塞进一个答案的长卡；应拆成多张原子卡。
不要仅替换措辞重复考查同一个事实。

【待处理内容】
${content.substring(0, MAX_GENERATION_CHARS)}

请返回 JSON 数组，不要包含任何其他文本、注释或 markdown 标记。格式如下：
[{"question": "...", "answer": "...", "card_type": "cloze/qa/def/reverse/compare/sequence", "category": "...", "source_section": "..."}]`;
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const {
    content,
    cardCount = 15,
    cardType = 'mixed',
    cardTypes,
    difficulty = 3,
    modelId,
    generationPlan = 'recommended',
    analysis,
  } = body as {
    content: string;
    cardCount?: number;
    cardType?: string;
    cardTypes?: CardType[];
    difficulty?: number;
    modelId?: string;
    generationPlan?: GenerationPlan;
    analysis?: ContentAnalysis;
  };
  const requestedTypes = normalizeRequestedCardTypes(cardTypes, cardType);

  if (!content || content.trim().length < 5) {
    return new Response(
      JSON.stringify({ error: '内容太短，请输入更多文本' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
  if (!Number.isFinite(cardCount) || cardCount < 1 || cardCount > MAX_SINGLE_BATCH_CARDS) {
    return Response.json(
      { error: `单批生成数量需在 1～${MAX_SINGLE_BATCH_CARDS} 张之间` },
      { status: 400 },
    );
  }

  let selectedModel: ReturnType<typeof getConfiguredModel>;
  try {
    selectedModel = getConfiguredModel(modelId);
  } catch (error) {
    const message = error instanceof Error ? error.message : '模型服务配置无效';
    return Response.json({ error: message }, { status: 500 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (msg: SSEMessage) => {
        const data = `data: ${JSON.stringify(msg)}\n\n`;
        controller.enqueue(encoder.encode(data));
      };

      try {
        let sentCount = 0;
        const cardTimestamp = Date.now();
        const targetCount = Math.round(cardCount);
        const seenQuestions = new Set<string>();
        const previousQuestions: string[] = [];
        const maxAttempts = Math.ceil(targetCount / MAX_CARDS_PER_MODEL_CALL) + 3;

        for (let attempt = 0; sentCount < targetCount && attempt < maxAttempts; attempt++) {
          const batchTarget = Math.min(MAX_CARDS_PER_MODEL_CALL, targetCount - sentCount);
          const messages = [
            {
              role: 'system' as const,
              content: '你是一个专业的 Anki 记忆卡片生成器。只返回 JSON 数组，不包含任何其他文字、解释或 markdown 标记。',
            },
            {
              role: 'user' as const,
              content: buildPrompt(
                content,
                batchTarget,
                requestedTypes,
                difficulty,
                generationPlan,
                previousQuestions,
                analysis,
              ),
            },
          ];
          let fullText = '';
          let parsedObjectCount = 0;

          const emitNewObjects = (objects: Record<string, unknown>[]) => {
            for (let index = parsedObjectCount; index < objects.length && sentCount < targetCount; index++) {
              parsedObjectCount++;
              const obj = objects[index];
              const question = typeof obj.question === 'string' ? obj.question.trim() : '';
              if (!question) continue;
              const questionKey = question.toLocaleLowerCase('zh-CN').replace(/[\s，。！？、；：,.!?;:]/g, '');
              if (!questionKey || seenQuestions.has(questionKey)) continue;

              const card: KnowledgeCard = {
                id: `card-${cardTimestamp}-${sentCount}`,
                question,
                answer: typeof obj.answer === 'string' ? obj.answer : '',
                category: typeof obj.category === 'string' && obj.category.trim() ? obj.category.trim() : '通用',
                card_type: enforceRequestedCardType(obj.card_type, requestedTypes, sentCount),
                source_section: typeof obj.source_section === 'string' && obj.source_section.trim()
                  ? obj.source_section.trim()
                  : (typeof obj.category === 'string' && obj.category.trim() ? obj.category.trim() : '通用'),
              };
              seenQuestions.add(questionKey);
              previousQuestions.push(question);
              send({ type: 'card', data: card });
              sentCount++;
            }
          };

          for await (const text of streamChatCompletion(selectedModel, messages, request.signal, {
            operation: 'generate',
            metadata: {
              contentCharacters: Math.min(content.length, MAX_GENERATION_CHARS),
              requestedCards: batchTarget,
              logicalRequestedCards: targetCount,
              batchNumber: attempt + 1,
              cardTypes: requestedTypes.length > 0 ? requestedTypes.join('|') : 'mixed',
              difficulty,
              generationPlan,
              truncated: content.length > MAX_GENERATION_CHARS,
            },
          })) {
            fullText += text;
            emitNewObjects(extractCompleteObjects(fullText));
          }
          emitNewObjects(extractCompleteObjects(fullText));
          send({ type: 'progress', data: { current: sentCount, total: targetCount } });
        }

        send({
          type: 'done',
          data: { total: sentCount, requested: targetCount, complete: sentCount === targetCount },
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : '生成卡片时发生未知错误';
        send({ type: 'error', data: { message } });
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
