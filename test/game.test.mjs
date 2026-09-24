import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../netlify/functions/lib/game.mjs';
import { memoryStore } from './memory-store.mjs';

const SECRET = 'hostcode';
const SP = (id) => `https://open.spotify.com/track/${id}`;
const YT = (id) => `https://www.youtube.com/watch?v=${id}`;

const stubMeta = async () => ({ title: 'Test Song', artist: 'Test Artist' });

function client(store, fetchMeta = stubMeta) {
  const call = (method, path, body, adminCode) =>
    handle({ method, path: '/api' + path, body, adminCode, adminSecret: SECRET, fetchMeta }, store);
  return {
    call,
    post: (p, b) => call('POST', p, b),
    get: (p) => call('GET', p),
    admin: (method, p, b) => call(method, '/admin' + p, b, SECRET),
  };
}

async function seededGame() {
  const c = client(memoryStore());
  for (const [name, url] of [['Ana', SP('a')], ['Ben', YT('b')], ['Cy', SP('c')], ['Dee', YT('d')]]) {
    assert.equal((await c.post('/join', { name, url })).status, 200);
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
  const fetchMeta = async () => { calls += 1; return { title: 'Song', artist: 'Artist' }; };
  const c = client(memoryStore(), fetchMeta);
  await c.post('/join', { name: 'Ana', url: SP('1') });
  assert.equal(calls, 1);
  let o = (await c.admin('GET', '/overview')).data;
  assert.deepEqual([o.entries[0].title, o.entries[0].artist], ['Song', 'Artist']);

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

test('players never see who picked what while the quiz is live', async () => {
  const c = await seededGame();
  await c.admin('POST', '/status', { status: 'live' });
  const r = await c.post('/login', { name: 'Ana' });
  assert.equal(r.data.status, 'live');
  assert.equal(r.data.songs.length, 4);
  assert.deepEqual(r.data.players, ['Ben', 'Cy', 'Dee']);
  assert.deepEqual(Object.keys(r.data.songs[0]).sort(), ['artist', 'id', 'n', 'platform', 'title', 'url']);
  assert.equal((await c.post('/login', { name: 'Zed' })).status, 404);
});

test('full flow: submit, scoring, results only after finish', async () => {
  const c = await seededGame();
  await c.admin('POST', '/status', { status: 'live' });

  const anaGuesses = await answers(c, 'Ana', 'right');
  assert.equal((await c.post('/submit', { name: 'Ana', guesses: anaGuesses })).status, 200);
  assert.equal((await c.post('/submit', { name: 'Ana', guesses: anaGuesses })).status, 409); // no double submit
  // while live: no score leaked
  assert.deepEqual((await c.post('/login', { name: 'Ana' })).data, { status: 'live', name: 'Ana', submitted: true });

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
  assert.deepEqual(rCy, { status: 'finished', name: 'Cy', submitted: false, leaderboard: expectedLeaderboard });

  assert.equal((await c.post('/submit', { name: 'Cy', guesses: {} })).status, 409);
  assert.equal((await c.post('/join', { name: 'Late', url: SP('z') })).status, 409);
});

test('submit validation: incomplete, duplicate, self, unknown names', async () => {
  const c = await seededGame();
  await c.admin('POST', '/status', { status: 'live' });
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
  const c = await seededGame();
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
  const c = await seededGame();
  await c.admin('POST', '/status', { status: 'live' });
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
