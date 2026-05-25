const { WebSocketServer, WebSocket } = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

const TILE = 28, COLS = 18, ROWS = 18;
const EMPTY = 0, WALL = 1, BOX = 2;
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const STARTS = [{ x: 1, y: 1 }, { x: 16, y: 16 }, { x: 16, y: 1 }, { x: 1, y: 16 }];
const TICK_MS = 50;
const ABILITY_CD = 30;

const HEROES = [
  { id: "caesar",   name: "Julius Caesar",  color: "#c084fc", dark: "#7c3aed", ability: "Iron Shield",      desc: "5s invincibility" },
  { id: "cleo",     name: "Cleopatra",       color: "#fbbf24", dark: "#d97706", ability: "Blessing",         desc: "+1 life (once)"   },
  { id: "achilles", name: "Achilles",        color: "#f87171", dark: "#dc2626", ability: "Berserker Rush",   desc: "Dash 3 tiles"     },
  { id: "suntzu",   name: "Sun Tzu",         color: "#4ade80", dark: "#16a34a", ability: "Smoke Screen",     desc: "Blind nearby 3s"  },
  { id: "leonidas", name: "Leonidas",        color: "#fb923c", dark: "#ea580c", ability: "Last Stand",       desc: "2x sword at 1hp"  },
  { id: "boudicca", name: "Boudicca",        color: "#e879f9", dark: "#a21caf", ability: "War Cry",          desc: "Push players back"},
  { id: "hannibal", name: "Hannibal",        color: "#38bdf8", dark: "#0284c7", ability: "Ambush",           desc: "Place 3 mines"    },
  { id: "joan",     name: "Joan of Arc",     color: "#f0abfc", dark: "#c026d3", ability: "Divine Flame",     desc: "Ring of fire 3s"  },
];

let lobby = null;

function randCode() { return Math.random().toString(36).slice(2, 6).toUpperCase(); }

function broadcast(data) {
  if (!lobby) return;
  const msg = JSON.stringify(data);
  for (const p of lobby.players.values())
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcastLobbyState() {
  if (!lobby) return;
  broadcast({ type: "lobby_state", code: lobby.code, players: serializePlayers() });
}

function serializePlayers() {
  return Array.from(lobby.players.values()).map(p => ({
    id: p.id, name: p.name, avatar: p.avatar, hero: p.hero,
    slot: p.slot, ready: p.ready, isHost: p.isHost,
  }));
}

function buildGrid(n) {
  const g = [];
  for (let r = 0; r < ROWS; r++) {
    g[r] = [];
    for (let c = 0; c < COLS; c++) {
      if (r===0||r===ROWS-1||c===0||c===COLS-1) g[r][c]=WALL;
      else if (r%2===0&&c%2===0) g[r][c]=WALL;
      else g[r][c]=EMPTY;
    }
  }
  for (let r=1;r<ROWS-1;r++) for (let c=1;c<COLS-1;c++) {
    if (g[r][c]===EMPTY) {
      const safe = STARTS.slice(0,n).some(s=>Math.abs(s.x-c)<=2&&Math.abs(s.y-r)<=2);
      if (!safe && Math.random()<0.62) g[r][c]=BOX;
    }
  }
  return g;
}

function solidAt(grid, c, r) {
  return grid[r]?.[c]===WALL || grid[r]?.[c]===BOX || grid[r]?.[c]===undefined;
}

function buildGameState() {
  const players = Array.from(lobby.players.values());
  const n = players.length;
  return {
    grid: buildGrid(n),
    players: players.map((p, i) => ({
      id: p.id, name: p.name, avatar: p.avatar, hero: p.hero || "caesar", slot: p.slot ?? i,
      tx: STARTS[i].x, ty: STARTS[i].y,
      px: STARTS[i].x*TILE+TILE/2, py: STARTS[i].y*TILE+TILE/2,
      hp: 3, maxHp: 3, dead: false, moving: false,
      mineCD: 0, swordCD: 0, abilityCD: 0,
      swordActive: false, swordTimer: 0, swordDir: { x:0, y:-1 },
      invincible: 0, shieldActive: false,
      abilityUsed: false,
      smokeTimer: 0,
      flameTimer: 0, flames: [],
      inputDir: null, wantMine: false, wantSword: false, wantAbility: false,
    })),
    mines: [], explosions: [], smokes: [], over: false, winner: null,
  };
}

function hurtPlayer(p, gs) {
  if (p.invincible > 0 || p.dead || p.shieldActive) return;
  p.hp--;
  p.invincible = 1.2;
  if (p.hp <= 0) { p.dead = true; p.hp = 0; spawnExp(p.tx, p.ty, 0.8, null, gs.explosions); }
}

function spawnExp(tx, ty, life, owner, arr) { arr.push({ tx, ty, life, maxLife: life, owner }); }

function triggerMine(m, gs) {
  spawnExp(m.tx, m.ty, 0.8, m.owner, gs.explosions);
  for (let d=0;d<4;d++) for (let r=1;r<=3;r++) {
    const ex=m.tx+DX[d]*r, ey=m.ty+DY[d]*r;
    const t=gs.grid[ey]?.[ex];
    if (t===WALL||t===undefined) break;
    spawnExp(ex, ey, 0.8, m.owner, gs.explosions);
    if (t===BOX) { gs.grid[ey][ex]=EMPTY; break; }
  }
  for (const p of gs.players) {
    if (p.dead||p.invincible>0||p.shieldActive) continue;
    if (gs.explosions.some(e=>Math.abs(e.tx-p.tx)<0.7&&Math.abs(e.ty-p.ty)<0.7)) hurtPlayer(p, gs);
  }
  for (const om of gs.mines) {
    if (om===m||om.exploding) continue;
    if (gs.explosions.some(e=>Math.abs(e.tx-om.tx)<0.7&&Math.abs(e.ty-om.ty)<0.7)) om.timer=0;
  }
}

function useAbility(p, gs) {
  if (p.abilityCD > 0 || p.dead) return;
  const hero = p.hero || "caesar";

  if (hero === "caesar") {
    p.shieldActive = true;
    p.invincible = 5;
    setTimeout(() => { p.shieldActive = false; }, 5000);
    p.abilityCD = ABILITY_CD;
  }
  else if (hero === "cleo") {
    if (!p.abilityUsed) { p.hp = Math.min(p.hp + 1, 4); p.abilityUsed = true; p.abilityCD = ABILITY_CD; }
  }
  else if (hero === "achilles") {
    let steps = 0;
    const dir = p.swordDir;
    while (steps < 3) {
      const nx = p.tx + dir.x, ny = p.ty + dir.y;
      if (solidAt(gs.grid, nx, ny)) break;
      p.tx = nx; p.ty = ny;
      p.px = nx*TILE+TILE/2; p.py = ny*TILE+TILE/2;
      steps++;
    }
    p.abilityCD = ABILITY_CD;
  }
  else if (hero === "suntzu") {
    gs.smokes.push({ tx: p.tx, ty: p.ty, timer: 3, owner: p.id });
    p.abilityCD = ABILITY_CD;
  }
  else if (hero === "leonidas") {
    p.leonidas = true;
    p.abilityCD = ABILITY_CD;
  }
  else if (hero === "boudicca") {
    for (const q of gs.players) {
      if (q===p||q.dead) continue;
      const dx = q.tx-p.tx, dy = q.ty-p.ty;
      const dist = Math.sqrt(dx*dx+dy*dy);
      if (dist <= 3) {
        const nx = Math.max(1,Math.min(COLS-2, q.tx+Math.sign(dx)*2));
        const ny = Math.max(1,Math.min(ROWS-2, q.ty+Math.sign(dy)*2));
        if (!solidAt(gs.grid, nx, ny)) { q.tx=nx; q.ty=ny; q.px=nx*TILE+TILE/2; q.py=ny*TILE+TILE/2; }
      }
    }
    p.abilityCD = ABILITY_CD;
  }
  else if (hero === "hannibal") {
    const dirs = [{x:0,y:-1},{x:1,y:0},{x:0,y:1}];
    for (const d of dirs) {
      const mx=p.tx+d.x, my=p.ty+d.y;
      if (!solidAt(gs.grid,mx,my)&&!gs.mines.some(m=>m.tx===mx&&m.ty===my))
        gs.mines.push({ tx:mx, ty:my, timer:2.5, owner:p.id, exploding:false });
    }
    p.abilityCD = ABILITY_CD;
  }
  else if (hero === "joan") {
    p.flameTimer = 3;
    const offsets = [{x:1,y:0},{x:-1,y:0},{x:0,y:1},{x:0,y:-1},{x:1,y:1},{x:-1,y:1},{x:1,y:-1},{x:-1,y:-1}];
    p.flames = offsets.map(o => ({ tx: p.tx+o.x, ty: p.ty+o.y }));
    p.abilityCD = ABILITY_CD;
  }
}

function tickGame(gs, dt) {
  for (const p of gs.players) {
    if (p.dead) continue;
    p.mineCD = Math.max(0, p.mineCD-dt);
    p.swordCD = Math.max(0, p.swordCD-dt);
    p.abilityCD = Math.max(0, p.abilityCD-dt);
    p.invincible = Math.max(0, p.invincible-dt);
    if (p.invincible <= 0) p.shieldActive = false;

    // Joan flame tick
    if (p.flameTimer > 0) {
      p.flameTimer = Math.max(0, p.flameTimer-dt);
      if (p.flameTimer <= 0) p.flames = [];
      else {
        for (const f of p.flames) {
          for (const q of gs.players) {
            if (q===p||q.dead||q.invincible>0) continue;
            if (q.tx===f.tx&&q.ty===f.ty) hurtPlayer(q, gs);
          }
        }
      }
    }

    // Sword tick
    if (p.swordActive) {
      p.swordTimer -= dt;
      if (p.swordTimer<=0) { p.swordActive=false; }
      else {
        const sx=p.tx+p.swordDir.x, sy=p.ty+p.swordDir.y;
        for (const q of gs.players) {
          if (q===p||q.dead||q.invincible>0||q.shieldActive) continue;
          if (q.tx===sx&&q.ty===sy) {
            const dmg = (p.hero==="leonidas"&&p.hp<=1) ? 2 : 1;
            for (let i=0;i<dmg;i++) hurtPlayer(q, gs);
          }
        }
      }
    }

    // Movement
    const SPEED = TILE*7;
    if (p.moving) {
      const tx=p.tx*TILE+TILE/2, ty=p.ty*TILE+TILE/2;
      const dx=tx-p.px, dy=ty-p.py, dist=Math.sqrt(dx*dx+dy*dy), step=SPEED*dt;
      if (dist<=step) {
        p.px=tx; p.py=ty; p.moving=false;
        if (p.inputDir!==null) {
          const nx=p.tx+DX[p.inputDir], ny=p.ty+DY[p.inputDir];
          if (!solidAt(gs.grid,nx,ny)) { p.moving=true; p.tx=nx; p.ty=ny; p.swordDir={x:DX[p.inputDir],y:DY[p.inputDir]}; }
        }
      } else { p.px+=dx/dist*step; p.py+=dy/dist*step; }
    } else if (p.inputDir!==null) {
      const nx=p.tx+DX[p.inputDir], ny=p.ty+DY[p.inputDir];
      if (!solidAt(gs.grid,nx,ny)) { p.moving=true; p.tx=nx; p.ty=ny; p.swordDir={x:DX[p.inputDir],y:DY[p.inputDir]}; }
    }

    // Mine
    if (p.wantMine&&p.mineCD<=0) {
      if (!gs.mines.some(m=>m.tx===p.tx&&m.ty===p.ty)) {
        gs.mines.push({ tx:p.tx, ty:p.ty, timer:2.5, owner:p.id, exploding:false });
        p.mineCD=1.2;
      }
      p.wantMine=false;
    }

    // Sword
    if (p.wantSword&&p.swordCD<=0) {
      p.swordActive=true; p.swordTimer=0.35; p.swordCD=0.7;
      p.wantSword=false;
    }

    // Ability
    if (p.wantAbility) { useAbility(p, gs); p.wantAbility=false; }
  }

  // Mine timers
  for (const m of gs.mines) {
    m.timer-=dt;
    if (m.timer<=0&&!m.exploding) { m.exploding=true; triggerMine(m, gs); }
  }
  gs.mines=gs.mines.filter(m=>!m.exploding);

  // Smoke timers
  for (const s of gs.smokes) s.timer-=dt;
  gs.smokes=gs.smokes.filter(s=>s.timer>0);

  // Explosions
  for (const e of gs.explosions) e.life-=dt;
  gs.explosions=gs.explosions.filter(e=>e.life>0);

  // Win check
  const alive=gs.players.filter(p=>!p.dead);
  if (alive.length<=1&&!gs.over) { gs.over=true; gs.winner=alive.length===1?alive[0].id:null; }
}

let gameInterval=null;
function startGameLoop() {
  let last=Date.now();
  gameInterval=setInterval(()=>{
    if (!lobby||!lobby.gameState) return;
    const now=Date.now(), dt=(now-last)/1000; last=now;
    tickGame(lobby.gameState, dt);
    broadcast({ type:"game_state", state:lobby.gameState });
    if (lobby.gameState.over) {
      stopGameLoop();
      lobby.phase="lobby";
      for (const p of lobby.players.values()) p.ready=false;
      setTimeout(()=>broadcastLobbyState(), 2000);
    }
  }, TICK_MS);
}
function stopGameLoop() { if (gameInterval) { clearInterval(gameInterval); gameInterval=null; } }

wss.on("connection", (ws) => {
  let playerId=null;

  ws.on("message", (raw) => {
    let msg; try { msg=JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case "create_lobby": {
        if (lobby) { send(ws,{type:"error",message:"A lobby already exists. Join with code: "+lobby.code}); return; }
        playerId=msg.playerId;
        lobby={ code:randCode(), phase:"lobby", players:new Map(), gameState:null };
        lobby.players.set(playerId,{ id:playerId, ws, name:msg.name, avatar:msg.avatar, hero:msg.hero||"caesar", slot:msg.slot??0, ready:false, isHost:true });
        send(ws,{type:"joined",code:lobby.code,playerId});
        broadcastLobbyState();
        break;
      }
      case "join_lobby": {
        if (!lobby) { send(ws,{type:"error",message:"Lobby not found."}); return; }
        if (lobby.code!==msg.code) { send(ws,{type:"error",message:"Wrong code."}); return; }
        if (lobby.players.size>=4) { send(ws,{type:"error",message:"Lobby is full!"}); return; }
        if (lobby.phase!=="lobby") { send(ws,{type:"error",message:"Game already in progress."}); return; }
        const takenSlots=Array.from(lobby.players.values()).map(p=>p.slot);
        let slot=msg.slot??0;
        if (takenSlots.includes(slot)) { slot=[0,1,2,3].find(s=>!takenSlots.includes(s))??0; }
        playerId=msg.playerId;
        lobby.players.set(playerId,{ id:playerId, ws, name:msg.name, avatar:msg.avatar, hero:msg.hero||"caesar", slot, ready:false, isHost:false });
        send(ws,{type:"joined",code:lobby.code,playerId,slot});
        broadcastLobbyState();
        break;
      }
      case "update_hero": {
        if (!lobby||!playerId) return;
        const p=lobby.players.get(playerId); if (!p) return;
        p.hero=msg.hero; p.slot=msg.slot??p.slot;
        broadcastLobbyState();
        break;
      }
      case "toggle_ready": {
        if (!lobby||!playerId) return;
        const p=lobby.players.get(playerId); if (!p) return;
        p.ready=!p.ready;
        broadcastLobbyState();
        const all=Array.from(lobby.players.values());
        if (all.length>=2&&all.every(p=>p.ready)) {
          lobby.phase="game"; lobby.gameState=buildGameState();
          broadcast({type:"game_start",state:lobby.gameState,heroes:HEROES});
          startGameLoop();
        }
        break;
      }
      case "input": {
        if (!lobby||!lobby.gameState||!playerId) return;
        const gp=lobby.gameState.players.find(p=>p.id===playerId);
        if (!gp||gp.dead) return;
        if (msg.dir!==undefined) gp.inputDir=msg.dir;
        if (msg.mine) gp.wantMine=true;
        if (msg.sword) gp.wantSword=true;
        if (msg.ability) gp.wantAbility=true;
        break;
      }
      case "leave": { handleDisconnect(playerId); playerId=null; break; }
    }
  });

  ws.on("close", ()=>handleDisconnect(playerId));
  ws.on("error", ()=>handleDisconnect(playerId));
});

function handleDisconnect(pid) {
  if (!pid||!lobby) return;
  lobby.players.delete(pid);
  if (lobby.players.size===0) { stopGameLoop(); lobby=null; return; }
  const hasHost=Array.from(lobby.players.values()).some(p=>p.isHost);
  if (!hasHost) lobby.players.values().next().value.isHost=true;
  if (lobby.gameState) { const gp=lobby.gameState.players.find(p=>p.id===pid); if (gp) { gp.dead=true; gp.hp=0; } }
  broadcastLobbyState();
}

console.log(`Mine Brawl server running on ws://localhost:${PORT}`);
