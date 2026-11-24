import type { NextRequest } from 'next/server';
import { pipeExpressStream } from '@/lib/streamProxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  return pipeExpressStream(req, `/api/proxy${req.nextUrl.search}`);
}

export async function HEAD(req: NextRequest): Promise<Response> {
  return pipeExpressStream(req, `/api/proxy${req.nextUrl.search}`);
}
