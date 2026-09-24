import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../netlify/functions/lib/game.mjs';
import { SpotifyNotConfiguredError } from '../netlify/functions/lib/spotify-search.mjs';
import { memoryStore } from './memory-store.mjs';

const SECRET = 'hostcode';
const SP = (id) => `https://open.spotify.com/track/${id}`;
const YT = (id) => `https://www.youtube.com/watch?v=${id}`;

const stubMeta = async () => ({ title: 'Test Song', artist: 'Test Artist', image: 'https://img.example/cover.jpg' });
const stubSearch = async () => [];
const ORIGIN = 'https://example.test';

function fakeSpotifyApi(overrides = {}) {
  return {
    buildAuthorizeUrl: (redirectUri, state) => `https://accounts.spotify.com/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
    exchangeCodeForTokens: async (code) => ({ accessToken: `access-${code}`, refreshToken: `refresh-${code}`, expiresIn: 3600 }),
    refreshAccessToken: async (refreshToken) => ({ accessToken: `access-from-${refreshToken}`, expiresIn: 3600, refreshToken: null }),
    getCurrentUser: async () => ({ id: 'user1', displayName: 'Test User' }),
    createPlaylist: async () => ({ id: 'pl1', url: 'https://open.spotify.com/playlist/pl1' }),
    addTracks: async () => {},
    renamePlaylist: async () => {},
    unfollowPlaylist: async () => {},
    extractTrackId: (url) => String(url ?? '').match(/\/track\/([a-zA-Z0-9]+)/)?.[1] ?? null,
    ...overrides,
  };
}

function client(store, fetchMeta = stubMeta, searchTracks = stubSearch, spotifyApi, origin = ORIGIN) {
  const call = (method, path, body, adminCode, query) =>
    handle({ method, path: '/api' + path, body, adminCode, adminSecret: SECRET, fetchMeta, searchTracks, spotifyApi, origin, query }, store);
  return {
    call,
    post: (p, b) => call('POST', p, b),
    get: (p, query) => call('GET', p, undefined, undefined, query),
    admin: (method, p, b) => call(method, '/admin' + p, b, SECRET),
  };
}

async function seededGame() {
  const c = client(memoryStore());
  // Register all 4 up front (host side, no songs yet) so that self-joining a
  // song below doesn't auto-start the game as soon as MIN_PLAYERS is hit -
  // only the last of the 4 to add a song should trigger that.
  for (const name of ['Ana', 'Ben', 'Cy', 'Dee']) {
    assert.equal((await c.admin('POST', '/entry', { name })).status, 200);
  }
  for (const [name, url] of [['Ana', SP('a')], ['Ben', YT('b')], ['Cy', SP('c')], ['Dee', YT('d')]]) {
    assert.equal((await c.post('/join', { name, url })).status, 200);
  }
  return c;
}

// Same 4 players, but added by the host: unlike /join, this never auto-starts,
// so the game stays in 'setup' for tests that need to exercise that phase.
async function seededGameViaAdmin() {
  const c = client(memoryStore());
  for (const [name, url] of [['Ana', SP('a')], ['Ben', YT('b')], ['Cy', SP('c')], ['Dee', YT('d')]]) {
    assert.equal((await c.admin('POST', '/entry', { name, url })).status, 200);
  }
  return c;
}

// Build a complete set of guesses for `name`; `pick(song, correctOwner, others)` decides each answer.
async function answers(c, name, mode) {
  const me = (await c.post('/login', { name })).data;
  const truth = (await c.admin('GET', '/overview')).data.entries;
  const ownerOf = Object.fromEntries(truth.map((e) => [e.id, e.name]));
  const songs = me.songs.filter((s) => s.id !== me.mySongId);
  const guesses = {};
  if (mode === 'right') {
    songs.forEach((s) => (guesses[s.id] = ownerOf[s.id]));
  } else {
    // shift every answer to the "next" owner, so nothing is right
    const owners = songs.map((s) => ownerOf[s.id]);
    songs.forEach((s, i) => (guesses[s.id] = owners[(i + 1) % owners.length]));
  }
  return guesses;
}

test('join validates names and links', async () => {
  const c = client(memoryStore());
  assert.equal((await c.post('/join', { name: '', url: SP('x') })).status, 400);
  assert.equal((await c.post('/join', { name: 'Ana', url: 'https://example.com/song' })).status, 400);
  assert.equal((await c.post('/join', { name: 'Ana', url: 'https://evilspotify.com/track/1' })).status, 400);
  assert.equal((await c.post('/join', { name: 'Ana', url: 'nope' })).status, 400);
  assert.equal((await c.post('/join', { name: 'Ana', url: 'https://youtu.be/abc' })).status, 200);
});

test('song metadata is fetched on join and reused when the link is unchanged', async () => {
  let calls = 0;
  const fetchMeta = async () => { calls += 1; return { title: 'Song', artist: 'Artist', image: 'https://img.example/a.jpg' }; };
  const c = client(memoryStore(), fetchMeta);
  await c.post('/join', { name: 'Ana', url: SP('1') });
  assert.equal(calls, 1);
  let o = (await c.admin('GET', '/overview')).data;
  assert.deepEqual([o.entries[0].title, o.entries[0].artist], ['Song', 'Artist']);
  assert.equal(o.entries[0].image, 'https://img.example/a.jpg');

  // same link again -> no re-fetch, metadata kept
  await c.post('/join', { name: 'Ana', url: SP('1') });
  assert.equal(calls, 1);

  // new link -> re-fetched
  await c.post('/join', { name: 'Ana', url: SP('2') });
  assert.equal(calls, 2);

  // metadata lookup failure doesn't block joining
  const c2 = client(memoryStore(), async () => null);
  assert.equal((await c2.post('/join', { name: 'Ben', url: SP('x') })).status, 200);
  o = (await c2.admin('GET', '/overview')).data;
  assert.deepEqual([o.entries[0].title, o.entries[0].artist], [null, null]);

  // a failed lookup is retried on the next join/edit, even with the same link
  let attempt = 0;
  const flaky = async () => (++attempt === 1 ? null : { title: 'Song', artist: 'Artist' });
  const c3 = client(memoryStore(), flaky);
  await c3.post('/join', { name: 'Cy', url: SP('y') });
  o = (await c3.admin('GET', '/overview')).data;
  assert.deepEqual([o.entries[0].title, o.entries[0].artist], [null, null]);
  await c3.post('/join', { name: 'Cy', url: SP('y') });
  assert.equal(attempt, 2);
  o = (await c3.admin('GET', '/overview')).data;
  assert.deepEqual([o.entries[0].title, o.entries[0].artist], ['Song', 'Artist']);
});

test('names are unique case-insensitively; rejoining updates the song', async () => {
  const c = client(memoryStore());
  await c.post('/join', { name: 'Ana', url: SP('1') });
  await c.post('/join', { name: ' ana ', url: SP('2') });
  const o = await c.admin('GET', '/overview');
  assert.equal(o.data.entries.length, 1);
  assert.equal(o.data.entries[0].name, 'Ana');
  assert.match(o.data.entries[0].url, /track\/2/);
});

test('admin routes need the host code', async () => {
  const c = client(memoryStore());
  assert.equal((await c.call('GET', '/admin/overview', null, 'wrong')).status, 401);
  assert.equal((await c.call('GET', '/admin/overview', null, undefined)).status, 401);
  const noSecret = await handle({ method: 'GET', path: '/api/admin/overview', adminCode: 'x' }, memoryStore());
  assert.equal(noSecret.status, 500);
});

test('cannot start with fewer than 3 players', async () => {
  const c = client(memoryStore());
  await c.post('/join', { name: 'Ana', url: SP('1') });
  await c.post('/join', { name: 'Ben', url: SP('2') });
  assert.equal((await c.admin('POST', '/status', { status: 'live' })).status, 400);
});

test('host can add a player without a song link; they add it later, or the host does', async () => {
  const c = client(memoryStore());
  await c.post('/join', { name: 'Ana', url: SP('1') });
  await c.post('/join', { name: 'Ben', url: SP('2') });
  assert.equal((await c.admin('POST', '/entry', { name: 'Cy' })).status, 200); // no url at all

  let o = (await c.admin('GET', '/overview')).data;
  const cy = o.entries.find((e) => e.name === 'Cy');
  assert.deepEqual([cy.url, cy.platform, cy.title, cy.artist, cy.image], [null, null, null, null, null]);

  // enough players, but Cy still has no song -> can't start
  assert.equal(o.entries.length, 3);
  let live = await c.admin('POST', '/status', { status: 'live' });
  assert.equal(live.status, 400);

  // Cy logs in themselves and sees they still need to add a song
  const cyLogin = (await c.post('/login', { name: 'Cy' })).data;
  assert.deepEqual(cyLogin, {
    status: 'setup', name: 'Cy', registered: true, url: null, title: null, artist: null, image: null,
    players: ['Ana', 'Ben', 'Cy'],
  });

  // Cy adds their own song, the last one needed -> the game auto-starts
  assert.equal((await c.post('/join', { name: 'Cy', url: SP('3') })).status, 200);
  assert.equal((await c.get('/status')).data.status, 'live');
  await c.admin('POST', '/status', { status: 'finished' });
  await c.admin('POST', '/status', { status: 'setup' });

  // alternatively, the host could have added the link for a player who never comes back
  assert.equal((await c.admin('POST', '/entry', { name: 'Dee' })).status, 200);
  live = await c.admin('POST', '/status', { status: 'live' });
  assert.equal(live.status, 400);
  assert.equal((await c.admin('POST', '/entry', { oldName: 'Dee', name: 'Dee', url: SP('4') })).status, 200);
  live = await c.admin('POST', '/status', { status: 'live' });
  assert.equal(live.status, 200);
});

test('auto-start: only a player finishing their own first song, via /join, starts the game', async () => {
  const c = client(memoryStore());
  await c.post('/join', { name: 'Ana', url: SP('1') });
  await c.post('/join', { name: 'Ben', url: SP('2') });
  assert.equal((await c.get('/status')).data.status, 'setup'); // still short of MIN_PLAYERS

  // admin completing the last song must NOT auto-start (player page only)
  assert.equal((await c.admin('POST', '/entry', { name: 'Cy' })).status, 200);
  assert.equal((await c.admin('POST', '/entry', { oldName: 'Cy', name: 'Cy', url: SP('3') })).status, 200);
  assert.equal((await c.get('/status')).data.status, 'setup');

  // a player re-saving their OWN existing song is not "their first song" -> no auto-start
  await c.post('/join', { name: 'Ana', url: SP('1-updated') });
  assert.equal((await c.get('/status')).data.status, 'setup');

  // add a 4th, songless player so the game isn't already complete
  assert.equal((await c.admin('POST', '/entry', { name: 'Dee' })).status, 200);
  await c.post('/join', { name: 'Ana', url: SP('1-updated-again') }); // still just an edit, not their first
  assert.equal((await c.get('/status')).data.status, 'setup');

  // Dee adding their first song is the last one needed -> auto-starts
  assert.equal((await c.post('/join', { name: 'Dee', url: SP('4') })).status, 200);
  assert.equal((await c.get('/status')).data.status, 'live');
});

test('auto-finish: the game ends the moment every player has submitted', async () => {
  const c = await seededGame(); // already live: seeding the 4th song auto-starts it
  assert.equal((await c.get('/status')).data.status, 'live');

  await c.post('/submit', { name: 'Ana', guesses: await answers(c, 'Ana', 'right') });
  assert.equal((await c.get('/status')).data.status, 'live');
  await c.post('/submit', { name: 'Ben', guesses: await answers(c, 'Ben', 'right') });
  assert.equal((await c.get('/status')).data.status, 'live');
  await c.post('/submit', { name: 'Cy', guesses: await answers(c, 'Cy', 'right') });
  assert.equal((await c.get('/status')).data.status, 'live');
  await c.post('/submit', { name: 'Dee', guesses: await answers(c, 'Dee', 'right') }); // the last one
  assert.equal((await c.get('/status')).data.status, 'finished');
});

test('players never see who picked what while the quiz is live', async () => {
  const c = await seededGame(); // auto-started once Dee (the 4th) joined
  const r = await c.post('/login', { name: 'Ana' });
  assert.equal(r.data.status, 'live');
  assert.equal(r.data.songs.length, 4);
  assert.deepEqual(r.data.players, ['Ben', 'Cy', 'Dee']);
  assert.deepEqual(Object.keys(r.data.songs[0]).sort(), ['artist', 'id', 'image', 'n', 'platform', 'title', 'url']);
  assert.equal((await c.post('/login', { name: 'Zed' })).status, 404);
});

test('full flow: submit, scoring, results only after finish', async () => {
  const c = await seededGame(); // auto-started once Dee (the 4th) joined

  const anaGuesses = await answers(c, 'Ana', 'right');
  assert.equal((await c.post('/submit', { name: 'Ana', guesses: anaGuesses })).status, 200);
  assert.equal((await c.post('/submit', { name: 'Ana', guesses: anaGuesses })).status, 409); // no double submit
  // while live: no score leaked
  assert.deepEqual((await c.post('/login', { name: 'Ana' })).data, { status: 'live', name: 'Ana', submitted: true, playlist: null });

  const benGuesses = await answers(c, 'Ben', 'wrong');
  assert.equal((await c.post('/submit', { name: 'Ben', guesses: benGuesses })).status, 200);

  const ov = (await c.admin('GET', '/overview')).data;
  assert.equal(ov.submissions.length, 2);

  assert.equal((await c.admin('POST', '/status', { status: 'finished' })).status, 200);
  const rAna = (await c.post('/login', { name: 'Ana' })).data;
  assert.equal(rAna.status, 'finished');
  assert.equal(rAna.score, 3);
  assert.equal(rAna.total, 3);
  assert.ok(rAna.review.every((r) => r.own || r.correct === true));
  assert.equal(rAna.review.filter((r) => r.own).length, 1);

  // everyone sees the same full leaderboard, not just their own score
  const expectedLeaderboard = [
    { name: 'Ana', submitted: true, score: 3, total: 3 },
    { name: 'Ben', submitted: true, score: 0, total: 3 },
    { name: 'Cy', submitted: false, score: null, total: null },
    { name: 'Dee', submitted: false, score: null, total: null },
  ];
  assert.deepEqual(rAna.leaderboard, expectedLeaderboard);

  const rBen = (await c.post('/login', { name: 'Ben' })).data;
  assert.equal(rBen.total, 3);
  assert.equal(rBen.score, 0);
  assert.ok(rBen.review.filter((r) => !r.own).every((r) => r.correct === false && r.answer));
  assert.deepEqual(rBen.leaderboard, expectedLeaderboard);

  const rCy = (await c.post('/login', { name: 'Cy' })).data;
  assert.deepEqual(rCy, { status: 'finished', name: 'Cy', submitted: false, leaderboard: expectedLeaderboard, playlist: null });

  assert.equal((await c.post('/submit', { name: 'Cy', guesses: {} })).status, 409);
  assert.equal((await c.post('/join', { name: 'Late', url: SP('z') })).status, 409);
});

test('submit validation: incomplete, duplicate, self, unknown names', async () => {
  const c = await seededGame(); // auto-started once Dee (the 4th) joined
  const me = (await c.post('/login', { name: 'Ana' })).data;
  const ids = me.songs.filter((s) => s.id !== me.mySongId).map((s) => s.id);
  const bad = async (guesses) => (await c.post('/submit', { name: 'Ana', guesses })).status;
  assert.equal(await bad({}), 400);
  assert.equal(await bad({ [ids[0]]: 'Ben', [ids[1]]: 'Ben', [ids[2]]: 'Cy' }), 400); // duplicate
  assert.equal(await bad({ [ids[0]]: 'Ana', [ids[1]]: 'Ben', [ids[2]]: 'Cy' }), 400); // self
  assert.equal(await bad({ [ids[0]]: 'Zed', [ids[1]]: 'Ben', [ids[2]]: 'Cy' }), 400); // unknown
  assert.equal(await bad({ [ids[0]]: 'ben', [ids[1]]: 'cy', [ids[2]]: 'dee' }), 200); // case-insensitive ok
});

test('host can edit/rename/delete in setup only, and reset a submission while live', async () => {
  const c = await seededGameViaAdmin();
  assert.equal((await c.admin('POST', '/entry', { oldName: 'Dee', name: 'Deedee', url: SP('new') })).status, 200);
  assert.equal((await c.admin('POST', '/entry', { name: 'ana', url: SP('z') })).status, 409);
  assert.equal((await c.admin('POST', '/entry/delete', { name: 'Deedee' })).status, 200);
  assert.equal((await c.admin('POST', '/entry', { name: 'Eve', url: SP('e') })).status, 200);
  const o = (await c.admin('GET', '/overview')).data;
  assert.deepEqual(o.entries.map((e) => e.name).sort(), ['Ana', 'Ben', 'Cy', 'Eve']);

  await c.admin('POST', '/status', { status: 'live' });
  assert.equal((await c.admin('POST', '/entry', { name: 'Zed', url: SP('z') })).status, 409);
  await c.post('/submit', { name: 'Ana', guesses: await answers(c, 'Ana', 'right') });
  assert.equal((await c.admin('GET', '/overview')).data.submissions.length, 1);
  await c.admin('POST', '/reset-guess', { name: 'Ana' });
  assert.equal((await c.admin('GET', '/overview')).data.submissions.length, 0);
});

test('back to setup clears answers; new game wipes everything', async () => {
  const c = await seededGame(); // auto-started once Dee (the 4th) joined
  await c.post('/submit', { name: 'Ana', guesses: await answers(c, 'Ana', 'right') });
  await c.admin('POST', '/status', { status: 'setup' });
  let o = (await c.admin('GET', '/overview')).data;
  assert.equal(o.status, 'setup');
  assert.equal(o.submissions.length, 0);
  assert.equal(o.entries.length, 4);
  await c.admin('POST', '/new-game', {});
  o = (await c.admin('GET', '/overview')).data;
  assert.equal(o.entries.length, 0);
  assert.equal((await c.get('/status')).data.status, 'setup');
});

test('song search: skips short queries, returns results, and surfaces config/lookup errors', async () => {
  let calls = 0;
  const counting = async () => { calls += 1; return []; };
  const c1 = client(memoryStore(), stubMeta, counting);
  assert.deepEqual((await c1.get('/search-songs', { q: 'a' })).data, { results: [] });
  assert.deepEqual((await c1.get('/search-songs', {})).data, { results: [] });
  assert.equal(calls, 0); // too short to bother searching

  const found = [{ url: SP('x'), title: 'Song', artist: 'Artist', image: null }];
  const c2 = client(memoryStore(), stubMeta, async (q) => {
    assert.equal(q, 'daft punk');
    return found;
  });
  assert.deepEqual((await c2.get('/search-songs', { q: 'daft punk' })).data, { results: found });

  const c3 = client(memoryStore(), stubMeta, async () => { throw new SpotifyNotConfiguredError('nope'); });
  const r3 = await c3.get('/search-songs', { q: 'abc' });
  assert.equal(r3.status, 500);
  assert.match(r3.data.error, /SPOTIFY_CLIENT_ID/);

  const c4 = client(memoryStore(), stubMeta, async () => { throw new Error('boom'); });
  const r4 = await c4.get('/search-songs', { q: 'abc' });
  assert.equal(r4.status, 502);
});

async function connectSpotify(store) {
  await store.setJSON('spotify-auth', { refreshToken: 'seed-refresh', userId: 'user1', displayName: 'Test User', connectedAt: Date.now() });
}

test('game playlist: created on start when connected, skipping YouTube songs', async () => {
  const calls = { createPlaylist: [], addTracks: [] };
  const spotifyApi = fakeSpotifyApi({
    createPlaylist: async (accessToken, userId, name) => {
      calls.createPlaylist.push({ accessToken, userId, name });
      return { id: 'pl1', url: 'https://open.spotify.com/playlist/pl1' };
    },
    addTracks: async (accessToken, playlistId, uris) => { calls.addTracks.push({ accessToken, playlistId, uris }); },
  });
  const store = memoryStore();
  await connectSpotify(store);
  const c = client(store, stubMeta, stubSearch, spotifyApi);
  for (const [name, url] of [['Ana', SP('a')], ['Ben', YT('b')], ['Cy', SP('c')]]) {
    assert.equal((await c.admin('POST', '/entry', { name, url })).status, 200);
  }
  assert.equal((await c.admin('POST', '/status', { status: 'live' })).data.status, 'live');

  assert.equal(calls.createPlaylist.length, 1);
  assert.equal(calls.createPlaylist[0].userId, 'user1');
  assert.equal(calls.addTracks.length, 1);
  // entries are ordered by a random songId, not insertion order, so compare as a set
  assert.deepEqual([...calls.addTracks[0].uris].sort(), ['spotify:track:a', 'spotify:track:c']); // Ben's YouTube link is skipped

  const login = (await c.post('/login', { name: 'Ana' })).data;
  assert.equal(login.playlist.url, 'https://open.spotify.com/playlist/pl1');
  assert.ok(login.playlist.name.length > 0);

  const history = (await c.admin('GET', '/playlists')).data.playlists;
  assert.equal(history.length, 1);
  assert.equal(history[0].id, 'pl1');
  assert.equal(history[0].trackCount, 2);
});

test('game playlist: skipped gracefully when not connected, all-YouTube, or Spotify errors - never blocks starting', async () => {
  // not connected at all
  let c = client(memoryStore());
  for (const [name, url] of [['Ana', SP('a')], ['Ben', SP('b')], ['Cy', SP('c')]]) {
    assert.equal((await c.admin('POST', '/entry', { name, url })).status, 200);
  }
  assert.equal((await c.admin('POST', '/status', { status: 'live' })).data.status, 'live');
  assert.equal((await c.post('/login', { name: 'Ana' })).data.playlist, null);

  // connected, but every song is YouTube -> nothing to add, so no playlist
  let store = memoryStore();
  await connectSpotify(store);
  c = client(store, stubMeta, stubSearch, fakeSpotifyApi());
  for (const [name, url] of [['Ana', YT('a')], ['Ben', YT('b')], ['Cy', YT('c')]]) {
    assert.equal((await c.admin('POST', '/entry', { name, url })).status, 200);
  }
  assert.equal((await c.admin('POST', '/status', { status: 'live' })).data.status, 'live');
  assert.equal((await c.post('/login', { name: 'Ana' })).data.playlist, null);

  // connected, has Spotify songs, but the Spotify API call fails - game still starts fine
  store = memoryStore();
  await connectSpotify(store);
  const failingApi = fakeSpotifyApi({ createPlaylist: async () => { throw new Error('spotify is down'); } });
  c = client(store, stubMeta, stubSearch, failingApi);
  for (const [name, url] of [['Ana', SP('a')], ['Ben', SP('b')], ['Cy', SP('c')]]) {
    assert.equal((await c.admin('POST', '/entry', { name, url })).status, 200);
  }
  const live = await c.admin('POST', '/status', { status: 'live' });
  assert.equal(live.status, 200);
  assert.equal(live.data.status, 'live');
  assert.equal((await c.post('/login', { name: 'Ana' })).data.playlist, null);
});

test('game playlist: the link survives finish/reopen, and is cleared (but kept in history) on reset', async () => {
  const store = memoryStore();
  await connectSpotify(store);
  const c = client(store, stubMeta, stubSearch, fakeSpotifyApi());
  for (const [name, url] of [['Ana', SP('a')], ['Ben', SP('b')], ['Cy', SP('c')]]) {
    assert.equal((await c.admin('POST', '/entry', { name, url })).status, 200);
  }
  await c.admin('POST', '/status', { status: 'live' });
  const playlistUrl = (await c.post('/login', { name: 'Ana' })).data.playlist.url;
  assert.ok(playlistUrl);

  await c.admin('POST', '/status', { status: 'finished' });
  assert.equal((await c.post('/login', { name: 'Ana' })).data.playlist.url, playlistUrl);

  await c.admin('POST', '/status', { status: 'live' }); // reopen
  assert.equal((await c.post('/login', { name: 'Ana' })).data.playlist.url, playlistUrl);

  await c.admin('POST', '/status', { status: 'setup' });
  assert.equal((await c.admin('GET', '/overview')).data.status, 'setup');
  assert.equal((await c.admin('GET', '/playlists')).data.playlists.length, 1); // stays in history
});

test('spotify connect flow: authorize redirect needs the admin code, callback checks single-use state', async () => {
  const store = memoryStore();
  const c = client(store, stubMeta, stubSearch, fakeSpotifyApi());

  assert.equal((await c.get('/spotify/connect', { code: 'wrong' })).status, 401);

  let r = await c.get('/spotify/connect', { code: SECRET });
  assert.equal(r.status, 302);
  assert.match(r.redirect, /^https:\/\/accounts\.spotify\.com\/authorize\?/);
  assert.match(r.redirect, new RegExp(encodeURIComponent(`${ORIGIN}/api/spotify/callback`)));
  const mismatchedState = 'not-the-real-state';

  let cb = await c.get('/spotify/callback', { code: 'auth-code', state: mismatchedState });
  assert.equal(cb.status, 302);
  assert.match(cb.redirect, /spotify=error/);
  assert.equal(await store.get('spotify-auth', { type: 'json' }), null);

  r = await c.get('/spotify/connect', { code: SECRET }); // the failed callback consumed the old state
  const state = new URL(r.redirect).searchParams.get('state');

  cb = await c.get('/spotify/callback', { code: 'auth-code', state });
  assert.equal(cb.status, 302);
  assert.match(cb.redirect, /spotify=connected/);
  assert.deepEqual((await c.admin('GET', '/spotify/status')).data, { connected: true, displayName: 'Test User' });

  cb = await c.get('/spotify/callback', { code: 'auth-code', state }); // single-use: replay fails
  assert.match(cb.redirect, /spotify=error/);

  assert.equal((await c.admin('POST', '/spotify/disconnect')).status, 200);
  assert.deepEqual((await c.admin('GET', '/spotify/status')).data, { connected: false, displayName: null });
});

test('admin playlist history: rename and delete update Spotify (best-effort) and our own record', async () => {
  const store = memoryStore();
  await connectSpotify(store);
  await store.setJSON('playlists/pl1', { id: 'pl1', url: 'https://open.spotify.com/playlist/pl1', name: 'Old Name', createdAt: 1, trackCount: 2 });

  const renamed = [];
  const unfollowed = [];
  const spotifyApi = fakeSpotifyApi({
    renamePlaylist: async (token, id, name) => renamed.push({ token, id, name }),
    unfollowPlaylist: async (token, id) => unfollowed.push({ token, id }),
  });
  const c = client(store, stubMeta, stubSearch, spotifyApi);

  assert.equal((await c.admin('POST', '/playlists/rename', { id: 'pl1', name: 'New Name' })).status, 200);
  assert.equal(renamed.length, 1);
  assert.equal(renamed[0].name, 'New Name');
  assert.equal((await c.admin('GET', '/playlists')).data.playlists[0].name, 'New Name');

  assert.equal((await c.admin('POST', '/playlists/rename', { id: 'missing', name: 'X' })).status, 404);
  assert.equal((await c.admin('POST', '/playlists/rename', { id: 'pl1', name: '' })).status, 400);

  assert.equal((await c.admin('POST', '/playlists/delete', { id: 'pl1' })).status, 200);
  assert.equal(unfollowed.length, 1);
  assert.equal((await c.admin('GET', '/playlists')).data.playlists.length, 0);
  assert.equal((await c.admin('POST', '/playlists/delete', { id: 'pl1' })).status, 200); // unknown id: harmless
});

test('admin playlist rename/delete still succeed locally even if the Spotify API call fails', async () => {
  const store = memoryStore();
  await connectSpotify(store);
  await store.setJSON('playlists/pl1', { id: 'pl1', url: 'x', name: 'Old', createdAt: 1, trackCount: 1 });
  const spotifyApi = fakeSpotifyApi({
    renamePlaylist: async () => { throw new Error('down'); },
    unfollowPlaylist: async () => { throw new Error('down'); },
  });
  const c = client(store, stubMeta, stubSearch, spotifyApi);
  assert.equal((await c.admin('POST', '/playlists/rename', { id: 'pl1', name: 'New' })).status, 200);
  assert.equal((await c.admin('GET', '/playlists')).data.playlists[0].name, 'New');
  assert.equal((await c.admin('POST', '/playlists/delete', { id: 'pl1' })).status, 200);
  assert.equal((await c.admin('GET', '/playlists')).data.playlists.length, 0);
});
