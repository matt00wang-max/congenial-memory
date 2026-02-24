const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ─── Config ───
const PORT = 3000;
const TICK_RATE = 20; // 20 ticks per second
const TICK_MS = 1000 / TICK_RATE;
const MAP_SIZE = 20000;
const MAX_PLAYERS = 20;
const BOT_COUNT = 30; // fewer bots in multiplayer

// ─── HTTP server to serve the game file ───
const httpServer = http.createServer((req, res) => {
  let filePath;
  if (req.url === '/' || req.url === '/index.html') {
    filePath = path.join(__dirname, 'battle-royale.html');
  } else {
    filePath = path.join(__dirname, req.url);
  }
  const ext = path.extname(filePath);
  const mimeTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  const contentType = mimeTypes[ext] || 'text/plain';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// ─── WebSocket server ───
const wss = new WebSocketServer({ server: httpServer });

// ─── Game State ───
let gameState = null;
let players = new Map(); // ws -> player data
let nextPlayerId = 1;
let tickTimer = null;

function generateId() {
  return nextPlayerId++;
}

// ─── Weapon definitions (mirrored from client) ───
const WEAPONS = {
  pistol:  { name:'Pistol',  damage:15, fireRate:300,  range:500,  speed:18, spread:0.04, magSize:12, reloadTime:1200, ammoType:'9mm' },
  smg:     { name:'SMG',     damage:12, fireRate:80,   range:400,  speed:16, spread:0.08, magSize:25, reloadTime:1500, ammoType:'9mm' },
  shotgun: { name:'Shotgun', damage:8,  fireRate:800,  range:250,  speed:14, spread:0.15, magSize:5,  reloadTime:2000, ammoType:'shells', pellets:6 },
  ar:      { name:'AR',      damage:20, fireRate:120,  range:700,  speed:22, spread:0.03, magSize:30, reloadTime:1800, ammoType:'5.56' },
  sniper:  { name:'Sniper',  damage:75, fireRate:1200, range:1200, speed:30, spread:0.005,magSize:5,  reloadTime:2500, ammoType:'.308' },
  lmg:     { name:'LMG',     damage:18, fireRate:100,  range:600,  speed:20, spread:0.06, magSize:50, reloadTime:3000, ammoType:'5.56' }
};

// ─── Initialize game world ───
function initGame() {
  const buildings = generateBuildings();
  const zone = {
    x: MAP_SIZE / 2, y: MAP_SIZE / 2, r: MAP_SIZE * 0.7,
    targetX: MAP_SIZE / 2, targetY: MAP_SIZE / 2, targetR: MAP_SIZE * 0.7,
    shrinkStart: 0, shrinkDuration: 15000, phase: 0,
    nextShrink: 30000, damage: 0
  };

  // Retreat zone
  const retreatAngle = Math.random() * Math.PI * 2;
  const retreatDist = MAP_SIZE * 0.25 + Math.random() * MAP_SIZE * 0.15;
  const retreatZone = {
    x: MAP_SIZE / 2 + Math.cos(retreatAngle) * retreatDist,
    y: MAP_SIZE / 2 + Math.sin(retreatAngle) * retreatDist,
    r: 600, timer: 0, required: 30000, active: true, extracted: false
  };

  // Bots
  const bots = [];
  for (let i = 0; i < BOT_COUNT; i++) {
    const bx = 500 + Math.random() * (MAP_SIZE - 1000);
    const by = 500 + Math.random() * (MAP_SIZE - 1000);
    const botSpeed = 2 + Math.random() * 1.5;
    bots.push({
      id: generateId(),
      x: bx, y: by, r: 14, hp: 100, maxHp: 100,
      armor: 0, armorLevel: 0,
      speed: botSpeed, baseSpeed: botSpeed,
      angle: Math.random() * Math.PI * 2,
      alive: true, name: 'Bot ' + (i + 1),
      weapons: [null, null, null], currentWeapon: 0,
      mag: [0, 0, 0], lastShot: 0,
      ammoInv: { '9mm': 30, 'shells': 10, '5.56': 30, '.308': 5 },
      kills: 0,
      ai: {
        state: 'wander', target: null,
        moveAngle: Math.random() * Math.PI * 2,
        stateTimer: 0, skill: 0.3 + Math.random() * 0.6,
        strafeDir: Math.random() < 0.5 ? 1 : -1, nextStrafe: 0
      },
      color: `hsl(${Math.random() * 360},60%,50%)`,
      isBot: true
    });
    // Give bots a random weapon
    const weaponKeys = Object.keys(WEAPONS);
    const wKey = weaponKeys[Math.floor(Math.random() * weaponKeys.length)];
    bots[i].weapons[0] = wKey;
    bots[i].mag[0] = WEAPONS[wKey].magSize;
  }

  // Vehicles
  const vehicleTypes = ['buggy', 'truck', 'atv'];
  const vehicles = [];
  for (let i = 0; i < 10; i++) {
    const vType = vehicleTypes[Math.floor(Math.random() * vehicleTypes.length)];
    vehicles.push({
      id: generateId(),
      type: vType,
      x: 500 + Math.random() * (MAP_SIZE - 1000),
      y: 500 + Math.random() * (MAP_SIZE - 1000),
      angle: Math.random() * Math.PI * 2,
      speed: 0, hp: vType === 'truck' ? 300 : vType === 'buggy' ? 150 : 100,
      maxHp: vType === 'truck' ? 300 : vType === 'buggy' ? 150 : 100,
      passenger: null, destroyed: false
    });
  }

  gameState = {
    buildings,
    zone,
    retreatZone,
    bots,
    vehicles,
    bullets: [],
    loot: [],
    killFeed: [],
    time: 0,
    started: false,
    startTime: Date.now()
  };
}

function generateBuildings() {
  const buildings = [];
  const count = 60;
  for (let i = 0; i < count; i++) {
    let bx, by, bw, bh, overlaps;
    let attempts = 0;
    do {
      bw = 120 + Math.floor(Math.random() * 180);
      bh = 120 + Math.floor(Math.random() * 180);
      bx = 200 + Math.random() * (MAP_SIZE - 400 - bw);
      by = 200 + Math.random() * (MAP_SIZE - 400 - bh);
      overlaps = buildings.some(b =>
        bx < b.x + b.w + 80 && bx + bw + 80 > b.x &&
        by < b.y + b.h + 80 && by + bh + 80 > b.y
      );
      attempts++;
    } while (overlaps && attempts < 50);

    if (!overlaps) {
      // Simple building with one door
      const doorWall = Math.floor(Math.random() * 4); // 0=N,1=E,2=S,3=W
      buildings.push({
        x: bx, y: by, w: bw, h: bh,
        color: `hsl(${20 + Math.random() * 30},${20 + Math.random() * 30}%,${30 + Math.random() * 20}%)`,
        doors: [{ wall: doorWall, pos: 0.5, open: false }]
      });
    }
  }
  return buildings;
}

// ─── Server tick ───
function tick() {
  if (!gameState) return;

  const now = Date.now();
  gameState.time = now - gameState.startTime;

  // Update bots AI
  updateBots();

  // Update bullets
  updateBullets();

  // Update zone
  updateZone();

  // Update vehicles
  updateVehicles();

  // Check player deaths
  checkDeaths();

  // Broadcast state to all players
  broadcastState();
}

function updateBots() {
  for (const bot of gameState.bots) {
    if (!bot.alive) continue;

    // Find nearest target (player or other bot)
    let nearestTarget = null;
    let nearestDist = Infinity;

    // Check players
    for (const [, p] of players) {
      if (!p.alive) continue;
      const d = dist(bot, p);
      if (d < nearestDist) { nearestDist = d; nearestTarget = p; }
    }
    // Check other bots
    for (const other of gameState.bots) {
      if (other === bot || !other.alive) continue;
      const d = dist(bot, other);
      if (d < nearestDist) { nearestDist = d; nearestTarget = other; }
    }

    bot.ai.stateTimer += TICK_MS;

    // State machine
    if (nearestTarget && nearestDist < 500) {
      bot.ai.state = 'fight';
      bot.ai.target = nearestTarget;
    } else if (bot.ai.stateTimer > 3000 + Math.random() * 2000) {
      bot.ai.moveAngle = Math.random() * Math.PI * 2;
      bot.ai.stateTimer = 0;
    }

    if (bot.ai.state === 'fight' && bot.ai.target) {
      const target = bot.ai.target;
      const dx = target.x - bot.x;
      const dy = target.y - bot.y;
      const targetAngle = Math.atan2(dy, dx);
      bot.angle = targetAngle;

      // Move towards target if far, strafe if close
      if (nearestDist > 200) {
        bot.x += Math.cos(targetAngle) * bot.speed;
        bot.y += Math.sin(targetAngle) * bot.speed;
      } else {
        // Strafe
        bot.x += Math.cos(targetAngle + Math.PI / 2 * bot.ai.strafeDir) * bot.speed * 0.5;
        bot.y += Math.sin(targetAngle + Math.PI / 2 * bot.ai.strafeDir) * bot.speed * 0.5;
        if (bot.ai.stateTimer > bot.ai.nextStrafe) {
          bot.ai.strafeDir *= -1;
          bot.ai.nextStrafe = bot.ai.stateTimer + 1000 + Math.random() * 1500;
        }
      }

      // Shoot if has weapon and in range
      const wKey = bot.weapons[bot.currentWeapon];
      if (wKey && nearestDist < WEAPONS[wKey].range) {
        const timeSinceShot = Date.now() - bot.lastShot;
        if (timeSinceShot > WEAPONS[wKey].fireRate / bot.ai.skill) {
          if (bot.mag[bot.currentWeapon] > 0) {
            botShoot(bot, targetAngle);
            bot.lastShot = Date.now();
            bot.mag[bot.currentWeapon]--;
          } else {
            // Reload
            bot.mag[bot.currentWeapon] = WEAPONS[wKey].magSize;
          }
        }
      }
    } else {
      // Wander
      bot.x += Math.cos(bot.ai.moveAngle) * bot.speed * 0.5;
      bot.y += Math.sin(bot.ai.moveAngle) * bot.speed * 0.5;
    }

    // Clamp to map
    bot.x = Math.max(20, Math.min(MAP_SIZE - 20, bot.x));
    bot.y = Math.max(20, Math.min(MAP_SIZE - 20, bot.y));

    // Building collision
    for (const b of gameState.buildings) {
      if (bot.x > b.x - bot.r && bot.x < b.x + b.w + bot.r &&
          bot.y > b.y - bot.r && bot.y < b.y + b.h + bot.r) {
        const dLeft = bot.x - (b.x - bot.r);
        const dRight = (b.x + b.w + bot.r) - bot.x;
        const dTop = bot.y - (b.y - bot.r);
        const dBottom = (b.y + b.h + bot.r) - bot.y;
        const minD = Math.min(dLeft, dRight, dTop, dBottom);
        if (minD === dLeft) bot.x = b.x - bot.r;
        else if (minD === dRight) bot.x = b.x + b.w + bot.r;
        else if (minD === dTop) bot.y = b.y - bot.r;
        else bot.y = b.y + b.h + bot.r;
      }
    }

    // Zone damage
    const dToCenter = dist(bot, gameState.zone);
    if (dToCenter > gameState.zone.r && gameState.zone.damage > 0) {
      bot.hp -= gameState.zone.damage * (TICK_MS / 1000);
    }
  }
}

function botShoot(bot, angle) {
  const wKey = bot.weapons[bot.currentWeapon];
  if (!wKey) return;
  const w = WEAPONS[wKey];
  const spread = w.spread * (1.5 - bot.ai.skill);
  const pellets = w.pellets || 1;

  for (let p = 0; p < pellets; p++) {
    const a = angle + (Math.random() - 0.5) * spread * 2;
    gameState.bullets.push({
      x: bot.x + Math.cos(a) * 20,
      y: bot.y + Math.sin(a) * 20,
      vx: Math.cos(a) * w.speed,
      vy: Math.sin(a) * w.speed,
      damage: w.damage,
      ownerId: bot.id,
      range: w.range,
      traveled: 0
    });
  }
}

function updateBullets() {
  for (let i = gameState.bullets.length - 1; i >= 0; i--) {
    const b = gameState.bullets[i];
    b.x += b.vx;
    b.y += b.vy;
    b.traveled += Math.sqrt(b.vx * b.vx + b.vy * b.vy);

    if (b.traveled > b.range || b.x < 0 || b.x > MAP_SIZE || b.y < 0 || b.y > MAP_SIZE) {
      gameState.bullets.splice(i, 1);
      continue;
    }

    // Hit building walls
    let hitWall = false;
    for (const bld of gameState.buildings) {
      if (b.x > bld.x && b.x < bld.x + bld.w && b.y > bld.y && b.y < bld.y + bld.h) {
        hitWall = true;
        break;
      }
    }
    if (hitWall) { gameState.bullets.splice(i, 1); continue; }

    // Hit players
    let hit = false;
    for (const [, p] of players) {
      if (!p.alive || p.id === b.ownerId) continue;
      if (Math.abs(b.x - p.x) < p.r && Math.abs(b.y - p.y) < p.r) {
        let dmg = b.damage;
        if (p.armor > 0) {
          const absorbed = dmg * (p.armorLevel * 0.15 + 0.1);
          p.armor = Math.max(0, p.armor - absorbed);
          dmg -= absorbed;
        }
        p.hp -= dmg;
        hit = true;
        // Track killer
        if (p.hp <= 0) {
          p.alive = false;
          // Find killer
          const killer = findEntityById(b.ownerId);
          if (killer) {
            killer.kills = (killer.kills || 0) + 1;
            addKillFeed(killer.name, p.name);
          }
        }
        break;
      }
    }
    if (hit) { gameState.bullets.splice(i, 1); continue; }

    // Hit bots
    for (const bot of gameState.bots) {
      if (!bot.alive || bot.id === b.ownerId) continue;
      if (Math.abs(b.x - bot.x) < bot.r && Math.abs(b.y - bot.y) < bot.r) {
        let dmg = b.damage;
        if (bot.armor > 0) {
          const absorbed = dmg * (bot.armorLevel * 0.15 + 0.1);
          bot.armor = Math.max(0, bot.armor - absorbed);
          dmg -= absorbed;
        }
        bot.hp -= dmg;
        hit = true;
        if (bot.hp <= 0) {
          bot.alive = false;
          const killer = findEntityById(b.ownerId);
          if (killer) {
            killer.kills = (killer.kills || 0) + 1;
            addKillFeed(killer.name, bot.name);
          }
        }
        break;
      }
    }
    if (hit) { gameState.bullets.splice(i, 1); continue; }

    // Hit vehicles
    for (const vh of gameState.vehicles) {
      if (vh.destroyed) continue;
      const vw = vh.type === 'truck' ? 48 : vh.type === 'buggy' ? 36 : 28;
      const vhh = vh.type === 'truck' ? 28 : vh.type === 'buggy' ? 22 : 18;
      if (Math.abs(b.x - vh.x) < vw / 2 + 5 && Math.abs(b.y - vh.y) < vhh / 2 + 5) {
        vh.hp -= b.damage;
        if (vh.hp <= 0) {
          vh.destroyed = true;
          // Eject and damage passenger
          if (vh.passenger) {
            const passenger = findEntityById(vh.passenger);
            if (passenger) {
              passenger.hp -= 30;
              passenger.inVehicle = null;
            }
            vh.passenger = null;
          }
        }
        hit = true;
        break;
      }
    }
    if (hit) { gameState.bullets.splice(i, 1); }
  }
}

function updateZone() {
  const z = gameState.zone;
  const elapsed = gameState.time;

  if (z.phase === 0 && elapsed > z.nextShrink) {
    z.phase = 1;
    z.targetR = z.r * 0.6;
    const angle = Math.random() * Math.PI * 2;
    const shift = z.r * 0.15;
    z.targetX = z.x + Math.cos(angle) * shift;
    z.targetY = z.y + Math.sin(angle) * shift;
    z.shrinkStart = elapsed;
    z.damage = 1;
    z.nextShrink = elapsed + 40000;
  } else if (z.phase > 0 && elapsed > z.nextShrink) {
    z.phase++;
    z.targetR = z.r * 0.6;
    const angle = Math.random() * Math.PI * 2;
    const shift = z.r * 0.1;
    z.targetX = z.x + Math.cos(angle) * shift;
    z.targetY = z.y + Math.sin(angle) * shift;
    z.shrinkStart = elapsed;
    z.damage = z.phase;
    z.nextShrink = elapsed + 30000;
  }

  // Smooth shrink
  if (z.r > z.targetR) {
    const t = Math.min(1, (elapsed - z.shrinkStart) / z.shrinkDuration);
    z.r = z.r + (z.targetR - z.r) * 0.01;
    z.x = z.x + (z.targetX - z.x) * 0.01;
    z.y = z.y + (z.targetY - z.y) * 0.01;
  }
}

function updateVehicles() {
  for (const vh of gameState.vehicles) {
    if (vh.destroyed) continue;
    if (vh.speed !== 0) {
      // Apply friction
      if (Math.abs(vh.speed) > 0.05) {
        vh.speed *= 0.98;
      } else {
        vh.speed = 0;
      }
      vh.x += Math.cos(vh.angle) * vh.speed;
      vh.y += Math.sin(vh.angle) * vh.speed;
      vh.x = Math.max(30, Math.min(MAP_SIZE - 30, vh.x));
      vh.y = Math.max(30, Math.min(MAP_SIZE - 30, vh.y));

      // Run over bots / players
      if (Math.abs(vh.speed) > 3) {
        const vw = vh.type === 'truck' ? 48 : vh.type === 'buggy' ? 36 : 28;
        // Hit bots
        for (const bot of gameState.bots) {
          if (!bot.alive) continue;
          if (Math.abs(vh.x - bot.x) < vw / 2 + 10 && Math.abs(vh.y - bot.y) < vw / 2 + 10) {
            bot.hp -= 50;
            if (bot.hp <= 0) {
              bot.alive = false;
              if (vh.passenger) {
                const driver = findEntityById(vh.passenger);
                if (driver) {
                  driver.kills = (driver.kills || 0) + 1;
                  addKillFeed(driver.name + ' [Vehicle]', bot.name);
                }
              }
            }
          }
        }
        // Hit players
        for (const [, p] of players) {
          if (!p.alive || p.inVehicle) continue;
          if (Math.abs(vh.x - p.x) < vw / 2 + 10 && Math.abs(vh.y - p.y) < vw / 2 + 10) {
            p.hp -= 50;
            if (p.hp <= 0) {
              p.alive = false;
              if (vh.passenger) {
                const driver = findEntityById(vh.passenger);
                if (driver) {
                  driver.kills = (driver.kills || 0) + 1;
                  addKillFeed(driver.name + ' [Vehicle]', p.name);
                }
              }
            }
          }
        }
      }
    }
  }
}

function checkDeaths() {
  // Check player deaths from zone, etc.
  for (const [, p] of players) {
    if (!p.alive) continue;
    // Zone damage
    const d = dist(p, gameState.zone);
    if (d > gameState.zone.r && gameState.zone.damage > 0) {
      p.hp -= gameState.zone.damage * (TICK_MS / 1000);
    }
    if (p.hp <= 0) {
      p.alive = false;
      addKillFeed('Zone', p.name);
    }
  }

  // Bot deaths
  for (const bot of gameState.bots) {
    if (bot.alive && bot.hp <= 0) {
      bot.alive = false;
    }
  }
}

function addKillFeed(killer, victim) {
  gameState.killFeed.push({ killer, victim, time: Date.now() });
  if (gameState.killFeed.length > 8) gameState.killFeed.shift();
}

function findEntityById(id) {
  for (const [, p] of players) {
    if (p.id === id) return p;
  }
  for (const bot of gameState.bots) {
    if (bot.id === id) return bot;
  }
  return null;
}

function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// ─── Build compact state for broadcast ───
function buildStateForPlayer(playerId) {
  const allEntities = [];

  // Add players
  for (const [, p] of players) {
    allEntities.push({
      id: p.id, x: Math.round(p.x), y: Math.round(p.y),
      angle: +(p.angle.toFixed(2)), hp: Math.round(p.hp),
      armor: Math.round(p.armor), armorLevel: p.armorLevel,
      alive: p.alive, name: p.name, kills: p.kills || 0,
      weapons: p.weapons, currentWeapon: p.currentWeapon,
      color: p.color, isBot: false,
      inVehicle: p.inVehicle || null
    });
  }

  // Add bots (only those within reasonable range or alive)
  for (const bot of gameState.bots) {
    allEntities.push({
      id: bot.id, x: Math.round(bot.x), y: Math.round(bot.y),
      angle: +(bot.angle.toFixed(2)), hp: Math.round(bot.hp),
      armor: Math.round(bot.armor), armorLevel: bot.armorLevel,
      alive: bot.alive, name: bot.name, kills: bot.kills || 0,
      weapons: bot.weapons, currentWeapon: bot.currentWeapon,
      color: bot.color, isBot: true
    });
  }

  // Compact bullets (just positions for rendering)
  const bulletData = gameState.bullets.map(b => ({
    x: Math.round(b.x), y: Math.round(b.y),
    vx: +(b.vx.toFixed(1)), vy: +(b.vy.toFixed(1))
  }));

  // Vehicles
  const vehicleData = gameState.vehicles.map(v => ({
    id: v.id, type: v.type,
    x: Math.round(v.x), y: Math.round(v.y),
    angle: +(v.angle.toFixed(2)),
    speed: +(v.speed.toFixed(1)),
    hp: Math.round(v.hp), maxHp: v.maxHp,
    passenger: v.passenger, destroyed: v.destroyed
  }));

  return {
    type: 'state',
    you: playerId,
    entities: allEntities,
    bullets: bulletData,
    vehicles: vehicleData,
    zone: {
      x: Math.round(gameState.zone.x), y: Math.round(gameState.zone.y),
      r: Math.round(gameState.zone.r), damage: gameState.zone.damage
    },
    retreatZone: {
      x: Math.round(gameState.retreatZone.x),
      y: Math.round(gameState.retreatZone.y),
      r: gameState.retreatZone.r, active: gameState.retreatZone.active
    },
    killFeed: gameState.killFeed.slice(-5),
    alive: countAlive(),
    time: gameState.time
  };
}

function countAlive() {
  let c = 0;
  for (const [, p] of players) { if (p.alive) c++; }
  for (const bot of gameState.bots) { if (bot.alive) c++; }
  return c;
}

function broadcastState() {
  for (const [ws, p] of players) {
    if (ws.readyState !== 1) continue; // OPEN
    try {
      ws.send(JSON.stringify(buildStateForPlayer(p.id)));
    } catch (e) { /* ignore send errors */ }
  }
}

// ─── Handle player input ───
function handleInput(playerData, msg) {
  if (!playerData.alive) return;

  if (msg.type === 'input') {
    const keys = msg.keys || {};
    const angle = msg.angle || 0;
    const shooting = msg.shooting || false;

    playerData.angle = angle;

    // Check if in vehicle
    if (playerData.inVehicle) {
      const vh = gameState.vehicles.find(v => v.id === playerData.inVehicle);
      if (vh && !vh.destroyed) {
        const VEHICLE_STATS = {
          buggy: { maxSpeed: 8, accel: 0.15, turnSpeed: 0.04, brakeForce: 0.08 },
          truck: { maxSpeed: 5, accel: 0.08, turnSpeed: 0.025, brakeForce: 0.06 },
          atv: { maxSpeed: 10, accel: 0.2, turnSpeed: 0.055, brakeForce: 0.1 }
        };
        const vs = VEHICLE_STATS[vh.type];

        if (keys.w) vh.speed = Math.min(vs.maxSpeed, vh.speed + vs.accel);
        if (keys.s) {
          if (vh.speed > 0.2) vh.speed = Math.max(0, vh.speed - vs.brakeForce * 2);
          else vh.speed = Math.max(-vs.maxSpeed * 0.4, vh.speed - vs.accel * 0.5);
        }
        if (Math.abs(vh.speed) > 0.3) {
          if (keys.a) vh.angle -= vs.turnSpeed * (vh.speed > 0 ? 1 : -1);
          if (keys.d) vh.angle += vs.turnSpeed * (vh.speed > 0 ? 1 : -1);
        }

        playerData.x = vh.x;
        playerData.y = vh.y;
        playerData.angle = vh.angle;

        // E = exit
        if (keys.e) {
          const now = Date.now();
          if (!playerData._lastVehicleToggle || now - playerData._lastVehicleToggle > 500) {
            playerData._lastVehicleToggle = now;
            playerData.inVehicle = null;
            vh.passenger = null;
            playerData.x = vh.x + Math.cos(vh.angle + Math.PI / 2) * 40;
            playerData.y = vh.y + Math.sin(vh.angle + Math.PI / 2) * 40;
          }
        }
      } else {
        // Vehicle destroyed or gone
        playerData.inVehicle = null;
      }
    } else {
      // On foot movement
      let dx = 0, dy = 0;
      if (keys.w) dy -= 1;
      if (keys.s) dy += 1;
      if (keys.a) dx -= 1;
      if (keys.d) dx += 1;
      if (dx || dy) {
        const len = Math.sqrt(dx * dx + dy * dy);
        playerData.x += (dx / len) * playerData.speed;
        playerData.y += (dy / len) * playerData.speed;
      }

      // Clamp to map
      playerData.x = Math.max(20, Math.min(MAP_SIZE - 20, playerData.x));
      playerData.y = Math.max(20, Math.min(MAP_SIZE - 20, playerData.y));

      // Building collision
      for (const b of gameState.buildings) {
        if (playerData.x > b.x - playerData.r && playerData.x < b.x + b.w + playerData.r &&
            playerData.y > b.y - playerData.r && playerData.y < b.y + b.h + playerData.r) {
          const dLeft = playerData.x - (b.x - playerData.r);
          const dRight = (b.x + b.w + playerData.r) - playerData.x;
          const dTop = playerData.y - (b.y - playerData.r);
          const dBottom = (b.y + b.h + playerData.r) - playerData.y;
          const minD = Math.min(dLeft, dRight, dTop, dBottom);
          if (minD === dLeft) playerData.x = b.x - playerData.r;
          else if (minD === dRight) playerData.x = b.x + b.w + playerData.r;
          else if (minD === dTop) playerData.y = b.y - playerData.r;
          else playerData.y = b.y + b.h + playerData.r;
        }
      }

      // Enter vehicle
      if (keys.e) {
        const now = Date.now();
        if (!playerData._lastVehicleToggle || now - playerData._lastVehicleToggle > 500) {
          for (const vh of gameState.vehicles) {
            if (vh.destroyed || vh.passenger) continue;
            if (dist(playerData, vh) < 50) {
              playerData._lastVehicleToggle = now;
              playerData.inVehicle = vh.id;
              vh.passenger = playerData.id;
              playerData.x = vh.x;
              playerData.y = vh.y;
              break;
            }
          }
        }
      }

      // Shooting
      if (shooting) {
        const wKey = playerData.weapons[playerData.currentWeapon];
        if (wKey) {
          const now = Date.now();
          if (now - playerData.lastShot > WEAPONS[wKey].fireRate) {
            if (playerData.mag[playerData.currentWeapon] > 0) {
              playerData.lastShot = now;
              playerData.mag[playerData.currentWeapon]--;
              const w = WEAPONS[wKey];
              const pellets = w.pellets || 1;
              for (let p = 0; p < pellets; p++) {
                const a = angle + (Math.random() - 0.5) * w.spread * 2;
                gameState.bullets.push({
                  x: playerData.x + Math.cos(a) * 20,
                  y: playerData.y + Math.sin(a) * 20,
                  vx: Math.cos(a) * w.speed,
                  vy: Math.sin(a) * w.speed,
                  damage: w.damage,
                  ownerId: playerData.id,
                  range: w.range,
                  traveled: 0
                });
              }
            }
          }
        }
      }
    }
  }

  if (msg.type === 'reload') {
    const wKey = playerData.weapons[playerData.currentWeapon];
    if (wKey) {
      playerData.mag[playerData.currentWeapon] = WEAPONS[wKey].magSize;
    }
  }

  if (msg.type === 'switchWeapon') {
    if (msg.slot >= 0 && msg.slot <= 2) {
      playerData.currentWeapon = msg.slot;
    }
  }
}

// ─── WebSocket connection handling ───
wss.on('connection', (ws) => {
  if (players.size >= MAX_PLAYERS) {
    ws.send(JSON.stringify({ type: 'error', msg: 'Server full' }));
    ws.close();
    return;
  }

  // Initialize game if first player
  if (!gameState) {
    initGame();
    tickTimer = setInterval(tick, TICK_MS);
    console.log('Game started!');
  }

  const spawnX = 500 + Math.random() * (MAP_SIZE - 1000);
  const spawnY = 500 + Math.random() * (MAP_SIZE - 1000);

  const playerData = {
    id: generateId(),
    x: spawnX, y: spawnY, r: 14,
    hp: 100, maxHp: 100,
    armor: 0, maxArmor: 100, armorLevel: 0,
    speed: 3.2, baseSpeed: 3.2,
    angle: 0, alive: true,
    name: 'Player',
    weapons: ['pistol', null, null],
    currentWeapon: 0,
    mag: [12, 0, 0],
    ammoInv: { '9mm': 30, 'shells': 0, '5.56': 0, '.308': 0 },
    lastShot: 0,
    kills: 0,
    color: `hsl(${Math.random() * 360},70%,55%)`,
    inVehicle: null,
    _lastVehicleToggle: 0
  };

  players.set(ws, playerData);
  console.log(`Player ${playerData.id} (${playerData.name}) joined. ${players.size} players online.`);

  // Send initial data (buildings, etc. that don't change)
  ws.send(JSON.stringify({
    type: 'init',
    playerId: playerData.id,
    mapSize: MAP_SIZE,
    buildings: gameState.buildings,
    retreatZone: gameState.retreatZone
  }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'setName') {
        playerData.name = (msg.name || 'Player').substring(0, 16);
        console.log(`Player ${playerData.id} set name: ${playerData.name}`);
        return;
      }
      handleInput(playerData, msg);
    } catch (e) { /* ignore bad messages */ }
  });

  ws.on('close', () => {
    const p = players.get(ws);
    if (p) {
      console.log(`Player ${p.id} (${p.name}) disconnected.`);
      // Release vehicle
      if (p.inVehicle) {
        const vh = gameState.vehicles.find(v => v.id === p.inVehicle);
        if (vh) vh.passenger = null;
      }
      players.delete(ws);
    }

    // If no players left, reset game after a delay
    if (players.size === 0) {
      console.log('No players left. Resetting game in 10 seconds...');
      setTimeout(() => {
        if (players.size === 0) {
          clearInterval(tickTimer);
          tickTimer = null;
          gameState = null;
          nextPlayerId = 1;
          console.log('Game reset.');
        }
      }, 10000);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Battle Royale server running at http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser to play!`);
});
