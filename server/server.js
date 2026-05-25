const { WebSocketServer, WebSocket } = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

const TILE = 28, COLS = 18, ROWS = 18;
const EMPTY = 0, WALL = 1, BOX = 2;
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const STARTS = [{ x:1,y:1 },{ x:16,y:16 },{ x:16,y:1 },{ x:1,y:16 }];
const TICK_MS = 50;
const ABILITY_CD = 30;
const BOMB_GRACE = 0.4; // seconds player can walk through own fresh bomb

const HEROES = [
  { id:"caesar",   name:"Julius Caesar", color:"#e8b84b", dark:"#b8860b", female:false, ability:"Imperial Shield",   desc:"3s invincibility",         cooldown:30 },
  { id:"cleo",     name:"Cleopatra",     color:"#38bdf8", dark:"#0284c7", female:true,  ability:"Blessing of Gods",  desc:"Revive once with 1 HP",    cooldown:0  },
  { id:"bjorn",    name:"Bjorn Ironside",color:"#94a3b8", dark:"#475569", female:false, ability:"Axe Throw",         desc:"Throw axe, 3 charges",     cooldown:30 },
  { id:"achilles", name:"Achilles",      color:"#f87171", dark:"#dc2626", female:false, ability:"Spear Spin",        desc:"Spinning spears 3s",       cooldown:30 },
  { id:"suntzu",   name:"Sun Tzu",       color:"#4ade80", dark:"#16a34a", female:false, ability:"Strategic Insight", desc:"See bomb zones 8s",        cooldown:30 },
  { id:"blackbeard",name:"Blackbeard",   color:"#c084fc", dark:"#7c3aed", female:false, ability:"Powder Toss",       desc:"Throw bombs 5s",           cooldown:30 },
];

let lobby = null;

function randCode() { return Math.random().toString(36).slice(2,6).toUpperCase(); }

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
  broadcast({ type:"lobby_state", code:lobby.code, players:serializePlayers(), heroes:HEROES });
}

function serializePlayers() {
  return Array.from(lobby.players.values()).map(p => ({
    id:p.id, name:p.name, color:p.color, hero:p.hero, ready:p.ready, isHost:p.isHost,
  }));
}

function buildGrid(n) {
  const g = [];
  for (let r=0;r<ROWS;r++) { g[r]=[]; for (let c=0;c<COLS;c++) {
    if (r===0||r===ROWS-1||c===0||c===COLS-1) g[r][c]=WALL;
    else if (r%2===0&&c%2===0) g[r][c]=WALL;
    else g[r][c]=EMPTY;
  }}
  for (let r=1;r<ROWS-1;r++) for (let c=1;c<COLS-1;c++) {
    if (g[r][c]===EMPTY) {
      const safe=STARTS.slice(0,n).some(s=>Math.abs(s.x-c)<=2&&Math.abs(s.y-r)<=2);
      if (!safe&&Math.random()<0.62) g[r][c]=BOX;
    }
  }
  return g;
}

function solidAt(grid,c,r) {
  return grid[r]?.[c]===WALL||grid[r]?.[c]===BOX||grid[r]?.[c]===undefined;
}

function mineBlocksAt(mines,tx,ty,playerId) {
  // returns true if there's a mine at tx,ty that is solid for this player
  return mines.some(m => m.tx===tx && m.ty===ty && (m.owner!==playerId || m.grace<=0));
}

function buildGameState() {
  const players = Array.from(lobby.players.values());
  return {
    grid: buildGrid(players.length),
    players: players.map((p,i) => ({
      id:p.id, name:p.name, color:p.color, hero:p.hero,
      tx:STARTS[i].x, ty:STARTS[i].y,
      px:STARTS[i].x*TILE+TILE/2, py:STARTS[i].y*TILE+TILE/2,
      hp:3, dead:false, moving:false,
      mineCD:0, bombCount:0, maxBombs:2,
      swordCD:0, abilityCD:0,
      swordActive:false, swordTimer:0, swordDir:{x:0,y:1},
      invincible:0, shieldActive:false,
      abilityUsed:false, abilityActive:false, abilityTimer:0,
      axeCharges:3, axeRegenTimer:0,
      inputDir:null, wantMine:false, wantSword:false, wantAbility:false,
    })),
    mines:[], explosions:[], projectiles:[], over:false, winner:null,
  };
}

function hurtPlayer(p,gs) {
  if (p.invincible>0||p.dead||p.shieldActive) return;
  p.hp--;
  p.invincible=1.0;
  if (p.hp<=0) {
    // Cleopatra revive
    if (p.hero==="cleo"&&!p.abilityUsed) {
      p.hp=1; p.abilityUsed=true; p.invincible=2;
      gs.events = gs.events||[];
      gs.events.push({type:"cleopatra_revive",id:p.id});
    } else {
      p.dead=true; p.hp=0;
      spawnExp(p.tx,p.ty,0.8,null,gs.explosions);
    }
  }
}

function spawnExp(tx,ty,life,owner,arr) { arr.push({tx,ty,life,maxLife:life,owner}); }

function triggerMine(m,gs) {
  gs.mines = gs.mines.filter(x=>x!==m);
  const owner = gs.players.find(p=>p.id===m.owner);
  if (owner) owner.bombCount=Math.max(0,owner.bombCount-1);

  spawnExp(m.tx,m.ty,0.7,m.owner,gs.explosions);
  for (let d=0;d<4;d++) {
    for (let r=1;r<=3;r++) {
      const ex=m.tx+DX[d]*r, ey=m.ty+DY[d]*r;
      const t=gs.grid[ey]?.[ex];
      if (t===WALL||t===undefined) break;
      spawnExp(ex,ey,0.7,m.owner,gs.explosions);
      if (t===BOX) { gs.grid[ey][ex]=EMPTY; break; }
    }
  }
  // hurt players in blast
  for (const p of gs.players) {
    if (p.dead||p.invincible>0||p.shieldActive) continue;
    if (gs.explosions.some(e=>Math.abs(e.tx-p.tx)<0.8&&Math.abs(e.ty-p.ty)<0.8)) hurtPlayer(p,gs);
  }
  // chain explosions
  for (const om of [...gs.mines]) {
    if (om.exploding) continue;
    if (gs.explosions.some(e=>Math.abs(e.tx-om.tx)<0.8&&Math.abs(e.ty-om.ty)<0.8)) { om.timer=0; }
  }
}

function useAbility(p,gs) {
  if (p.abilityCD>0||p.dead) return;
  const h = p.hero;

  if (h==="caesar") {
    p.shieldActive=true; p.invincible=3; p.abilityCD=ABILITY_CD;
    gs.events=gs.events||[]; gs.events.push({type:"ability",id:p.id,hero:h});
  }
  else if (h==="bjorn") {
    if (p.axeCharges<=0) return;
    p.axeCharges--;
    p.axeRegenTimer=ABILITY_CD;
    gs.projectiles.push({ type:"axe", tx:p.tx, ty:p.ty, px:p.px, py:p.py, dir:{x:p.swordDir.x,y:p.swordDir.y}, owner:p.id, speed:TILE*14, done:false });
    gs.events=gs.events||[]; gs.events.push({type:"ability",id:p.id,hero:h});
  }
  else if (h==="achilles") {
    p.abilityActive=true; p.abilityTimer=3; p.abilityCD=ABILITY_CD;
    gs.events=gs.events||[]; gs.events.push({type:"ability",id:p.id,hero:h});
  }
  else if (h==="suntzu") {
    p.abilityActive=true; p.abilityTimer=8; p.abilityCD=ABILITY_CD;
    gs.events=gs.events||[]; gs.events.push({type:"ability",id:p.id,hero:h});
  }
  else if (h==="blackbeard") {
    p.abilityActive=true; p.abilityTimer=5; p.abilityCD=ABILITY_CD;
    gs.events=gs.events||[]; gs.events.push({type:"ability",id:p.id,hero:h});
  }
}

function tickGame(gs,dt) {
  gs.events = [];

  for (const p of gs.players) {
    if (p.dead) continue;
    p.mineCD=Math.max(0,p.mineCD-dt);
    p.swordCD=Math.max(0,p.swordCD-dt);
    p.abilityCD=Math.max(0,p.abilityCD-dt);
    p.invincible=Math.max(0,p.invincible-dt);
    if (p.invincible<=0) p.shieldActive=false;

    // Axe regen
    if (p.hero==="bjorn"&&p.axeCharges<3) {
      p.axeRegenTimer=Math.max(0,p.axeRegenTimer-dt);
      if (p.axeRegenTimer<=0) { p.axeCharges=Math.min(3,p.axeCharges+1); if(p.axeCharges<3) p.axeRegenTimer=ABILITY_CD; }
    }

    // Ability timer
    if (p.abilityActive) {
      p.abilityTimer=Math.max(0,p.abilityTimer-dt);
      if (p.abilityTimer<=0) p.abilityActive=false;
    }

    // Achilles spear spin damage
    if (p.abilityActive&&p.hero==="achilles") {
      for (const q of gs.players) {
        if (q===p||q.dead||q.invincible>0) continue;
        const dx=q.tx-p.tx, dy=q.ty-p.ty;
        if (Math.sqrt(dx*dx+dy*dy)<=1.5) hurtPlayer(q,gs);
      }
    }

    // Sword tick
    if (p.swordActive) {
      p.swordTimer-=dt;
      if (p.swordTimer<=0) { p.swordActive=false; }
      else {
        const sx=p.tx+p.swordDir.x, sy=p.ty+p.swordDir.y;
        for (const q of gs.players) {
          if (q===p||q.dead||q.invincible>0||q.shieldActive) continue;
          if (q.tx===sx&&q.ty===sy) hurtPlayer(q,gs);
        }
      }
    }

    // Movement — snappy grid movement
    const SPEED = TILE*10;
    if (p.moving) {
      const tx=p.tx*TILE+TILE/2, ty=p.ty*TILE+TILE/2;
      const dx=tx-p.px, dy=ty-p.py, dist=Math.sqrt(dx*dx+dy*dy), step=SPEED*dt;
      if (dist<=step) {
        p.px=tx; p.py=ty; p.moving=false;
        if (p.inputDir!==null) {
          const nx=p.tx+DX[p.inputDir], ny=p.ty+DY[p.inputDir];
          if (!solidAt(gs.grid,nx,ny)&&!mineBlocksAt(gs.mines,nx,ny,p.id)) {
            p.moving=true; p.tx=nx; p.ty=ny;
            p.swordDir={x:DX[p.inputDir],y:DY[p.inputDir]};
          }
        }
      } else { p.px+=dx/dist*step; p.py+=dy/dist*step; }
    } else if (p.inputDir!==null) {
      const nx=p.tx+DX[p.inputDir], ny=p.ty+DY[p.inputDir];
      if (!solidAt(gs.grid,nx,ny)&&!mineBlocksAt(gs.mines,nx,ny,p.id)) {
        p.moving=true; p.tx=nx; p.ty=ny;
        p.swordDir={x:DX[p.inputDir],y:DY[p.inputDir]};
      }
    }

    // Mine placement
    if (p.wantMine&&p.mineCD<=0&&p.bombCount<p.maxBombs) {
      const alreadyThere=gs.mines.some(m=>m.tx===p.tx&&m.ty===p.ty);
      if (!alreadyThere) {
        // Blackbeard throw mode
        if (p.abilityActive&&p.hero==="blackbeard") {
          const tx=p.tx+p.swordDir.x*3, ty=p.ty+p.swordDir.y*3;
          gs.projectiles.push({ type:"bomb", tx:p.tx, ty:p.ty, px:p.px, py:p.py,
            destTx:tx, destTy:ty, dir:p.swordDir, owner:p.id, speed:TILE*12, done:false, timer:3 });
          p.bombCount++; p.mineCD=1.2;
        } else {
          gs.mines.push({tx:p.tx,ty:p.ty,timer:3,owner:p.id,exploding:false,grace:BOMB_GRACE});
          p.bombCount++; p.mineCD=1.2;
        }
      }
      p.wantMine=false;
    }

    // Sword
    if (p.wantSword&&p.swordCD<=0) {
      p.swordActive=true; p.swordTimer=0.3; p.swordCD=0.6;
      p.wantSword=false;
    }

    // Ability
    if (p.wantAbility) { useAbility(p,gs); p.wantAbility=false; }
  }

  // Mine timers and grace
  for (const m of gs.mines) {
    m.timer-=dt;
    m.grace=Math.max(0,(m.grace||0)-dt);
    if (m.timer<=0&&!m.exploding) { m.exploding=true; triggerMine(m,gs); }
  }
  gs.mines=gs.mines.filter(m=>!m.exploding);

  // Projectiles (axe + thrown bombs)
  for (const proj of gs.projectiles) {
    if (proj.done) continue;
    const speed=proj.speed*dt;
    const tx=proj.tx*TILE+TILE/2, ty=proj.ty*TILE+TILE/2;
    const dx=(proj.dir.x*TILE*10), dy=(proj.dir.y*TILE*10);
    proj.px+=proj.dir.x*speed; proj.py+=proj.dir.y*speed;
    const ntx=Math.round((proj.px-TILE/2)/TILE), nty=Math.round((proj.py-TILE/2)/TILE);

    if (proj.type==="axe") {
      // hit wall or box
      if (solidAt(gs.grid,ntx,nty)) {
        if (gs.grid[nty]?.[ntx]===BOX) gs.grid[nty][ntx]=EMPTY;
        proj.done=true; continue;
      }
      // hit player
      for (const q of gs.players) {
        if (q.id===proj.owner||q.dead) continue;
        if (Math.abs(q.px-proj.px)<TILE*0.6&&Math.abs(q.py-proj.py)<TILE*0.6) { hurtPlayer(q,gs); proj.done=true; }
      }
      // out of bounds
      if (ntx<0||ntx>=COLS||nty<0||nty>=ROWS) proj.done=true;
    }

    if (proj.type==="bomb") {
      // travel toward dest
      const dtx=proj.destTx*TILE+TILE/2, dty=proj.destTy*TILE+TILE/2;
      const dist=Math.sqrt((dtx-proj.px)**2+(dty-proj.py)**2);
      if (dist<TILE*0.5||solidAt(gs.grid,ntx,nty)) {
        // land as mine
        const lx=solidAt(gs.grid,ntx,nty)?proj.tx:ntx;
        const ly=solidAt(gs.grid,nty,nty)?proj.ty:nty;
        gs.mines.push({tx:lx,ty:ly,timer:proj.timer||3,owner:proj.owner,exploding:false,grace:0});
        proj.done=true;
      } else {
        proj.tx=ntx; proj.ty=nty;
      }
    }
  }
  gs.projectiles=gs.projectiles.filter(p=>!p.done);

  // Explosions fade
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
    const now=Date.now(), dt=Math.min((now-last)/1000,0.1); last=now;
    tickGame(lobby.gameState,dt);
    broadcast({type:"game_state",state:lobby.gameState});
    if (lobby.gameState.over) {
      stopGameLoop();
      lobby.phase="lobby";
      for (const p of lobby.players.values()) p.ready=false;
      setTimeout(()=>broadcastLobbyState(),3000);
    }
  },TICK_MS);
}
function stopGameLoop() { if (gameInterval){clearInterval(gameInterval);gameInterval=null;} }

wss.on("connection",(ws)=>{
  let playerId=null;

  ws.on("message",(raw)=>{
    let msg; try{msg=JSON.parse(raw);}catch{return;}

    switch(msg.type) {
      case "create_lobby": {
        if (lobby) { send(ws,{type:"error",message:"A lobby exists. Join with: "+lobby.code}); return; }
        playerId=msg.playerId;
        lobby={ code:randCode(), phase:"lobby", players:new Map(), gameState:null };
        lobby.players.set(playerId,{id:playerId,ws,name:msg.name,color:msg.color,hero:msg.hero||"caesar",ready:false,isHost:true});
        send(ws,{type:"joined",code:lobby.code,playerId});
        broadcastLobbyState();
        break;
      }
      case "join_lobby": {
        if (!lobby){send(ws,{type:"error",message:"Lobby not found."});return;}
        if (lobby.code!==msg.code){send(ws,{type:"error",message:"Wrong code."});return;}
        if (lobby.players.size>=4){send(ws,{type:"error",message:"Lobby is full!"});return;}
        if (lobby.phase!=="lobby"){send(ws,{type:"error",message:"Game in progress."});return;}
        const takenColors=Array.from(lobby.players.values()).map(p=>p.color);
        if (takenColors.includes(msg.color)){send(ws,{type:"error",message:"Color taken! Pick another."});return;}
        playerId=msg.playerId;
        lobby.players.set(playerId,{id:playerId,ws,name:msg.name,color:msg.color,hero:msg.hero||"caesar",ready:false,isHost:false});
        send(ws,{type:"joined",code:lobby.code,playerId});
        broadcastLobbyState();
        break;
      }
      case "update_loadout": {
        if (!lobby||!playerId) return;
        const p=lobby.players.get(playerId); if(!p) return;
        if (msg.hero) p.hero=msg.hero;
        broadcastLobbyState();
        break;
      }
      case "toggle_ready": {
        if (!lobby||!playerId) return;
        const p=lobby.players.get(playerId); if(!p) return;
        p.ready=!p.ready;
        broadcastLobbyState();
        const all=Array.from(lobby.players.values());
        if (all.length>=2&&all.every(p=>p.ready)) {
          lobby.phase="game";
          lobby.gameState=buildGameState();
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

  ws.on("close",()=>handleDisconnect(playerId));
  ws.on("error",()=>handleDisconnect(playerId));
});

function handleDisconnect(pid) {
  if (!pid||!lobby) return;
  lobby.players.delete(pid);
  if (lobby.players.size===0){stopGameLoop();lobby=null;return;}
  const hasHost=Array.from(lobby.players.values()).some(p=>p.isHost);
  if (!hasHost) lobby.players.values().next().value.isHost=true;
  if (lobby.gameState){const gp=lobby.gameState.players.find(p=>p.id===pid);if(gp){gp.dead=true;gp.hp=0;}}
  broadcastLobbyState();
}

console.log(`Mine Brawl server on ws://localhost:${PORT}`);
