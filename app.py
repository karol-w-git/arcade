"""Arcade — a tiny backend for building, password-locking and deploying game instances.

Dashboard (owner, single admin password)  ->  /
Deployed instance (players, per-instance password)  ->  /g/<slug>

Run:  python app.py        (see README.md for env vars)
"""
import json
import os
import re
import secrets
import sqlite3
import time
from datetime import timedelta
from pathlib import Path

from flask import (Flask, abort, g, jsonify, redirect, render_template,
                   request, send_from_directory, session, url_for)
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

BASE = Path(__file__).parent
DB_PATH = BASE / "data" / "arcade.db"
UPLOAD_DIR = BASE / "data" / "uploads"

ADMIN_PASSWORD = os.environ.get("ARCADE_ADMIN_PASSWORD", "admin")
SECRET_FILE = BASE / "data" / "secret_key"

def _flag(name):
    return os.environ.get(name, "").lower() in ("1", "true", "yes", "on")

# Set ARCADE_PROD=1 when running anywhere but your own machine.
PROD = _flag("ARCADE_PROD")
# Behind Caddy/nginx: trust one hop of X-Forwarded-* so redirects keep https://
BEHIND_PROXY = _flag("ARCADE_BEHIND_PROXY") or PROD
DEBUG = _flag("ARCADE_DEBUG")

MAX_SPRITE_BYTES = 2 * 1024 * 1024
# Raster only. SVG can carry <script>, which would run if a player opened the
# file's URL directly, so it is not accepted.
SPRITE_TYPES = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                "gif": "image/gif", "webp": "image/webp"}
MAX_BG_HTML = 20000

# Which parts of a game can carry a custom image.
SPRITE_SLOTS = ["paddle", "ball", "brick1", "brick2", "brick3", "brickSolid",
                # the dig-mode cube: one image, drawn on every face
                "brickSuper",
                "powerupWide", "powerupMulti", "powerupSlow", "powerupLife",
                "boardBg",
                # a transparent PNG laid over the background, behind the board -
                # company logos at events. Handled by the page, not the engine.
                "overlay"]

GAME_TYPES = {
    "arkanoid": {
        "name": "Arkanoid",
        "blurb": "Brick breaker with power-ups, 4 levels and steerable bounce.",
        "engine": "engine/arkanoid.js",
        "libs": [],
        "dimensions": "2D",
        "defaults": {
            "bg": "#05070f",
            "pageBg": "#0a0c14",
            "accent": "#4cc9f0",
            "paddleColor": "#e8ecf8",
            "ballColor": "#e8ecf8",
            # page text (HUD, prompts, help). "" follows the paddle colour, which
            # is what it used to borrow - fine on dark themes, unreadable on light
            "textColor": "",
            "brickColors": ["#f72585", "#b5179e", "#7209b7", "#4361ee",
                            "#4cc9f0", "#3ddc97", "#ffd166", "#ff8c42"],
            "grid": True,
            "lives": 3,
            "ballSpeed": 7.2,
            "paddleWidth": 110,
            # classic = clear the board; dig = break through to the superblock
            # before the clock runs out
            "mode": "classic",
            "timeLimit": 90,          # seconds, dig mode only
            "superHp": 3,             # hits to break the superblock
            # "" means follow the accent colour
            "superColor": "",
            "pipSize": 6,             # thickness of the hit segments, board px
            "pipColor": "#ffffff",
            "logoScale": 80,          # % of the cube face the logo covers
            # how far a brick darkens as it is worn down (0 = no darkening)
            "damageDarken": 0.32,
            "powerups": False,        # off by default; switch back on per instance
            "level": 0,
            "bgStyle": "radial",
            # chrome around the play area: border, rounded corners, drop shadow
            "frame": True,
            # debris burst when a brick breaks
            "particles": True,
            # 0 = fully see-through board (background shows through), 1 = opaque
            "boardAlpha": 1.0,
            # animated background: color | preset | custom
            "bgMode": "color",
            "bgPreset": "starfield",
            "bgHtml": "",
            # logo overlay: sits above the background, behind the play area
            "overlayPos": "center",
            "overlaySize": 40,        # % of the smaller viewport dimension
            "overlayOpacity": 0.5,
            "overlayTile": False,
            # draw the logo over the play area (a watermark) instead of behind it
            "overlayFront": False,
            # player names + leaderboard
            "askName": True,
            "scoreboard": True,
            "sprites": {},
        },
    }
}

# The 3D game reads the same config keys, so the editor needs no per-type branching.
GAME_TYPES["arkanoid3d"] = {
    "name": "Arkanoid 3D",
    "blurb": "The same game, on a board tilted into 3D - bevelled bricks, "
             "lighting and depth. Plays identically to the 2D version.",
    "engine": "engine/arkanoid3d.js",
    "libs": ["vendor/three.min.js"],
    "dimensions": "3D",
    "defaults": dict(GAME_TYPES["arkanoid"]["defaults"], grid=True,
                     tiltX=0.22, tiltY=0.17),
}

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_SPRITE_BYTES + 64 * 1024
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=PROD,          # https-only cookies once deployed
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    TEMPLATES_AUTO_RELOAD=DEBUG,         # otherwise Flask caches templates and
)                                        # your edits appear only after a restart

if BEHIND_PROXY:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)


def _secret_key() -> bytes:
    """Stable across restarts so sessions survive a reload."""
    env = os.environ.get("ARCADE_SECRET_KEY")
    if env:
        return env.encode()
    if not SECRET_FILE.exists():
        SECRET_FILE.parent.mkdir(parents=True, exist_ok=True)
        SECRET_FILE.write_text(secrets.token_hex(32))
    return SECRET_FILE.read_text().strip().encode()


app.secret_key = _secret_key()


# ---------------------------------------------------------------- database
def db():
    if "db" not in g:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def _close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS instances (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    slug       TEXT    NOT NULL UNIQUE,
    title      TEXT    NOT NULL,
    game_type  TEXT    NOT NULL,
    config     TEXT    NOT NULL,
    pw_hash    TEXT,
    deployed   INTEGER NOT NULL DEFAULT 0,
    plays      INTEGER NOT NULL DEFAULT 0,
    created_at REAL    NOT NULL,
    updated_at REAL    NOT NULL
);

CREATE TABLE IF NOT EXISTS scores (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    score       INTEGER NOT NULL,
    level       INTEGER NOT NULL DEFAULT 1,
    created_at  REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scores_instance ON scores(instance_id, score DESC);
"""


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()


def stored_config(row) -> dict:
    """Config as saved, backfilled with any keys added since it was written."""
    cfg = dict(GAME_TYPES[row["game_type"]]["defaults"])
    cfg.update(json.loads(row["config"]))
    cfg.setdefault("sprites", {})
    return cfg


def row_to_dict(row, best=None):
    return {
        "id": row["id"],
        "slug": row["slug"],
        "title": row["title"],
        "game_type": row["game_type"],
        "config": stored_config(row),
        "deployed": bool(row["deployed"]),
        "locked": row["pw_hash"] is not None,
        "plays": row["plays"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "url": url_for("play", slug=row["slug"], _external=False),
        "best": best,
    }


def best_score(iid):
    r = db().execute(
        "SELECT name, score FROM scores WHERE instance_id=? ORDER BY score DESC LIMIT 1",
        (iid,)).fetchone()
    return {"name": r["name"], "score": r["score"]} if r else None


# ---------------------------------------------------------------- helpers
SLUG_RE = re.compile(r"[^a-z0-9-]+")


def slugify(text: str) -> str:
    s = SLUG_RE.sub("-", (text or "").strip().lower()).strip("-")
    return s or "game"


def unique_slug(base: str, ignore_id=None) -> str:
    base = slugify(base)
    slug, n = base, 2
    while True:
        row = db().execute("SELECT id FROM instances WHERE slug = ?", (slug,)).fetchone()
        if row is None or row["id"] == ignore_id:
            return slug
        slug = f"{base}-{n}"
        n += 1


SPRITE_URL_RE = re.compile(r"^/uploads/\d+/[A-Za-z0-9._-]{1,60}(\?v=\d{1,12})?$")


def clean_sprites(raw) -> dict:
    """Sprite values are URLs this app itself minted. Anything else is dropped."""
    out = {}
    if not isinstance(raw, dict):
        return out
    for slot, url in raw.items():
        if slot not in SPRITE_SLOTS or not isinstance(url, str):
            continue
        if SPRITE_URL_RE.match(url):
            out[slot] = url
            continue
        # A malformed stamp (e.g. two ?v= from an older client) should cost the
        # cache-buster, not the image itself.
        base = url.split("?", 1)[0]
        if SPRITE_URL_RE.match(base):
            out[slot] = base
    return out


def clean_config(game_type: str, raw: dict) -> dict:
    """Whitelist config keys against the game's defaults, coercing types.

    Never trust the client here: this JSON is inlined into the play page."""
    defaults = GAME_TYPES[game_type]["defaults"]
    out = dict(defaults)
    raw = raw or {}
    hexcol = re.compile(r"^#[0-9a-fA-F]{6}$")

    for key, dv in defaults.items():
        if key not in raw:
            continue
        v = raw[key]
        try:
            if key == "sprites":
                out[key] = clean_sprites(v)
            elif key == "bgHtml":
                out[key] = str(v)[:MAX_BG_HTML] if isinstance(v, str) else ""
            elif isinstance(dv, bool):
                out[key] = bool(v)
            elif isinstance(dv, (int, float)) and not isinstance(dv, bool):
                v = float(v)
                out[key] = int(v) if isinstance(dv, int) else round(v, 2)
            elif isinstance(dv, list):
                cols = [c for c in v if isinstance(c, str) and hexcol.match(c)][:12]
                out[key] = cols or dv
            elif isinstance(dv, str):
                if key in ("superColor", "textColor"):
                    v = v if isinstance(v, str) else ""
                    out[key] = v if (v == "" or hexcol.match(v)) else ""
                elif key.endswith("Color") or key in ("bg", "accent", "pageBg"):
                    out[key] = v if isinstance(v, str) and hexcol.match(v) else dv
                else:
                    out[key] = str(v)[:40]
        except (TypeError, ValueError):
            out[key] = dv

    out["lives"] = max(1, min(9, int(out["lives"])))
    out["ballSpeed"] = max(3.0, min(14.0, float(out["ballSpeed"])))
    out["paddleWidth"] = max(50, min(260, int(out["paddleWidth"])))
    out["level"] = max(0, min(3, int(out["level"])))
    out["timeLimit"] = max(15, min(600, int(out["timeLimit"])))
    out["superHp"] = max(1, min(20, int(out["superHp"])))
    out["pipSize"] = max(1, min(14, int(out["pipSize"])))
    out["logoScale"] = max(30, min(100, int(out["logoScale"])))
    out["damageDarken"] = max(0.0, min(0.8, float(out["damageDarken"])))
    if out.get("mode") not in ("classic", "dig"):
        out["mode"] = "classic"
    out["boardAlpha"] = max(0.0, min(1.0, float(out["boardAlpha"])))
    for k in ("tiltX", "tiltY"):        # 3D only; radians, kept to a gentle lean
        if k in out:
            out[k] = max(-0.6, min(0.6, float(out[k])))
    if out.get("bgStyle") not in ("radial", "flat"):
        out["bgStyle"] = "radial"
    if out.get("bgMode") not in ("color", "preset", "custom"):
        out["bgMode"] = "color"
    if out.get("bgPreset") not in ("starfield", "aurora", "scanlines", "drift"):
        out["bgPreset"] = "starfield"
    if out.get("overlayPos") not in ("center", "top", "bottom", "top-left",
                                     "top-right", "bottom-left", "bottom-right"):
        out["overlayPos"] = "center"
    out["overlaySize"] = max(5, min(100, int(out["overlaySize"])))
    out["overlayOpacity"] = max(0.0, min(1.0, float(out["overlayOpacity"])))
    return out


def logged_in() -> bool:
    return session.get("admin") is True


def require_admin():
    if not logged_in():
        abort(401)


def get_instance(iid):
    row = db().execute("SELECT * FROM instances WHERE id = ?", (iid,)).fetchone()
    if row is None:
        abort(404)
    return row


# ---------------------------------------------------------------- dashboard
@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        if secrets.compare_digest(request.form.get("password", ""), ADMIN_PASSWORD):
            session["admin"] = True
            session.permanent = True
            return redirect(request.args.get("next") or url_for("dashboard"))
        error = "Wrong password."
        time.sleep(0.4)  # blunt the brute force
    return render_template("login.html", error=error,
                           default_hint=(ADMIN_PASSWORD == "admin"))


@app.route("/logout", methods=["POST"])
def logout():
    session.pop("admin", None)
    return redirect(url_for("login"))


@app.route("/")
def dashboard():
    if not logged_in():
        return redirect(url_for("login"))
    rows = db().execute("SELECT * FROM instances ORDER BY updated_at DESC").fetchall()
    return render_template("dashboard.html",
                           instances=[row_to_dict(r, best_score(r["id"])) for r in rows],
                           game_types=GAME_TYPES)


@app.route("/new/<game_type>")
def new_instance(game_type):
    if not logged_in():
        return redirect(url_for("login"))
    if game_type not in GAME_TYPES:
        abort(404)
    return render_template("editor.html", instance=None, game_type=game_type,
                           meta=GAME_TYPES[game_type],
                           config=GAME_TYPES[game_type]["defaults"],
                           sprite_slots=SPRITE_SLOTS, scores=[])


@app.route("/edit/<int:iid>")
def edit_instance(iid):
    if not logged_in():
        return redirect(url_for("login"))
    row = get_instance(iid)
    inst = row_to_dict(row)
    rows = db().execute(
        "SELECT name, score, level, created_at FROM scores WHERE instance_id=?"
        " ORDER BY score DESC LIMIT 25", (iid,)).fetchall()
    return render_template("editor.html", instance=inst,
                           game_type=inst["game_type"],
                           meta=GAME_TYPES[inst["game_type"]],
                           config=inst["config"],
                           sprite_slots=SPRITE_SLOTS,
                           scores=[dict(r) for r in rows])


# ---------------------------------------------------------------- API
@app.post("/api/instances")
def api_create():
    require_admin()
    data = request.get_json(silent=True) or {}
    game_type = data.get("game_type")
    if game_type not in GAME_TYPES:
        return jsonify(error="Unknown game type"), 400

    title = (data.get("title") or "Untitled game").strip()[:80]
    slug = unique_slug(data.get("slug") or title)
    config = clean_config(game_type, data.get("config"))
    password = data.get("password") or ""
    pw_hash = generate_password_hash(password) if password else None
    now = time.time()

    cur = db().execute(
        "INSERT INTO instances (slug,title,game_type,config,pw_hash,deployed,created_at,updated_at)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (slug, title, game_type, json.dumps(config), pw_hash,
         1 if data.get("deployed") else 0, now, now))
    db().commit()
    row = get_instance(cur.lastrowid)
    return jsonify(row_to_dict(row)), 201


@app.put("/api/instances/<int:iid>")
def api_update(iid):
    require_admin()
    row = get_instance(iid)
    data = request.get_json(silent=True) or {}

    title = (data.get("title") or row["title"]).strip()[:80]
    slug = unique_slug(data.get("slug") or title, ignore_id=iid)
    config = clean_config(row["game_type"], data.get("config"))

    pw_hash = row["pw_hash"]
    if data.get("clear_password"):
        pw_hash = None
    elif data.get("password"):
        pw_hash = generate_password_hash(data["password"])

    deployed = row["deployed"] if data.get("deployed") is None else (1 if data["deployed"] else 0)

    db().execute(
        "UPDATE instances SET title=?, slug=?, config=?, pw_hash=?, deployed=?, updated_at=?"
        " WHERE id=?",
        (title, slug, json.dumps(config), pw_hash, deployed, time.time(), iid))
    db().commit()
    return jsonify(row_to_dict(get_instance(iid)))


@app.post("/api/instances/<int:iid>/deploy")
def api_deploy(iid):
    require_admin()
    get_instance(iid)
    on = bool((request.get_json(silent=True) or {}).get("deployed", True))
    db().execute("UPDATE instances SET deployed=?, updated_at=? WHERE id=?",
                 (1 if on else 0, time.time(), iid))
    db().commit()
    return jsonify(row_to_dict(get_instance(iid)))


@app.delete("/api/instances/<int:iid>")
def api_delete(iid):
    require_admin()
    get_instance(iid)
    db().execute("DELETE FROM scores WHERE instance_id=?", (iid,))
    db().execute("DELETE FROM instances WHERE id=?", (iid,))
    db().commit()
    folder = UPLOAD_DIR / str(iid)
    if folder.is_dir():
        for f in folder.iterdir():
            f.unlink()
        folder.rmdir()
    return jsonify(ok=True)


# ---------------------------------------------------------------- sprites
@app.post("/api/instances/<int:iid>/sprite")
def api_sprite_upload(iid):
    """One image per slot. Re-uploading a slot replaces the previous file."""
    require_admin()
    get_instance(iid)
    slot = request.form.get("slot", "")
    if slot not in SPRITE_SLOTS:
        return jsonify(error="Unknown sprite slot"), 400

    file = request.files.get("file")
    if file is None or not file.filename:
        return jsonify(error="No file"), 400

    ext = secure_filename(file.filename).rsplit(".", 1)[-1].lower()
    if ext not in SPRITE_TYPES:
        return jsonify(error=f"Use one of: {', '.join(sorted(SPRITE_TYPES))}"), 400

    blob = file.read(MAX_SPRITE_BYTES + 1)
    if len(blob) > MAX_SPRITE_BYTES:
        return jsonify(error="Image is over 2 MB"), 413

    folder = UPLOAD_DIR / str(iid)
    folder.mkdir(parents=True, exist_ok=True)
    for old in folder.glob(f"{slot}.*"):     # drop the previous format
        old.unlink()
    (folder / f"{slot}.{ext}").write_bytes(blob)

    # Cache-bust so every layer that keys images by URL picks the new file up.
    stamp = int(time.time())
    return jsonify(slot=slot, url=f"/uploads/{iid}/{slot}.{ext}?v={stamp}",
                   cache_key=stamp)


@app.delete("/api/instances/<int:iid>/sprite/<slot>")
def api_sprite_delete(iid, slot):
    require_admin()
    get_instance(iid)
    if slot not in SPRITE_SLOTS:
        abort(404)
    folder = UPLOAD_DIR / str(iid)
    if folder.is_dir():
        for f in folder.glob(f"{slot}.*"):
            f.unlink()
    return jsonify(ok=True)


@app.route("/uploads/<int:iid>/<path:filename>")
def uploaded_file(iid, filename):
    folder = UPLOAD_DIR / str(iid)
    if not folder.is_dir():
        abort(404)
    resp = send_from_directory(folder, filename)
    resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    resp.headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp


# ---------------------------------------------------------------- scores
def public_scores(iid, limit=25):
    rows = db().execute(
        "SELECT name, score, level, created_at FROM scores WHERE instance_id=?"
        " ORDER BY score DESC, created_at ASC LIMIT ?", (iid, limit)).fetchall()
    return [dict(r) for r in rows]


@app.get("/g/<slug>/scores")
def scores_list(slug):
    row = db().execute("SELECT * FROM instances WHERE slug=?", (slug,)).fetchone()
    if row is None or not row["deployed"]:
        abort(404)
    if row["pw_hash"] and not session.get(f"unlocked:{slug}"):
        abort(403)
    return jsonify(scores=public_scores(row["id"]))


@app.post("/g/<slug>/scores")
def scores_submit(slug):
    """Accept one score per issued play token.

    Scores come from the player's browser, so a determined player can forge one.
    The token stops casual replay/duplicate posting; it is not tamper-proof."""
    row = db().execute("SELECT * FROM instances WHERE slug=?", (slug,)).fetchone()
    if row is None or not row["deployed"]:
        abort(404)
    if row["pw_hash"] and not session.get(f"unlocked:{slug}"):
        abort(403)

    data = request.get_json(silent=True) or {}
    token = data.get("token")
    if not token or token != session.get(f"token:{slug}"):
        return jsonify(error="Stale game token — reload the page."), 409
    session.pop(f"token:{slug}", None)

    name = (data.get("name") or "Anonymous").strip()[:24] or "Anonymous"
    try:
        score = max(0, min(10_000_000, int(data.get("score", 0))))
        level = max(1, min(999, int(data.get("level", 1))))
    except (TypeError, ValueError):
        return jsonify(error="Bad score"), 400

    db().execute(
        "INSERT INTO scores (instance_id,name,score,level,created_at) VALUES (?,?,?,?,?)",
        (row["id"], name, score, level, time.time()))
    db().commit()

    # Hand out the next token so the following player can post without a reload.
    nxt = secrets.token_urlsafe(16)
    session[f"token:{slug}"] = nxt
    return jsonify(ok=True, token=nxt, scores=public_scores(row["id"]))


@app.delete("/api/instances/<int:iid>/scores")
def api_scores_clear(iid):
    require_admin()
    get_instance(iid)
    db().execute("DELETE FROM scores WHERE instance_id=?", (iid,))
    db().commit()
    return jsonify(ok=True)


# ---------------------------------------------------------------- preview
@app.route("/preview/<game_type>")
def preview(game_type):
    """Bare game frame for the editor. Config arrives over postMessage."""
    if not logged_in():
        abort(401)
    if game_type not in GAME_TYPES:
        abort(404)
    return render_template("play.html", meta=GAME_TYPES[game_type],
                           title="Preview", config=GAME_TYPES[game_type]["defaults"],
                           preview=True, slug=None, token=None, scores=[])


# ---------------------------------------------------------------- deployed
@app.route("/g/<slug>")
def play(slug):
    row = db().execute("SELECT * FROM instances WHERE slug=?", (slug,)).fetchone()
    if row is None or not row["deployed"]:
        # Owners get a hint; the public sees a plain 404.
        if row is not None and logged_in():
            return render_template("notfound.html", undeployed=True, iid=row["id"]), 404
        return render_template("notfound.html", undeployed=False), 404

    if row["pw_hash"] and not session.get(f"unlocked:{slug}"):
        return redirect(url_for("unlock", slug=slug))

    db().execute("UPDATE instances SET plays = plays + 1 WHERE id=?", (row["id"],))
    db().commit()

    token = secrets.token_urlsafe(16)
    session[f"token:{slug}"] = token
    meta = GAME_TYPES[row["game_type"]]
    return render_template("play.html", meta=meta, title=row["title"],
                           config=stored_config(row), preview=False,
                           slug=slug, token=token,
                           scores=public_scores(row["id"]))


@app.route("/g/<slug>/unlock", methods=["GET", "POST"])
def unlock(slug):
    row = db().execute("SELECT * FROM instances WHERE slug=?", (slug,)).fetchone()
    if row is None or not row["deployed"]:
        return render_template("notfound.html", undeployed=False), 404
    if not row["pw_hash"]:
        return redirect(url_for("play", slug=slug))

    error = None
    if request.method == "POST":
        if check_password_hash(row["pw_hash"], request.form.get("password", "")):
            session[f"unlocked:{slug}"] = True
            return redirect(url_for("play", slug=slug))
        error = "Nieprawid\u0142owe has\u0142o."      # players see Polish; the dashboard stays English
        time.sleep(0.4)
    return render_template("unlock.html", title=row["title"], slug=slug, error=error)


@app.errorhandler(413)
def _too_big(_e):
    return jsonify(error="Image is over 2 MB"), 413


@app.after_request
def _no_store(resp):
    if request.path.startswith(("/api/", "/g/")):
        resp.headers["Cache-Control"] = "no-store"
    return resp


def _preflight():
    init_db()
    if PROD:
        problems = []
        if ADMIN_PASSWORD == "admin":
            problems.append("ARCADE_ADMIN_PASSWORD is still the default")
        if not os.environ.get("ARCADE_SECRET_KEY"):
            problems.append("ARCADE_SECRET_KEY is unset (sessions reset on restart)")
        if problems:
            raise SystemExit("Refusing to start in prod mode:\n  - " + "\n  - ".join(problems))
    elif ADMIN_PASSWORD == "admin":
        print("!! ARCADE_ADMIN_PASSWORD is unset - dashboard password is 'admin'")


if __name__ == "__main__":
    _preflight()
    port = int(os.environ.get("PORT", 5000))
    if PROD:
        # waitress: a real WSGI server. Flask's own is single-threaded and
        # explicitly not for production.
        from waitress import serve
        print(f"arcade (prod) on 0.0.0.0:{port}")
        serve(app, host="0.0.0.0", port=port, threads=8)
    else:
        app.run(host="127.0.0.1", port=port, debug=DEBUG)
