# Who picked this?

A party quiz. Everyone picks one song (a Spotify or YouTube link). When the host starts the quiz, each player sees all the songs as a numbered tracklist and matches every song to the person who picked it. Scores and right/wrong answers appear only after the host ends the game.

## How it plays

1. **Setup.** Players open the site, enter their name and paste a link to their song. Or the host adds everyone in the host view (Players and songs tab).
2. **Live.** The host presses *Start quiz*. Each player enters their name, taps *Listen* on a track to open it in Spotify or YouTube, and picks who chose it. Their own song is skipped. Each person can be matched to one song only.
3. **Finished.** The host presses *End game and show results*. Each player enters their name again and sees only their own score and which answers were right or wrong. The host's Selections tab shows everyone's answers and scores at any time.

There are no accounts. Names are unique (case-insensitive). The host view is protected by a single host code.

## Deploy on Netlify

1. Push this folder to a GitHub repo (see below).
2. In Netlify: **Add new site → Import an existing project**, pick the repo. Build settings are read from `netlify.toml`, nothing to fill in.
3. Under **Site configuration → Environment variables**, add `ADMIN_CODE` with the host code you want. Redeploy.
4. Open the site. The host view lives at `/#admin`.

Game data is stored in Netlify Blobs, which needs no setup on Netlify.

## Run locally

```bash
npm install
npm test                                   # backend tests
ADMIN_CODE=secret node test/dev-server.mjs # quick local server, in-memory data, http://localhost:8888
# or, with real Netlify Blobs:
ADMIN_CODE=secret npx netlify dev
```

## Push to GitHub

```bash
git init && git add . && git commit -m "Who picked this?"
gh repo create who-picked-this --public --source=. --push
```

## Layout

- `public/index.html` – the whole front end (player and host views).
- `netlify/functions/api.mjs` – the Netlify function, served at `/api/*`.
- `netlify/functions/lib/game.mjs` – game rules and API handlers.
- `test/` – backend tests and the local dev server.

## Good to know

- Songs appear as numbered tracks with a Listen button. Titles aren't shown because the app only stores links.
- Answers are validated on the server, and the list of who picked what is never sent to players until the game is finished.
- Anyone who knows a player's name can answer as them. That is the trade-off of having no passwords. The host can reset a submission while the quiz is live.
