// Shared across spotify-search.mjs and spotify-playlist.mjs so callers can
// use a single `instanceof` check regardless of which module threw it.
export class SpotifyNotConfiguredError extends Error {}
