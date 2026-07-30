import type { Database, SqlJsStatic } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';
import JSZip from 'jszip';
import * as CRC32 from 'crc-32';
import type { KnowledgeCard } from './types';

// ============================================================
// 常量
// ============================================================

const BASIC_MODEL_ID = 1607392319;
const CLOZE_MODEL_ID = 1607392320;
const DEF_MODEL_ID = 1607392321;
const REVERSE_MODEL_ID = 1607392322;
const DECK_ID = 2059400110;
const DECK_CONFIG_ID = 1;
const SCHEMA_VER = 11;
const FIELD_SEPARATOR = String.fromCharCode(0x1f);

// ============================================================
// Anki 模型定义
// ============================================================

const BASIC_MODEL_CSS = `
.card {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 16px;
  text-align: left;
  color: #333;
  padding: 20px;
}
.category {
  font-size: 12px;
  color: #888;
  margin-bottom: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.question {
  font-size: 18px;
  font-weight: 600;
  color: #1a1a1a;
  margin-bottom: 20px;
  line-height: 1.5;
}
.answer {
  font-size: 16px;
  color: #2d5016;
  background: #f0f7f0;
  padding: 15px;
  border-radius: 8px;
  line-height: 1.6;
}
.source {
  font-size: 11px;
  color: #aaa;
  margin-top: 15px;
}
`;

const CLOZE_MODEL_CSS = `
.card {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 16px;
  text-align: left;
  color: #333;
  padding: 20px;
}
.cloze {
  font-weight: bold;
  color: #0066cc;
  background: #e6f0ff;
  padding: 2px 6px;
  border-radius: 4px;
}
.extra {
  font-size: 12px;
  color: #666;
  margin-top: 15px;
}
`;

const DEF_MODEL_CSS = `
.card {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 16px;
  text-align: left;
  color: #333;
  padding: 20px;
}
.category {
  font-size: 12px;
  color: #888;
  margin-bottom: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.question {
  font-size: 18px;
  font-weight: 600;
  color: #1a1a1a;
  margin-bottom: 20px;
  line-height: 1.5;
}
.answer {
  font-size: 16px;
  color: #2d5016;
  background: #f0f7f0;
  padding: 15px;
  border-radius: 8px;
  line-height: 1.6;
}
.source {
  font-size: 11px;
  color: #aaa;
  margin-top: 15px;
}
`;

function createBasicModel() {
  return {
    id: BASIC_MODEL_ID,
    name: 'AnkiCard Basic',
    type: 0,
    mod: 0,
    usn: -1,
    sortf: 0,
    did: DECK_ID,
    tmpls: [
      {
        name: 'Card 1',
        ord: 0,
        qfmt: '<div class="category">{{Category}}</div>\n<div class="question">{{Question}}</div>',
        afmt: '{{FrontSide}}\n<hr id="answer">\n<div class="answer">{{Answer}}</div>\n<div class="source">Source: {{Source}}</div>',
        bqfmt: '',
        bafmt: '',
        did: null,
      },
    ],
    flds: [
      { name: 'Question', ord: 0, sticky: false, media: [] },
      { name: 'Answer', ord: 1, sticky: false, media: [] },
      { name: 'Category', ord: 2, sticky: false, media: [] },
      { name: 'Source', ord: 3, sticky: false, media: [] },
    ],
    css: BASIC_MODEL_CSS.replace(/\n/g, '\n').trim(),
    req: [[0, 'any', [0]]],
    vers: [],
  };
}

function createClozeModel() {
  return {
    id: CLOZE_MODEL_ID,
    name: 'AnkiCard Cloze',
    type: 1,
    mod: 0,
    usn: -1,
    sortf: 0,
    did: DECK_ID,
    tmpls: [
      {
        name: 'Cloze',
        ord: 0,
        qfmt: '{{cloze:Text}}',
        afmt: '{{cloze:Text}}<br><hr id="extra"><div class="extra">{{Extra}}</div>',
        bqfmt: '',
        bafmt: '',
        did: null,
      },
    ],
    flds: [
      { name: 'Text', ord: 0, sticky: false, media: [] },
      { name: 'Extra', ord: 1, sticky: false, media: [] },
    ],
    css: CLOZE_MODEL_CSS.replace(/\n/g, '\n').trim(),
    req: [],
    vers: [],
  };
}

function createDefModel() {
  return {
    id: DEF_MODEL_ID,
    name: 'AnkiCard Definition',
    type: 0,
    mod: 0,
    usn: -1,
    sortf: 0,
    did: DECK_ID,
    tmpls: [
      {
        name: 'Card 1',
        ord: 0,
        qfmt: '<div class="category">{{Category}}</div>\n<div class="question">{{Question}}</div>',
        afmt: '{{FrontSide}}\n<hr id="answer">\n<div class="answer">{{Answer}}</div>\n<div class="source">Source: {{Source}}</div>',
        bqfmt: '',
        bafmt: '',
        did: null,
      },
    ],
    flds: [
      { name: 'Question', ord: 0, sticky: false, media: [] },
      { name: 'Answer', ord: 1, sticky: false, media: [] },
      { name: 'Category', ord: 2, sticky: false, media: [] },
      { name: 'Source', ord: 3, sticky: false, media: [] },
    ],
    css: DEF_MODEL_CSS.replace(/\n/g, '\n').trim(),
    req: [[0, 'any', [0]]],
    vers: [],
  };
}

function createReverseModel() {
  return {
    id: REVERSE_MODEL_ID,
    name: 'AnkiCard Reversible',
    type: 0,
    mod: 0,
    usn: -1,
    sortf: 0,
    did: DECK_ID,
    tmpls: [
      {
        name: '正向',
        ord: 0,
        qfmt: '<div class="category">{{Category}}</div>\n<div class="question">{{Question}}</div>',
        afmt: '{{FrontSide}}\n<hr id="answer">\n<div class="answer">{{Answer}}</div>',
        bqfmt: '',
        bafmt: '',
        did: null,
      },
      {
        name: '反向',
        ord: 1,
        qfmt: '<div class="category">{{Category}}</div>\n<div class="question">{{Answer}}</div>',
        afmt: '{{FrontSide}}\n<hr id="answer">\n<div class="answer">{{Question}}</div>',
        bqfmt: '',
        bafmt: '',
        did: null,
      },
    ],
    flds: [
      { name: 'Question', ord: 0, sticky: false, media: [] },
      { name: 'Answer', ord: 1, sticky: false, media: [] },
      { name: 'Category', ord: 2, sticky: false, media: [] },
      { name: 'Source', ord: 3, sticky: false, media: [] },
    ],
    css: BASIC_MODEL_CSS.replace(/\n/g, '\n').trim(),
    req: [
      [0, 'any', [0]],
      [1, 'any', [1]],
    ],
    vers: [],
  };
}

function createDeckConfig() {
  return {
    1: {
      id: DECK_CONFIG_ID,
      name: 'Default',
      mod: 0,
      usn: -1,
      autoplay: true,
      dyn: false,
      maxTaken: 60,
      replayq: true,
      timer: 0,
      new: {
        bury: false,
        delays: [1, 10],
        ints: [1, 4, 7],
        initialFactor: 2500,
        order: 1,
        perDay: 20,
        separate: true,
      },
      rev: {
        bury: false,
        ease4: 1.3,
        fuzz: 0.05,
        hardFactor: 1.2,
        maxIvl: 36500,
        minSpace: 1,
        perDay: 200,
      },
      lapse: {
        delays: [10, 1440],
        leechAction: 1,
        leechFails: 8,
        minInt: 1,
        mult: 0,
      },
    },
  };
}

function createDeck(name: string) {
  const now = Math.floor(Date.now() / 1000);
  const defaultDeck = {
    id: 1,
    name: 'Default',
    mod: now,
    usn: -1,
    desc: '',
    dyn: 0,
    collapsed: false,
    browserCollapsed: false,
    extendNew: 10,
    extendRev: 50,
    conf: DECK_CONFIG_ID,
    new: { perDay: 20 },
    rev: { perDay: 200 },
    lrnToday: [0, 0],
    revToday: [0, 0],
    timeToday: [0, 0],
  };

  const userDeck = {
    ...defaultDeck,
    id: DECK_ID,
    name,
    mod: now,
  };

  return { '1': defaultDeck, [DECK_ID]: userDeck };
}

function createCollectionConf() {
  return {
    activeDecks: [DECK_ID],
    curDeck: DECK_ID,
    newBury: false,
    revBury: false,
    schedVer: 1,
    collapseTime: 1200,
    lapse: {
      delays: [10, 1440],
      mult: 0,
      minInt: 1,
      leechFails: 8,
      leechAction: 1,
    },
    rev: {
      perDay: 200,
      ease4: 1.3,
      fuzz: 0.05,
      minSpace: 1,
      maxIvl: 36500,
      hardFactor: 1.2,
    },
    new: {
      perDay: 20,
      delays: [1, 10],
      separate: true,
      order: 1,
      ints: [1, 4, 7],
      initialFactor: 2500,
    },
    timeLim: 0,
    estTimes: true,
    dueCounts: true,
  };
}

// ============================================================
// 辅助函数
// ============================================================

function stripHtmlMedia(field: string): string {
  let s = field;
  // 移除 HTML 标签
  s = s.replace(/<[^>]*>/g, '');
  // 移除声音引用
  s = s.replace(/\[sound:[^\]]*\]/g, '');
  // 移除 cloze 标记
  s = s.replace(/\{\{c\d+::(.*?)(::.*?)?}}/g, '$1');
  return s;
}

function fieldChecksum(field: string): number {
  let stripped = stripHtmlMedia(field);
  stripped = stripped.toLowerCase();
  // 截断到 8KB
  stripped = stripped.substring(0, 8192);
  // CRC32
  const checksum = CRC32.str(stripped);
  return checksum >>> 0;
}

const GUID_CHARS = 'abcdefghijkmnopqrstuvwxyz';

function generateGuid(): string {
  let guid = '';
  for (let i = 0; i < 10; i++) {
    guid += GUID_CHARS[Math.floor(Math.random() * GUID_CHARS.length)];
  }
  return guid;
}

// ============================================================
// 数据库初始化
// ============================================================

let sqlPromise: Promise<SqlJsStatic> | null = null;

async function getSQL(): Promise<SqlJsStatic> {
  if (sqlPromise) return sqlPromise;

  sqlPromise = (async () => {
    const initModule = await import('sql.js');
    const initFn = initModule.default || initModule;

    // 尝试从文件系统加载 WASM
    const wasmCandidates = [
      path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
      path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
    ];

    for (const wasmPath of wasmCandidates) {
      if (fs.existsSync(wasmPath)) {
        const wasmBinary = fs.readFileSync(wasmPath);
        // Buffer -> ArrayBuffer: 截取实际字节范围
        const wasmArrayBuffer = wasmBinary.buffer.slice(
          wasmBinary.byteOffset,
          wasmBinary.byteOffset + wasmBinary.byteLength,
        ) as ArrayBuffer;
        return await initFn({ wasmBinary: wasmArrayBuffer });
      }
    }

    // 回退：让 sql.js 自动定位
    return await initFn();
  })();

  return sqlPromise;
}

// ============================================================
// Anki 导出核心逻辑
// ============================================================

function createSchema(db: Database): void {
  db.run(`
    CREATE TABLE col (
      id integer primary key,
      crt integer not null,
      mod integer not null,
      scm integer not null,
      ver integer not null,
      dty integer not null,
      usn integer not null,
      ls integer not null,
      conf text not null,
      models text not null,
      decks text not null,
      dconf text not null,
      tags text not null
    );
  `);

  db.run(`
    CREATE TABLE notes (
      id integer primary key,
      guid text not null,
      mid integer not null,
      mod integer not null,
      usn integer not null,
      tags text not null,
      flds text not null,
      sfld text not null,
      csum integer not null,
      flags integer not null,
      data text not null
    );
  `);

  db.run(`
    CREATE TABLE cards (
      id integer primary key,
      nid integer not null,
      did integer not null,
      ord integer not null,
      mod integer not null,
      usn integer not null,
      type integer not null,
      queue integer not null,
      due integer not null,
      ivl integer not null,
      factor integer not null,
      reps integer not null,
      lapses integer not null,
      left integer not null,
      odue integer not null,
      odid integer not null,
      flags integer not null,
      data text not null
    );
  `);

  db.run(`
    CREATE TABLE revlog (
      id integer primary key,
      cid integer not null,
      usn integer not null,
      ease integer not null,
      ivl integer not null,
      lastIvl integer not null,
      factor integer not null,
      time integer not null,
      type integer not null
    );
  `);

  db.run(`
    CREATE TABLE graves (
      usn integer not null,
      oid integer not null,
      type integer not null
    );
  `);

  db.run(`CREATE INDEX ix_notes_usn on notes (usn);`);
  db.run(`CREATE INDEX ix_cards_usn on cards (usn);`);
  db.run(`CREATE INDEX ix_cards_nid on cards (nid);`);
  db.run(`CREATE INDEX ix_revlog_usn on revlog (usn);`);
  db.run(`CREATE INDEX ix_revlog_cid on revlog (cid);`);
}

function insertCollection(db: Database, models: Record<string, unknown>, decks: Record<string, unknown>, dconf: Record<string, unknown>): void {
  const now = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();

  db.run(
    `INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      1,
      now,
      nowMs,
      nowMs,
      SCHEMA_VER,
      0,
      -1,
      0,
      JSON.stringify(createCollectionConf()),
      JSON.stringify(models),
      JSON.stringify(decks),
      JSON.stringify(dconf),
      '{}',
    ],
  );
}

function insertNote(db: Database, card: KnowledgeCard, modelId: number, noteId: number, mod: number): void {
  const guid = generateGuid();
  let fields: string[];
  let sortField: string;

  if (card.card_type === 'cloze') {
    fields = [card.question, `Category: ${card.category}`];
    sortField = card.question;
  } else {
    fields = [card.question, card.answer || '', card.category, card.source_section || card.category];
    sortField = card.question;
  }

  const flds = fields.join(FIELD_SEPARATOR);
  const csum = fieldChecksum(fields[0]);

  db.run(
    `INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [noteId, guid, modelId, mod, -1, '', flds, sortField, csum, 0, ''],
  );
}

function insertCard(db: Database, noteId: number, cardId: number, mod: number, due: number, ord = 0): void {
  db.run(
    `INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      cardId,
      noteId,
      DECK_ID,
      ord, // template ordinal
      mod,
      -1,
      0, // type: new
      0, // queue: new
      due, // due: position in new queue
      0, // ivl
      0, // factor
      0, // reps
      0, // lapses
      0, // left
      0, // odue
      0, // odid
      0, // flags
      '', // data
    ],
  );
}

// ============================================================
// 主导出函数
// ============================================================

export async function exportApkg(cards: KnowledgeCard[], deckName: string): Promise<Buffer> {
  const SQL = await getSQL();
  const db = new SQL.Database();

  try {
    // 1. 创建表结构
    createSchema(db);

    // 2. 准备模型、牌组配置
    const models: Record<string, unknown> = {};
    models[String(BASIC_MODEL_ID)] = createBasicModel();
    models[String(CLOZE_MODEL_ID)] = createClozeModel();
    models[String(DEF_MODEL_ID)] = createDefModel();
    models[String(REVERSE_MODEL_ID)] = createReverseModel();

    const decks = createDeck(deckName || 'AnkiCard Deck');
    const dconf = createDeckConfig();

    // 3. 插入 collection 元数据
    insertCollection(db, models, decks, dconf);

    // 4. 插入笔记和卡片
    const now = Date.now();
    const noteIdBase = now;
    const cardIdBase = now + 1;
    let dueCounter = 1;

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const modelId =
        card.card_type === 'cloze'
          ? CLOZE_MODEL_ID
          : card.card_type === 'def'
            ? DEF_MODEL_ID
            : card.card_type === 'reverse'
              ? REVERSE_MODEL_ID
              : BASIC_MODEL_ID;
      const noteId = noteIdBase + i * 2;
      const cardId = cardIdBase + i * 2;
      const mod = Math.floor(Date.now() / 1000);

      insertNote(db, card, modelId, noteId, mod);
      insertCard(db, noteId, cardId, mod, dueCounter);
      dueCounter++;
      if (card.card_type === 'reverse') {
        insertCard(db, noteId, cardId + 1, mod, dueCounter, 1);
        dueCounter++;
      }
    }

    // 5. 导出数据库为二进制
    const dbBinary = db.export();

    // 6. 创建 ZIP 包
    const zip = new JSZip();
    zip.file('collection.anki2', dbBinary);
    zip.file('media', '{}');

    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });

    return Buffer.from(zipBuffer);
  } finally {
    db.close();
  }
}
