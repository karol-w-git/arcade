# Cleanup audit — 4 Sep 2026

Two things happened while you were out: your Helix requests are done and pushed
locally, and I went looking for cleanup. What follows separates **what I already
did** (measured, verified, committed) from **what I did not do**, because the
rest are your calls, not mine.

Nothing here is deployed to the live server yet.

---

## Done

### 1. The editor showed every game every other game's controls

`0722e28`

The editor was one form for all three games. Helix Jump therefore offered a
**paddle width**, a **ball speed**, **power-up drops**, a **starting level**, a
**superblock cube** with its hit count, logo size and pip colour, **grid lines**,
and a **paddle colour** — for a game with no paddle, no bricks and no cube. It
also offered every sprite slot, so you could upload a brick texture to a tower.

Controls and sprite slots are now gated on what the type declares. Helix shows
**48 controls, Arkanoid 61** — the 13 that vanished were all inapplicable. Sprite
slots for Helix are down to ball, goal pad and board background.

The mechanism is worth knowing, because it is what makes adding a fourth game
cheap: a type declares its keys in `GAME_TYPES[...]["defaults"]`, and the editor
renders a control only `{% if 'thatKey' in config %}`. `slots_for()` does the same
for images. Every optional control is read through a `has()` guard — without it a
missing input throws and the rest of the form silently stops being read, which is
exactly the bug I hit mid-way through and fixed.

### 2. Bounce height, which you asked for

`0722e28`

**Tower → Bounce height**, 0.3x to 2.0x. Default 1.0x is what you have been
playing, so nothing changes until you move it.

Measured apex of a hop, against the 2.6-unit gap between levels:

| Setting | Apex |
| --- | --- |
| 0.3x | 0.07 units |
| 1.0x | 0.99 units |
| 2.0x | 1.93 units |

You said the frequency felt too high, so **start at 0.5x and work up**. Low
settings make the ball settle onto a platform instead of dribbling on it.

It is clamped to 80% of the level spacing however far you drag it. That is not
politeness — an uncapped bounce is precisely what made the first version of this
game unplayable, with the ball climbing the tower instead of descending it.

### 3. The level layouts were two copies

`2c7ef92`

`LEVELS` and `DIG_LEVELS` were **64 byte-identical lines in both brick engines**,
with nothing keeping them in step. Edit a layout for the 2D game and the 3D one
keeps the old one, and you find out at an event. They now live in
`static/engine/levels.js`, loaded as a lib before either engine.

### 4. Three config keys nothing read

`2c7ef92`

`boardAlpha` and `damageDarken` on Helix, plus the `darken()` helper that went
with them. **Board opacity had a working slider that did nothing** — the tower has
no board backing to fade — so it is gated now and no longer appears for Helix.

Net across both commits: **−46 lines**, and the engines are 4297 lines total.

---

## Found and deliberately left alone

### The "Keep a high-score list" checkbox does nothing

`config.scoreboard` is written by the editor, stored in the database, and **read
by nothing**. Scores are always kept and `P` always opens the list, whatever the
box says. Two honest fixes — make it work, or remove it — and which one depends
on whether you ever want an instance that plays without a leaderboard. I did not
guess.

### The dashboard login has no rate limit

A wrong admin password costs an attacker 0.4 seconds and nothing else: no
lockout, no per-IP counter. Your password is strong enough that this is not
urgent, but the delay is a `time.sleep` **inside the request handler**, so it also
blocks a server thread — a burst of wrong guesses is a cheap way to make the
dashboard unresponsive. The fix is a per-IP attempt counter with backoff and no
sleeping in the worker. It touches auth, so I would rather you were awake.

### I tried to optimise the Helix render loop and it did not pay

Worth recording, since it is the kind of thing that looks obviously right.

`sync()` walks every ring every frame to set mesh visibility — up to 1280 meshes,
almost always writing the value already there. Rings are evenly spaced and
ordered, so this can be an index window that touches only what enters or leaves.
I wrote it, along with cached colour parsing to stop `Color.set(string)` running
three's CSS parser twice a frame.

Then I measured it, three fresh page loads each way, on an 80-level 16-slot tower
with the ball actually descending:

| | median frame work | p90 |
| --- | --- | --- |
| before | 1.6 ms | 2.4 ms |
| after | 1.8 ms | 2.5 ms |

**No improvement, and the difference is inside the noise.** The frame is dominated
by the render itself, not by that loop, so the change bought added state and a new
invalidation rule for nothing. I reverted it and kept only the dead-code deletion.

A note on method: frame *deltas* cannot show this. They sit pinned at 8.3 ms on
your 120 Hz display whether the game has headroom or none. The numbers above come
from wrapping `requestAnimationFrame` and timing each callback from entry to
return — that is the figure that tells you how much room is left.

### The same shape, still duplicated

`makeBricks`, `hitBricks`, `applyPower` and `step` exist in both brick engines at
roughly the same size — about 21% of the 2D engine has an identical twin. Unlike
the level tables these are **not** byte-identical: they diverge where 2D draws and
3D moves meshes. Untangling them means a shared rules core with a rendering
adapter — a real refactor of a system that currently works, which is not what I
would start the week before an event. Flagging it as the largest remaining
duplication, not recommending it yet.

### Small, unglamorous, harmless

- The 3D `sync()` scans all ~160 bricks every frame to animate the one superblock,
  and calls `Date.now()` inside that loop. Keeping a reference would fix it, but
  see above: this loop is not where the time goes either, and I am not going to
  claim a win I have not measured.
- `PRAGMA foreign_keys` is off, so `ON DELETE CASCADE` on `scores` is decorative.
  No orphans in practice — the delete route removes scores explicitly first.

---

## Before the next event

Unrelated to cleanup, still true, and still the thing most likely to bite:

**The live server's uploads are empty.** Content does not travel with a deploy —
the database and `data/uploads/` live only on the VM. Logos uploaded on localhost
are on localhost. They have to be uploaded again through the live dashboard.
