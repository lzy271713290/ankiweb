import type { NextRequest } from 'next/server';
import { saveExamQuestion } from '@/lib/server/exams';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ questionId: string }>;
}

function parseOptions(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const options = Object.fromEntries(
    'ABCD'.split('').map((label) => [label, typeof record[label] === 'string' ? record[label] : '']),
  );
  return options;
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { questionId } = await context.params;
  const body = await request.json() as Record<string, unknown>;
  const options = parseOptions(body.options);
  if (
    typeof body.stem !== 'string' ||
    !options ||
    typeof body.answer !== 'string' ||
    typeof body.explanation !== 'string'
  ) {
    return Response.json({ error: '题目数据格式不正确' }, { status: 400 });
  }
  try {
    return Response.json(await saveExamQuestion(questionId, {
      stem: body.stem,
      options,
      answer: body.answer,
      explanation: body.explanation,
    }));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : '保存题目失败' },
      { status: 400 },
    );
  }
}
