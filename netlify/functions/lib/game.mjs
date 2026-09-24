// Game logic for "Who picked this?".
// Storage-agnostic: `store` needs get(key, {type:'json'}), setJSON(key, value),
// delete(key) and list({prefix}) -> {blobs:[{key}]}  (the @netlify/blobs API).
//
// Data layout:
//   meta                -> { status: 'setup' | 'live' | 'finished', playlistId? }
//   entries/<nameKey>   -> { name, url, platform, title, artist, image, songId, createdAt }
//                          (url/platform/title/artist/image are null until a song link is set)
//   guesses/<nameKey>   -> { name, guesses: { [songId]: playerName }, submittedAt }
//   playlists/<id>      -> { id, url, name, createdAt, trackCount }  (history of every game's playlist)
//   spotify-auth        -> { refreshToken, userId, displayName, connectedAt }  (one connected account)
//   spotify-oauth-state -> { state, createdAt }  (single-use CSRF token for the connect flow)

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { fetchSongMeta } from './metadata.mjs';
import { searchSpotifyTracks } from './spotify-search.mjs';
import { SpotifyNotConfiguredError } from './spotify-errors.mjs';
import * as spotify from './spotify-playlist.mjs';

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

const playlistKey = (id) => 'playlists/' + encodeURIComponent(id);
const SPOTIFY_AUTH_KEY = 'spotify-auth';
const SPOTIFY_STATE_KEY = 'spotify-oauth-state';

async function currentPlaylistInfo(store, meta) {
  if (!meta.playlistId) return null;
  const p = await store.get(playlistKey(meta.playlistId), { type: 'json' });
  return p ? { url: p.url, name: p.name } : null;
}

async function getSpotifyAuth(store) {
  return store.get(SPOTIFY_AUTH_KEY, { type: 'json' });
}

// Spotify may rotate the refresh token on refresh; persist it when it does.
async function ensureSpotifyAccessToken(store, spotifyApi) {
  const auth = await getSpotifyAuth(store);
  if (!auth?.refreshToken) return null;
  const { accessToken, refreshToken: rotated } = await spotifyApi.refreshAccessToken(auth.refreshToken);
  if (rotated && rotated !== auth.refreshToken) {
    await store.setJSON(SPOTIFY_AUTH_KEY, { ...auth, refreshToken: rotated });
  }
  return accessToken;
}

// Best-effort: returns null (no playlist this round) whenever nothing is
// connected or there's nothing Spotify to add - never throws for those cases.
async function createGamePlaylist(store, entries, spotifyApi) {
  const auth = await getSpotifyAuth(store);
  if (!auth) return null;

  const trackUris = entries
    .filter((e) => e.platform === 'spotify')
    .map((e) => spotifyApi.extractTrackId(e.url))
    .filter(Boolean)
    .map((id) => `spotify:track:${id}`);
  if (!trackUris.length) return null;

  const accessToken = await ensureSpotifyAccessToken(store, spotifyApi);
  if (!accessToken) return null;
  const name = `מי בחר את זה — ${new Date().toLocaleDateString('he-IL')}`;
  const playlist = await spotifyApi.createPlaylist(accessToken, auth.userId, name);
  await spotifyApi.addTracks(accessToken, playlist.id, trackUris);
  return { id: playlist.id, url: playlist.url, name, trackCount: trackUris.length };
}

// Flips the game live and, best-effort, creates this game's Spotify
// playlist. Playlist creation never blocks or fails the game starting.
async function startGame(store, entries, spotifyApi) {
  let playlistId = null;
  try {
    const playlist = await createGamePlaylist(store, entries, spotifyApi);
    if (playlist) {
      await store.setJSON(playlistKey(playlist.id), {
        id: playlist.id,
        url: playlist.url,
        name: playlist.name,
        createdAt: Date.now(),
        trackCount: playlist.trackCount,
      });
      playlistId = playlist.id;
    }
  } catch (err) {
    console.warn('playlist creation failed', err?.message || err);
  }
  await store.setJSON('meta', { status: 'live', playlistId });
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

// ---------- song search ----------

const MIN_SEARCH_QUERY = 2;
const MAX_SEARCH_QUERY = 100;

async function searchSongs(query, searchTracks) {
  const q = String(query ?? '').trim().slice(0, MAX_SEARCH_QUERY);
  if (q.length < MIN_SEARCH_QUERY) return { results: [] };
  try {
    return { results: await searchTracks(q) };
  } catch (err) {
    if (err instanceof SpotifyNotConfiguredError) {
      throw new HttpError(
        500,
        'חיפוש שירים לא הוגדר. הוסיפו SPOTIFY_CLIENT_ID ו-SPOTIFY_CLIENT_SECRET ב-Netlify תחת Site configuration → Environment variables, ואז פרסמו מחדש.',
      );
    }
    console.warn('song search failed', err?.message || err);
    throw new HttpError(502, 'החיפוש לא הצליח כרגע. אפשר להדביק את הקישור ידנית.');
  }
}

// ---------- player actions ----------

async function login(store, body) {
  const name = cleanName(body?.name);
  const meta = await getMeta(store);
  const entries = await loadEntries(store);
  const me = findEntry(entries, name);
  const players = entries.map((e) => e.name).sort(byName);

  if (meta.status === 'setup') {
    return {
      status: 'setup',
      name: me?.name ?? name,
      registered: !!me,
      url: me?.url ?? null,
      title: me?.title ?? null,
      artist: me?.artist ?? null,
      image: me?.image ?? null,
      players,
    };
  }
  if (!me) {
    throw new HttpError(404, 'לא מצאנו את השם הזה. בדקו את האיות או בקשו מהמנחה להוסיף אתכם.');
  }
  const row = await store.get(guessKey(me.name), { type: 'json' });
  const playlist = await currentPlaylistInfo(store, meta);

  if (meta.status === 'live') {
    if (row) return { status: 'live', name: me.name, submitted: true, playlist };
    return {
      status: 'live',
      name: me.name,
      submitted: false,
      mySongId: me.songId,
      songs: entries.map(publicSong),
      players: players.filter((p) => nameKey(p) !== nameKey(me.name)),
      playlist,
    };
  }
  // finished
  const leaderboard = await buildLeaderboard(store, entries);
  if (!row) return { status: 'finished', name: me.name, submitted: false, leaderboard, playlist };
  const { score, total, review } = scoreRow(entries, row);
  return { status: 'finished', name: me.name, submitted: true, score, total, review, leaderboard, playlist };
}

async function join(store, body, fetchMeta, spotifyApi) {
  const name = cleanName(body?.name);
  const { url, platform } = parseSongUrl(body?.url);
  const meta = await getMeta(store);
  if (meta.status !== 'setup') throw new HttpError(409, 'איסוף השירים סגור. בקשו מהמנחה להוסיף אתכם.');
  const entries = await loadEntries(store);
  const existing = findEntry(entries, name);
  if (!existing && entries.length >= MAX_PLAYERS) throw new HttpError(409, 'המשחק הזה מלא.');
  const hadSongBefore = !!existing?.url;
  const info = existing?.url === url && hasMeta(existing) ? existing : await fetchMeta(url, platform);
  const savedName = existing?.name ?? name;
  await store.setJSON(entryKey(savedName), {
    name: savedName,
    url,
    platform,
    title: info?.title ?? null,
    artist: info?.artist ?? null,
    image: info?.image ?? null,
    songId: existing?.songId ?? randomBytes(4).toString('hex'),
    createdAt: existing?.createdAt ?? Date.now(),
  });

  // Auto-start: only when *this* player just added their first song (not an
  // edit of an existing one), and that was the last song the game needed.
  // Admin-side entry edits never trigger this.
  if (!hadSongBefore) {
    const updatedEntries = await loadEntries(store);
    const readyToStart = updatedEntries.length >= MIN_PLAYERS && updatedEntries.every((e) => !!e.url);
    if (readyToStart) await startGame(store, updatedEntries, spotifyApi);
  }
  return { ok: true, name: savedName };
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

  const priorRows = await listJson(store, 'guesses/');
  await store.setJSON(guessKey(me.name), { name: me.name, guesses, submittedAt: Date.now() });

  // Auto-finish once every player has locked in their answers.
  const submitted = new Set(priorRows.map((r) => nameKey(r.name)));
  submitted.add(nameKey(me.name));
  if (entries.every((e) => submitted.has(nameKey(e.name)))) {
    await store.setJSON('meta', { ...meta, status: 'finished' });
  }
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

async function adminSetStatus(store, body, spotifyApi) {
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
    await startGame(store, entries, spotifyApi);
    return { ok: true, status: next };
  }
  if (next === 'live' && from === 'finished') {
    // reopen: keep submissions and the game's existing playlist
  } else if (next === 'finished' && from === 'live') {
    // reveal: keep the game's existing playlist
  } else if (next === 'setup' && (from === 'live' || from === 'finished')) {
    await clearGuesses(store);
    await store.setJSON('meta', { status: next, playlistId: null });
    return { ok: true, status: next };
  } else {
    throw new HttpError(409, 'השינוי הזה לא אפשרי מהמצב הנוכחי.');
  }
  await store.setJSON('meta', { ...meta, status: next });
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

// ---------- Spotify account + playlist history ----------

async function spotifyStatus(store) {
  const auth = await getSpotifyAuth(store);
  return { connected: !!auth, displayName: auth?.displayName ?? null };
}

async function spotifyDisconnect(store) {
  await store.delete(SPOTIFY_AUTH_KEY);
  return { ok: true };
}

// A plain browser navigation (clicking a link), so the admin code travels as
// a query param rather than the x-admin-code header used everywhere else.
async function spotifyConnectUrl(store, adminCode, adminSecret, origin, spotifyApi) {
  requireAdmin(adminCode, adminSecret);
  if (!origin) throw new HttpError(500, 'לא ניתן לזהות את כתובת האתר.');
  const state = randomBytes(16).toString('hex');
  await store.setJSON(SPOTIFY_STATE_KEY, { state, createdAt: Date.now() });
  return spotifyApi.buildAuthorizeUrl(`${origin}/api/spotify/callback`, state);
}

// Always returns a URL to redirect the browser to (success or failure) -
// Spotify itself navigated here, so there's no one to hand a JSON error to.
async function spotifyCallback(store, query, origin, spotifyApi) {
  const stored = await store.get(SPOTIFY_STATE_KEY, { type: 'json' });
  await store.delete(SPOTIFY_STATE_KEY); // single-use
  const failed = `${origin}/?spotify=error#admin`;
  if (!stored || !query?.state || query.state !== stored.state || query?.error || !query?.code) {
    return failed;
  }
  try {
    const { accessToken, refreshToken } = await spotifyApi.exchangeCodeForTokens(query.code, `${origin}/api/spotify/callback`);
    const user = await spotifyApi.getCurrentUser(accessToken);
    await store.setJSON(SPOTIFY_AUTH_KEY, {
      refreshToken,
      userId: user.id,
      displayName: user.displayName,
      connectedAt: Date.now(),
    });
    return `${origin}/?spotify=connected#admin`;
  } catch (err) {
    console.warn('spotify oauth callback failed', err?.message || err);
    return failed;
  }
}

async function adminListPlaylists(store) {
  const rows = await listJson(store, 'playlists/');
  rows.sort((a, b) => b.createdAt - a.createdAt);
  return { playlists: rows };
}

async function adminRenamePlaylist(store, body, spotifyApi) {
  const id = body?.id;
  const name = normName(body?.name);
  if (!id) throw new HttpError(400, 'חסר מזהה פלייליסט.');
  if (!name) throw new HttpError(400, 'תנו שם לפלייליסט.');
  const record = await store.get(playlistKey(id), { type: 'json' });
  if (!record) throw new HttpError(404, 'הפלייליסט לא נמצא.');
  const accessToken = await ensureSpotifyAccessToken(store, spotifyApi).catch(() => null);
  if (accessToken) {
    try {
      await spotifyApi.renamePlaylist(accessToken, id, name);
    } catch (err) {
      console.warn('spotify rename failed', err?.message || err);
    }
  }
  await store.setJSON(playlistKey(id), { ...record, name });
  return { ok: true };
}

async function adminDeletePlaylist(store, body, spotifyApi) {
  const id = body?.id;
  if (!id) throw new HttpError(400, 'חסר מזהה פלייליסט.');
  const record = await store.get(playlistKey(id), { type: 'json' });
  if (record) {
    const accessToken = await ensureSpotifyAccessToken(store, spotifyApi).catch(() => null);
    if (accessToken) {
      try {
        await spotifyApi.unfollowPlaylist(accessToken, id);
      } catch (err) {
        console.warn('spotify unfollow failed', err?.message || err);
      }
    }
    await store.delete(playlistKey(id));
  }
  return { ok: true };
}

// ---------- router ----------

export async function handle(
  {
    method,
    path,
    body,
    query,
    origin,
    adminCode,
    adminSecret,
    fetchMeta = fetchSongMeta,
    searchTracks = searchSpotifyTracks,
    spotifyApi = spotify,
  },
  store,
) {
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
      case 'GET /search-songs': return ok(await searchSongs(query?.q, searchTracks));
      case 'POST /login': return ok(await login(store, body));
      case 'POST /join': return ok(await join(store, body, fetchMeta, spotifyApi));
      case 'POST /submit': return ok(await submit(store, body));
      case 'GET /spotify/connect': return redirect(await spotifyConnectUrl(store, query?.code, adminSecret, origin, spotifyApi));
      case 'GET /spotify/callback': return redirect(await spotifyCallback(store, query, origin, spotifyApi));
      case 'GET /admin/overview': return ok(await adminOverview(store));
      case 'POST /admin/entry': return ok(await adminSaveEntry(store, body, fetchMeta));
      case 'POST /admin/entry/delete': return ok(await adminDeleteEntry(store, body));
      case 'POST /admin/status': return ok(await adminSetStatus(store, body, spotifyApi));
      case 'POST /admin/reset-guess': return ok(await adminResetGuess(store, body));
      case 'POST /admin/new-game': return ok(await adminNewGame(store));
      case 'GET /admin/spotify/status': return ok(await spotifyStatus(store));
      case 'POST /admin/spotify/disconnect': return ok(await spotifyDisconnect(store));
      case 'GET /admin/playlists': return ok(await adminListPlaylists(store));
      case 'POST /admin/playlists/rename': return ok(await adminRenamePlaylist(store, body, spotifyApi));
      case 'POST /admin/playlists/delete': return ok(await adminDeletePlaylist(store, body, spotifyApi));
      default: throw new HttpError(404, 'הנתיב לא נמצא.');
    }
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, data: { error: e.message } };
    console.error(e);
    return { status: 500, data: { error: 'משהו השתבש אצלנו. נסו שוב.' } };
  }
}

const ok = (data) => ({ status: 200, data });
const redirect = (url) => ({ status: 302, redirect: url });
