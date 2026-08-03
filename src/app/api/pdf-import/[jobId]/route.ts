import { readPdfImportJob, startPdfImportJob } from '@/lib/server/pdf-imports';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ jobId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    return Response.json(await readPdfImportJob((await context.params).jobId));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '读取 OCR 进度失败' }, { status: 404 });
  }
}

export async function POST(_request: Request, context: RouteContext) {
  try {
    return Response.json(await startPdfImportJob((await context.params).jobId));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '启动 OCR 失败' }, { status: 409 });
  }
}
