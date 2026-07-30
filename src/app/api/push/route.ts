import { NextRequest, NextResponse } from 'next/server';
import type { KnowledgeCard } from '@/lib/types';

type ChannelId = 'feishu' | 'wecom';

function assertWebhook(channel: ChannelId): URL {
  const value =
    channel === 'feishu'
      ? process.env.FEISHU_WEBHOOK_URL?.trim()
      : process.env.WECOM_WEBHOOK_URL?.trim();
  if (!value) throw new Error(`${channel === 'feishu' ? '飞书' : '企业微信'}机器人尚未配置`);

  const url = new URL(value);
  const expectedHost = channel === 'feishu' ? 'open.feishu.cn' : 'qyapi.weixin.qq.com';
  if (url.protocol !== 'https:' || url.hostname !== expectedHost) {
    throw new Error('机器人 Webhook 地址不合法');
  }
  return url;
}

function isKnowledgeCard(value: unknown): value is KnowledgeCard {
  if (typeof value !== 'object' || value === null) return false;
  const card = value as Partial<KnowledgeCard>;
  return (
    typeof card.question === 'string' &&
    typeof card.answer === 'string' &&
    typeof card.category === 'string' &&
    typeof card.card_type === 'string'
  );
}

function formatCards(deckName: string, cards: KnowledgeCard[]): string {
  const cardText = cards
    .slice(0, 5)
    .map((card, index) => {
      const answer =
        card.card_type === 'cloze'
          ? card.question.replace(/\{\{c\d+::(.*?)(?:::(.*?))?}}/g, '$1')
          : card.answer || '（无答案）';
      return `${index + 1}. ${card.question}\n答案：${answer}`;
    })
    .join('\n\n');
  const suffix = cards.length > 5 ? `\n\n还有 ${cards.length - 5} 张卡片，请在 AnkiCard AI 中继续学习。` : '';
  return `📚 AnkiCard AI · 今日卡组：${deckName}\n\n${cardText}${suffix}`;
}

export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json();
    if (typeof body !== 'object' || body === null) {
      return NextResponse.json({ error: '请求格式不正确' }, { status: 400 });
    }
    const { channel, deckName, cards } = body as {
      channel?: unknown;
      deckName?: unknown;
      cards?: unknown;
    };
    if (channel !== 'feishu' && channel !== 'wecom') {
      return NextResponse.json({ error: '不支持的推送渠道' }, { status: 400 });
    }
    if (typeof deckName !== 'string' || !Array.isArray(cards) || !cards.every(isKnowledgeCard) || cards.length === 0) {
      return NextResponse.json({ error: '请选择包含卡片的卡组' }, { status: 400 });
    }

    const webhook = assertWebhook(channel);
    const content = formatCards(deckName.trim() || '未命名卡组', cards);
    const payload =
      channel === 'feishu'
        ? { msg_type: 'text', content: { text: content } }
        : { msgtype: 'markdown', markdown: { content } };
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    const result = (await response.json().catch(() => null)) as
      | { code?: number; StatusCode?: number; errcode?: number; msg?: string; errmsg?: string }
      | null;
    const remoteCode = channel === 'feishu' ? result?.code : result?.errcode;
    if (!response.ok || (typeof remoteCode === 'number' && remoteCode !== 0)) {
      throw new Error(result?.msg || result?.errmsg || `推送失败（${response.status}）`);
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : '推送失败';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
