// Song-title search against Spotify's catalog, used to let people pick a
// song instead of hunting down and pasting its link. Requires a Spotify app's
// client credentials (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET), since even
// this read-only catalog search needs an OAuth app access token.

import { fetchWithTimeout } from './http.mjs';

export class SpotifyNotConfiguredError extends Error {}

let cachedToken = null; // { token, expiresAt }

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;

  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) throw new SpotifyNotConfiguredError('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET is not configured');

  const basic = Buffer.from(`${id}:${secret}`).toString('base64');
  const res = await fetchWithTimeout('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`spotify token request failed: ${res.status}`);
  const data = await res.json();
  // Refresh a minute early so a token never expires mid-flight.
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return cachedToken.token;
}

// Spotify's album images are largest-first; the smallest is plenty for a
// list-row thumbnail.
const pickThumbnail = (images) => (images?.length ? images[images.length - 1]?.url ?? images[0].url : null);

export async function searchSpotifyTracks(query) {
  const token = await getAccessToken();
  const url = `https://api.spotify.com/v1/search?type=track&limit=8&q=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`spotify search failed: ${res.status}`);
  const data = await res.json();
  const items = data?.tracks?.items ?? [];
  return items.map((t) => ({
    url: t.external_urls?.spotify ?? `https://open.spotify.com/track/${t.id}`,
    title: t.name,
    artist: (t.artists ?? []).map((a) => a.name).join(', ') || null,
    image: pickThumbnail(t.album?.images),
  }));
}
