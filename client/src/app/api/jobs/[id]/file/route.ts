import type { NextRequest } from 'next/server';
import { pipeExpressStream } from '@/lib/streamProxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, context: RouteContext): Promise<Response> {
  const { id } = await context.params;
  return pipeExpressStream(req, `/api/jobs/${encodeURIComponent(id)}/file`);
}

export async function HEAD(req: NextRequest, context: RouteContext): Promise<Response> {
  const { id } = await context.params;
  return pipeExpressStream(req, `/api/jobs/${encodeURIComponent(id)}/file`);
}
