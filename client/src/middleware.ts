import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_PATHS = new Set(['/login']);

/**
 * Performs lightweight structural & expiry inspection on the JWT cookie inside Edge
 * middleware so missing or visibly expired tokens redirect before SSR hydration.
 * Authoritative HMAC signature verification remains enforced by Express on every API call.
 */
function hasUnexpiredJwtStructure(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return false;
  }

  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padLength = (4 - (normalized.length % 4)) % 4;
    const padded = normalized + '='.repeat(padLength);
    const decoded = atob(padded);
    const payload = JSON.parse(decoded) as { exp?: unknown };

    if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) {
      if (payload.exp * 1000 <= Date.now()) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  const token = request.cookies.get('jwt')?.value;
  if (!token || !hasUnexpiredJwtStructure(token)) {
    const loginUrl = new URL('/login', request.url);
    if (pathname !== '/' && pathname.startsWith('/') && !pathname.startsWith('//')) {
      loginUrl.searchParams.set('next', `${pathname}${search}`);
    }

    const response = NextResponse.redirect(loginUrl);
    if (token) {
      response.cookies.delete('jwt');
    }
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
