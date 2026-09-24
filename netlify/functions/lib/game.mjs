// Game logic for "Who picked this?".
// Storage-agnostic: `store` needs get(key, {type:'json'}), setJSON(key, value),
// delete(key) and list({prefix}) -> {blobs:[{key}]}  (the @netlify/blobs API).
//
// Data layout:
//   meta                -> { status: 'setup' | 'live' | 'finished' }
//   entries/<nameKey>   -> { name, url, platform, title, artist, image, songId, createdAt }
//                          (url/platform/title/artist/image are null until a song link is set)
//   guesses/<nameKey>   -> { name, guesses: { [songId]: playerName }, submittedAt }

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { fetchSongMeta } from './metadata.mjs';

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
  if (!name) throw new HttpError(400, 'הזינו שם.');
  if (name.length > MAX_NAME) throw new HttpError(400, `שם יכול להכיל עד ${MAX_NAME} תווים.`);
  return name;
}

const hostIs = (host, domain) => host === domain || host.endsWith('.' + domain);

export function parseSongUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    throw new HttpError(400, 'זה לא נראה כמו קישור. הדביקו את הקישור המלא מ-Spotify או YouTube.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new HttpError(400, 'קישורים חייבים להתחיל ב-https://');
  }
  const host = u.hostname.toLowerCase();
  let platform;
  if (['spotify.com', 'spotify.link', 'spoti.fi'].some((d) => hostIs(host, d))) platform = 'spotify';
  else if (['youtube.com', 'youtu.be'].some((d) => hostIs(host, d))) platform = 'youtube';
  else throw new HttpError(400, 'השתמשו בקישור מ-Spotify או YouTube.');
  u.protocol = 'https:';
  u.username = '';
  u.password = '';
  return { url: u.href, platform };
}

// Only the host can leave a song link out entirely (a placeholder player who
// hasn't picked a song yet); a blank link is otherwise still an error.
function parseOptionalSongUrl(raw) {
  if (!String(raw ?? '').trim()) return { url: null, platform: null };
  return parseSongUrl(raw);
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
const hasMeta = (e) => !!(e?.title || e?.artist);
const publicSong = (e) => ({
  id: e.songId,
  n: e.n,
  url: e.url,
  platform: e.platform,
  title: e.title ?? null,
  artist: e.artist ?? null,
  image: e.image ?? null,
});

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

async function buildLeaderboard(store, entries) {
  const rows = await listJson(store, 'guesses/');
  const byRow = new Map(rows.map((r) => [nameKey(r.name), r]));
  return entries
    .map((e) => {
      const row = byRow.get(nameKey(e.name));
      if (!row) return { name: e.name, submitted: false, score: null, total: null };
      const { score, total } = scoreRow(entries, row);
      return { name: e.name, submitted: true, score, total };
    })
    .sort((a, b) => {
      if (a.submitted !== b.submitted) return a.submitted ? -1 : 1;
      return a.submitted ? b.score - a.score || byName(a.name, b.name) : byName(a.name, b.name);
    });
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
    throw new HttpError(404, 'לא מצאנו את השם הזה. בדקו את האיות או בקשו מהמנחה להוסיף אתכם.');
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
  const leaderboard = await buildLeaderboard(store, entries);
  if (!row) return { status: 'finished', name: me.name, submitted: false, leaderboard };
  const { score, total, review } = scoreRow(entries, row);
  return { status: 'finished', name: me.name, submitted: true, score, total, review, leaderboard };
}

async function join(store, body, fetchMeta) {
  const name = cleanName(body?.name);
  const { url, platform } = parseSongUrl(body?.url);
  const meta = await getMeta(store);
  if (meta.status !== 'setup') throw new HttpError(409, 'איסוף השירים סגור. בקשו מהמנחה להוסיף אתכם.');
  const entries = await loadEntries(store);
  const existing = findEntry(entries, name);
  if (!existing && entries.length >= MAX_PLAYERS) throw new HttpError(409, 'המשחק הזה מלא.');
  const info = existing?.url === url && hasMeta(existing) ? existing : await fetchMeta(url, platform);
  await store.setJSON(entryKey(existing?.name ?? name), {
    name: existing?.name ?? name,
    url,
    platform,
    title: info?.title ?? null,
    artist: info?.artist ?? null,
    image: info?.image ?? null,
    songId: existing?.songId ?? randomBytes(4).toString('hex'),
    createdAt: existing?.createdAt ?? Date.now(),
  });
  return { ok: true, name: existing?.name ?? name };
}

async function submit(store, body) {
  const meta = await getMeta(store);
  if (meta.status !== 'live') throw new HttpError(409, 'החידון לא פתוח לתשובות כרגע.');
  const entries = await loadEntries(store);
  const me = findEntry(entries, body?.name);
  if (!me) throw new HttpError(404, 'לא מצאנו את השם הזה.');
  if (await store.get(guessKey(me.name), { type: 'json' })) {
    throw new HttpError(409, 'כבר הגשתם את התשובות שלכם.');
  }
  const raw = body?.guesses;
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'התאימו כל שיר לפני ההגשה.');

  const others = entries.filter((e) => e !== me);
  const canonical = new Map(others.map((e) => [nameKey(e.name), e.name]));
  const used = new Set();
  const guesses = {};
  for (const song of others) {
    const picked = canonical.get(nameKey(raw[song.songId]));
    if (!picked) throw new HttpError(400, 'התאימו כל שיר לפני ההגשה.');
    if (used.has(picked)) throw new HttpError(400, 'כל שחקן יכול להיות מותאם לשיר אחד בלבד.');
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
      'ה-ADMIN_CODE לא הוגדר. הוסיפו אותו ב-Netlify תחת Site configuration → Environment variables, ואז פרסמו מחדש.',
    );
  }
  const a = createHash('sha256').update(String(code ?? '')).digest();
  const b = createHash('sha256').update(String(secret)).digest();
  if (!timingSafeEqual(a, b)) throw new HttpError(401, 'קוד המנחה לא נכון.');
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

async function adminSaveEntry(store, body, fetchMeta) {
  const meta = await getMeta(store);
  if (meta.status !== 'setup') throw new HttpError(409, 'אפשר לערוך שירים רק לפני תחילת החידון.');
  const name = cleanName(body?.name);
  const { url, platform } = parseOptionalSongUrl(body?.url);
  const entries = await loadEntries(store);
  const old = body?.oldName ? findEntry(entries, body.oldName) : null;
  if (body?.oldName && !old) throw new HttpError(404, 'השחקן הזה כבר לא קיים.');
  const clash = findEntry(entries, name);
  if (clash && clash !== old) throw new HttpError(409, 'השם הזה כבר קיים ברשימה.');
  if (!old && entries.length >= MAX_PLAYERS) throw new HttpError(409, 'המשחק הזה מלא.');

  const base = old;
  const info = !url ? null : base?.url === url && hasMeta(base) ? base : await fetchMeta(url, platform);
  if (old && entryKey(old.name) !== entryKey(name)) await store.delete(entryKey(old.name));
  await store.setJSON(entryKey(name), {
    name,
    url,
    platform,
    title: info?.title ?? null,
    artist: info?.artist ?? null,
    image: info?.image ?? null,
    songId: base?.songId ?? randomBytes(4).toString('hex'),
    createdAt: base?.createdAt ?? Date.now(),
  });
  return { ok: true };
}

async function adminDeleteEntry(store, body) {
  const meta = await getMeta(store);
  if (meta.status !== 'setup') throw new HttpError(409, 'אפשר להסיר שחקנים רק לפני תחילת החידון.');
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
      throw new HttpError(400, `הוסיפו לפחות ${MIN_PLAYERS} שחקנים לפני ההתחלה.`);
    }
    if (entries.some((e) => !e.url)) {
      throw new HttpError(400, 'לכל השחקנים צריך להיות שיר לפני שמתחילים. השלימו או הוסיפו קישורים לשחקנים שחסר להם.');
    }
  } else if (next === 'live' && from === 'finished') {
    // reopen: keep submissions
  } else if (next === 'finished' && from === 'live') {
    // reveal
  } else if (next === 'setup' && (from === 'live' || from === 'finished')) {
    await clearGuesses(store);
  } else {
    throw new HttpError(409, 'השינוי הזה לא אפשרי מהמצב הנוכחי.');
  }
  await store.setJSON('meta', { status: next });
  return { ok: true, status: next };
}

async function adminResetGuess(store, body) {
  const meta = await getMeta(store);
  if (meta.status !== 'live') throw new HttpError(409, 'אפשר לאפס תשובות רק כשהחידון פעיל.');
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

export async function handle({ method, path, body, adminCode, adminSecret, fetchMeta = fetchSongMeta }, store) {
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
      case 'POST /join': return ok(await join(store, body, fetchMeta));
      case 'POST /submit': return ok(await submit(store, body));
      case 'GET /admin/overview': return ok(await adminOverview(store));
      case 'POST /admin/entry': return ok(await adminSaveEntry(store, body, fetchMeta));
      case 'POST /admin/entry/delete': return ok(await adminDeleteEntry(store, body));
      case 'POST /admin/status': return ok(await adminSetStatus(store, body));
      case 'POST /admin/reset-guess': return ok(await adminResetGuess(store, body));
      case 'POST /admin/new-game': return ok(await adminNewGame(store));
      default: throw new HttpError(404, 'הנתיב לא נמצא.');
    }
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, data: { error: e.message } };
    console.error(e);
    return { status: 500, data: { error: 'משהו השתבש אצלנו. נסו שוב.' } };
  }
}

const ok = (data) => ({ status: 200, data });
