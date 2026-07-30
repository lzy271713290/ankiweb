import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (isIP(normalized) !== 6) return true;

  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('::ffff:127.') ||
    normalized.startsWith('::ffff:10.') ||
    normalized.startsWith('::ffff:192.168.')
  );
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('仅支持 HTTP 或 HTTPS URL');
  }

  if (url.username || url.password) {
    throw new Error('URL 不能包含用户名或密码');
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('不允许访问本地地址');
  }

  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });

  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('不允许访问内网或保留地址');
  }
}

async function fetchPublicUrl(initialUrl: URL): Promise<Response> {
  let currentUrl = initialUrl;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    await assertPublicUrl(currentUrl);
    const response = await fetch(currentUrl, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,text/plain,application/json,application/xml;q=0.9',
        'User-Agent': 'AnkiCardAI/1.0',
      },
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get('location');
    if (!location) throw new Error('网页返回了无效的重定向');
    currentUrl = new URL(location, currentUrl);
  }

  throw new Error('网页重定向次数过多');
}

async function readLimitedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('网页内容超过 2MB 限制');
  }

  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalBytes += value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('网页内容超过 2MB 限制');
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };

  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith('#')) {
      const hexadecimal = code[1]?.toLowerCase() === 'x';
      const value = Number.parseInt(code.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : entity;
    }
    return namedEntities[code.toLowerCase()] || entity;
  });
}

function extractPageText(source: string, contentType: string): { content: string; title?: string } {
  if (!contentType.includes('html') && !/^\s*</.test(source)) {
    return { content: source.trim() };
  }

  const titleMatch = source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, ' ')).trim() : undefined;
  const text = source
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?(article|aside|blockquote|br|div|footer|h[1-6]|header|li|main|nav|p|pre|section|table|tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const content = decodeHtmlEntities(text)
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();

  return { content: title ? `# ${title}\n\n${content}` : content, title };
}

export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json();
    const urlValue =
      typeof body === 'object' && body !== null && 'url' in body
        ? (body as { url?: unknown }).url
        : undefined;

    if (typeof urlValue !== 'string' || !urlValue.trim()) {
      return NextResponse.json({ error: '请提供有效的 URL' }, { status: 400 });
    }

    let url: URL;
    try {
      url = new URL(urlValue.trim());
    } catch {
      return NextResponse.json({ error: 'URL 格式不正确' }, { status: 400 });
    }

    const response = await fetchPublicUrl(url);
    if (!response.ok) {
      return NextResponse.json({ error: `网页请求失败（${response.status}）` }, { status: 502 });
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() || '';
    const supported = ['text/', 'application/json', 'application/xml', 'application/xhtml+xml'];
    if (contentType && !supported.some((type) => contentType.includes(type))) {
      return NextResponse.json({ error: `不支持的网页内容类型：${contentType}` }, { status: 415 });
    }

    const source = await readLimitedText(response);
    const extracted = extractPageText(source, contentType);
    if (!extracted.content) {
      return NextResponse.json({ error: '未能从 URL 提取文本内容' }, { status: 422 });
    }

    return NextResponse.json({
      content: extracted.content,
      source: extracted.title || url.toString(),
      type: 'url',
      title: extracted.title,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'URL 解析失败';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
