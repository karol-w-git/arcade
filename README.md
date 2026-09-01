# Arcade

A small backend for turning a game engine into **deployable, password-locked instances**.

```
dashboard  /                 pick a game type, manage instances   (admin password)
editor     /new/<type>       customize colors + gameplay, live preview
           /edit/<id>
deployed   /g/<slug>         the public address of one instance    (player password)
```

## Run

```bash
python app.py
```

Then open http://127.0.0.1:5000. Stack is Flask + SQLite from the stdlib — no `pip install` needed.

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARCADE_ADMIN_PASSWORD` | `admin` | Dashboard login. **Set this before hosting anywhere.** |
| `ARCADE_SECRET_KEY` | generated into `data/secret_key` | Session signing key |
| `PORT` | `5000` | Listen port |
| `ARCADE_DEBUG` | unset | Flask debug reloader |

```powershell
$env:ARCADE_ADMIN_PASSWORD = "something-long"; python app.py
```

## Flow

1. Sign in to the dashboard.
2. Pick a game type → the editor opens with a live preview iframe.
3. Change colors, palette, lives, ball speed, paddle width, power-ups. Color edits swap
   live; gameplay edits restart the preview.
4. Give it a background and sprites (below), decide whether players are asked for a name.
5. Set a player password (optional) and hit **Save & deploy**.
6. The instance is live at `/g/<slug>`. Visitors hit a password gate first; unlocking
   stores a per-slug flag in their session.

## Backgrounds

Three modes, per instance:

- **Plain colors** — the page gradient only.
- **Animated preset** — starfield, aurora, scanlines or drifting grid. Presets tint
  themselves from the instance's accent and palette, so they follow the color scheme.
- **Custom HTML / CSS** — paste anything self-contained (a Claude Design export, an SVG,
  a keyframe animation), up to 20 000 characters.

**Board opacity** (0-100%) fades the play area itself, so an animated background can
show through the game. **Frame** toggles the border, rounded corners and drop shadow
around the play area - turn it off and the board bleeds into the background with nothing
clipping the corners of a tilted 3D board.

Custom markup renders in a **fully sandboxed iframe** (`sandbox=""`) behind the board:
it can animate, but it cannot touch the page, read cookies, or make network calls. It is
also `pointer-events: none`, so it never steals a click from the paddle.

## Effects

**Debris burst** (Gameplay panel) sprays shards in the brick's colour when it breaks -
flat squares with gravity in 2D, tumbling cubes in 3D. Off is a single checkbox.

## Sprites

Any of these can carry a custom image, and any slot left empty keeps the drawn shape:
paddle, ball, brick (1/2/3 hits), unbreakable brick, the four power-ups, and a full board
background image.

PNG / JPG / GIF / WebP, 512 KB max. Files live in `data/uploads/<instance-id>/` and are
served with `Content-Security-Policy: sandbox` and `nosniff`. SVG is rejected on purpose —
it can carry `<script>` that would run if a player opened the file's URL directly.
Animated GIFs do not animate once drawn to canvas; use the background for motion.

## Players and scores

When "ask each player for a name" is on, the game opens with a name prompt, plays under
that name, and on death offers **Play again** / **Next player** / **Scores** — so a queue
of people can hand the keyboard around without reloading.

**`P` opens the high-score list** from anywhere: mid-game, at the name prompt, or on the
game-over screen. It pauses play while open. Pause moved to **`Esc`** to free `P` up.

Scores are stored per instance and listed highest first, with the score just set
highlighted. Clear them from the editor's "Players & scores" panel.

**On trust:** scores are submitted by the player's browser, so a determined player can
forge one. Each page load issues a one-shot token that is rotated on every accepted score,
which stops duplicate and replayed submissions — it is not tamper-proof, and it is not
meant to be. Names are capped at 24 characters and escaped on render; scores are clamped
server-side.

**Draft vs live:** an undeployed instance 404s at its public address (you, signed in, get a
hint instead). Undeploy from the dashboard to take a link offline without deleting it.

## Data

Everything lives in `data/arcade.db` (SQLite: `instances` + `scores`) and
`data/uploads/<instance-id>/` for sprites. Passwords are stored
as `werkzeug` PBKDF2 hashes — never plaintext, and never sent back to the browser. Delete
the file to reset.

## Adding another game type

1. Drop an engine at `static/engine/<name>.js` that registers
   `Arcade.<name>(canvas, config, { onHud, onGameOver })` and returns
   `{ setConfig, restart, pause, resume, setBlocked, getState, destroy }`.
   The page shell owns the name prompt, the `P` leaderboard and score submission, so a new
   engine gets all of that for free by calling `onGameOver({ score, level })` once per death.
2. Add an entry to `GAME_TYPES` in `app.py` with its `defaults` dict.

`clean_config()` whitelists incoming config against those defaults, so a new key is only
accepted once it exists in `defaults` — the config JSON is inlined into the play page, so
nothing unvalidated gets through.

## Notes / limits

- Instances are served on a path (`/g/<slug>`), not a subdomain. Subdomains would need DNS
  plus a wildcard cert; the routing hook is a single `before_request` if you want it later.
- The dev server is single-owner and single-process. For real hosting put it behind
  `waitress` or `gunicorn` and terminate TLS in front — the player password is only as
  private as the connection carrying it.
