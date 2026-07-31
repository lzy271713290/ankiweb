import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { exportApkg } from '../src/lib/anki';
import type { KnowledgeCard } from '../src/lib/types';

interface SourceInfo {
  name: string;
  url: string;
}

interface ReviewCard extends KnowledgeCard {
  source_url: string;
  review_status: string;
  note: string;
}

interface DeckSource {
  deckName: string;
  version: string;
  scope: string;
  sources: SourceInfo[];
  cards: ReviewCard[];
}

function escapeCsv(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function main(): Promise<void> {
  const projectRoot = process.cwd();
  const sourcePath = path.join(
    projectRoot,
    'content',
    'decks',
    'system-integration-pm-sample.json',
  );
  const outputDir = path.join(projectRoot, 'outputs', 'system-integration-pm');
  const source = JSON.parse(await readFile(sourcePath, 'utf8')) as DeckSource;

  await mkdir(outputDir, { recursive: true });

  const apkg = await exportApkg(source.cards, source.deckName);
  await writeFile(path.join(outputDir, `${source.deckName}.apkg`), apkg);

  const headers = [
    'ID',
    '模块',
    '卡片类型',
    '问题',
    '答案',
    '教程章节',
    '来源链接',
    '审核状态',
    '备注',
  ];
  const rows = source.cards.map((card) => [
    card.id,
    card.category,
    card.card_type,
    card.question,
    card.answer,
    card.source_section,
    card.source_url,
    card.review_status,
    card.note,
  ]);
  const csv = [
    headers.map(escapeCsv).join(','),
    ...rows.map((row) => row.map(escapeCsv).join(',')),
  ].join('\r\n');

  await writeFile(
    path.join(outputDir, '系统集成项目管理工程师-高频考点样卡.csv'),
    `\uFEFF${csv}`,
    'utf8',
  );
}

void main();
