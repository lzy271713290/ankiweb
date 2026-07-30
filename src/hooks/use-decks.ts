'use client';

import { useCallback, useEffect, useState } from 'react';
import type { KnowledgeCard, SavedDeck } from '@/lib/types';

const STORAGE_KEY = 'ankicard.saved-decks.v1';

function readStoredDecks(): SavedDeck[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedDeck[]) : [];
  } catch {
    return [];
  }
}

export function useDecks() {
  const [decks, setDecks] = useState<SavedDeck[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setDecks(readStoredDecks());
    setReady(true);
  }, []);

  useEffect(() => {
    if (ready) localStorage.setItem(STORAGE_KEY, JSON.stringify(decks));
  }, [decks, ready]);

  const saveDeck = useCallback((name: string, cards: KnowledgeCard[]) => {
    const normalizedName = name.trim() || '未命名卡组';
    const now = new Date().toISOString();
    setDecks((current) => {
      const existing = current.find(
        (deck) => deck.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase(),
      );
      if (existing) {
        return current.map((deck) =>
          deck.id === existing.id
            ? { ...deck, cards: structuredClone(cards), updatedAt: now }
            : deck,
        );
      }
      return [
        {
          id: crypto.randomUUID(),
          name: normalizedName,
          cards: structuredClone(cards),
          createdAt: now,
          updatedAt: now,
        },
        ...current,
      ];
    });
  }, []);

  const deleteDeck = useCallback((id: string) => {
    setDecks((current) => current.filter((deck) => deck.id !== id));
  }, []);

  return { decks, ready, saveDeck, deleteDeck };
}
