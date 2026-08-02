import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  appendUsageRecord,
  readUsageRecords,
  summarizeUsage,
  type UsageRecord,
} from '../src/lib/server/usage';

const legacyFile = path.join(process.cwd(), 'data', 'llm-usage.jsonl');

async function main(): Promise<void> {
  let records: UsageRecord[] = [];
  try {
    const content = await readFile(legacyFile, 'utf8');
    records = content
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as UsageRecord];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  for (const record of records) await appendUsageRecord(record);
  const migrated = await readUsageRecords();
  console.log(JSON.stringify({
    importedFromJsonl: records.length,
    sqliteRecords: migrated.length,
    summary: summarizeUsage(migrated),
    storage: 'data/llm-usage.sqlite',
  }, null, 2));
}

void main();
