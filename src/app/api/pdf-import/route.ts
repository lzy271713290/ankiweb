import { inspectUploadedPdf } from '@/lib/server/pdf-imports';

export const runtime = 'nodejs';

const MAX_FILE_SIZE = 200 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) return Response.json({ error: '请选择 PDF 文件' }, { status: 400 });
    if (!file.name.toLowerCase().endsWith('.pdf')) return Response.json({ error: '仅支持 PDF 文件' }, { status: 415 });
    if (file.size > MAX_FILE_SIZE) return Response.json({ error: 'PDF 大小不能超过 200MB' }, { status: 413 });
    return Response.json(await inspectUploadedPdf(file));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'PDF 检测失败' }, { status: 500 });
  }
}
