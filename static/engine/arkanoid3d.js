/* Arkanoid 3D — the 2D game, tilted.

   Gameplay and physics are a straight port of the 2D engine: the ball moves in a
   plane, the paddle slides on X only, the levels and power-ups are the same. What
   changes is presentation - the board sits at a slight angle under a perspective
   camera, and the bricks are extruded with a small bevel so their edges catch the
   light.

   Logical coordinates stay in the 2D engine's 640x720 board space and are converted
   to world units on the way to the meshes, so the two games play identically.
   Requires THREE (vendored, r128).

     Arcade.arkanoid3d(canvas, config, { onHud, onGameOver })
     -> { setConfig, restart, pause, resume, setBlocked, getState, destroy } */
(function (root) {

const DEFAULTS = {
  bg: '#05070f', accent: '#4cc9f0',
  paddleColor: '#e8ecf8', ballColor: '#e8ecf8',
  brickColors: ['#f72585', '#b5179e', '#7209b7', '#4361ee', '#4cc9f0', '#3ddc97', '#ffd166', '#ff8c42'],
  grid: true, lives: 3, ballSpeed: 7.2, paddleWidth: 110,
  powerups: false, particles: true, level: 0, boardAlpha: 1, sprites: {},
  mode: 'classic', timeLimit: 90, superHp: 3,
  tiltX: 0.22, tiltY: 0.17     // radians; how far the board leans
};

// board space, identical to the 2D engine
const W = 640, H = 720;
const COLS = 10, ROWS = 8, BW = 56, BH = 22, GAP = 4;
const OX = (W - (COLS * BW + (COLS - 1) * GAP)) / 2, OY = 70;
const S = 32;                       // board pixels per world unit
const BRICK_D = 0.8, BEVEL = 0.08;
const SUPER = BW * 2 + GAP;   // square footprint: a real cube

const LEVELS = [
  ['..........','.11111111.','.11111111.','.22222222.','..........','..........','..........','..........'],
  ['1........1','.1......1.','..122221..','..123321..','..122221..','.1......1.','1........1','..........'],
  ['2222222222','2........2','2.X3333X.2','2.3....3.2','2.X3333X.2','2........2','2222222222','..........'],
  ['.3.3.3.3..','3.3.3.3.3.','.2.2.2.2..','2.2.2.2.2.','.X.1.1.X..','1.1.1.1.1.','.1.1.1.1..','..........']
];

/* Dig mode, identical to the 2D engine: 'S' is the top-left cell of a 2x2
   superblock, walled in at top middle with a hard cap underneath. */
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

function darken(hex, amount){
  if(!amount) return hex;
  const n = parseInt((hex || '#888888').slice(1), 16), f = 1 - amount;
  return ((Math.round(((n >> 16) & 255) * f) << 16) |
          (Math.round(((n >> 8) & 255) * f) << 8) |
           Math.round((n & 255) * f));
}

/* A box with rounded corners and a bevelled rim, built from core THREE only
   (RoundedBoxGeometry lives in examples/, which we deliberately don't vendor). */
function beveledBox(w, h, d, radius){
  const r = Math.min(radius, w / 2 - 0.01, h / 2 - 0.01);
  const x = -w / 2, y = -h / 2;
  const sh = new THREE.Shape();
  sh.moveTo(x + r, y);
  sh.lineTo(x + w - r, y);
  sh.quadraticCurveTo(x + w, y, x + w, y + r);
  sh.lineTo(x + w, y + h - r);
  sh.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  sh.lineTo(x + r, y + h);
  sh.quadraticCurveTo(x, y + h, x, y + h - r);
  sh.lineTo(x, y + r);
  sh.quadraticCurveTo(x, y, x + r, y);
  const geo = new THREE.ExtrudeGeometry(sh, {
    depth: Math.max(0.01, d - BEVEL * 2), bevelEnabled: true,
    bevelThickness: BEVEL, bevelSize: BEVEL, bevelOffset: 0, bevelSegments: 2, curveSegments: 3
  });
  geo.center();
  return geo;
}

function arkanoid3d(canvas, userConfig, opts){
  if(typeof THREE === 'undefined') throw new Error('arkanoid3d needs THREE');
  if(typeof opts === 'function') opts = { onHud: opts };
  opts = opts || {};
  const onHud = opts.onHud, onGameOver = opts.onGameOver;

  let cfg = Object.assign({}, DEFAULTS, userConfig || {});
  let bricks = [], balls = [], powerups = [], shards = [], paddle;
  let score, lives, level, state, shake = 0, raf;
  let timeLeft = null, lastTick = null, wonAt = 0;
  let dead = false, blocked = false, reported = false;

  const hud = () => onHud && onHud({ score, lives, level: level + 1, state,
                                     timeLeft: timeLeft, mode: cfg.mode });

  // board pixels -> world units
  const wx = x => (x - W / 2) / S;
  const wy = y => (H / 2 - y) / S;

  // ---------------- scene ----------------
  const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(canvas.width, canvas.height, false);
  renderer.setClearColor(0x000000, 0);      // the board backing carries boardAlpha
  renderer.shadowMap.enabled = true;        // shadows are what actually sell the depth
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, canvas.width / canvas.height, 0.1, 200);
  camera.position.set(0, 0, 42);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.46));
  const key = new THREE.DirectionalLight(0xffffff, 1.15);
  key.position.set(-10, 14, 9);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  const sc = key.shadow.camera;             // orthographic: cover the whole board
  sc.left = -14; sc.right = 14; sc.top = 16; sc.bottom = -16; sc.near = 1; sc.far = 60;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.5);
  rim.position.set(11, -7, 5);
  scene.add(rim);
  const ballLight = new THREE.PointLight(0xffffff, 0.9, 9);
  scene.add(ballLight);

  // everything sits in a group, so one rotation tilts the whole board
  const board = new THREE.Group();
  scene.add(board);

  const texLoader = new THREE.TextureLoader();
  const texCache = {};
  function tex(slot){
    const url = (cfg.sprites || {})[slot];
    if(!url) return null;
    if(texCache[slot] && texCache[slot].key === url) return texCache[slot].t;
    const t = texLoader.load(url);
    texCache[slot] = { key: url, t: t };
    return t;
  }

  // board backing - this is what the opacity slider fades
  const backMat = new THREE.MeshStandardMaterial({ transparent: true, roughness: 1, metalness: 0 });
  const back = new THREE.Mesh(new THREE.PlaneGeometry(W / S, H / S), backMat);
  back.receiveShadow = true;
  back.position.z = -0.45;
  board.add(back);

  const gridMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.16 });
  let gridLines = null;
  (function buildGrid(){
    const pts = [];
    for(let x = 0; x <= W; x += 40){ pts.push(wx(x), wy(0), -0.43, wx(x), wy(H), -0.43); }
    for(let y = 0; y <= H; y += 40){ pts.push(wx(0), wy(y), -0.43, wx(W), wy(y), -0.43); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    gridLines = new THREE.LineSegments(g, gridMat);
    board.add(gridLines);
  })();

  const brickGeo = beveledBox(BW / S, BH / S, BRICK_D, 0.06);
  const superGeo = new THREE.BoxGeometry(SUPER / S, SUPER / S, SUPER / S);
  const shardGeo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
  const ballGeo = new THREE.SphereGeometry(7 / S, 20, 16);
  const puGeo = beveledBox(22 / S, 22 / S, 0.3, 0.06);
  let paddleGeo = null;

  const paddleMat = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.05 });
  const paddleMesh = new THREE.Mesh(new THREE.BufferGeometry(), paddleMat);
  paddleMesh.castShadow = true;
  board.add(paddleMesh);

  function rebuildPaddleGeo(){
    if(paddleGeo) paddleGeo.dispose();
    paddleGeo = beveledBox(paddle.w / S, paddle.h / S, 0.36, 0.07);
    paddleMesh.geometry = paddleGeo;
  }

  function applyTheme(){
    const accent = new THREE.Color(cfg.accent);
    backMat.color = new THREE.Color(cfg.bg);
    backMat.opacity = clamp(cfg.boardAlpha === undefined ? 1 : +cfg.boardAlpha, 0, 1);
    backMat.map = tex('boardBg') || null;
    if(backMat.map) backMat.color = new THREE.Color(0xffffff);
    backMat.visible = backMat.opacity > 0 || !!backMat.map;
    backMat.needsUpdate = true;

    if(gridLines) gridLines.visible = !!cfg.grid;

    ballLight.color = accent;
    paddleMat.color = new THREE.Color(cfg.paddleColor);
    paddleMat.emissive = accent.clone().multiplyScalar(0.3);
    paddleMat.map = tex('paddle') || null;
    if(paddleMat.map) paddleMat.color = new THREE.Color(0xffffff);
    paddleMat.needsUpdate = true;

    for(const b of balls) styleBall(b);
    for(const k of bricks) styleBrick(k);
  }

  function styleBall(b){
    const m = b.mesh.material;
    m.color = new THREE.Color(cfg.ballColor);
    m.emissive = new THREE.Color(cfg.ballColor).multiplyScalar(0.45);
    m.map = tex('ball') || null;
    if(m.map) m.color = new THREE.Color(0xffffff);
    m.needsUpdate = true;
  }

  function styleBrick(k){
    if(k.sup){
      const m = k.mesh.material;
      const acc = new THREE.Color(cfg.accent);
      const wear = 1 - (k.hp / (k.maxHp || 1));
      m.color = acc.clone().multiplyScalar(1 - wear * 0.45);
      m.emissive = acc.clone().multiplyScalar(0.35);
      m.map = tex('brickSuper') || null;
      if(m.map) m.color = new THREE.Color(0xffffff);
      m.needsUpdate = true;
      return;
    }
    const pal = cfg.brickColors.length ? cfg.brickColors : DEFAULTS.brickColors;
    const base = k.solid ? '#5b6684' : pal[k.pi % pal.length];
    const t = tex(k.solid ? 'brickSolid' : 'brick' + clamp(k.hp, 1, 3));
    const m = k.mesh.material;
    // damage darkens, never fades - a see-through board would show through otherwise
    m.color = t ? new THREE.Color(0xffffff)
      : new THREE.Color(k.solid ? base : darken(base, k.hp >= 3 ? 0 : k.hp === 2 ? 0.14 : 0.32));
    m.map = t || null;
    m.emissive = new THREE.Color(base).multiplyScalar(k.solid ? 0.05 : 0.12);
    m.needsUpdate = true;
  }

  // ---------------- world ----------------
  function dropMeshes(list){
    for(const it of list){ board.remove(it.mesh); it.mesh.material.dispose(); }
    list.length = 0;
  }

  const digMode = () => cfg.mode === 'dig';

  function makeBricks(idx){
    dropMeshes(bricks);
    const set = digMode() ? DIG_LEVELS : LEVELS;
    const layout = set[idx % set.length];
    // the 'S' cells are a pocket; the cube is one square brick at its top-left
    let sr = -1, scol = -1;
    for(let r = 0; r < ROWS; r++) for(let c = 0; c < COLS; c++){
      if(((layout[r] || '')[c] || '.') === 'S' && sr < 0){ sr = r; scol = c; }
    }
    if(sr >= 0){
      const hp = clamp(+cfg.superHp || 3, 1, 20);
      const x = OX + scol * (BW + GAP), y = OY + sr * (BH + GAP);
      const mesh = new THREE.Mesh(superGeo, new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.1 }));
      mesh.castShadow = true;
      mesh.position.set(wx(x + SUPER / 2), wy(y + SUPER / 2), SUPER / S / 2 - BRICK_D / 2);
      board.add(mesh);
      const k = { x: x, y: y, w: SUPER, h: SUPER, hp: hp, maxHp: hp,
                  solid: false, sup: true, pi: 0, mesh: mesh };
      bricks.push(k);
      styleBrick(k);
    }

    for(let r = 0; r < ROWS; r++) for(let c = 0; c < COLS; c++){
      const ch = (layout[r] || '')[c] || '.';
      if(ch === '.' || ch === 'S') continue;
      const x = OX + c * (BW + GAP), y = OY + r * (BH + GAP);


      const mesh = new THREE.Mesh(brickGeo, new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.05 }));
      mesh.castShadow = true;
      mesh.position.set(wx(x + BW / 2), wy(y + BH / 2), 0);
      board.add(mesh);
      const k = { x: x, y: y, w: BW, h: BH, hp: ch === 'X' ? Infinity : +ch,
                  solid: ch === 'X', pi: (r + (+ch || 0)) % 8, mesh: mesh };
      bricks.push(k);
      styleBrick(k);
    }
  }

  const baseW = () => clamp(+cfg.paddleWidth || 110, 50, 260);

  function resetPaddle(){
    const w = baseW();
    paddle = { x: W / 2 - w / 2, y: H - 46, w: w, h: 14, speed: 9, wide: 0 };
    rebuildPaddleGeo();
  }

  function newBall(stuck){
    const mesh = new THREE.Mesh(ballGeo, new THREE.MeshStandardMaterial({ roughness: 0.25, metalness: 0.1 }));
    mesh.castShadow = true;
    board.add(mesh);
    const b = { x: paddle.x + paddle.w / 2, y: paddle.y - 8, r: 7, vx: 0, vy: 0, stuck: !!stuck, mesh: mesh };
    styleBall(b);
    return b;
  }

  function startLevel(i){
    level = i;
    makeBricks(i);
    resetPaddle();
    dropMeshes(balls); dropMeshes(powerups);
    balls.push(newBall(true));
    state = 'ready';
    hud();
  }

  function newGame(){
    for(const p of shards){ board.remove(p.mesh); }
    shards = [];
    timeLeft = cfg.mode === 'dig' ? clamp(+cfg.timeLimit || 90, 15, 600) : null;
    lastTick = null;
    score = 0;
    lives = clamp(+cfg.lives || 3, 1, 9);
    shake = 0; reported = false;
    startLevel(+cfg.level || 0);
  }

  // ---------------- input (X only, exactly like 2D) ----------------
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
    const r = canvas.getBoundingClientRect();
    const px = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    return px * (W / r.width);
  }
  function movePaddleTo(x){
    if(blocked || state === 'over') return;
    paddle.x = clamp(x - paddle.w / 2, 0, W - paddle.w);
  }
  const onMove = e => movePaddleTo(pointerX(e));
  const onTouchMove = e => { e.preventDefault(); movePaddleTo(pointerX(e)); };
  const onDown = () => { if(blocked) return; state === 'over' ? newGame() : launch(); };
  const onTouchStart = e => { e.preventDefault(); onDown(); };

  addEventListener('keydown', onKeyDown);
  addEventListener('keyup', onKeyUp);
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('touchstart', onTouchStart, { passive: false });

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

  // ---------------- power-ups ----------------
  const PTYPES = [
    { k: 'wide',  c: 0x3ddc97, slot: 'powerupWide' },
    { k: 'multi', c: 0x4cc9f0, slot: 'powerupMulti' },
    { k: 'slow',  c: 0xffd166, slot: 'powerupSlow' },
    { k: 'life',  c: 0xf72585, slot: 'powerupLife' }
  ];
  function maybeDrop(x, y){
    if(!cfg.powerups || Math.random() > 0.14) return;
    const p = PTYPES[Math.random() * PTYPES.length | 0];
    const t = tex(p.slot);
    const mesh = new THREE.Mesh(puGeo, new THREE.MeshStandardMaterial({
      color: t ? 0xffffff : p.c, emissive: new THREE.Color(p.c).multiplyScalar(0.35), map: t || null }));
    mesh.castShadow = true;
    board.add(mesh);
    powerups.push({ x: x, y: y, w: 22, h: 22, vy: 2.4, k: p.k, mesh: mesh, spin: 0 });
  }
  function applyPower(k){
    if(k === 'wide'){ paddle.wide = 900; paddle.w = 170; rebuildPaddleGeo(); }
    else if(k === 'multi'){
      for(const b of balls.slice(0, 3)) for(const s of [-0.45, 0.45]){
        const sp = Math.hypot(b.vx, b.vy) || 7.2;
        const a = Math.atan2(b.vy, b.vx) + s;
        const nb = newBall(false);
        nb.x = b.x; nb.y = b.y; nb.vx = Math.cos(a) * sp; nb.vy = Math.sin(a) * sp;
        balls.push(nb);
      }
    }
    else if(k === 'slow'){ for(const b of balls){ b.vx *= 0.75; b.vy *= 0.75; } }
    else if(k === 'life'){ lives++; hud(); }
  }

  // ---------------- debris ----------------
  function burst(k, mult){
    if(!cfg.particles) return;
    const pal = cfg.brickColors.length ? cfg.brickColors : DEFAULTS.brickColors;
    const col = new THREE.Color(k.sup ? cfg.accent : (k.solid ? '#5b6684' : pal[k.pi % pal.length]));
    // one material per burst, shared by its shards, disposed when they all die
    const mat = new THREE.MeshStandardMaterial({
      color: col, emissive: col.clone().multiplyScalar(0.25),
      roughness: 0.5, metalness: 0.05, transparent: true });
    const n = Math.round(12 * (mult || 1));
    for(let i = 0; i < n; i++){
      const mesh = new THREE.Mesh(shardGeo, mat);
      const sx = k.x + k.w / 2 + (Math.random() - 0.5) * k.w;
      const sy = k.y + k.h / 2 + (Math.random() - 0.5) * k.h;
      mesh.position.set(wx(sx), wy(sy), BRICK_D / 2);
      const sc = 0.5 + Math.random();
      mesh.scale.setScalar(sc);
      board.add(mesh);
      const a = (Math.PI * 2 * i) / n + Math.random() * 0.5;
      const sp = (0.04 + Math.random() * 0.08) * (mult || 1);
      shards.push({
        mesh: mesh, mat: mat,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp + 0.04, vz: 0.02 + Math.random() * 0.06,
        vrx: (Math.random() - 0.5) * 0.3, vry: (Math.random() - 0.5) * 0.3,
        life: 1, decay: (0.018 + Math.random() * 0.016) / (mult || 1), scale: sc * (mult ? 1.5 : 1)
      });
    }
  }

  function stepShards(){
    if(!shards.length) return;
    const dying = [];
    for(const p of shards){
      p.mesh.position.x += p.vx;
      p.mesh.position.y += p.vy;
      p.mesh.position.z += p.vz;
      p.vy -= 0.007;                 // gravity, in world units
      p.vz -= 0.004;
      if(p.mesh.position.z < 0.05){ p.mesh.position.z = 0.05; p.vz = Math.abs(p.vz) * 0.35; }
      p.mesh.rotation.x += p.vrx;
      p.mesh.rotation.y += p.vry;
      p.life -= p.decay;
      p.mesh.scale.setScalar(p.scale * clamp(p.life, 0, 1));
      if(p.life <= 0) dying.push(p);
    }
    if(dying.length){
      for(const p of dying) board.remove(p.mesh);
      shards = shards.filter(p => p.life > 0);
      // drop a burst's material once none of its shards remain
      for(const p of dying){
        if(!shards.some(q => q.mat === p.mat)) p.mat.dispose();
      }
    }
    // fade what is left
    for(const p of shards) p.mat.opacity = clamp(p.life + 0.25, 0, 1);
  }

  // ---------------- physics: a straight port of the 2D engine ----------------
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
        if(!reported){ reported = true; onGameOver && onGameOver({ score: score, level: level + 1, won: false, timedOut: true }); }
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
      rebuildPaddleGeo();
    }

    for(const b of balls){
      if(b.stuck){ b.x = paddle.x + paddle.w / 2; b.y = paddle.y - b.r - 1; continue; }

      const steps = Math.max(1, Math.ceil(Math.hypot(b.vx, b.vy) / 4));
      for(let s = 0; s < steps; s++){
        b.x += b.vx / steps; b.y += b.vy / steps;

        if(b.x - b.r < 0){ b.x = b.r; b.vx = Math.abs(b.vx); }
        if(b.x + b.r > W){ b.x = W - b.r; b.vx = -Math.abs(b.vx); }
        if(b.y - b.r < 0){ b.y = b.r; b.vy = Math.abs(b.vy); }

        if(b.vy > 0 && b.y + b.r >= paddle.y && b.y - b.r <= paddle.y + paddle.h &&
           b.x >= paddle.x - b.r && b.x <= paddle.x + paddle.w + b.r){
          b.y = paddle.y - b.r;
          const hit = ((b.x - paddle.x) / paddle.w - 0.5) * 2;
          const a = -Math.PI / 2 + clamp(hit, -1, 1) * 1.05;
          const sp = clamp(Math.hypot(b.vx, b.vy) * 1.01, 6, 13);
          b.vx = Math.cos(a) * sp; b.vy = Math.sin(a) * sp;
        }

        hitBricks(b);
      }
    }

    const lost = balls.filter(b => b.y - b.r >= H + 30);
    if(lost.length){
      for(const b of lost){ board.remove(b.mesh); b.mesh.material.dispose(); }
      balls = balls.filter(b => b.y - b.r < H + 30);
    }
    if(balls.length === 0){
      lives--; hud(); shake = 14;
      if(lives <= 0){
        state = 'over'; hud();
        if(!reported){ reported = true; onGameOver && onGameOver({ score: score, level: level + 1 }); }
      } else {
        resetPaddle(); balls.push(newBall(true)); state = 'ready';
      }
    }

    for(const p of powerups){
      p.y += p.vy; p.spin += 0.05;
      if(p.y + p.h >= paddle.y && p.y <= paddle.y + paddle.h &&
         p.x + p.w >= paddle.x && p.x <= paddle.x + paddle.w){
        applyPower(p.k); p.dead = true; score += 50; hud();
      }
    }
    const gone = powerups.filter(p => p.dead || p.y >= H + 40);
    for(const p of gone){ board.remove(p.mesh); p.mesh.material.dispose(); }
    powerups = powerups.filter(p => !p.dead && p.y < H + 40);

    if(!digMode() && bricks.every(k => k.hp === Infinity)){
      score += 500;
      startLevel(level + 1);
    }
    stepShards();
    if(shake > 0) shake--;
  }

  function hitBricks(b){
    for(let i = 0; i < bricks.length; i++){
      const k = bricks[i];
      if(b.x + b.r < k.x || b.x - b.r > k.x + k.w || b.y + b.r < k.y || b.y - b.r > k.y + k.h) continue;

      const ox = Math.min(b.x + b.r - k.x, k.x + k.w - (b.x - b.r));
      const oy = Math.min(b.y + b.r - k.y, k.y + k.h - (b.y - b.r));
      if(ox < oy){ b.vx = -b.vx; b.x += b.vx > 0 ? ox : -ox; }
      else       { b.vy = -b.vy; b.y += b.vy > 0 ? oy : -oy; }

      if(k.hp !== Infinity){
        k.hp--;
        if(k.hp <= 0){
          burst(k);
          board.remove(k.mesh); k.mesh.material.dispose();
          bricks.splice(i, 1);
          if(k.sup){
            burst(k, 4);                  // the cube goes out loudly
            shake = 26;
            score += 2000;
            state = 'won'; wonAt = performance.now(); hud();
            if(!reported){
              reported = true;
              onGameOver && onGameOver({ score: score, level: level + 1, won: true,
                                         timeLeft: timeLeft === null ? null : Math.round(timeLeft) });
            }
            return;
          }
          maybeDrop(k.x + k.w / 2 - 11, k.y);
          score += 100;
        } else {
          styleBrick(k);
          score += 25;
        }
        hud();
      }
      shake = Math.max(shake, 4);
      return;
    }
  }

  // ---------------- render ----------------
  function sync(){
    paddleMesh.position.set(wx(paddle.x + paddle.w / 2), wy(paddle.y + paddle.h / 2), 0.22);
    for(const b of balls) b.mesh.position.set(wx(b.x), wy(b.y), 0.42);
    for(const p of powerups){
      p.mesh.position.set(wx(p.x + p.w / 2), wy(p.y + p.h / 2), 0.1);
      p.mesh.rotation.z = p.spin; p.mesh.rotation.y = p.spin * 0.7;
    }
    if(balls.length) ballLight.position.set(wx(balls[0].x), wy(balls[0].y), 1.4);

    for(const k of bricks){
      if(!k.sup) continue;
      const w = Date.now() / 1000;
      k.mesh.rotation.y = Math.sin(w * 0.6) * 0.22;   // small: the hitbox stays square
      k.mesh.rotation.x = Math.sin(w * 0.45) * 0.12;
    }

    // the tilt breathes a little so the depth reads, plus a knock on impact
    const t = Date.now() / 1000;
    const jitter = shake ? shake * 0.002 : 0;
    board.rotation.x = (+cfg.tiltX || 0) + Math.sin(t * 0.45) * 0.012 + (Math.random() - 0.5) * jitter;
    board.rotation.y = (+cfg.tiltY || 0) + Math.sin(t * 0.32) * 0.016 + (Math.random() - 0.5) * jitter;
  }

  function loop(){
    if(dead) return;
    if(state === 'play' || state === 'ready' || state === 'won') step();
    sync();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }

  applyTheme();
  newGame();
  loop();

  return {
    setConfig(next){
      cfg = Object.assign({}, cfg, next || {});
      if(!Array.isArray(cfg.brickColors) || !cfg.brickColors.length) cfg.brickColors = DEFAULTS.brickColors;
      applyTheme();
    },
    restart(next){
      if(next){
        cfg = Object.assign({}, cfg, next);
        if(!Array.isArray(cfg.brickColors) || !cfg.brickColors.length) cfg.brickColors = DEFAULTS.brickColors;
      }
      newGame();
      applyTheme();
    },
    pause(){ if(state === 'play') state = 'paused'; hud(); },
    resume(){ if(state === 'paused') state = 'play'; hud(); },
    setBlocked(v){ blocked = !!v; for(const k in keys) keys[k] = false; },
    getState(){ return { score: score, lives: lives, level: level + 1, state: state }; },
    destroy(){
      dead = true;
      cancelAnimationFrame(raf);
      removeEventListener('keydown', onKeyDown);
      removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('mousedown', onDown);
      canvas.removeEventListener('touchstart', onTouchStart);
      dropMeshes(bricks); dropMeshes(balls); dropMeshes(powerups);
      for(const p of shards){ board.remove(p.mesh); }
      shards = [];
      brickGeo.dispose(); ballGeo.dispose(); puGeo.dispose(); shardGeo.dispose();
      if(paddleGeo) paddleGeo.dispose();
      renderer.dispose();
    }
  };
}

root.Arcade = root.Arcade || {};
root.Arcade.arkanoid3d = arkanoid3d;
root.Arcade.arkanoid3dDefaults = DEFAULTS;

})(window);
