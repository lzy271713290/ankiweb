import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Database, SqlJsStatic } from 'sql.js';
import type { KnowledgeCard, SavedDeck } from '@/lib/types';

interface BundledDeckDocument {
  deckName: string;
  version: string;
  releaseStatus?: string;
  releaseDate?: string;
  scope?: string;
  reviewSummary?: string;
  sources?: unknown[];
  cards: KnowledgeCard[];
}

interface SaveDeckInput {
  id?: string;
  name: string;
  cards: KnowledgeCard[];
  createdAt?: string;
  updatedAt?: string;
}

const DATA_DIRECTORY = path.join(process.cwd(), 'data');
const DECKS_FILE = path.join(DATA_DIRECTORY, 'decks.sqlite');
const SQL_WASM_FILE = path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
const BUNDLED_DECK_FILE = path.join(
  process.cwd(),
  'content',
  'decks',
  'system-integration-pm-sample.json',
);
const BUNDLED_DECK_ID = 'bundled:system-integration-pm-core';

let sqlPromise: Promise<SqlJsStatic> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

async function getSQL(): Promise<SqlJsStatic> {
  if (sqlPromise) return sqlPromise;
  sqlPromise = (async () => {
    const initModule = await import('sql.js');
    const initSqlJs = initModule.default || initModule;
    const wasm = await readFile(SQL_WASM_FILE);
    const wasmBinary = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer;
    return initSqlJs({ wasmBinary });
  })();
  return sqlPromise;
}

function createSchema(db: Database): void {
  db.run(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS decks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      storage_kind TEXT NOT NULL DEFAULT 'user',
      version TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      metadata_json TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS decks_name_nocase_idx
      ON decks(name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS decks_updated_at_idx
      ON decks(updated_at DESC);
    CREATE TABLE IF NOT EXISTS cards (
      deck_id TEXT NOT NULL,
      id TEXT NOT NULL,
      position INTEGER NOT NULL,
      card_json TEXT NOT NULL,
      PRIMARY KEY (deck_id, id),
      FOREIGN KEY (deck_id) REFERENCES decks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS cards_deck_position_idx
      ON cards(deck_id, position);
  `);
}

async function openDatabase(): Promise<Database> {
  const SQL = await getSQL();
  try {
    const bytes = await readFile(DECKS_FILE);
    const db = new SQL.Database(new Uint8Array(bytes));
    createSchema(db);
    return db;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const db = new SQL.Database();
    createSchema(db);
    return db;
  }
}

async function persistDatabase(db: Database): Promise<void> {
  await mkdir(DATA_DIRECTORY, { recursive: true });
  const temporaryFile = `${DECKS_FILE}.${process.pid}.tmp`;
  await writeFile(temporaryFile, Buffer.from(db.export()));
  await rename(temporaryFile, DECKS_FILE);
}

function writeCards(db: Database, deckId: string, cards: KnowledgeCard[]): void {
  db.run('DELETE FROM cards WHERE deck_id = ?', [deckId]);
  const statement = db.prepare(
    'INSERT INTO cards (deck_id, id, position, card_json) VALUES (?, ?, ?, ?)',
  );
  try {
    cards.forEach((card, position) => {
      statement.run([deckId, card.id, position, JSON.stringify(card)]);
    });
  } finally {
    statement.free();
  }
}

function findDeckByName(
  db: Database,
  name: string,
): { id: string; storageKind: string } | undefined {
  const statement = db.prepare(
    'SELECT id, storage_kind FROM decks WHERE name = ? COLLATE NOCASE LIMIT 1',
  );
  try {
    statement.bind([name]);
    if (!statement.step()) return undefined;
    const row = statement.getAsObject();
    return { id: String(row.id), storageKind: String(row.storage_kind) };
  } finally {
    statement.free();
  }
}

function upsertUserDeck(db: Database, input: SaveDeckInput): string {
  let normalizedName = input.name.trim() || '未命名卡组';
  let existing = findDeckByName(db, normalizedName);
  if (existing?.storageKind === 'bundled') {
    normalizedName = `${normalizedName}（我的副本）`;
    existing = findDeckByName(db, normalizedName);
  }
  const safeInputId = input.id === BUNDLED_DECK_ID ? undefined : input.id;
  const id = existing?.id || safeInputId || crypto.randomUUID();
  const now = new Date().toISOString();
  const createdAt = input.createdAt || now;
  const updatedAt = input.updatedAt || now;

  db.run('BEGIN');
  try {
    db.run(
      `INSERT INTO decks (id, name, storage_kind, version, created_at, updated_at, metadata_json)
       VALUES (?, ?, 'user', NULL, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         updated_at = excluded.updated_at`,
      [id, normalizedName, createdAt, updatedAt],
    );
    writeCards(db, id, input.cards);
    db.run('COMMIT');
    return id;
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

async function seedBundledDeck(db: Database): Promise<boolean> {
  const source = JSON.parse(await readFile(BUNDLED_DECK_FILE, 'utf8')) as BundledDeckDocument;
  const statement = db.prepare('SELECT version FROM decks WHERE id = ? LIMIT 1');
  let currentVersion: string | undefined;
  try {
    statement.bind([BUNDLED_DECK_ID]);
    if (statement.step()) currentVersion = String(statement.getAsObject().version || '');
  } finally {
    statement.free();
  }
  if (currentVersion === source.version) return false;

  const releaseDate = source.releaseDate
    ? new Date(`${source.releaseDate}T00:00:00+08:00`).toISOString()
    : new Date().toISOString();
  const metadata = {
    scope: source.scope,
    releaseStatus: source.releaseStatus,
    reviewSummary: source.reviewSummary,
    sources: source.sources,
  };

  db.run('BEGIN');
  try {
    db.run(
      `INSERT INTO decks (id, name, storage_kind, version, created_at, updated_at, metadata_json)
       VALUES (?, ?, 'bundled', ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         version = excluded.version,
         updated_at = excluded.updated_at,
         metadata_json = excluded.metadata_json`,
      [
        BUNDLED_DECK_ID,
        source.deckName,
        source.version,
        releaseDate,
        releaseDate,
        JSON.stringify(metadata),
      ],
    );
    writeCards(db, BUNDLED_DECK_ID, source.cards);
    db.run('COMMIT');
    return true;
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

function readCards(db: Database, deckId: string): KnowledgeCard[] {
  const statement = db.prepare(
    'SELECT card_json FROM cards WHERE deck_id = ? ORDER BY position ASC',
  );
  const cards: KnowledgeCard[] = [];
  try {
    statement.bind([deckId]);
    while (statement.step()) {
      const parsed = JSON.parse(String(statement.getAsObject().card_json)) as KnowledgeCard;
      cards.push(parsed);
    }
    return cards;
  } finally {
    statement.free();
  }
}

function readDecksFromDatabase(db: Database): SavedDeck[] {
  const statement = db.prepare(`
    SELECT id, name, storage_kind, version, created_at, updated_at
    FROM decks
    ORDER BY CASE storage_kind WHEN 'bundled' THEN 0 ELSE 1 END, updated_at DESC
  `);
  const decks: SavedDeck[] = [];
  try {
    while (statement.step()) {
      const row = statement.getAsObject();
      const id = String(row.id);
      decks.push({
        id,
        name: String(row.name),
        cards: readCards(db, id),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        storageKind: row.storage_kind === 'bundled' ? 'bundled' : 'user',
        version: typeof row.version === 'string' && row.version ? row.version : undefined,
      });
    }
    return decks;
  } finally {
    statement.free();
  }
}

export async function readDecks(): Promise<SavedDeck[]> {
  await writeQueue.catch(() => undefined);
  const db = await openDatabase();
  try {
    if (await seedBundledDeck(db)) await persistDatabase(db);
    return readDecksFromDatabase(db);
  } finally {
    db.close();
  }
}

export async function saveDeck(input: SaveDeckInput): Promise<SavedDeck[]> {
  let result: SavedDeck[] = [];
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    const db = await openDatabase();
    try {
      await seedBundledDeck(db);
      upsertUserDeck(db, input);
      await persistDatabase(db);
      result = readDecksFromDatabase(db);
    } finally {
      db.close();
    }
  });
  await writeQueue;
  return result;
}

export async function importDecks(inputs: SaveDeckInput[]): Promise<SavedDeck[]> {
  let result: SavedDeck[] = [];
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    const db = await openDatabase();
    try {
      await seedBundledDeck(db);
      for (const input of inputs) upsertUserDeck(db, input);
      await persistDatabase(db);
      result = readDecksFromDatabase(db);
    } finally {
      db.close();
    }
  });
  await writeQueue;
  return result;
}

export async function deleteDeck(id: string): Promise<SavedDeck[]> {
  let result: SavedDeck[] = [];
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    const db = await openDatabase();
    try {
      await seedBundledDeck(db);
      const statement = db.prepare('SELECT storage_kind FROM decks WHERE id = ? LIMIT 1');
      let storageKind: string | undefined;
      try {
        statement.bind([id]);
        if (statement.step()) storageKind = String(statement.getAsObject().storage_kind);
      } finally {
        statement.free();
      }
      if (storageKind === 'bundled') throw new Error('内置卡组不能删除');
      db.run('DELETE FROM decks WHERE id = ?', [id]);
      await persistDatabase(db);
      result = readDecksFromDatabase(db);
    } finally {
      db.close();
    }
  });
  await writeQueue;
  return result;
}

export const DECK_STORAGE_PATH = 'data/decks.sqlite';
