// CSV export of the admin picks table (for spreadsheets; the real backup is JSON). One row per player.
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
