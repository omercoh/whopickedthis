// Best-effort artist/title/artwork lookup for a song link, so the app can
// show "Artist - Song" and a thumbnail instead of a bare track number. Any
// failure (network, unexpected markup, private/removed track) just yields
// no metadata — callers fall back to the numbered placeholder.

import { fetchWithTimeout } from './http.mjs';

// A real browser UA: Spotify's track pages render Open Graph tags for link
// unfurls, but can serve a stripped-down page to obvious bot user agents.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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

// Spotify's public oEmbed only ever returns the track name and artwork (no
// artist field), but it's a stable documented JSON API, so it's the most
// reliable source for those two. The track page's Open Graph tags are the
// only place the artist shows up, but scraping HTML is inherently more
// fragile, so that part is allowed to fail without losing what we already have.
async function fetchSpotifyOembed(url) {
  const res = await fetchWithTimeout(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, {
    headers: { 'user-agent': UA },
  });
  if (!res.ok) { console.warn('spotify oembed failed', res.status, url); return null; }
  const data = await res.json();
  return { title: data?.title || null, image: data?.thumbnail_url || null };
}

async function fetchSpotifyPageTags(url) {
  const res = await fetchWithTimeout(url, { headers: { 'user-agent': UA, accept: 'text/html' } });
  if (!res.ok) { console.warn('spotify page fetch failed', res.status, url); return null; }
  return metaTags(await res.text());
}

async function fetchSpotifyMeta(url) {
  const [oembed, tags] = await Promise.all([
    fetchSpotifyOembed(url).catch((err) => { console.warn('spotify oembed error', err?.message || err); return null; }),
    fetchSpotifyPageTags(url).catch((err) => { console.warn('spotify page error', err?.message || err); return null; }),
  ]);
  const title = oembed?.title || tags?.['og:title'] || null;
  if (!title) return null;
  const image = oembed?.image || tags?.['og:image'] || null;
  return { title, artist: spotifyArtistFromDescription(tags?.['og:description']), image };
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
  if (!res.ok) { console.warn('youtube oembed failed', res.status, url); return null; }
  const data = await res.json();
  if (!data?.title) return null;
  return { ...splitYoutubeTitle(data.title, data.author_name), image: data.thumbnail_url || null };
}

export async function fetchSongMeta(url, platform) {
  try {
    if (platform === 'spotify') return await fetchSpotifyMeta(url);
    if (platform === 'youtube') return await fetchYoutubeMeta(url);
  } catch (err) {
    console.warn('song metadata lookup failed', platform, url, err?.message || err);
  }
  return null;
}
