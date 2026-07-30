import { NextResponse } from 'next/server';
import type { PushChannelStatus } from '@/lib/types';

export function getChannelStatuses(): PushChannelStatus[] {
  return [
    {
      id: 'feishu',
      label: '飞书群机器人',
      configured: Boolean(process.env.FEISHU_WEBHOOK_URL?.trim()),
      description: '通过飞书自定义机器人 Webhook 推送到指定群聊',
    },
    {
      id: 'wecom',
      label: '企业微信群机器人',
      configured: Boolean(process.env.WECOM_WEBHOOK_URL?.trim()),
      description: '通过企业微信群机器人 Webhook 推送学习卡片',
    },
  ];
}

export async function GET() {
  return NextResponse.json({ channels: getChannelStatuses() });
}
