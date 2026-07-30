import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:5000'),
  title: {
    default: 'AnkiCard AI - 智能记忆卡片生成器',
    template: '%s | AnkiCard AI',
  },
  description:
    '将笔记、文档和文本一键转换为 Anki 记忆卡片。AI 智能生成填空题和问答题，支持导出 .apkg 文件直接导入 Anki。',
  keywords: [
    'Anki',
    '记忆卡片',
    '闪卡',
    'AI 卡片生成',
    '间隔重复',
    '学习工具',
    'Anki 导出',
    'apkg',
  ],
  authors: [{ name: 'AnkiCard AI' }],
  openGraph: {
    title: 'AnkiCard AI - 智能记忆卡片生成器',
    description: '将文本一键转换为 Anki 记忆卡片，AI 智能生成填空题和问答题。',
    locale: 'zh_CN',
    type: 'website',
    images: [
      {
        url: '/og.png',
        width: 1680,
        height: 945,
        alt: 'AnkiCard AI - 从阅读到记忆',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'AnkiCard AI - 智能记忆卡片生成器',
    description: '从阅读到记忆：生成、微调、保存并推送你的学习卡片。',
    images: ['/og.png'],
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className={`antialiased`}>
        {children}
      </body>
    </html>
  );
}
