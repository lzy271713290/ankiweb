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

function toCardType(value: unknown): CardType {
  return value === 'cloze' ||
    value === 'def' ||
    value === 'reverse' ||
    value === 'compare' ||
    value === 'sequence'
    ? value
    : 'qa';
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
  preferCloze: boolean,
  coverAll: boolean,
  cardType: string,
  difficulty: number,
  generationPlan: GenerationPlan,
  analysis?: ContentAnalysis,
): string {
  const diffLabels = ['', '轻松', '较易', '中等', '较难', '困难'];
  const diffLabel = diffLabels[difficulty] || '中等';

  let typeInstruction = '';
  if (cardType === 'mixed') {
    typeInstruction = '根据内容自动选择最合适的卡片类型（qa、cloze、def）。';
  } else if (cardType === 'qa') {
    typeInstruction = '只生成问答卡（qa）。';
  } else if (cardType === 'cloze') {
    typeInstruction = '只生成填空题（cloze），用 {{c1::答案}} 标记答案。';
  } else if (cardType === 'def') {
    typeInstruction = '只生成定义卡（def），question 字段放"什么是 XX？"形式的问题，answer 字段放详细定义。';
  } else if (cardType === 'reverse') {
    typeInstruction = '只生成双向卡（reverse），question 和 answer 必须都是可独立识别、适合正反两个方向复习的内容。';
  } else if (cardType === 'compare') {
    typeInstruction = '只生成对比卡（compare），question 明确指出需要比较的两个概念，answer 用简洁的相同点和不同点回答。';
  } else if (cardType === 'sequence') {
    typeInstruction = '只生成步骤卡（sequence），question 询问流程或顺序，answer 用有序步骤回答。';
  } else if (preferCloze) {
    typeInstruction = '优先使用填空题（cloze）格式，用 {{c1::答案}} 标记答案。';
  } else {
    typeInstruction = '灵活使用问答（qa）和填空题（cloze）格式。';
  }

  const countInstruction = coverAll
    ? `请覆盖文本中的所有关键知识点，根据内容量生成合适数量的卡片，确保没有遗漏任何重要知识点。不要限制卡片数量，宁多勿少。`
    : `请根据以下内容生成 ${cardCount} 张高质量的学习卡片。`;

  const difficultyInstruction = `难度倾向：${diffLabel}（1=轻松，5=困难）。`;
  const planLabels: Record<GenerationPlan, string> = {
    concise: '精简复习：只保留核心、高频和最值得主动回忆的内容',
    recommended: '标准推荐：覆盖核心知识点，并保留重要辨析、公式和流程',
    comprehensive: '全面覆盖：在避免重复的前提下覆盖核心、重要和补充知识点',
    custom: '自定义数量：优先保证原子性和有效性，不为凑数制造同义重复',
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

  return `你是一个专业的 Anki 记忆卡片生成器。${countInstruction}${difficultyInstruction}

【科学拆卡规则】
1. ${typeInstruction}
2. 一张卡片只测试一个主要事实、定义、关系、公式或步骤；定义、特点、作用、原因和例子不要混在同一张卡里
3. 问题必须脱离原文仍能独立理解，避免“它、上述、这种情况”等模糊指代
4. 普通答案优先控制在 40 个汉字以内；超过 80 个汉字时必须拆卡，除非是不可再拆的步骤或对比
5. 先在内部把原文拆成原子知识点，再生成卡片；不要输出拆分过程或思考过程
6. 问题不能无意泄露答案，答案不得补充原文没有依据的事实
7. 不要为达到数量制造同义改写或低价值重复；若有效知识不足，可以少于目标数量
8. 三项以上列表、易混概念、公式含义与应用可以拆成多张互补卡片
9. 根据内容自动判断分类（category），并填写能定位原文的 source_section

${analysisInstruction}

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
    preferCloze = true,
    coverAll = false,
    cardType = 'mixed',
    difficulty = 3,
    modelId,
    generationPlan = 'recommended',
    analysis,
  } = body as {
    content: string;
    cardCount?: number;
    preferCloze?: boolean;
    coverAll?: boolean;
    cardType?: string;
    difficulty?: number;
    modelId?: string;
    generationPlan?: GenerationPlan;
    analysis?: ContentAnalysis;
  };

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

  const messages = [
    {
      role: 'system' as const,
      content:
        '你是一个专业的 Anki 记忆卡片生成器。只返回 JSON 数组，不包含任何其他文字、解释或 markdown 标记。',
    },
    {
      role: 'user' as const,
      content: buildPrompt(
        content,
        Math.round(cardCount),
        preferCloze,
        coverAll,
        cardType,
        difficulty,
        generationPlan,
        analysis,
      ),
    },
  ];

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (msg: SSEMessage) => {
        const data = `data: ${JSON.stringify(msg)}\n\n`;
        controller.enqueue(encoder.encode(data));
      };

      try {
        let fullText = '';
        let sentCount = 0;
        const cardTimestamp = Date.now();

        for await (const text of streamChatCompletion(selectedModel, messages, request.signal)) {
          fullText += text;

          // 每次只发送新出现的完整对象。
          const objects = extractCompleteObjects(fullText);
          for (let i = sentCount; i < objects.length; i++) {
              const obj = objects[i];
              const card: KnowledgeCard = {
                id: `card-${cardTimestamp}-${sentCount}`,
                question: (obj.question as string) || '',
                answer: (obj.answer as string) || '',
                category: (obj.category as string) || '通用',
                card_type: toCardType(obj.card_type),
                source_section: (obj.source_section as string) || (obj.category as string) || '通用',
              };
              send({ type: 'card', data: card });
              sentCount++;
          }
        }

        // 流结束后，尝试解析剩余文本中的完整对象
        const finalObjects = extractCompleteObjects(fullText);
        if (finalObjects.length > sentCount) {
          for (let i = sentCount; i < finalObjects.length; i++) {
            const obj = finalObjects[i];
            const card: KnowledgeCard = {
              id: `card-${cardTimestamp}-${i}`,
              question: (obj.question as string) || '',
              answer: (obj.answer as string) || '',
              category: (obj.category as string) || '通用',
              card_type: toCardType(obj.card_type),
              source_section: (obj.source_section as string) || (obj.category as string) || '通用',
            };
            send({ type: 'card', data: card });
            sentCount++;
          }
        }

        send({ type: 'done', data: { total: sentCount } });
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
