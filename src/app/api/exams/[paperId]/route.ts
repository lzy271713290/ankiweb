import { confirmExamPaper, readExamPaper } from '@/lib/server/exams';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ paperId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const { paperId } = await context.params;
  const detail = await readExamPaper(paperId);
  if (!detail) return Response.json({ error: '试卷不存在' }, { status: 404 });
  return Response.json(detail);
}

export async function POST(_request: Request, context: RouteContext) {
  const { paperId } = await context.params;
  try {
    return Response.json(await confirmExamPaper(paperId));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : '确认试卷失败' },
      { status: 400 },
    );
  }
}
