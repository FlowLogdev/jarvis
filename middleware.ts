import { NextResponse, type NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  return NextResponse.rewrite(new URL('/index.html', request.url));
}

export const config = {
  matcher: '/',
};
