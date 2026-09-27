import { getStore } from '@netlify/blobs';
import { handle } from './lib/game.mjs';

export default async (req) => {
  const url = new URL(req.url);
  let body = null;
  if (req.method === 'POST') {
    try {
      body = await req.json();
    } catch {
      return json(400, { error: 'בקשה לא תקינה.' });
    }
  }
  const store = getStore({ name: 'quiz', consistency: 'strong' });
  const { status, data, redirect } = await handle(
    {
      method: req.method,
      path: url.pathname,
      body,
      query: Object.fromEntries(url.searchParams),
      origin: url.origin,
      adminCode: req.headers.get('x-admin-code'),
      adminSecret: process.env.ADMIN_CODE,
    },
    store,
  );
  if (redirect) return Response.redirect(redirect, status);
  return json(status, data);
};

const json = (status, data) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export const config = { path: '/api/*' };
