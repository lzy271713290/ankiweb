import { NextRequest, NextResponse } from 'next/server';

const TEXT_EXTENSIONS = [
  'txt', 'md', 'markdown', 'csv', 'json', 'html', 'htm', 'xml',
  'yaml', 'yml', 'log', 'js', 'ts', 'py', 'java', 'c', 'cpp', 'h',
  'css', 'scss', 'svg', 'go', 'rs', 'rb', 'php', 'sh', 'sql',
];

function getExtension(filename: string): string {
  const parts = filename.split('.');
  return parts.length > 1 ? parts.pop()!.toLowerCase() : '';
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: '未找到文件' },
        { status: 400 },
      );
    }

    // 限制文件大小 20MB
    if (file.size > 20 * 1024 * 1024) {
      return NextResponse.json(
        { error: '文件大小超过 20MB 限制' },
        { status: 400 },
      );
    }

    const ext = getExtension(file.name);
    const fileName = file.name;

    // 纯文本文件：直接读取返回
    if (TEXT_EXTENSIONS.includes(ext)) {
      const text = await file.text();
      return NextResponse.json({
        content: text,
        source: fileName,
        type: 'text',
      });
    }

    return NextResponse.json(
      { error: `暂不支持 .${ext || '未知'} 格式，请上传纯文本文件` },
      { status: 415 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '文件解析失败';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
