import { EXAM_STORAGE_PATH, readExamPapers } from '@/lib/server/exams';

export const runtime = 'nodejs';

export async function GET() {
  return Response.json({ papers: await readExamPapers(), storage: EXAM_STORAGE_PATH });
}
