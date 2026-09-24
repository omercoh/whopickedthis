// Best-effort artist/title lookup for a song link, so the app can show
// "Artist - Song" instead of a bare track number. Any failure (network,
// unexpected markup, private/removed track) just yields no metadata —
// callers fall back to the numbered placeholder.

const FETCH_TIMEOUT_MS = 4000;
const UA = 'Mozilla/5.0 (compatible; WhoPickedThisBot/1.0)';

async function fetchWithTimeout(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const decodeEntities = (s) =>
  String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

function metaTags(html) {
  const tags = {};
  const re = /<meta\s+([^>]+)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const prop = attrs.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i);
    const content = attrs.match(/content\s*=\s*["']([^"']*)["']/i);
    if (prop && content) tags[prop[1].toLowerCase()] = decodeEntities(content[1]);
  }
  return tags;
}

// Spotify's og:description for a track reads like "Song · Artist · Year".
function spotifyArtistFromDescription(description) {
  const parts = String(description ?? '')
    .split('·')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts[1] || null;
}

async function fetchSpotifyMeta(url) {
  const res = await fetchWithTimeout(url, { headers: { 'user-agent': UA, accept: 'text/html' } });
  if (!res.ok) return null;
  const html = await res.text();
  const tags = metaTags(html);
  const title = tags['og:title'];
  if (!title) return null;
  return { title, artist: spotifyArtistFromDescription(tags['og:description']) };
}

function splitYoutubeTitle(rawTitle, authorName) {
  const title = String(rawTitle ?? '').trim();
  const dash = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash) return { artist: dash[1].trim(), title: dash[2].trim() };
  const author = String(authorName ?? '')
    .replace(/\s*-\s*topic$/i, '')
    .replace(/vevo$/i, '')
    .trim();
  return { artist: author || null, title };
}

async function fetchYoutubeMeta(url) {
  const api = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  const res = await fetchWithTimeout(api, { headers: { 'user-agent': UA } });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data?.title) return null;
  return splitYoutubeTitle(data.title, data.author_name);
}

export async function fetchSongMeta(url, platform) {
  try {
    if (platform === 'spotify') return await fetchSpotifyMeta(url);
    if (platform === 'youtube') return await fetchYoutubeMeta(url);
  } catch {
    // best-effort only
  }
  return null;
}
