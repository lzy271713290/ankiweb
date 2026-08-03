import { readFile } from 'node:fs/promises';
import type { NextRequest } from 'next/server';
import { readExamSourcePageFile } from '@/lib/server/exams';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const paperId = request.nextUrl.searchParams.get('paperId')?.trim();
  const page = Number.parseInt(request.nextUrl.searchParams.get('page') || '', 10);
  if (!paperId || !Number.isFinite(page)) {
    return Response.json({ error: '缺少试卷或页码' }, { status: 400 });
  }
  const file = await readExamSourcePageFile(paperId, page);
  if (!file) return Response.json({ error: '原页不存在' }, { status: 404 });
  const data = await readFile(file.path);
  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': file.mimeType,
      'Cache-Control': 'no-store',
    },
  });
}
