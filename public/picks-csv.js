// CSV backup format for the admin picks table. One row per player.
// Columns: player, track, url, title, artist, image, status, guess_<track>...
// (a guess column holds the name that player matched to that track; blank = not locked in yet)

const BASE = ['player', 'track', 'url', 'title', 'artist', 'image', 'status'];

const cell = (v) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

export function buildCsv({ status, entries, submissions }) {
  const tracks = [...entries].sort((a, b) => a.n - b.n);
  const nk = (s) => String(s).trim().toLowerCase();
  const head = [...BASE, ...tracks.map((t) => 'guess_' + t.n)];
  const rows = entries.map((e) => {
    const sub = submissions.find((s) => nk(s.name) === nk(e.name));
    const guesses = tracks.map((t) => (sub && t !== e ? sub.guesses[t.id] ?? '' : ''));
    return [e.name, e.n, e.url ?? '', e.title ?? '', e.artist ?? '', e.image ?? '', status, ...guesses];
  });
  return [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function parseRows(text) {
  const src = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim()));
}

export function parseCsv(text) {
  const [head, ...rows] = parseRows(text);
  if (!head) throw new Error('הקובץ ריק.');
  const col = (name) => head.findIndex((h) => h.trim().toLowerCase() === name);
  if (col('player') < 0 || col('status') < 0) throw new Error('זה לא קובץ גיבוי של המשחק.');
  const guessCols = head.map((h, i) => [/^guess_(\d+)$/i.exec(h.trim()), i]).filter(([m]) => m).map(([m, i]) => [Number(m[1]), i]);
  const get = (r, name) => (r[col(name)] ?? '').trim();
  const status = get(rows[0] ?? [], 'status');
  const players = rows.map((r) => {
    const guesses = {};
    for (const [n, i] of guessCols) guesses[n] = (r[i] ?? '').trim();
    return {
      name: get(r, 'player'), track: get(r, 'track'), url: get(r, 'url'), title: get(r, 'title'),
      artist: get(r, 'artist'), image: get(r, 'image'), guesses,
    };
  });
  return { status, players };
}
