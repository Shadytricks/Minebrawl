const { WebSocketServer, WebSocket } = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

// ─── Constants ────────────────────────────────────────────────────────────────
const TILE = 28, COLS = 18, ROWS = 18;
const EMPTY = 0, WALL = 1, BOX = 2;
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const STARTS = [{ x: 1, y: 1 }, { x: 16, y: 16 }, { x: 16, y: 1 }, { x: 1, y: 16 }];
const AVATARS = ["🟣", "🟢", "🔴", "🟡"];
const TICK_MS = 50; // 20 ticks/sec

// ─── State ────────────────────────────────────────────────────────────────────
let lobby = null; // only one lobby at a time

// ─── Helpers ──────────────────────────────────────────────────────────────────
function randCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

function broadcast(data) {
  if (!lobby) return;
  const msg = JSON.stringify(data);
  for (const player of lobby.players.values()) {
    if (player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(msg);
    }
  }
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcastLobbyState() {
  if (!lobby) return;
  broadcast({
    type: "lobby_state",
    code: lobby.code,
    players: serializePlayers(),
  });
}

function serializePlayers() {
  return Array.from(lobby.players.values()).map((p) => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    ready: p.ready,
    isHost: p.isHost,
  }));
}

// ─── Grid ─────────────────────────────────────────────────────────────────────
function buildGrid(numPlayers) {
  const g = [];
  for (let r = 0; r < ROWS; r++) {
    g[r] = [];
    for (let c = 0; c < COLS; c++) {
      if (r === 0 || r === ROWS - 1 || c === 0 || c === COLS - 1) g[r][c] = WALL;
      else if (r % 2 === 0 && c % 2 === 0) g[r][c] = WALL;
      else g[r][c] = EMPTY;
    }
  }
  for (let r = 1; r < ROWS - 1; r++) {
    for (let c = 1; c < COLS - 1; c++) {
      if (g[r][c] === EMPTY) {
        const safe = STARTS.slice(0, numPlayers).some(
          (s) => Math.abs(s.x - c) <= 2 && Math.abs(s.y - r) <= 2
        );
        if (!safe && Math.random() < 0.62) g[r][c] = BOX;
      }
    }
  }
  return g;
}

function solidAt(grid, c, r) {
  return grid[r]?.[c] === WALL || grid[r]?.[c] === BOX || grid[r]?.[c] === undefined;
}

// ─── Game Logic ───────────────────────────────────────────────────────────────
function buildGameState() {
  const players = Array.from(lobby.players.values());
  const numPlayers = players.length;
  return {
    grid: buildGrid(numPlayers),
    players: players.map((p, i) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      tx: STARTS[i].x,
      ty: STARTS[i].y,
      px: STARTS[i].x * TILE + TILE / 2,
      py: STARTS[i].y * TILE + TILE / 2,
      hp: 3,
      dead: false,
      moving: false,
      mineCD: 0,
      swordCD: 0,
      swordActive: false,
      swordTimer: 0,
      swordDir: { x: 0, y: -1 },
      invincible: 0,
      inputDir: null,
      wantMine: false,
      wantSword: false,
    })),
    mines: [],
    explosions: [],
    over: false,
    winner: null,
  };
}

function hurtPlayer(p, gs) {
  if (p.invincible > 0 || p.dead) return;
  p.hp--;
  p.invincible = 1.5;
  if (p.hp <= 0) {
    p.dead = true;
    p.hp = 0;
    spawnExplosion(p.tx, p.ty, 0.8, null, gs.explosions);
  }
}

function spawnExplosion(tx, ty, life, owner, explosions) {
  explosions.push({ tx, ty, life, maxLife: life, owner });
}

function triggerMineExplosion(mine, gs) {
  spawnExplosion(mine.tx, mine.ty, 0.8, mine.owner, gs.explosions);
  for (let d = 0; d < 4; d++) {
    for (let r = 1; r <= 3; r++) {
      const ex = mine.tx + DX[d] * r;
      const ey = mine.ty + DY[d] * r;
      const t = gs.grid[ey]?.[ex];
      if (t === WALL || t === undefined) break;
      spawnExplosion(ex, ey, 0.8, mine.owner, gs.explosions);
      if (t === BOX) { gs.grid[ey][ex] = EMPTY; break; }
    }
  }
  // Hurt players caught in blast
  for (const p of gs.players) {
    if (p.dead || p.invincible > 0) continue;
    if (gs.explosions.some((e) => Math.abs(e.tx - p.tx) < 0.7 && Math.abs(e.ty - p.ty) < 0.7)) {
      hurtPlayer(p, gs);
    }
  }
  // Chain explosions
  for (const om of gs.mines) {
    if (om === mine || om.exploding) continue;
    if (gs.explosions.some((e) => Math.abs(e.tx - om.tx) < 0.7 && Math.abs(e.ty - om.ty) < 0.7)) {
      om.timer = 0;
    }
  }
}

function tickGame(gs, dt) {
  for (const p of gs.players) {
    if (p.dead) continue;
    p.mineCD = Math.max(0, p.mineCD - dt);
    p.swordCD = Math.max(0, p.swordCD - dt);
    p.invincible = Math.max(0, p.invincible - dt);

    // Sword tick
    if (p.swordActive) {
      p.swordTimer -= dt;
      if (p.swordTimer <= 0) {
        p.swordActive = false;
      } else {
        const sx = p.tx + p.swordDir.x;
        const sy = p.ty + p.swordDir.y;
        for (const q of gs.players) {
          if (q === p || q.dead || q.invincible > 0) continue;
          if (q.tx === sx && q.ty === sy) hurtPlayer(q, gs);
        }
      }
    }

    // Movement
    if (!p.moving && p.inputDir !== null) {
      const nx = p.tx + DX[p.inputDir];
      const ny = p.ty + DY[p.inputDir];
      if (!solidAt(gs.grid, nx, ny)) {
        p.moving = true;
        p.tx = nx;
        p.ty = ny;
        p.swordDir = { x: DX[p.inputDir], y: DY[p.inputDir] };
      }
    }

    if (p.moving) {
      const tx = p.tx * TILE + TILE / 2;
      const ty = p.ty * TILE + TILE / 2;
      const dx = tx - p.px;
      const dy = ty - p.py;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const step = TILE * 0.25;
      if (dist <= step) { p.px = tx; p.py = ty; p.moving = false; }
      else { p.px += (dx / dist) * step; p.py += (dy / dist) * step; }
    }

    // Mine placement
    if (p.wantMine && p.mineCD <= 0) {
      const already = gs.mines.some((m) => m.tx === p.tx && m.ty === p.ty);
      if (!already) {
        gs.mines.push({ tx: p.tx, ty: p.ty, timer: 2.5, owner: p.id, exploding: false });
        p.mineCD = 1.2;
      }
      p.wantMine = false;
    }

    // Sword swing
    if (p.wantSword && p.swordCD <= 0) {
      p.swordActive = true;
      p.swordTimer = 0.35;
      p.swordCD = 0.7;
      p.wantSword = false;
    }
  }

  // Mine timers
  for (const m of gs.mines) {
    m.timer -= dt;
    if (m.timer <= 0 && !m.exploding) {
      m.exploding = true;
      triggerMineExplosion(m, gs);
    }
  }
  gs.mines = gs.mines.filter((m) => !m.exploding);

  // Explosion fade
  for (const e of gs.explosions) e.life -= dt;
  gs.explosions = gs.explosions.filter((e) => e.life > 0);

  // Check win
  const alive = gs.players.filter((p) => !p.dead);
  if (alive.length <= 1 && !gs.over) {
    gs.over = true;
    gs.winner = alive.length === 1 ? alive[0].id : null;
  }
}

// ─── Game Loop ────────────────────────────────────────────────────────────────
let gameInterval = null;

function startGameLoop() {
  let last = Date.now();
  gameInterval = setInterval(() => {
    if (!lobby || !lobby.gameState) return;
    const now = Date.now();
    const dt = (now - last) / 1000;
    last = now;

    tickGame(lobby.gameState, dt);

    broadcast({ type: "game_state", state: lobby.gameState });

    if (lobby.gameState.over) {
      stopGameLoop();
      lobby.phase = "lobby";
      // Reset ready states
      for (const p of lobby.players.values()) p.ready = false;
      setTimeout(() => broadcastLobbyState(), 2000);
    }
  }, TICK_MS);
}

function stopGameLoop() {
  if (gameInterval) { clearInterval(gameInterval); gameInterval = null; }
}

// ─── Connection Handler ───────────────────────────────────────────────────────
wss.on("connection", (ws) => {
  let playerId = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── Create lobby ──────────────────────────────────────────────────────
      case "create_lobby": {
        if (lobby) {
          send(ws, { type: "error", message: "A lobby already exists. Join with code: " + lobby.code });
          return;
        }
        playerId = msg.playerId;
        lobby = {
          code: randCode(),
          phase: "lobby",
          players: new Map(),
          gameState: null,
        };
        lobby.players.set(playerId, {
          id: playerId,
          ws,
          name: msg.name,
          avatar: msg.avatar,
          ready: false,
          isHost: true,
        });
        send(ws, { type: "joined", code: lobby.code, playerId });
        broadcastLobbyState();
        break;
      }

      // ── Join lobby ────────────────────────────────────────────────────────
      case "join_lobby": {
        if (!lobby) { send(ws, { type: "error", message: "Lobby not found." }); return; }
        if (lobby.code !== msg.code) { send(ws, { type: "error", message: "Wrong code." }); return; }
        if (lobby.players.size >= 4) { send(ws, { type: "error", message: "Lobby is full!" }); return; }
        if (lobby.phase !== "lobby") { send(ws, { type: "error", message: "Game already in progress." }); return; }

        // Resolve avatar conflicts
        const takenAvatars = Array.from(lobby.players.values()).map((p) => p.avatar);
        let avatar = msg.avatar;
        if (takenAvatars.includes(avatar)) {
          const free = [0, 1, 2, 3].find((a) => !takenAvatars.includes(a));
          if (free === undefined) { send(ws, { type: "error", message: "All avatars taken!" }); return; }
          avatar = free;
        }

        playerId = msg.playerId;
        lobby.players.set(playerId, { id: playerId, ws, name: msg.name, avatar, ready: false, isHost: false });
        send(ws, { type: "joined", code: lobby.code, playerId, avatar });
        broadcastLobbyState();
        break;
      }

      // ── Toggle ready ──────────────────────────────────────────────────────
      case "toggle_ready": {
        if (!lobby || !playerId) return;
        const player = lobby.players.get(playerId);
        if (!player) return;
        player.ready = !player.ready;
        broadcastLobbyState();

        // Auto-launch when all ready (min 2)
        const all = Array.from(lobby.players.values());
        if (all.length >= 2 && all.every((p) => p.ready)) {
          lobby.phase = "game";
          lobby.gameState = buildGameState();
          broadcast({ type: "game_start", state: lobby.gameState });
          startGameLoop();
        }
        break;
      }

      // ── Player input ──────────────────────────────────────────────────────
      case "input": {
        if (!lobby || !lobby.gameState || !playerId) return;
        const gp = lobby.gameState.players.find((p) => p.id === playerId);
        if (!gp || gp.dead) return;
        if (msg.dir !== undefined) gp.inputDir = msg.dir;
        if (msg.mine) gp.wantMine = true;
        if (msg.sword) gp.wantSword = true;
        break;
      }

      // ── Leave ─────────────────────────────────────────────────────────────
      case "leave": {
        handleDisconnect(playerId);
        playerId = null;
        break;
      }
    }
  });

  ws.on("close", () => handleDisconnect(playerId));
  ws.on("error", () => handleDisconnect(playerId));
});

function handleDisconnect(pid) {
  if (!pid || !lobby) return;
  lobby.players.delete(pid);

  if (lobby.players.size === 0) {
    stopGameLoop();
    lobby = null;
    return;
  }

  // Pass host to next player
  const hasHost = Array.from(lobby.players.values()).some((p) => p.isHost);
  if (!hasHost) {
    const next = lobby.players.values().next().value;
    next.isHost = true;
  }

  // If in-game, mark player dead
  if (lobby.gameState) {
    const gp = lobby.gameState.players.find((p) => p.id === pid);
    if (gp) { gp.dead = true; gp.hp = 0; }
  }

  broadcastLobbyState();
}

console.log(`Mine Brawl server running on ws://localhost:${PORT}`);
