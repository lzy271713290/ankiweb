'use client';

import { useCallback, useEffect, useState } from 'react';
import type { KnowledgeCard, SavedDeck } from '@/lib/types';

const LEGACY_STORAGE_KEY = 'ankicard.saved-decks.v1';

interface DecksResponse {
  decks?: SavedDeck[];
  error?: string;
  storage?: string;
}

function readLegacyDecks(): SavedDeck[] {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedDeck[]) : [];
  } catch {
    return [];
  }
}

async function readResponse(response: Response): Promise<SavedDeck[]> {
  const payload = await response.json() as DecksResponse;
  if (!response.ok) throw new Error(payload.error || '卡组存储操作失败');
  return Array.isArray(payload.decks) ? payload.decks : [];
}

export function useDecks() {
  const [decks, setDecks] = useState<SavedDeck[]>([]);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const loadDecks = async () => {
      const legacyDecks = readLegacyDecks();
      try {
        const response = await fetch('/api/decks', legacyDecks.length > 0 ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decks: legacyDecks }),
        } : undefined);
        const storedDecks = await readResponse(response);
        if (cancelled) return;
        setDecks(storedDecks);
        setStorageError('');
        if (legacyDecks.length > 0) localStorage.removeItem(LEGACY_STORAGE_KEY);
      } catch (error) {
        if (cancelled) return;
        setDecks(legacyDecks);
        setStorageError(error instanceof Error ? error.message : '无法读取 SQLite 卡组');
      } finally {
        if (!cancelled) setReady(true);
      }
    };
    void loadDecks();
    return () => {
      cancelled = true;
    };
  }, []);

  const saveDeck = useCallback(async (name: string, cards: KnowledgeCard[]) => {
    const response = await fetch('/api/decks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, cards }),
    });
    const storedDecks = await readResponse(response);
    setDecks(storedDecks);
    setStorageError('');
  }, []);

  const deleteDeck = useCallback(async (id: string) => {
    const response = await fetch(`/api/decks?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    const storedDecks = await readResponse(response);
    setDecks(storedDecks);
    setStorageError('');
  }, []);

  return { decks, ready, storageError, saveDeck, deleteDeck };
}
