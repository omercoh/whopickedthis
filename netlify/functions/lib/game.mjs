// Game logic for "Who picked this?".
// Storage-agnostic: `store` needs get(key, {type:'json'}), setJSON(key, value),
// delete(key) and list({prefix}) -> {blobs:[{key}]}  (the @netlify/blobs API).
//
// Data layout:
//   meta                -> { status: 'setup' | 'live' | 'finished' }
//   entries/<nameKey>   -> { name, url, platform, songId, createdAt }
//   guesses/<nameKey>   -> { name, guesses: { [songId]: playerName }, submittedAt }

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const MIN_PLAYERS = 3;
const MAX_PLAYERS = 60;
const MAX_NAME = 30;

export const normName = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
export const nameKey = (s) => normName(s).toLowerCase();
const entryKey = (name) => 'entries/' + encodeURIComponent(nameKey(name));
const guessKey = (name) => 'guesses/' + encodeURIComponent(nameKey(name));
const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });

function cleanName(raw) {
  const name = normName(raw);
  if (!name) throw new HttpError(400, 'Enter a name.');
  if (name.length > MAX_NAME) throw new HttpError(400, `Names can be up to ${MAX_NAME} characters.`);
  return name;
}

const hostIs = (host, domain) => host === domain || host.endsWith('.' + domain);

export function parseSongUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    throw new HttpError(400, 'That doesn’t look like a link. Paste the full Spotify or YouTube link.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new HttpError(400, 'Links must start with https://');
  }
  const host = u.hostname.toLowerCase();
  let platform;
  if (['spotify.com', 'spotify.link', 'spoti.fi'].some((d) => hostIs(host, d))) platform = 'spotify';
  else if (['youtube.com', 'youtu.be'].some((d) => hostIs(host, d))) platform = 'youtube';
  else throw new HttpError(400, 'Use a Spotify or YouTube link.');
  u.protocol = 'https:';
  u.username = '';
  u.password = '';
  return { url: u.href, platform };
}

// ---------- storage helpers ----------

async function getMeta(store) {
  return (await store.get('meta', { type: 'json' })) ?? { status: 'setup' };
}

async function listJson(store, prefix) {
  const { blobs } = await store.list({ prefix });
  const rows = await Promise.all(blobs.map((b) => store.get(b.key, { type: 'json' })));
  return rows.filter(Boolean);
}

// Entries sorted by their random songId. The position is the "track number"
// everyone sees; it reveals nothing about who picked what.
async function loadEntries(store) {
  const rows = await listJson(store, 'entries/');
  rows.sort((a, b) => (a.songId < b.songId ? -1 : 1));
  return rows.map((e, i) => ({ ...e, n: i + 1 }));
}

const findEntry = (entries, name) => entries.find((e) => nameKey(e.name) === nameKey(name));
const publicSong = (e) => ({ id: e.songId, n: e.n, url: e.url, platform: e.platform });

async function clearGuesses(store) {
  const { blobs } = await store.list({ prefix: 'guesses/' });
  await Promise.all(blobs.map((b) => store.delete(b.key)));
}

function scoreRow(entries, row) {
  const me = nameKey(row.name);
  let score = 0;
  let total = 0;
  const review = entries.map((e) => {
    const own = nameKey(e.name) === me;
    const guess = own ? e.name : row.guesses?.[e.songId] ?? null;
    const correct = own ? null : guess !== null && nameKey(guess) === nameKey(e.name);
    if (!own) {
      total += 1;
      if (correct) score += 1;
    }
    return { ...publicSong(e), own, guess, answer: e.name, correct };
  });
  return { score, total, review };
}

// ---------- player actions ----------

async function login(store, body) {
  const name = cleanName(body?.name);
  const meta = await getMeta(store);
  const entries = await loadEntries(store);
  const me = findEntry(entries, name);
  const players = entries.map((e) => e.name).sort(byName);

  if (meta.status === 'setup') {
    return { status: 'setup', name: me?.name ?? name, registered: !!me, url: me?.url ?? null, players };
  }
  if (!me) {
    throw new HttpError(404, 'We can’t find that name. Check the spelling or ask the host to add you.');
  }
  const row = await store.get(guessKey(me.name), { type: 'json' });

  if (meta.status === 'live') {
    if (row) return { status: 'live', name: me.name, submitted: true };
    return {
      status: 'live',
      name: me.name,
      submitted: false,
      mySongId: me.songId,
      songs: entries.map(publicSong),
      players: players.filter((p) => nameKey(p) !== nameKey(me.name)),
    };
  }
  // finished
  if (!row) return { status: 'finished', name: me.name, submitted: false };
  const { score, total, review } = scoreRow(entries, row);
  return { status: 'finished', name: me.name, submitted: true, score, total, review };
}

async function join(store, body) {
  const name = cleanName(body?.name);
  const { url, platform } = parseSongUrl(body?.url);
  const meta = await getMeta(store);
  if (meta.status !== 'setup') throw new HttpError(409, 'Song collection is closed. Ask the host to add you.');
  const entries = await loadEntries(store);
  const existing = findEntry(entries, name);
  if (!existing && entries.length >= MAX_PLAYERS) throw new HttpError(409, 'This game is full.');
  await store.setJSON(entryKey(existing?.name ?? name), {
    name: existing?.name ?? name,
    url,
    platform,
    songId: existing?.songId ?? randomBytes(4).toString('hex'),
    createdAt: existing?.createdAt ?? Date.now(),
  });
  return { ok: true, name: existing?.name ?? name };
}

async function submit(store, body) {
  const meta = await getMeta(store);
  if (meta.status !== 'live') throw new HttpError(409, 'The quiz isn’t open for answers right now.');
  const entries = await loadEntries(store);
  const me = findEntry(entries, body?.name);
  if (!me) throw new HttpError(404, 'We can’t find that name.');
  if (await store.get(guessKey(me.name), { type: 'json' })) {
    throw new HttpError(409, 'You’ve already submitted your answers.');
  }
  const raw = body?.guesses;
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'Match every song before submitting.');

  const others = entries.filter((e) => e !== me);
  const canonical = new Map(others.map((e) => [nameKey(e.name), e.name]));
  const used = new Set();
  const guesses = {};
  for (const song of others) {
    const picked = canonical.get(nameKey(raw[song.songId]));
    if (!picked) throw new HttpError(400, 'Match every song before submitting.');
    if (used.has(picked)) throw new HttpError(400, 'Each player can only be matched to one song.');
    used.add(picked);
    guesses[song.songId] = picked;
  }
  await store.setJSON(guessKey(me.name), { name: me.name, guesses, submittedAt: Date.now() });
  return { ok: true };
}

// ---------- host actions ----------

function requireAdmin(code, secret) {
  if (!secret) {
    throw new HttpError(
      500,
      'ADMIN_CODE isn’t set. Add it in Netlify under Site configuration → Environment variables, then redeploy.',
    );
  }
  const a = createHash('sha256').update(String(code ?? '')).digest();
  const b = createHash('sha256').update(String(secret)).digest();
  if (!timingSafeEqual(a, b)) throw new HttpError(401, 'That host code isn’t right.');
}

async function adminOverview(store) {
  const meta = await getMeta(store);
  const entries = await loadEntries(store);
  const rows = await listJson(store, 'guesses/');
  return {
    status: meta.status,
    minPlayers: MIN_PLAYERS,
    entries: entries.map((e) => ({ ...publicSong(e), name: e.name })),
    submissions: rows.map((r) => {
      const { score, total } = scoreRow(entries, r);
      return { name: r.name, guesses: r.guesses, score, total, submittedAt: r.submittedAt };
    }),
  };
}

async function adminSaveEntry(store, body) {
  const meta = await getMeta(store);
  if (meta.status !== 'setup') throw new HttpError(409, 'Songs can only be edited before the quiz starts.');
  const name = cleanName(body?.name);
  const { url, platform } = parseSongUrl(body?.url);
  const entries = await loadEntries(store);
  const old = body?.oldName ? findEntry(entries, body.oldName) : null;
  if (body?.oldName && !old) throw new HttpError(404, 'That player no longer exists.');
  const clash = findEntry(entries, name);
  if (clash && clash !== old) throw new HttpError(409, 'That name is already in the list.');
  if (!old && entries.length >= MAX_PLAYERS) throw new HttpError(409, 'This game is full.');

  const base = old;
  if (old && entryKey(old.name) !== entryKey(name)) await store.delete(entryKey(old.name));
  await store.setJSON(entryKey(name), {
    name,
    url,
    platform,
    songId: base?.songId ?? randomBytes(4).toString('hex'),
    createdAt: base?.createdAt ?? Date.now(),
  });
  return { ok: true };
}

async function adminDeleteEntry(store, body) {
  const meta = await getMeta(store);
  if (meta.status !== 'setup') throw new HttpError(409, 'Players can only be removed before the quiz starts.');
  const entries = await loadEntries(store);
  const e = findEntry(entries, body?.name);
  if (e) await store.delete(entryKey(e.name));
  return { ok: true };
}

async function adminSetStatus(store, body) {
  const next = body?.status;
  const meta = await getMeta(store);
  const from = meta.status;
  if (next === 'live' && from === 'setup') {
    const entries = await loadEntries(store);
    if (entries.length < MIN_PLAYERS) {
      throw new HttpError(400, `Add at least ${MIN_PLAYERS} players before starting.`);
    }
  } else if (next === 'live' && from === 'finished') {
    // reopen: keep submissions
  } else if (next === 'finished' && from === 'live') {
    // reveal
  } else if (next === 'setup' && (from === 'live' || from === 'finished')) {
    await clearGuesses(store);
  } else {
    throw new HttpError(409, 'That change isn’t possible from the current state.');
  }
  await store.setJSON('meta', { status: next });
  return { ok: true, status: next };
}

async function adminResetGuess(store, body) {
  const meta = await getMeta(store);
  if (meta.status !== 'live') throw new HttpError(409, 'Answers can only be reset while the quiz is live.');
  await store.delete(guessKey(body?.name));
  return { ok: true };
}

async function adminNewGame(store) {
  const { blobs } = await store.list({ prefix: 'entries/' });
  await Promise.all(blobs.map((b) => store.delete(b.key)));
  await clearGuesses(store);
  await store.setJSON('meta', { status: 'setup' });
  return { ok: true };
}

// ---------- router ----------

export async function handle({ method, path, body, adminCode, adminSecret }, store) {
  try {
    const p = path.replace(/^\/api/, '').replace(/\/+$/, '') || '/';
    if (p.startsWith('/admin/')) requireAdmin(adminCode, adminSecret);
    const route = `${method} ${p}`;
    switch (route) {
      case 'GET /status': {
        const meta = await getMeta(store);
        const { blobs } = await store.list({ prefix: 'entries/' });
        return ok({ status: meta.status, count: blobs.length });
      }
      case 'POST /login': return ok(await login(store, body));
      case 'POST /join': return ok(await join(store, body));
      case 'POST /submit': return ok(await submit(store, body));
      case 'GET /admin/overview': return ok(await adminOverview(store));
      case 'POST /admin/entry': return ok(await adminSaveEntry(store, body));
      case 'POST /admin/entry/delete': return ok(await adminDeleteEntry(store, body));
      case 'POST /admin/status': return ok(await adminSetStatus(store, body));
      case 'POST /admin/reset-guess': return ok(await adminResetGuess(store, body));
      case 'POST /admin/new-game': return ok(await adminNewGame(store));
      default: throw new HttpError(404, 'Not found.');
    }
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, data: { error: e.message } };
    console.error(e);
    return { status: 500, data: { error: 'Something went wrong on our side. Try again.' } };
  }
}

const ok = (data) => ({ status: 200, data });
