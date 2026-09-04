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

For development, run with auto-reload so template and code edits show up on
refresh (without it Flask caches templates until you restart):

```powershell
$env:ARCADE_DEBUG = "1"; python app.py
```

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARCADE_ADMIN_PASSWORD` | `admin` | Dashboard login. **Required in prod.** |
| `ARCADE_SECRET_KEY` | generated into `data/secret_key` | Session signing key. **Required in prod** - without it every restart logs everyone out. |
| `PORT` | `5000` | Listen port |
| `ARCADE_DEBUG` | unset | Auto-reload + Flask debugger. Never in prod. |
| `ARCADE_PROD` | unset | Serve with waitress on 0.0.0.0, https-only cookies, trust one proxy hop. |
| `ARCADE_BEHIND_PROXY` | follows `ARCADE_PROD` | Trust `X-Forwarded-*` from one hop (Caddy/nginx). |

In prod mode the app **refuses to start** if the admin password is still the
default or the secret key is unset, rather than quietly serving an open dashboard.

### Deployment

```bash
pip install -r requirements.txt
ARCADE_PROD=1 ARCADE_ADMIN_PASSWORD=... ARCADE_SECRET_KEY=... PORT=8080 python app.py
```

Put TLS in front of it (Caddy is the least work). The player password is only as
private as the connection carrying it.

Everything mutable lives in `data/` - the SQLite database, the session key and
uploaded sprites - and that directory is gitignored. Back it up; it is the only
copy of your instances and scores.

## Flow

1. Sign in to the dashboard.
2. Pick a game type → the editor opens with a live preview iframe.
3. Change colors, palette, lives, ball speed, paddle width, power-ups. Color edits swap
   live; gameplay edits restart the preview.
4. Give it a background and sprites (below), decide whether players are asked for a name.
5. Set a player password (optional) and hit **Save & deploy**.
6. The instance is live at `/g/<slug>`. Visitors hit a password gate first; unlocking
   stores a per-slug flag in their session.

## Game types

Three, all sharing one engine contract and one editor:

| Type | | |
| --- | --- | --- |
| **Arkanoid** | 2D | brick breaker, 16:9 board |
| **Arkanoid 3D** | 3D | the same physics on a tilted board with bevelled bricks |
| **Helix Jump** | 3D | spin a tower, drop a ball through the gaps to the logo pad |

### Helix Jump

The ball falls; the player spins the tower (drag, arrow keys or a finger) to line
a gap up beneath it. Landing on a platform bounces; finding the gap drops a level
and scores. Chain `helixSmash` clean drops and the ball becomes a wrecking ball
that smashes platforms instead of bouncing - red hazard wedges stay fatal either
way, and cost a life. Reaching the pad at the bottom wins, and that pad carries
the **goalPad** sprite, so the event logo is the thing you land on.

Its own **Tower** panel sets depth, wedges per ring, gap width, hazard share,
spin sensitivity, drops-to-smash and **bounce height**, plus the hazard and pad
colours. Bounce height scales the hop off a platform but is clamped to 80% of the
level spacing however far it is turned up, so the ball can never climb the tower -
which is exactly what an uncapped bounce did the first time this shipped.

The editor renders **only the controls a type declares**. `slots_for()` does the
same for sprite slots. Helix Jump therefore shows no paddle, ball speed, power-ups
or superblock cube, and offers only the ball, goal pad and board background as
images. Every optional control is read through a `has()` guard: a missing input
would otherwise throw and leave the rest of the form unread. Hazard
wedges carry spikes, so "deadly" reads at a glance rather than depending on
colour alone.

A wedge is an **extruded annular sector**, not a `CylinderGeometry` slice: three's
cylinder leaves the two cut faces open, so slices looked hollow from any angle
that saw their side. Note the extrusion runs 0..depth and the shape is drawn in
XY then laid flat, so the geometry needs centring on its own plane and a quarter
turn of angle offset - both easy to get wrong, and both worth re-measuring against
the collision test after any change. `mode: dig`
puts it on the clock exactly like the brick games.

## Board shape

The field is **1280x720** in board coordinates - 16:9, because that is what an
event screen is - laid out as 16 columns by 10 rows. The canvas scales to fill
whichever axis runs out first (`min(98vw, 88vh * 16/9)`), so it fills a 1080p
screen to within a few percent and still fits a laptop.

`paddleWidth` is stored against the original 640-wide field and scaled on the way
in, so an instance tuned before the change keeps the same share of the board.

## Rendering cost

The board renders at **1280x720 in 2D** and is capped at **1920x1080 in 3D**; the
canvas is stretched to the screen by CSS, so pixels beyond that buy nothing
visible and cost frames.

Two things to know if you touch the 3D renderer:

- `setPixelRatio()` resizes the canvas itself, so the intended buffer size must be
  captured *before* calling it. Passing `canvas.width` into `setSize()` afterwards
  applies the ratio twice - that shipped once, rendering 2880x1620 (4.67 MP) on a
  1.5x display instead of 1920x1080, at roughly half the frame rate.
- The shadow map is rendered **on demand** (`shadowMap.autoUpdate = false`), not
  every frame, since the casters only change when a brick breaks. The ball, paddle
  and power-ups therefore do not cast shadows: a moving caster would leave its
  shadow behind in a static map.

Measured on a 1.5x display, same harness, 300 frames: **7.92 ms/frame before,
3.75 ms/frame after**.

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

## Dig mode

`mode: dig` replaces "clear the board" with a race: a **cube** sits walled in at
the top middle behind a three-hit cap, and breaking it before the clock runs out
wins the round (+2000). The cube is square in board space - two bricks wide and
just as tall - so it renders as an actual cube in 3D and as a shaded box in 2D.
Upload an image to the **brickSuper** sprite slot and it appears on its faces:
this is where a company logo goes. Remaining hits show as dots spaced around the
cube's **border**, going dark one by one - the face is left clear for the logo.

Time limit (15 s - 10 min) and the cube's hit count (1-20) are per instance, as
are the cube's **colour** (or "follow accent"), the **logo size** on its faces,
and the **size and colour** of the hit dots. **Damage darkening** (Colors panel)
sets how far any brick dims as it is worn down; 0 keeps every brick at full colour.

A **Text** panel holds the two text colours: **body text** (titles, help line,
player name) and **accented text** (scores, clock, prompts). Accented text used to
be tied to Accent / glow, but that is a lighting colour - a glow that looks right
is not necessarily readable as text - so the two are now independent. Both accept
"follow" so existing instances are unchanged.
Power-ups default to off; a checkbox brings them back. Classic mode is unchanged
and still the default.

When the cube breaks the engine holds the board for ~1.7 s so the explosion is
actually seen, then the score sheet slides in. A loss shows its sheet immediately.

## Effects

**Debris burst** (Gameplay panel) sprays shards in the brick's colour when it breaks -
flat squares with gravity in 2D, tumbling cubes in 3D. Off is a single checkbox.

## Logo overlay

A transparent PNG laid over the background for company logos at events. Its own
panel in the editor: upload, size (% of the smaller viewport edge, so it holds up
on any screen), opacity, position (centred, an edge, or any corner), tile, and
whether it sits **behind** the play area or **over** it as a watermark.

The layer is `pointer-events: none`, so it never intercepts a click meant for the
paddle, and it always sits under the name prompt and leaderboard.

Note that behind the board, a *centred* logo is invisible unless the board is
partly transparent — put it in a corner, turn the board opacity down, or switch
it to watermark mode.

## Sprites

Any of these can carry a custom image, and any slot left empty keeps the drawn shape:
paddle, ball, brick (1/2/3 hits), unbreakable brick, the dig-mode cube, the four
power-ups, and a full board background image.

Replacing a slot keeps the filename, so the upload response hands back a
`?v=<stamp>` URL and that versioned URL is what gets stored. Without it the
editor preview, both engines and the browser all keep serving the previous image,
since each of them caches by URL.

PNG / JPG / GIF / WebP, 2 MB max. Files live in `data/uploads/<instance-id>/` and are
served with `Content-Security-Policy: sandbox` and `nosniff`. SVG is rejected on purpose —
it can carry `<script>` that would run if a player opened the file's URL directly.
Animated GIFs do not animate once drawn to canvas; use the background for motion.

## Players and scores

When "ask each player for a name" is on, the game opens with a name prompt, plays under
that name, and on death offers **Next player** / **Scores** — so a queue of people can
hand the keyboard around without reloading. There is deliberately no "play again":
at an event the queue moves on.

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
   Declare any libraries it needs in `libs` and they are loaded before it.
   A game type only has to declare the config keys it uses: `clean_config()`
   clamps whatever is present and ignores the rest, so Helix Jump carries no
   paddle settings and the brick games carry no tower settings.
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
