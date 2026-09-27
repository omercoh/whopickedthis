// Low-level Spotify Web API calls needed to create a per-game playlist under
// a connected Spotify account. Unlike the app-only client-credentials flow
// used for search, creating playlists requires a real user's authorization
// (OAuth "Authorization Code" flow), since a playlist always belongs to some
// Spotify account. This module only talks to Spotify's HTTP APIs - it knows
// nothing about our own storage; the caller (game.mjs) persists whatever it
// needs (the refresh token, playlist history, etc).

import { fetchWithTimeout } from './http.mjs';
import { SpotifyNotConfiguredError } from './spotify-errors.mjs';

const SCOPES = 'playlist-modify-public playlist-modify-private';

function clientCredentials() {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) throw new SpotifyNotConfiguredError('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET is not configured');
  return { id, secret };
}

const basicAuthHeader = (id, secret) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

export function buildAuthorizeUrl(redirectUri, state) {
  const { id } = clientCredentials();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: id,
    scope: SCOPES,
    redirect_uri: redirectUri,
    state,
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

async function tokenRequest(bodyParams) {
  const { id, secret } = clientCredentials();
  const res = await fetchWithTimeout('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { authorization: basicAuthHeader(id, secret), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(bodyParams).toString(),
  });
  if (!res.ok) throw new Error(`spotify token request failed: ${res.status}`);
  return res.json();
}

export async function exchangeCodeForTokens(code, redirectUri) {
  const data = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };
}

// Spotify may or may not rotate the refresh token; callers should persist
// the returned refreshToken only when it's present and different.
export async function refreshAccessToken(refreshToken) {
  const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  return { accessToken: data.access_token, expiresIn: data.expires_in, refreshToken: data.refresh_token ?? null };
}

async function spotifyApi(accessToken, path, opts = {}) {
  const res = await fetchWithTimeout(`https://api.spotify.com/v1${path}`, {
    ...opts,
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', ...opts.headers },
  });
  if (!res.ok) throw new Error(`spotify api ${path} failed: ${res.status}`);
  if (res.status === 204) return null;
  return res.json();
}

export async function getCurrentUser(accessToken) {
  const data = await spotifyApi(accessToken, '/me');
  return { id: data.id, displayName: data.display_name || data.id };
}

export async function createPlaylist(accessToken, userId, name) {
  const data = await spotifyApi(accessToken, `/users/${encodeURIComponent(userId)}/playlists`, {
    method: 'POST',
    body: JSON.stringify({ name, public: false, description: 'מי בחר את זה - כל השירים של המשחק הזה' }),
  });
  return { id: data.id, url: data.external_urls?.spotify ?? `https://open.spotify.com/playlist/${data.id}` };
}

// Spotify caps this at 100 URIs per request; a game only ever has up to 60
// songs, but chunk defensively rather than assume that never changes.
export async function addTracks(accessToken, playlistId, uris) {
  for (let i = 0; i < uris.length; i += 100) {
    const chunk = uris.slice(i, i + 100);
    await spotifyApi(accessToken, `/playlists/${encodeURIComponent(playlistId)}/tracks`, {
      method: 'POST',
      body: JSON.stringify({ uris: chunk }),
    });
  }
}

export async function renamePlaylist(accessToken, playlistId, name) {
  await spotifyApi(accessToken, `/playlists/${encodeURIComponent(playlistId)}`, {
    method: 'PUT',
    body: JSON.stringify({ name }),
  });
}

// Spotify's API has no true "delete"; unfollowing removes it from the
// account, which is the closest equivalent.
export async function unfollowPlaylist(accessToken, playlistId) {
  await spotifyApi(accessToken, `/playlists/${encodeURIComponent(playlistId)}/followers`, { method: 'DELETE' });
}

// Matches a track ID out of any open.spotify.com track URL, including
// localized paths like /intl-en/track/<id>.
export function extractTrackId(url) {
  const m = String(url ?? '').match(/\/track\/([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
}
