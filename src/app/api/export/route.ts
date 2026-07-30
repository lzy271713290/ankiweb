import { NextRequest, NextResponse } from 'next/server';
import { exportApkg } from '@/lib/anki';
import type { KnowledgeCard } from '@/lib/types';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cards, deckName } = body as {
      cards: KnowledgeCard[];
      deckName: string;
    };

    if (!cards || !Array.isArray(cards) || cards.length === 0) {
      return NextResponse.json(
        { error: '没有可导出的卡片' },
        { status: 400 },
      );
    }

    const safeDeckName = (deckName || 'AnkiCard Deck').replace(/[^\w\s\u4e00-\u9fff-]/g, '').trim() || 'AnkiCard Deck';

    const apkgBuffer = await exportApkg(cards, safeDeckName);

    const filename = encodeURIComponent(`${safeDeckName}.apkg`);

    return new NextResponse(new Uint8Array(apkgBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
        'Content-Length': apkgBuffer.length.toString(),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : '导出失败，请重试';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
