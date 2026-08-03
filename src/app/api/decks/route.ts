import { NextRequest } from 'next/server';
import {
  DECK_STORAGE_PATH,
  deleteDeck,
  importDecks,
  readDecks,
  saveDeck,
} from '@/lib/server/decks';
import type { CardType, KnowledgeCard, SavedDeck } from '@/lib/types';

export const runtime = 'nodejs';

const CARD_TYPES = new Set<CardType>(['cloze', 'qa', 'def', 'reverse', 'compare', 'sequence']);

function parseCard(value: unknown): KnowledgeCard | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const card = value as Record<string, unknown>;
  if (
    typeof card.id !== 'string' ||
    typeof card.question !== 'string' ||
    typeof card.answer !== 'string' ||
    typeof card.category !== 'string' ||
    typeof card.card_type !== 'string' ||
    !CARD_TYPES.has(card.card_type as CardType)
  ) return undefined;
  return {
    id: card.id,
    question: card.question,
    answer: card.answer,
    category: card.category,
    card_type: card.card_type as CardType,
    source_section: typeof card.source_section === 'string' ? card.source_section : card.category,
  };
}

function parseDeck(value: unknown): SavedDeck | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const deck = value as Record<string, unknown>;
  if (typeof deck.name !== 'string' || !Array.isArray(deck.cards)) return undefined;
  const cards = deck.cards.map(parseCard).filter((card): card is KnowledgeCard => card !== undefined);
  if (cards.length !== deck.cards.length) return undefined;
  const now = new Date().toISOString();
  return {
    id: typeof deck.id === 'string' && deck.id ? deck.id : crypto.randomUUID(),
    name: deck.name,
    cards,
    createdAt: typeof deck.createdAt === 'string' ? deck.createdAt : now,
    updatedAt: typeof deck.updatedAt === 'string' ? deck.updatedAt : now,
  };
}

export async function GET() {
  return Response.json({ decks: await readDecks(), storage: DECK_STORAGE_PATH });
}

export async function POST(request: NextRequest) {
  const body = await request.json() as Record<string, unknown>;
  if (Array.isArray(body.decks)) {
    const decks = body.decks.map(parseDeck).filter((deck): deck is SavedDeck => deck !== undefined);
    if (decks.length !== body.decks.length) {
      return Response.json({ error: '待迁移卡组数据格式不正确' }, { status: 400 });
    }
    return Response.json({ decks: await importDecks(decks), storage: DECK_STORAGE_PATH });
  }

  const deck = parseDeck(body);
  if (!deck || deck.cards.length === 0) {
    return Response.json({ error: '卡组名称或卡片数据不正确' }, { status: 400 });
  }
  return Response.json({ decks: await saveDeck(deck), storage: DECK_STORAGE_PATH });
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id')?.trim();
  if (!id) return Response.json({ error: '缺少卡组 ID' }, { status: 400 });
  try {
    return Response.json({ decks: await deleteDeck(id), storage: DECK_STORAGE_PATH });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : '删除卡组失败' },
      { status: 400 },
    );
  }
}
