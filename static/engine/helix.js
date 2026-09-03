/* Helix Jump — a ball falls down a rotating tower.

   The player spins the tower (mouse drag, arrow keys, or a finger) to line a gap
   up under the ball. Land on a platform and you bounce; find the gap and you drop
   a level. Chain enough drops and the ball turns into a wrecking ball that smashes
   platforms instead of bouncing off them. Touch a hazard segment and it costs a
   life. Reach the pad at the bottom to win - that pad carries the event logo.

   Same contract as the other engines, so the page shell gives it the name prompt,
   the P leaderboard, scores and the win/lose sheets for free:

     Arcade.helix(canvas, config, { onHud, onGameOver })
     -> { setConfig, restart, pause, resume, setBlocked, getState, destroy }

   Requires THREE (vendored, r128). */
(function (root) {

const DEFAULTS = {
  bg: '#05070f', pageBg: '#0a0c14', accent: '#4cc9f0',
  ballColor: '#e8ecf8', paddleColor: '#e8ecf8',
  brickColors: ['#f72585', '#b5179e', '#7209b7', '#4361ee', '#4cc9f0', '#3ddc97', '#ffd166', '#ff8c42'],
  accentTextColor: '', textColor: '',
  lives: 3, particles: true, boardAlpha: 1, sprites: {},
  mode: 'classic',        // 'dig' adds the clock; the goal is the same
  timeLimit: 90,
  // helix-specific
  helixLevels: 24,        // how deep the tower goes
  helixSlots: 8,          // wedges per ring
  helixGap: 2,            // wedges removed to make the way through
  helixHazard: 0.22,      // share of remaining wedges that are deadly
  helixSpin: 1.0,         // rotation sensitivity
  helixSmash: 3,          // clean drops needed before the ball smashes through
  hazardColor: '#e63946',
  goalColor: '',          // '' follows the accent
  damageDarken: 0.32
};

// tower geometry, in world units
const R_IN = 0.55, R_OUT = 3.4, PLATE_H = 0.42;
const LEVEL_H = 2.6, BALL_R = 0.52;
// A bounce must stay well under one level. apex = BOUNCE^2 / (2 * |GRAVITY|),
// so 0.22 gives ~1.1 units against a 2.6-unit spacing. It used to be 0.58, an
// apex of 7.6 units: the ball climbed the tower instead of descending it.
const GRAVITY = -0.022, BOUNCE = 0.22, MAX_FALL = -0.45;

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const TAU = Math.PI * 2;

function darken(hex, amount){
  if(!amount) return hex;
  const n = parseInt((hex || '#888888').slice(1), 16), f = 1 - amount;
  return ((Math.round(((n >> 16) & 255) * f) << 16) |
          (Math.round(((n >> 8) & 255) * f) << 8) |
           Math.round((n & 255) * f));
}

/* Angles are awkward here: a wedge spans [a, a+w] in tower-local space, and the
   ball always sits at world angle 0. Rotating the tower by `spin` puts the ball
   at local angle -spin, so that is the value every test is against. */
const norm = a => ((a % TAU) + TAU) % TAU;
const inWedge = (angle, start, sweep) => norm(angle - start) < sweep;

function helix(canvas, userConfig, opts){
  if(typeof THREE === 'undefined') throw new Error('helix needs THREE');
  if(typeof opts === 'function') opts = { onHud: opts };
  opts = opts || {};
  const onHud = opts.onHud, onGameOver = opts.onGameOver;

  let cfg = Object.assign({}, DEFAULTS, userConfig || {});
  let rings = [], shards = [];
  let score, lives, depth, state, raf, shake = 0;
  let ball, spin = 0, spinVel = 0, combo = 0, smashing = false;
  let timeLeft = null, lastTick = null, wonAt = 0;
  let dead = false, blocked = false, reported = false;
  let hurtFlash = 0;

  const levels = () => clamp(+cfg.helixLevels || 24, 5, 80);
  const accentCol = () => cfg.accent || '#4cc9f0';
  const goalCol = () => cfg.goalColor || accentCol();
  const dmg = () => clamp(cfg.damageDarken === undefined ? 0.32 : +cfg.damageDarken, 0, 0.8);

  const hud = () => onHud && onHud({
    score: score, lives: lives, level: depth, state: state,
    timeLeft: timeLeft, mode: cfg.mode,
    showLevel: true            // depth is meaningful here even on the clock
  });

  // ---------------- scene ----------------
  const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
  // never render above 1080p: the canvas is stretched to the screen anyway.
  // setPixelRatio() resizes the canvas itself, so capture the size first.
  const BUF_W = canvas.width, BUF_H = canvas.height;
  const maxRatio = Math.min(1920 / BUF_W, 1080 / BUF_H, 2);
  renderer.setPixelRatio(Math.max(1, Math.min(devicePixelRatio || 1, maxRatio)));
  renderer.setSize(BUF_W, BUF_H, false);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(46, BUF_W / BUF_H, 0.1, 120);

  scene.add(new THREE.AmbientLight(0xffffff, 0.62));
  const key = new THREE.DirectionalLight(0xffffff, 0.9);
  key.position.set(6, 12, 10);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.35);
  rim.position.set(-8, -4, 6);
  scene.add(rim);
  const ballLight = new THREE.PointLight(0xffffff, 1.0, 12);
  scene.add(ballLight);

  const tower = new THREE.Group();          // everything that spins
  scene.add(tower);

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

  // the column the platforms hang off
  const coreMat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.05 });
  const core = new THREE.Mesh(new THREE.CylinderGeometry(R_IN, R_IN, 1, 20), coreMat);
  scene.add(core);

  const ballMat = new THREE.MeshStandardMaterial({ roughness: 0.25, metalness: 0.1 });
  const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 22, 16), ballMat);
  scene.add(ballMesh);

  const goalMat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.1 });
  const goal = new THREE.Mesh(new THREE.CylinderGeometry(R_OUT * 0.95, R_OUT * 0.95, 0.5, 36), goalMat);
  scene.add(goal);
  // the logo sits face-up on the pad
  const goalFaceMat = new THREE.MeshBasicMaterial({ transparent: true });
  const goalFace = new THREE.Mesh(new THREE.CircleGeometry(R_OUT * 0.8, 32), goalFaceMat);
  goalFace.rotation.x = -Math.PI / 2;
  goalFace.visible = false;
  scene.add(goalFace);

  const shardGeo = new THREE.BoxGeometry(0.3, 0.16, 0.3);

  /* A wedge as a closed solid. CylinderGeometry with a thetaLength leaves the two
     cut faces open, so a slice looked hollow from any angle that saw its side.
     Extruding an annular sector gives every face: outer arc, inner arc, both cut
     faces, top and bottom.

     The shape is drawn in XY and laid flat, which rotates it a quarter turn: a
     shape angle p ends up at world atan2(x, z) = p + PI/2. Drawing from -PI/2
     therefore puts the wedge at world [0, sweep], which is the range the
     collision test uses once the mesh is turned by `start`. */
  const wedgeGeos = {};
  function wedgeGeo(sweep){
    const k = sweep.toFixed(3);
    if(!wedgeGeos[k]){
      const segs = Math.max(6, Math.round(40 * sweep / TAU));
      const a0 = -Math.PI / 2, a1 = a0 + sweep;
      const sh = new THREE.Shape();
      sh.absarc(0, 0, R_OUT, a0, a1, false);      // outer edge
      sh.absarc(0, 0, R_IN, a1, a0, true);        // and back along the core
      const geo = new THREE.ExtrudeGeometry(sh, {
        depth: PLATE_H, bevelEnabled: false, curveSegments: segs });
      geo.rotateX(-Math.PI / 2);                  // stand it up as a floor
      geo.translate(0, -PLATE_H / 2, 0);          // centre it: the extrusion runs 0..depth,
                                                  // and the physics expects the top face at +PLATE_H/2
      wedgeGeos[k] = geo;
    }
    return wedgeGeos[k];
  }

  // spikes, so a deadly wedge reads as deadly rather than merely red
  const spikeGeo = new THREE.ConeGeometry(0.16, 0.42, 5);
  const spikeMat = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.15 });
  function addSpikes(mesh, sweep){
    // two staggered rows across the wedge, so the danger reads from any angle
    const span = R_OUT - R_IN;
    const rows = [
      { r: R_IN + span * 0.34, n: 3, offset: 0.5 },
      { r: R_IN + span * 0.72, n: 4, offset: 0.0 }
    ];
    for(const row of rows){
      for(let i = 0; i < row.n; i++){
        const a = sweep * ((i + 1 + row.offset) / (row.n + 1 + row.offset * 2));
        const sp = new THREE.Mesh(spikeGeo, spikeMat);
        sp.position.set(Math.sin(a) * row.r, PLATE_H / 2 + 0.21, Math.cos(a) * row.r);
        mesh.add(sp);                             // inherits the parent's visibility
      }
    }
  }

  // ---------------- building the tower ----------------
  function clearRings(){
    for(const r of rings){
      for(const w of r.wedges){ tower.remove(w.mesh); w.mesh.material.dispose(); }
    }
    rings = [];
  }

  function buildTower(){
    clearRings();
    const n = levels();
    const slots = clamp(+cfg.helixSlots || 8, 4, 16);
    const slotAngle = TAU / slots;
    const gapSlots = clamp(+cfg.helixGap || 2, 1, Math.max(1, slots - 2));
    const hazardShare = clamp(+cfg.helixHazard === undefined ? 0.22 : +cfg.helixHazard, 0, 0.6);
    const pal = cfg.brickColors && cfg.brickColors.length ? cfg.brickColors : DEFAULTS.brickColors;

    for(let i = 0; i < n; i++){
      const y = -i * LEVEL_H;
      const gapStart = Math.floor(Math.random() * slots);
      const wedges = [];
      // the first two rings are always safe, so nobody dies before they have
      // understood the controls
      const allowHazard = i > 1;
      for(let s = 0; s < slots; s++){
        const isGap = ((s - gapStart + slots) % slots) < gapSlots;
        if(isGap) continue;
        const hazard = allowHazard && Math.random() < hazardShare;
        const start = s * slotAngle;
        const mesh = new THREE.Mesh(wedgeGeo(slotAngle * 0.985),
          new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.08 }));
        mesh.position.y = y;
        // CylinderGeometry's theta starts at +Z and runs toward +X, which is the
        // same direction atan2(x, z) measures - so the mesh rotates by +start,
        // matching the [start, start+sweep] range the collision test uses.
        // With -start the tower rendered mirrored: the visible gap was never the
        // real one, and the game was unplayable.
        mesh.rotation.y = start;
        if(hazard) addSpikes(mesh, slotAngle * 0.985);
        tower.add(mesh);
        wedges.push({ mesh: mesh, start: start, sweep: slotAngle * 0.985, hazard: hazard });
      }
      rings.push({ y: y, wedges: wedges, level: i, pi: i % pal.length, broken: false });
    }
    styleAll();
  }

  function styleAll(){
    const pal = cfg.brickColors && cfg.brickColors.length ? cfg.brickColors : DEFAULTS.brickColors;
    const hz = cfg.hazardColor || '#e63946';
    for(const r of rings){
      for(const w of r.wedges){
        const m = w.mesh.material;
        m.color = new THREE.Color(w.hazard ? hz : pal[r.pi % pal.length]);
        m.emissive = new THREE.Color(w.hazard ? hz : '#000000').multiplyScalar(w.hazard ? 0.25 : 0);
      }
    }
    spikeMat.color = new THREE.Color(hz).lerp(new THREE.Color('#ffffff'), 0.45);
    spikeMat.emissive = new THREE.Color(hz).multiplyScalar(0.35);
    coreMat.color = new THREE.Color(cfg.bg || '#05070f').lerp(new THREE.Color(accentCol()), 0.35);
    ballMat.color = new THREE.Color(cfg.ballColor || '#e8ecf8');
    ballMat.emissive = new THREE.Color(cfg.ballColor || '#e8ecf8').multiplyScalar(0.35);
    const bt = tex('ball');
    ballMat.map = bt || null;
    if(bt) ballMat.color = new THREE.Color(0xffffff);
    ballMat.needsUpdate = true;

    goalMat.color = new THREE.Color(goalCol());
    goalMat.emissive = new THREE.Color(goalCol()).multiplyScalar(0.3);
    const gt = tex('goalPad') || tex('brickSuper');
    goalFaceMat.map = gt || null;
    goalFace.visible = !!gt;
    goalFaceMat.needsUpdate = true;
  }

  // ---------------- run state ----------------
  function resetBall(atLevel){
    ball = { y: -atLevel * LEVEL_H + LEVEL_H * 0.9, vy: 0 };
    combo = 0; smashing = false;
  }

  function newGame(){
    score = 0;
    lives = clamp(+cfg.lives || 3, 1, 9);
    depth = 0;
    shards.forEach(p => scene.remove(p.mesh));
    shards = [];
    spin = 0; spinVel = 0; shake = 0; hurtFlash = 0;
    reported = false;
    timeLeft = cfg.mode === 'dig' ? clamp(+cfg.timeLimit || 90, 15, 600) : null;
    lastTick = null;
    buildTower();
    resetBall(0);
    const bottom = -(levels() - 1) * LEVEL_H - LEVEL_H;
    goal.position.y = bottom - 0.25;
    goalFace.position.set(0, bottom + 0.02, 0);
    core.scale.y = Math.abs(bottom) + LEVEL_H * 2;
    core.position.y = bottom / 2 + LEVEL_H;
    camera.position.set(0, ball.y + 5.2, 14.5);
    camera.lookAt(0, ball.y - 3.5, 0);
    state = 'ready';
    hud();
  }

  // ---------------- input ----------------
  const keys = {};
  let dragging = false, lastX = 0;

  function onKeyDown(e){
    if(blocked) return;
    const t = e.target;
    if(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    keys[e.code] = true;
    if(e.code === 'Space'){ e.preventDefault(); if(state === 'ready'){ state = 'play'; hud(); } }
    if(e.code === 'Escape'){
      if(state === 'play') state = 'paused';
      else if(state === 'paused') state = 'play';
      hud();
    }
  }
  const onKeyUp = e => { keys[e.code] = false; };

  const pointerX = e => (e.touches ? e.touches[0].clientX : e.clientX);
  function onDown(e){
    if(blocked) return;
    dragging = true; lastX = pointerX(e);
    if(state === 'ready'){ state = 'play'; hud(); }
  }
  function onMove(e){
    if(blocked || !dragging) return;
    const x = pointerX(e);
    const dx = x - lastX;
    lastX = x;
    const r = canvas.getBoundingClientRect();
    spin += (dx / Math.max(1, r.width)) * TAU * 1.6 * (+cfg.helixSpin || 1);
  }
  const onUp = () => { dragging = false; };
  const onTouchStart = e => { e.preventDefault(); onDown(e); };
  const onTouchMove = e => { e.preventDefault(); onMove(e); };

  addEventListener('keydown', onKeyDown);
  addEventListener('keyup', onKeyUp);
  canvas.addEventListener('mousedown', onDown);
  addEventListener('mousemove', onMove);
  addEventListener('mouseup', onUp);
  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  addEventListener('touchend', onUp);

  // ---------------- effects ----------------
  function burst(y, colorHex, mult){
    if(!cfg.particles) return;
    const n = Math.round(10 * (mult || 1));
    const col = new THREE.Color(colorHex);
    const mat = new THREE.MeshStandardMaterial({ color: col, emissive: col.clone().multiplyScalar(0.3),
                                                 roughness: 0.6, transparent: true });
    for(let i = 0; i < n; i++){
      const a = Math.random() * TAU;
      const rr = R_IN + Math.random() * (R_OUT - R_IN);
      const mesh = new THREE.Mesh(shardGeo, mat);
      mesh.position.set(Math.cos(a) * rr, y, Math.sin(a) * rr);
      scene.add(mesh);
      shards.push({ mesh: mesh, mat: mat,
                    vx: Math.cos(a) * 0.06, vz: Math.sin(a) * 0.06,
                    vy: 0.04 + Math.random() * 0.06,
                    vr: (Math.random() - 0.5) * 0.3,
                    life: 1, decay: 0.02 + Math.random() * 0.02 });
    }
  }

  function stepShards(){
    if(!shards.length) return;
    const dying = [];
    for(const p of shards){
      p.mesh.position.x += p.vx; p.mesh.position.z += p.vz; p.mesh.position.y += p.vy;
      p.vy -= 0.006;
      p.mesh.rotation.x += p.vr; p.mesh.rotation.z += p.vr * 0.7;
      p.life -= p.decay;
      p.mat.opacity = clamp(p.life, 0, 1);
      if(p.life <= 0) dying.push(p);
    }
    if(dying.length){
      for(const p of dying) scene.remove(p.mesh);
      shards = shards.filter(p => p.life > 0);
      for(const p of dying) if(!shards.some(q => q.mat === p.mat)) p.mat.dispose();
    }
  }

  function smashRing(ring){
    const pal = cfg.brickColors && cfg.brickColors.length ? cfg.brickColors : DEFAULTS.brickColors;
    burst(ring.y, pal[ring.pi % pal.length], 1.4);
    for(const w of ring.wedges){ tower.remove(w.mesh); w.mesh.material.dispose(); }
    ring.wedges = [];
    ring.broken = true;
    shake = Math.max(shake, 9);
  }

  // ---------------- physics ----------------
  /* The ring whose top face the ball crosses between this frame and the next.
     A window test ("is the ball within 0.8 of the top?") silently misses at
     speed; a swept test cannot. */
  function ringCrossed(fromY, toY){
    const fromBottom = fromY - BALL_R, toBottom = toY - BALL_R;
    for(const r of rings){
      if(r.broken || !r.wedges.length) continue;
      const top = r.y + PLATE_H / 2;
      if(fromBottom > top && toBottom <= top) return r;
    }
    return null;
  }

  function wedgeUnderBall(ring){
    const local = norm(-spin);              // the ball sits at world angle 0
    for(const w of ring.wedges) if(inWedge(local, w.start, w.sweep)) return w;
    return null;
  }

  function lose(reason){
    lives--;
    hurtFlash = 1;
    shake = Math.max(shake, 16);
    burst(ball.y, cfg.hazardColor || '#e63946', 1.6);
    hud();
    if(lives <= 0){
      state = 'over';
      hud();
      if(!reported){
        reported = true;
        onGameOver && onGameOver({ score: score, level: depth, won: false, timedOut: reason === 'time' });
      }
      return;
    }
    resetBall(depth);                        // another go from this level
  }

  function step(){
    if(state === 'won'){ stepShards(); return; }

    if(timeLeft !== null && state === 'play'){
      const now = performance.now();
      if(lastTick !== null) timeLeft = Math.max(0, timeLeft - (now - lastTick) / 1000);
      lastTick = now;
      if(timeLeft <= 0){
        timeLeft = 0;
        state = 'over'; hud();
        if(!reported){
          reported = true;
          onGameOver && onGameOver({ score: score, level: depth, won: false, timedOut: true });
        }
        return;
      }
    } else {
      lastTick = null;
    }

    // rotation: keys nudge, drag is applied directly, and it eases to a stop
    const spinStep = 0.045 * (+cfg.helixSpin || 1);
    if(keys.ArrowLeft)  spinVel -= spinStep * 0.35;
    if(keys.ArrowRight) spinVel += spinStep * 0.35;
    spin += spinVel;
    spinVel *= 0.86;
    tower.rotation.y = spin;

    if(state !== 'play'){ stepShards(); return; }

    // fall
    ball.vy = Math.max(MAX_FALL, ball.vy + GRAVITY);
    const nextY = ball.y + ball.vy;

    if(ball.vy < 0){
      const ring = ringCrossed(ball.y, nextY);
      if(ring){
        const w = wedgeUnderBall(ring);
        if(w && w.hazard){                    // red is fatal, smashing or not
          lose('hazard');
          return;
        }
        if(w && !smashing){                   // land on it and hop
          ball.y = ring.y + PLATE_H / 2 + BALL_R;
          ball.vy = BOUNCE;
          combo = 0;
          smashing = false;
          shake = Math.max(shake, 3);
          hud();
          return;
        }
        if(w && smashing){                    // straight through the platform
          smashRing(ring);
          score += 50;
        }
        // past this ring, either through its gap or through its wreckage
        if(ring.level + 1 > depth){
          depth = ring.level + 1;
          if(!w) score += 100;
          combo++;
          if(combo >= clamp(+cfg.helixSmash || 3, 1, 20)) smashing = true;
        }
        hud();
      }
    }
    ball.y = nextY;

    // the pad at the bottom
    const bottom = goal.position.y + 0.25;
    if(ball.y - BALL_R <= bottom + 0.3){
      ball.y = bottom + 0.3 + BALL_R;
      score += 2000;
      state = 'won'; wonAt = performance.now();
      shake = 24;
      burst(ball.y, goalCol(), 4);
      hud();
      if(!reported){
        reported = true;
        onGameOver && onGameOver({ score: score, level: depth, won: true,
                                   timeLeft: timeLeft === null ? null : Math.round(timeLeft) });
      }
      return;
    }

    stepShards();
  }

  // ---------------- render ----------------
  function sync(){
    ballMesh.position.set(0, ball.y, R_OUT * 0.72);
    ballMesh.scale.setScalar(smashing ? 1.25 : 1);
    ballMat.emissive.set(smashing ? accentCol() : (cfg.ballColor || '#e8ecf8'))
      .multiplyScalar(smashing ? 0.8 : 0.35);
    ballLight.position.set(0, ball.y + 0.5, R_OUT * 1.0);
    ballLight.color.set(smashing ? accentCol() : '#ffffff');

    // camera trails the ball, with a knock on impact
    const targetY = ball.y + 5.2;
    camera.position.y += (targetY - camera.position.y) * 0.12;
    const j = shake ? shake * 0.012 : 0;
    camera.position.x = (Math.random() - 0.5) * j;
    camera.position.z = 14.5 + (Math.random() - 0.5) * j;
    camera.lookAt(0, camera.position.y - 8.7, 0);

    // only the rings near the ball are worth drawing
    const near = ball.y;
    for(const r of rings){
      const d = Math.abs(r.y - near);
      const vis = d < LEVEL_H * 7;
      for(const w of r.wedges) w.mesh.visible = vis;
    }

    if(hurtFlash > 0){
      hurtFlash = Math.max(0, hurtFlash - 0.06);
      const f = new THREE.Color(cfg.hazardColor || '#e63946').multiplyScalar(hurtFlash * 0.5);
      renderer.setClearColor(f, hurtFlash * 0.5);
    } else {
      renderer.setClearColor(0x000000, 0);
    }
  }

  function loop(){
    if(dead) return;
    if(state === 'play' || state === 'ready' || state === 'won') step();
    if(shake > 0) shake--;
    sync();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }

  styleAll();
  newGame();
  loop();

  return {
    setConfig(next){
      const before = { levels: cfg.helixLevels, slots: cfg.helixSlots,
                       gap: cfg.helixGap, hazard: cfg.helixHazard };
      cfg = Object.assign({}, cfg, next || {});
      const shapeChanged = before.levels !== cfg.helixLevels || before.slots !== cfg.helixSlots ||
                           before.gap !== cfg.helixGap || before.hazard !== cfg.helixHazard;
      if(shapeChanged) newGame(); else styleAll();
    },
    restart(next){
      if(next) cfg = Object.assign({}, cfg, next);
      newGame();
    },
    pause(){ if(state === 'play') state = 'paused'; hud(); },
    resume(){ if(state === 'paused') state = 'play'; hud(); },
    setBlocked(v){ blocked = !!v; dragging = false; for(const k in keys) keys[k] = false; },
    getState(){ return { score: score, lives: lives, level: depth, state: state }; },
    destroy(){
      dead = true;
      cancelAnimationFrame(raf);
      removeEventListener('keydown', onKeyDown);
      removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('mousedown', onDown);
      removeEventListener('mousemove', onMove);
      removeEventListener('mouseup', onUp);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      removeEventListener('touchend', onUp);
      clearRings();
      shards.forEach(p => { scene.remove(p.mesh); p.mat.dispose(); });
      shards = [];
      for(const k in wedgeGeos) wedgeGeos[k].dispose();
      shardGeo.dispose(); spikeGeo.dispose(); spikeMat.dispose();
      renderer.dispose();
    }
  };
}

root.Arcade = root.Arcade || {};
root.Arcade.helix = helix;
root.Arcade.helixDefaults = DEFAULTS;

})(window);
