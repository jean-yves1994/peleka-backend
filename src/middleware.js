import { NextResponse } from 'next/server';

const ALLOWED_ORIGINS = new Set([
  'https://www.pelekaapp.com',
  'https://pelekaapp.com',
  'https://www.admin.pelekaapp.com',
  'https://admin.pelekaapp.com',
]);

function getAllowedOrigin(request) {
  const origin = request.headers.get('origin');

  if (!origin) return null;

  if (ALLOWED_ORIGINS.has(origin)) {
    return origin;
  }

  if (
    origin === 'http://localhost:3000' ||
    origin === 'http://localhost:3001' ||
    origin === 'http://127.0.0.1:3000' ||
    origin === 'http://127.0.0.1:3001'
  ) {
    return origin;
  }

  return null;
}

function applyCors(response, origin) {
  if (!origin) return response;

  response.headers.set('Access-Control-Allow-Origin', origin);
  response.headers.set(
    'Access-Control-Allow-Methods',
    'GET,POST,PUT,PATCH,DELETE,OPTIONS'
  );
  response.headers.set(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Requested-With, Accept'
  );
  response.headers.set('Access-Control-Max-Age', '86400');
  response.headers.append('Vary', 'Origin');

  return response;
}

export function middleware(request) {
  const origin = getAllowedOrigin(request);

  if (request.method === 'OPTIONS') {
    if (!origin) {
      return new NextResponse(null, { status: 403 });
    }

    return applyCors(new NextResponse(null, { status: 204 }), origin);
  }

  return applyCors(NextResponse.next(), origin);
}

export const config = {
  matcher: ['/api/:path*'],
};
