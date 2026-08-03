import { readFile } from 'node:fs/promises';
import type { NextRequest } from 'next/server';
import { readExamAssetFile, setExamAssetDisplayMode } from '@/lib/server/exams';
import type { ExamAssetDisplayMode } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DISPLAY_MODES = new Set<ExamAssetDisplayMode>(['crop', 'source_page', 'hidden']);

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id')?.trim();
  if (!id) return Response.json({ error: '缺少图片 ID' }, { status: 400 });
  const file = await readExamAssetFile(id);
  if (!file) return Response.json({ error: '图片不存在或已隐藏' }, { status: 404 });
  const data = await readFile(file.path);
  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': file.mimeType,
      'Cache-Control': 'no-store',
    },
  });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json() as Record<string, unknown>;
  if (
    typeof body.id !== 'string' ||
    typeof body.displayMode !== 'string' ||
    !DISPLAY_MODES.has(body.displayMode as ExamAssetDisplayMode)
  ) {
    return Response.json({ error: '图片设置格式不正确' }, { status: 400 });
  }
  try {
    return Response.json(await setExamAssetDisplayMode(body.id, body.displayMode as ExamAssetDisplayMode));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : '保存图片设置失败' },
      { status: 400 },
    );
  }
}
