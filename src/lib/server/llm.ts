import type { ModelOption } from '@/lib/types';

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string;
    };
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

interface ServerModel extends ModelOption {
  apiKey?: string;
  baseUrl?: string;
  demo?: boolean;
  disableThinking?: boolean;
}

function parseCustomModels(): Array<{ model: string; label: string }> {
  return (process.env.CUSTOM_LLM_MODELS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [model, label] = item.split('|').map((part) => part.trim());
      return { model, label: label || model };
    });
}

function buildCatalog(): ServerModel[] {
  const deepseekKey = process.env.DEEPSEEK_API_KEY?.trim();
  const catalog: ServerModel[] = [
    {
      id: 'deepseek:deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      provider: 'DeepSeek',
      model: 'deepseek-v4-flash',
      configured: Boolean(deepseekKey),
      recommended: true,
      apiKey: deepseekKey,
      baseUrl: 'https://api.deepseek.com',
      disableThinking: true,
    },
    {
      id: 'deepseek:deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      provider: 'DeepSeek',
      model: 'deepseek-v4-pro',
      configured: Boolean(deepseekKey),
      apiKey: deepseekKey,
      baseUrl: 'https://api.deepseek.com',
      disableThinking: true,
    },
  ];

  const customKey = process.env.CUSTOM_LLM_API_KEY?.trim();
  const customBaseUrl = process.env.CUSTOM_LLM_BASE_URL?.trim();
  for (const item of parseCustomModels()) {
    catalog.push({
      id: `custom:${item.model}`,
      label: item.label,
      provider: process.env.CUSTOM_LLM_PROVIDER_NAME?.trim() || '自定义模型',
      model: item.model,
      configured: Boolean(customKey && customBaseUrl),
      apiKey: customKey,
      baseUrl: customBaseUrl,
    });
  }

  const legacyKey = process.env.LLM_API_KEY?.trim();
  const legacyModel = process.env.LLM_MODEL?.trim();
  if (legacyKey && legacyModel) {
    catalog.push({
      id: `compatible:${legacyModel}`,
      label: legacyModel,
      provider: 'OpenAI 兼容接口',
      model: legacyModel,
      configured: true,
      apiKey: legacyKey,
      baseUrl: (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').trim(),
    });
  }

  if (process.env.ENABLE_DEMO_MODEL === 'true') {
    catalog.unshift({
      id: 'demo:local',
      label: '本地演示模型',
      provider: '仅供流程测试',
      model: 'local-demo',
      configured: true,
      demo: true,
    });
  }

  return catalog;
}

export function getPublicModels(): ModelOption[] {
  return buildCatalog().map((model) => ({
    id: model.id,
    label: model.label,
    provider: model.provider,
    model: model.model,
    configured: model.configured,
    recommended: model.recommended,
  }));
}

export function getConfiguredModel(modelId?: string): ServerModel {
  const configuredModels = buildCatalog().filter((model) => model.configured);
  const selected = modelId
    ? configuredModels.find((model) => model.id === modelId)
    : configuredModels.find((model) => model.recommended) || configuredModels[0];

  if (!selected) {
    throw new Error('没有可用模型，请先配置 DEEPSEEK_API_KEY 或自定义模型环境变量');
  }
  return selected;
}

function completionEndpoint(baseUrl: string): URL {
  return new URL('chat/completions', `${baseUrl.replace(/\/$/, '')}/`);
}

function demoCardsFromPrompt(prompt: string): string {
  const requestedCount = Number(prompt.match(/生成\s+(\d+)\s+张/)?.[1] || 6);
  const count = Math.min(Math.max(requestedCount, 1), 10);
  const content = prompt.split('【待处理内容】')[1]?.split('请返回 JSON')[0]?.trim() || '这是用于验证完整流程的演示材料。';
  const sentences = content
    .split(/(?<=[。！？\n])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 4);
  const source = sentences.length > 0 ? sentences : [content];
  const forcedType =
    prompt.includes('只生成问答卡') ? 'qa'
      : prompt.includes('只生成填空题') ? 'cloze'
        : prompt.includes('只生成定义卡') ? 'def'
          : prompt.includes('只生成双向卡') ? 'reverse'
            : prompt.includes('只生成对比卡') ? 'compare'
              : prompt.includes('只生成步骤卡') ? 'sequence'
                : undefined;
  const types = ['qa', 'cloze', 'def', 'reverse', 'compare', 'sequence'] as const;
  const cards = Array.from({ length: count }, (_, index) => {
    const sentence = source[index % source.length].replace(/^[#\-\d.\s]+/, '').trim();
    const type = forcedType || types[index % types.length];
    const keyword = sentence.slice(0, Math.min(8, sentence.length));

    if (type === 'cloze') {
      return {
        question: sentence.replace(keyword, `{{c1::${keyword}}}`),
        answer: '',
        card_type: type,
        category: '演示材料',
      };
    }
    if (type === 'def') {
      return { question: `如何理解“${keyword}”？`, answer: sentence, card_type: type, category: '核心概念' };
    }
    if (type === 'reverse') {
      return { question: keyword, answer: sentence, card_type: type, category: '双向记忆' };
    }
    if (type === 'compare') {
      return { question: `比较并辨析第 ${index + 1} 个知识点。`, answer: sentence, card_type: type, category: '对比辨析' };
    }
    if (type === 'sequence') {
      return { question: `第 ${index + 1} 个步骤或要点是什么？`, answer: sentence, card_type: type, category: '流程步骤' };
    }
    return { question: `材料中的第 ${index + 1} 个关键知识点是什么？`, answer: sentence, card_type: type, category: '核心知识' };
  });
  return JSON.stringify(cards);
}

function demoAnalysisFromPrompt(prompt: string): string {
  const content = prompt.split('【材料】')[1]?.trim() || '用于验证分析流程的演示材料。';
  const sentences = content
    .split(/[。！？!?\n]+/)
    .map((sentence) => sentence.replace(/^[#\-\d.\s]+/, '').trim())
    .filter((sentence) => sentence.length >= 6);
  const points = (sentences.length > 0 ? sentences : [content])
    .slice(0, 12)
    .map((sentence, index) => ({
      title: sentence.slice(0, 28),
      importance: index < 4 ? 'core' : 'important',
      knowledge_type:
        /区别|相比|不同/.test(sentence) ? 'comparison'
          : /步骤|流程|首先|其次|最后/.test(sentence) ? 'sequence'
            : /公式|=|计算/.test(sentence) ? 'formula'
              : index === 0 ? 'definition'
                : 'fact',
      suggested_cards: /区别|相比|不同|步骤|流程|公式|计算/.test(sentence) ? 2 : 1,
    }));
  const formulas = sentences.filter((sentence) => /公式|=|计算/.test(sentence)).length;
  const comparisons = sentences.filter((sentence) => /区别|相比|不同/.test(sentence)).length;
  const processes = sentences.filter((sentence) => /步骤|流程|首先|其次|最后/.test(sentence)).length;

  return JSON.stringify({
    sections: Math.max(1, content.split(/\n#{1,6}\s|第.+章/).length),
    knowledge_points: Math.max(3, points.length),
    core_knowledge_points: Math.max(2, points.filter((point) => point.importance === 'core').length),
    signals: { formulas, comparisons, processes },
    reason: '演示模型根据句子、概念关系和复杂知识类型给出建议。',
    knowledge_point_items: points,
  });
}

function demoResponseFromPrompt(prompt: string): string {
  return prompt.includes('请先分析材料，不要生成卡片')
    ? demoAnalysisFromPrompt(prompt)
    : demoCardsFromPrompt(prompt);
}

export async function* streamChatCompletion(
  model: ServerModel,
  messages: ChatMessage[],
  signal: AbortSignal,
): AsyncGenerator<string> {
  if (model.demo) {
    const content = demoResponseFromPrompt(messages.at(-1)?.content || '');
    for (let index = 0; index < content.length; index += 48) {
      yield content.slice(index, index + 48);
    }
    return;
  }

  if (!model.apiKey || !model.baseUrl) throw new Error('模型配置不完整');
  const body: Record<string, unknown> = {
    messages,
    model: model.model,
    stream: true,
    temperature: 0.7,
  };
  if (model.disableThinking) body.thinking = { type: 'disabled' };

  const response = await fetch(completionEndpoint(model.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${model.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
    signal,
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`模型服务请求失败（${response.status}）${detail ? `: ${detail}` : ''}`);
  }
  if (!response.body) throw new Error('模型服务未返回响应流');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? '' : (lines.pop() || '');

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      const chunk = JSON.parse(payload) as ChatCompletionChunk;
      if (chunk.error?.message) throw new Error(chunk.error.message);
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) yield content;
    }
    if (done) break;
  }
}

export async function testModelConnection(modelId: string): Promise<{ message: string; latencyMs: number }> {
  const model = getConfiguredModel(modelId);
  const startedAt = performance.now();
  if (model.demo) return { message: '演示模型工作正常', latencyMs: Math.round(performance.now() - startedAt) };
  if (!model.apiKey || !model.baseUrl) throw new Error('模型配置不完整');

  const body: Record<string, unknown> = {
    model: model.model,
    messages: [{ role: 'user', content: '只回复 OK' }],
    stream: false,
    max_tokens: 16,
    temperature: 0,
  };
  if (model.disableThinking) body.thinking = { type: 'disabled' };

  const response = await fetch(completionEndpoint(model.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${model.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  });
  const payload = (await response.json().catch(() => null)) as ChatCompletionChunk | null;
  if (!response.ok) {
    throw new Error(payload?.error?.message || `模型连接失败（${response.status}）`);
  }
  const message = payload?.choices?.[0]?.message?.content?.trim();
  if (!message) throw new Error('模型已响应，但没有返回文本内容');
  return { message, latencyMs: Math.round(performance.now() - startedAt) };
}
