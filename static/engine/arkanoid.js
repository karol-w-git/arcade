/* Arkanoid engine.
   Usage: const game = Arcade.arkanoid(canvasEl, config, { onHud, onGameOver })
          game.setConfig(newConfig)   // live theme swap, keeps play going
          game.restart()              // full reset (needed for lives / speed changes)
          game.pause() / .resume()    // the page shell pauses us for overlays
          game.setBlocked(true)       // ignore all input (name prompt, leaderboard)
   Config is plain JSON so the server can store it per instance.
   config.sprites maps slots (paddle, ball, brick1..3, brickSolid, powerupWide,
   powerupMulti, powerupSlow, powerupLife, boardBg) to image URLs; any slot left
   empty falls back to the vector drawing. */
(function (root) {

const DEFAULTS = {
  bg: '#05070f',
  accent: '#4cc9f0',
  paddleColor: '#e8ecf8',
  ballColor: '#e8ecf8',
  brickColors: ['#f72585', '#b5179e', '#7209b7', '#4361ee', '#4cc9f0', '#3ddc97', '#ffd166', '#ff8c42'],
  grid: true,
  lives: 3,
  ballSpeed: 7.2,
  paddleWidth: 110,
  powerups: false,  // off by default now; per-instance switch brings them back
  particles: true,  // debris burst when a brick breaks
  mode: 'classic',  // 'classic' clears the board; 'dig' races a clock to the superblock
  timeLimit: 90,    // seconds (dig)
  superHp: 3,       // hits to break the superblock (dig)
  level: 0,         // starting level index
  boardAlpha: 1,    // 0 lets the page background show through the board
  sprites: {}
};

const COLS = 10, ROWS = 8, BW = 56, BH = 22, GAP = 4;
const SUPER = BW * 2 + GAP;   // the superblock is square: a cube, not a slab

const LEVELS = [
  ['..........','.11111111.','.11111111.','.22222222.','..........','..........','..........','..........'],
  ['1........1','.1......1.','..122221..','..123321..','..122221..','.1......1.','1........1','..........'],
  ['2222222222','2........2','2.X3333X.2','2.3....3.2','2.X3333X.2','2........2','2222222222','..........'],
  ['.3.3.3.3..','3.3.3.3.3.','.2.2.2.2..','2.2.2.2.2.','.X.1.1.X..','1.1.1.1.1.','.1.1.1.1..','..........']
];

/* Dig mode. 'S' marks the top-left cell of a 2x2 superblock; 'X' is unbreakable.
   The superblock sits top-middle, flanked by walls, with a hard cap underneath -
   the only way in is straight up through the middle. */
const DIG_LEVELS = [
  ['2222SS2222',
   '111XSSX111',
   '111XSSX111',
   '111XSSX111',
   '111XSSX111',
   '1113333111',
   '.11111111.',
   '..111111..'],
  ['1111SS1111',
   '11XXSSXX11',
   '11XXSSXX11',
   '11XXSSXX11',
   '111XSSX111',
   '11X3333X11',
   '1111111111',
   '..222222..']
];

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

/* Mix a #rrggbb toward black by `amount` (0..1). Used for brick damage so the
   cue survives a transparent board, where alpha would show the page through. */
function darken(hex, amount){
  if(!amount) return hex;
  const n = parseInt((hex || '#888888').slice(1), 16);
  const f = 1 - amount;
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

function arkanoid(cv, userConfig, opts){
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const OX = (W - (COLS * BW + (COLS - 1) * GAP)) / 2, OY = 70;

  if(typeof opts === 'function') opts = { onHud: opts };   // older call style
  opts = opts || {};
  const onHud = opts.onHud, onGameOver = opts.onGameOver;

  let cfg = Object.assign({}, DEFAULTS, userConfig || {});
  let bricks, balls, powerups, paddle, score, lives, level, state, shake, raf;
  let shards = [];
  let timeLeft = null, lastTick = null, wonAt = 0;
  let dead = false, blocked = false, reported = false;

  const hud = () => onHud && onHud({ score, lives, level: level + 1, state,
                                     timeLeft: timeLeft, mode: cfg.mode });

  // ---- sprites: decoded once per URL, redrawn as soon as they land ----
  let sprites = {};
  function loadSprites(){
    const want = cfg.sprites || {};
    const next = {};
    for(const slot of Object.keys(want)){
      const url = want[slot];
      if(!url) continue;
      if(sprites[slot] && sprites[slot].key === url){ next[slot] = sprites[slot]; continue; }
      const img = new Image();
      img.key = url;               // img.src normalises to an absolute URL, so key it ourselves
      img.src = url;
      img.ready = false;
      img.onload = () => { img.ready = true; };
      img.onerror = () => { img.ready = false; };   // fall back to vectors
      next[slot] = img;
    }
    sprites = next;
  }
  const sprite = slot => {
    const s = sprites[slot];
    return s && s.ready ? s : null;
  };
  function drawSprite(img, x, y, w, h){
    ctx.drawImage(img, x, y, w, h);
  }

  const digMode = () => cfg.mode === 'dig';

  function makeBricks(idx){
    const set = digMode() ? DIG_LEVELS : LEVELS;
    const layout = set[idx % set.length];
    const pal = cfg.brickColors.length ? cfg.brickColors : DEFAULTS.brickColors;
    const out = [];

    // every 'S' cell is a pocket for the cube; the cube itself is one square
    // brick anchored at the top-left of that pocket
    let sr = -1, scol = -1;
    for(let r = 0; r < ROWS; r++) for(let c = 0; c < COLS; c++){
      if(((layout[r] || '')[c] || '.') === 'S' && sr < 0){ sr = r; scol = c; }
    }
    if(sr >= 0){
      const hp = clamp(+cfg.superHp || 3, 1, 20);
      out.push({ x: OX + scol * (BW + GAP), y: OY + sr * (BH + GAP),
                 w: SUPER, h: SUPER, hp: hp, maxHp: hp,
                 pi: 0, solid: false, sup: true });
    }

    for(let r = 0; r < ROWS; r++) for(let c = 0; c < COLS; c++){
      const ch = (layout[r] || '')[c] || '.';
      if(ch === '.' || ch === 'S') continue;
      const x = OX + c * (BW + GAP), y = OY + r * (BH + GAP);
      out.push({
        x: x, y: y, w: BW, h: BH,
        hp: ch === 'X' ? Infinity : +ch,
        pi: (r + (+ch || 0)) % pal.length,     // palette index, resolved at draw time
        solid: ch === 'X'
      });
    }
    return out;
  }

  const baseW = () => clamp(+cfg.paddleWidth || 110, 50, 260);

  function resetPaddle(){
    const w = baseW();
    paddle = { x: W / 2 - w / 2, y: H - 46, w: w, h: 14, speed: 9, wide: 0 };
  }

  const newBall = stuck => ({ x: paddle.x + paddle.w / 2, y: paddle.y - 8, r: 7, vx: 0, vy: 0, stuck: !!stuck });

  function startLevel(i){
    level = i;
    bricks = makeBricks(i);
    resetPaddle();
    balls = [newBall(true)];
    powerups = [];
    state = 'ready';
    hud();
  }

  function newGame(){
    shards = [];
    timeLeft = cfg.mode === 'dig' ? clamp(+cfg.timeLimit || 90, 15, 600) : null;
    lastTick = null;
    score = 0;
    lives = clamp(+cfg.lives || 3, 1, 9);
    shake = 0;
    reported = false;
    startLevel(+cfg.level || 0);
  }

  // ---- input ----
  // NB: P is deliberately NOT handled here - the page shell owns it for the
  // leaderboard overlay. Pause lives on Escape.
  const keys = {};
  function onKeyDown(e){
    if(blocked) return;
    keys[e.code] = true;
    if(e.code === 'Space'){ e.preventDefault(); launch(); }
    if(e.code === 'Escape'){
      if(state === 'play') state = 'paused';
      else if(state === 'paused') state = 'play';
      hud();
    }
    if(state === 'over' && e.code === 'Enter') newGame();
  }
  const onKeyUp = e => { keys[e.code] = false; };

  function pointerX(e){
    const r = cv.getBoundingClientRect();
    const px = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    return px * (W / r.width);
  }
  const onMove = e => { if(!blocked) movePaddleTo(pointerX(e)); };
  const onTouchMove = e => { e.preventDefault(); if(!blocked) movePaddleTo(pointerX(e)); };
  const onDown = () => { if(blocked) return; state === 'over' ? newGame() : launch(); };
  const onTouchStart = e => { e.preventDefault(); onDown(); };

  addEventListener('keydown', onKeyDown);
  addEventListener('keyup', onKeyUp);
  cv.addEventListener('mousemove', onMove);
  cv.addEventListener('touchmove', onTouchMove, { passive: false });
  cv.addEventListener('mousedown', onDown);
  cv.addEventListener('touchstart', onTouchStart, { passive: false });

  function movePaddleTo(x){
    if(state === 'over') return;
    paddle.x = clamp(x - paddle.w / 2, 0, W - paddle.w);
  }

  function launch(){
    if(state === 'ready') state = 'play';
    for(const b of balls) if(b.stuck){
      b.stuck = false;
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 0.6;
      const sp = clamp(+cfg.ballSpeed || 7.2, 3, 14);
      b.vx = Math.cos(a) * sp; b.vy = Math.sin(a) * sp;
    }
    hud();
  }

  // ---- powerups ----
  const PTYPES = [
    { k: 'wide',  c: '#3ddc97', t: 'W' },
    { k: 'multi', c: '#4cc9f0', t: 'M' },
    { k: 'slow',  c: '#ffd166', t: 'S' },
    { k: 'life',  c: '#f72585', t: '+' }
  ];
  function maybeDrop(x, y){
    if(!cfg.powerups || Math.random() > 0.14) return;
    const p = PTYPES[Math.random() * PTYPES.length | 0];
    powerups.push({ x: x, y: y, w: 22, h: 22, vy: 2.4, k: p.k, c: p.c, t: p.t });
  }
  function applyPower(k){
    if(k === 'wide'){ paddle.wide = 900; paddle.w = baseW() * 1.55; }
    else if(k === 'multi'){
      for(const b of balls.slice(0, 3)) for(const s of [-0.45, 0.45]){
        const sp = Math.hypot(b.vx, b.vy) || 7.2;
        const a = Math.atan2(b.vy, b.vx) + s;
        balls.push({ x: b.x, y: b.y, r: b.r, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, stuck: false });
      }
    }
    else if(k === 'slow'){ for(const b of balls){ b.vx *= 0.75; b.vy *= 0.75; } }
    else if(k === 'life'){ lives++; hud(); }
  }

  // ---- physics ----
  function step(){
    if(state === 'won'){          // the win animation: debris only
      stepShards();
      if(shake > 0) shake--;
      return;
    }
    if(timeLeft !== null && state === 'play'){
      const now = performance.now();
      if(lastTick !== null) timeLeft = Math.max(0, timeLeft - (now - lastTick) / 1000);
      lastTick = now;
      if(timeLeft <= 0){
        state = 'over'; hud();
        if(!reported){ reported = true; onGameOver && onGameOver({ score, level: level + 1, won: false, timedOut: true }); }
        return;
      }
    } else {
      lastTick = null;
    }

    if(keys.ArrowLeft)  paddle.x -= paddle.speed;
    if(keys.ArrowRight) paddle.x += paddle.speed;
    paddle.x = clamp(paddle.x, 0, W - paddle.w);
    if(paddle.wide > 0 && --paddle.wide === 0){
      const cx = paddle.x + paddle.w / 2;
      paddle.w = baseW();
      paddle.x = clamp(cx - paddle.w / 2, 0, W - paddle.w);
    }

    for(const b of balls){
      if(b.stuck){ b.x = paddle.x + paddle.w / 2; b.y = paddle.y - b.r - 1; continue; }

      // substep so a fast ball cannot tunnel through a brick
      const steps = Math.max(1, Math.ceil(Math.hypot(b.vx, b.vy) / 4));
      for(let s = 0; s < steps; s++){
        b.x += b.vx / steps; b.y += b.vy / steps;

        if(b.x - b.r < 0){ b.x = b.r; b.vx = Math.abs(b.vx); }
        if(b.x + b.r > W){ b.x = W - b.r; b.vx = -Math.abs(b.vx); }
        if(b.y - b.r < 0){ b.y = b.r; b.vy = Math.abs(b.vy); }

        if(b.vy > 0 && b.y + b.r >= paddle.y && b.y - b.r <= paddle.y + paddle.h &&
           b.x >= paddle.x - b.r && b.x <= paddle.x + paddle.w + b.r){
          b.y = paddle.y - b.r;
          const hit = ((b.x - paddle.x) / paddle.w - 0.5) * 2;   // -1 .. 1
          const a = -Math.PI / 2 + clamp(hit, -1, 1) * 1.05;
          const sp = clamp(Math.hypot(b.vx, b.vy) * 1.01, 6, 13);
          b.vx = Math.cos(a) * sp; b.vy = Math.sin(a) * sp;
        }

        hitBricks(b);
      }
    }

    balls = balls.filter(b => b.y - b.r < H + 30);
    if(balls.length === 0){
      lives--; hud(); shake = 14;
      if(lives <= 0){
        state = 'over'; hud();
        if(!reported){ reported = true; onGameOver && onGameOver({ score, level: level + 1 }); }
      }
      else { resetPaddle(); balls = [newBall(true)]; state = 'ready'; }
    }

    for(const p of powerups){
      p.y += p.vy;
      if(p.y + p.h >= paddle.y && p.y <= paddle.y + paddle.h &&
         p.x + p.w >= paddle.x && p.x <= paddle.x + paddle.w){
        applyPower(p.k); p.dead = true; score += 50; hud();
      }
    }
    powerups = powerups.filter(p => !p.dead && p.y < H + 40);

    if(bricks.every(b => b.hp === Infinity)){
      score += 500;
      startLevel(level + 1);
    }
    stepShards();
    if(shake > 0) shake--;
  }

    // colour a brick resolves to right now - shared by the renderer and the debris
  function pal2(k){
    const pal = cfg.brickColors.length ? cfg.brickColors : DEFAULTS.brickColors;
    return k.solid ? '#5b6684' : pal[k.pi % pal.length];
  }

  function burst(k, color, mult){
    if(!cfg.particles) return;
    const n = Math.round(18 * (mult || 1));
    for(let i = 0; i < n; i++){
      const a = (Math.PI * 2 * i) / n + Math.random() * 0.5;
      const sp = 1.2 + Math.random() * 2.6;
      shards.push({
        x: k.x + k.w / 2 + (Math.random() - 0.5) * k.w,
        y: k.y + k.h / 2 + (Math.random() - 0.5) * k.h,
        vx: Math.cos(a) * sp * (mult || 1), vy: Math.sin(a) * sp * (mult || 1) - 1,
        s: (4 + Math.random() * 5) * (mult ? 1.4 : 1), life: 1,
        decay: (0.014 + Math.random() * 0.014) / (mult || 1),
        rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
        c: color
      });
    }
    if(shards.length > 600) shards.splice(0, shards.length - 600);
  }

  function stepShards(){
    for(const p of shards){
      p.x += p.vx; p.y += p.vy;
      p.vy += 0.22;              // gravity
      p.vx *= 0.99;
      p.rot += p.vr;
      p.life -= p.decay;
    }
    shards = shards.filter(p => p.life > 0 && p.y < H + 40);
  }

  function drawShards(){
    for(const p of shards){
      ctx.save();
      ctx.globalAlpha = clamp(p.life, 0, 1);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

function hitBricks(b){
    for(let i = 0; i < bricks.length; i++){
      const k = bricks[i];
      if(b.x + b.r < k.x || b.x - b.r > k.x + k.w || b.y + b.r < k.y || b.y - b.r > k.y + k.h) continue;

      // resolve on the axis of least overlap
      const ox = Math.min(b.x + b.r - k.x, k.x + k.w - (b.x - b.r));
      const oy = Math.min(b.y + b.r - k.y, k.y + k.h - (b.y - b.r));
      if(ox < oy){ b.vx = -b.vx; b.x += b.vx > 0 ? ox : -ox; }
      else       { b.vy = -b.vy; b.y += b.vy > 0 ? oy : -oy; }

      if(k.hp !== Infinity){
        k.hp--;
        if(k.sup && k.hp > 0){
          k.punch = performance.now();          // drives the squash + flash
          burst(k, cfg.accent, 0.6);            // chips fly off the cube
          shake = Math.max(shake, 13);          // and the room notices
        }
        if(k.hp <= 0){
          burst(k, pal2(k));
          bricks.splice(i, 1);
          if(k.sup){
            burst(k, cfg.accent, 4);      // the cube goes out loudly
            burst(k, '#ffffff', 2);
            shake = 26;
            score += 2000;
            state = 'won'; wonAt = performance.now(); hud();
            if(!reported){
              reported = true;
              onGameOver && onGameOver({ score, level: level + 1, won: true,
                                         timeLeft: timeLeft === null ? null : Math.round(timeLeft) });
            }
            return;
          }
          maybeDrop(k.x + k.w / 2 - 11, k.y);
          score += 100;
        } else {
          score += 25;
        }
        hud();
      }
      shake = Math.max(shake, 4);
      return; // at most one brick per substep
    }
  }

  /* The objective, drawn as a cube: a front face carrying the logo, plus a lit
     top and a shaded right side faked in projection. 2D has no camera, so the
     depth is painted rather than rendered. */
  function drawSuper(k){
    const wear = 1 - k.hp / (k.maxHp || 1);
    const t = Date.now() / 600;
    const d = Math.round(k.w * 0.16);            // apparent depth
    const face = darken(cfg.accent, wear * 0.4);
    const img = sprite('brickSuper');

    // 0..1, decaying over ~260ms after a hit
    const punch = k.punch ? clamp(1 - (performance.now() - k.punch) / 260, 0, 1) : 0;

    ctx.save();
    if(punch > 0){
      // squash on impact, about its own centre, so the hitbox is untouched
      const cx = k.x + k.w / 2, cy = k.y + k.h / 2;
      ctx.translate(cx, cy);
      ctx.scale(1 + 0.10 * punch, 1 - 0.07 * punch);
      ctx.rotate((Math.random() - 0.5) * 0.04 * punch);
      ctx.translate(-cx, -cy);
    }
    ctx.shadowColor = cfg.accent;
    ctx.shadowBlur = 18 + Math.sin(t) * 7;       // a slow pulse: this is the target

    // top face
    ctx.fillStyle = darken(cfg.accent, wear * 0.4 + 0.12);
    ctx.beginPath();
    ctx.moveTo(k.x, k.y); ctx.lineTo(k.x + d, k.y - d);
    ctx.lineTo(k.x + k.w + d, k.y - d); ctx.lineTo(k.x + k.w, k.y);
    ctx.closePath(); ctx.fill();
    // right face
    ctx.fillStyle = darken(cfg.accent, wear * 0.4 + 0.34);
    ctx.beginPath();
    ctx.moveTo(k.x + k.w, k.y); ctx.lineTo(k.x + k.w + d, k.y - d);
    ctx.lineTo(k.x + k.w + d, k.y + k.h - d); ctx.lineTo(k.x + k.w, k.y + k.h);
    ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;

    // front face - the logo lives here
    ctx.fillStyle = face;
    roundRect(k.x, k.y, k.w, k.h, 5); ctx.fill();
    if(img){
      const pad = Math.round(k.w * 0.1);
      ctx.save();
      roundRect(k.x + 2, k.y + 2, k.w - 4, k.h - 4, 4); ctx.clip();
      drawSprite(img, k.x + pad, k.y + pad, k.w - pad * 2, k.h - pad * 2);
      ctx.restore();
    }
    ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.lineWidth = 2;
    roundRect(k.x + 1, k.y + 1, k.w - 2, k.h - 2, 5); ctx.stroke();

    if(punch > 0){                               // white flash over the whole face
      ctx.fillStyle = 'rgba(255,255,255,' + (0.55 * punch) + ')';
      roundRect(k.x, k.y, k.w, k.h, 5); ctx.fill();
    }

    // remaining hits, as pips along the bottom edge
    const n = k.maxHp || 1, pr = 4, gapx = 14;
    const startX = k.x + k.w / 2 - ((n - 1) * gapx) / 2, cy = k.y + k.h - 12;
    for(let i = 0; i < n; i++){
      ctx.beginPath();
      ctx.arc(startX + i * gapx, cy, pr, 0, Math.PI * 2);
      ctx.fillStyle = i < k.hp ? 'rgba(255,255,255,.95)' : 'rgba(0,0,0,.45)';
      ctx.fill();
    }
    ctx.restore();
  }

  // ---- render ----
  function roundRect(x, y, w, h, r){
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function draw(){
    ctx.save();
    if(shake > 0) ctx.translate((Math.random() - 0.5) * shake * 0.6, (Math.random() - 0.5) * shake * 0.6);

    // Clear first: at boardAlpha < 1 the fill no longer erases the previous frame,
    // and whatever is behind the canvas shows through.
    ctx.clearRect(-20, -20, W + 40, H + 40);
    const alpha = clamp(cfg.boardAlpha === undefined ? 1 : +cfg.boardAlpha, 0, 1);
    if(alpha > 0){
      ctx.globalAlpha = alpha;
      ctx.fillStyle = cfg.bg;
      ctx.fillRect(-20, -20, W + 40, H + 40);
      const boardBg = sprite('boardBg');
      if(boardBg) drawSprite(boardBg, 0, 0, W, H);
      ctx.globalAlpha = 1;
    }

    if(cfg.grid){
      ctx.strokeStyle = 'rgba(255,255,255,.045)'; ctx.lineWidth = 1;
      for(let x = 0; x < W; x += 40){ ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      for(let y = 0; y < H; y += 40){ ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    }

    const pal = cfg.brickColors.length ? cfg.brickColors : DEFAULTS.brickColors;
    for(const k of bricks){
      if(k.sup){ drawSuper(k); continue; }
      const img = sprite(k.solid ? 'brickSolid' : 'brick' + clamp(k.hp, 1, 3));
      if(img){ drawSprite(img, k.x, k.y, k.w, k.h); continue; }
      // Damage is shown by darkening, never by alpha - a see-through board would
      // otherwise leak the page background through every partly-damaged brick.
      const base = k.solid ? '#5b6684' : pal[k.pi % pal.length];
      ctx.fillStyle = k.solid ? base : darken(base, k.hp >= 3 ? 0 : k.hp === 2 ? 0.14 : 0.32);
      roundRect(k.x, k.y, k.w, k.h, 4); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.18)';
      roundRect(k.x + 2, k.y + 2, k.w - 4, 5, 2); ctx.fill();
    }

    drawShards();

    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for(const p of powerups){
      const img = sprite('powerup' + p.k.charAt(0).toUpperCase() + p.k.slice(1));
      if(img){ drawSprite(img, p.x, p.y, p.w, p.h); continue; }
      ctx.fillStyle = p.c; roundRect(p.x, p.y, p.w, p.h, 6); ctx.fill();
      ctx.fillStyle = '#06080f'; ctx.font = 'bold 14px system-ui';
      ctx.fillText(p.t, p.x + p.w / 2, p.y + p.h / 2 + 1);
    }
    ctx.textBaseline = 'alphabetic';

    const paddleImg = sprite('paddle'), ballImg = sprite('ball');
    ctx.shadowColor = cfg.accent; ctx.shadowBlur = paddleImg ? 0 : 14;
    if(paddleImg){
      drawSprite(paddleImg, paddle.x, paddle.y - paddle.h * 0.5, paddle.w, paddle.h * 2);
    } else {
      ctx.fillStyle = cfg.paddleColor;
      roundRect(paddle.x, paddle.y, paddle.w, paddle.h, 7); ctx.fill();
    }
    ctx.shadowBlur = ballImg ? 0 : 14;
    ctx.fillStyle = cfg.ballColor;
    for(const b of balls){
      if(ballImg) drawSprite(ballImg, b.x - b.r, b.y - b.r, b.r * 2, b.r * 2);
      else { ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.shadowBlur = 0;

    ctx.textAlign = 'center';
    if(state === 'ready'){
      ctx.fillStyle = cfg.accent; ctx.font = '16px system-ui';
      ctx.fillText('Kliknij lub naciśnij spację', W / 2, H / 2 + 60);
    }
    if(state === 'paused'){
      ctx.fillStyle = cfg.accent; ctx.font = 'bold 34px system-ui';
      ctx.fillText('PAUZA', W / 2, H / 2);
    }
    // When a shell is listening it draws its own game-over UI (score submit,
    // next player), so we only dim the board.
    if(state === 'over' && onGameOver){
      ctx.fillStyle = 'rgba(0,0,0,.72)'; ctx.fillRect(0, 0, W, H);
    }
    if(state === 'won' && onGameOver){
      // let the player watch the cube come apart before anything covers it
      const since = performance.now() - wonAt;
      const a = clamp((since - 1100) / 500, 0, 1) * 0.72;
      if(a > 0){ ctx.fillStyle = 'rgba(0,0,0,' + a + ')'; ctx.fillRect(0, 0, W, H); }
    }
    if(state === 'over' && !onGameOver){
      ctx.fillStyle = 'rgba(0,0,0,.72)'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = cfg.accent; ctx.font = 'bold 44px system-ui';
      ctx.fillText('KONIEC GRY', W / 2, H / 2 - 16);
      ctx.fillStyle = cfg.paddleColor; ctx.font = '18px system-ui';
      ctx.fillText('Wynik ' + score, W / 2, H / 2 + 20);
      ctx.globalAlpha = .6; ctx.font = '15px system-ui';
      ctx.fillText('Kliknij lub Enter, aby zagrać ponownie', W / 2, H / 2 + 52);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function loop(){
    if(dead) return;
    if(state === 'play' || state === 'ready' || state === 'won') step();
    draw();
    raf = requestAnimationFrame(loop);
  }

  loadSprites();
  newGame();
  loop();

  return {
    setConfig(next){                    // live theme swap; play continues
      cfg = Object.assign({}, cfg, next || {});
      if(!Array.isArray(cfg.brickColors) || !cfg.brickColors.length) cfg.brickColors = DEFAULTS.brickColors;
      loadSprites();
    },
    pause(){ if(state === 'play') state = 'paused'; hud(); },
    resume(){ if(state === 'paused') state = 'play'; hud(); },
    setBlocked(v){ blocked = !!v; for(const k in keys) keys[k] = false; },
    getState(){ return { score: score, lives: lives, level: level + 1, state: state }; },
    restart(next){                      // apply gameplay params too
      if(next) this.setConfig(next);
      newGame();
    },
    destroy(){
      dead = true;
      cancelAnimationFrame(raf);
      removeEventListener('keydown', onKeyDown);
      removeEventListener('keyup', onKeyUp);
      cv.removeEventListener('mousemove', onMove);
      cv.removeEventListener('touchmove', onTouchMove);
      cv.removeEventListener('mousedown', onDown);
      cv.removeEventListener('touchstart', onTouchStart);
    }
  };
}

root.Arcade = root.Arcade || {};
root.Arcade.arkanoid = arkanoid;
root.Arcade.arkanoidDefaults = DEFAULTS;

})(window);
