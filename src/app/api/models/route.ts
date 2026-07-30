import { NextResponse } from 'next/server';
import { getPublicModels } from '@/lib/server/llm';

export async function GET() {
  return NextResponse.json({ models: getPublicModels() });
}
