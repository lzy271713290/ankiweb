import { NextRequest, NextResponse } from 'next/server';
import { testModelConnection } from '@/lib/server/llm';

export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json();
    const modelId =
      typeof body === 'object' && body !== null && 'modelId' in body
        ? (body as { modelId?: unknown }).modelId
        : undefined;
    if (typeof modelId !== 'string' || !modelId) {
      return NextResponse.json({ error: '请选择需要测试的模型' }, { status: 400 });
    }
    return NextResponse.json(await testModelConnection(modelId));
  } catch (error) {
    const message = error instanceof Error ? error.message : '模型测试失败';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
