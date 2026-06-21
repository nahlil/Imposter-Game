const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const { v4: uuid } = require('uuid');
const path = require('path');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ─── GAME DATA ───────────────────────────────────────────────────────────────
const TOPICS = {
  animals:    { icon:'🐾', words:['dog','cat','elephant','parrot','shark','penguin','giraffe','wolf','lion','dolphin','zebra','crocodile'] },
  fruits:     { icon:'🍉', words:['mango','apple','watermelon','grape','pineapple','banana','kiwi','papaya','durian','guava','lychee','dragonfruit'] },
  countries:  { icon:'🌍', words:['Japan','Brazil','Ethiopia','Canada','Australia','Egypt','Norway','Mexico','Nigeria','Thailand','Argentina','Sweden'] },
  sports:     { icon:'⚽', words:['soccer','tennis','swimming','boxing','basketball','cycling','rugby','golf','volleyball','archery','fencing','sumo'] },
  movies:     { icon:'🎬', words:['Titanic','Inception','Parasite','Avatar','Joker','Dune','Interstellar','Frozen','Oppenheimer','Alien','Gladiator','Matrix'] },
  foods:      { icon:'🍕', words:['pizza','sushi','tacos','pasta','burger','injera','ramen','croissant','baklava','jollof','biryani','pho'] },
  jobs:       { icon:'💼', words:['teacher','doctor','pilot','chef','lawyer','engineer','farmer','musician','astronaut','spy','firefighter','surgeon'] },
  colors:     { icon:'🎨', words:['crimson','turquoise','violet','amber','ivory','navy','scarlet','olive','magenta','cobalt','teal','vermillion'] },
  vehicles:   { icon:'🚀', words:['motorcycle','submarine','helicopter','tractor','speedboat','tram','rocket','skateboard','zeppelin','hovercraft','gondola','snowmobile'] },
  superheroes:{ icon:'🦸', words:['Spider-Man','Batman','Wonder Woman','Thor','Black Panther','Hulk','Flash','Superman','Deadpool','Aquaman','Iron Man','Wolverine'] },
  music:      { icon:'🎵', words:['guitar','piano','drums','violin','trumpet','saxophone','flute','cello','ukulele','harp','banjo','accordion'] },
  nature:     { icon:'🌿', words:['volcano','glacier','rainforest','desert','coral reef','waterfall','canyon','tundra','savanna','mangrove','geyser','fjord'] },
  girls:      { icon:'👧', words:['Saron 😍','Bitaniya (mia)','Leah (Shele one)','Melkam (Ahh)','Emrachel 😘','Maleda 🤢','Amal 🍑','Awnan 🍒','FeVen 👩🏿','FeBen (KSI)'] },
};

// ─── ROOMS ───────────────────────────────────────────────────────────────────
const rooms = {}; // roomCode -> room
const clients = {}; // ws -> { roomCode, playerId }

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function impostorCount(n) { return n <= 4 ? 1 : n <= 8 ? 2 : 3; }

function broadcast(room, msg, excludeId = null) {
  room.players.forEach(p => {
    if (p.id !== excludeId && p.ws && p.ws.readyState === 1) {
      p.ws.send(JSON.stringify(msg));
    }
  });
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function roomPublicState(room) {
  return {
    code: room.code,
    phase: room.phase,
    host: room.host,
    topic: room.topic,
    totalRounds: room.totalRounds,
    currentRound: room.currentRound,
    timerDuration: room.timerDuration,
    timerLeft: room.timerLeft,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      connected: p.connected,
      voted: p.voted,
      eliminated: p.eliminated,
    })),
    votes: room.phase === 'verdict' ? room.votes : {},
    crewWins: room.crewWins,
    impWins: room.impWins,
    verdict: room.verdict || null,
    theWord: room.phase === 'verdict' || room.phase === 'scoreboard' ? room.theWord : undefined,
  };
}

function startTimerTick(room) {
  if (room.timerInterval) clearInterval(room.timerInterval);
  if (!room.timerDuration) return;
  room.timerLeft = room.timerDuration;
  room.timerPaused = false;
  room.timerInterval = setInterval(() => {
    if (room.timerPaused) return;
    room.timerLeft--;
    broadcast(room, { type: 'timer', timerLeft: room.timerLeft });
    if (room.timerLeft <= 0) {
      clearInterval(room.timerInterval);
      startVoting(room);
    }
  }, 1000);
}

function stopTimer(room) {
  if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
}

function assignRoles(room) {
  const n = room.players.length;
  const numImp = impostorCount(n);
  const impIdxs = new Set(shuffle([...Array(n).keys()]).slice(0, numImp));
  const topicData = TOPICS[room.topic];
  const word = topicData.words[Math.floor(Math.random() * topicData.words.length)];
  room.theWord = word;
  room.impostors = [];
  room.players.forEach((p, i) => {
    p.isImpostor = impIdxs.has(i);
    p.role = p.isImpostor ? 'impostor' : 'crewmate';
    p.voted = false;
    p.eliminated = false;
    if (p.isImpostor) room.impostors.push(p.id);
  });
}

function startVoting(room) {
  stopTimer(room);
  room.phase = 'voting';
  room.votes = {};
  room.players.forEach(p => { p.voted = false; });
  broadcast(room, { type: 'phase', phase: 'voting', state: roomPublicState(room) });
}

function resolveVotes(room) {
  const tally = {};
  room.players.forEach(p => { tally[p.id] = 0; });
  Object.values(room.votes).forEach(v => { if (v && tally[v] !== undefined) tally[v]++; });
  const maxV = Math.max(0, ...Object.values(tally));
  const candidates = Object.keys(tally).filter(k => tally[k] === maxV && maxV > 0);
  const eliminatedId = candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : null;
  const eliminatedPlayer = eliminatedId ? room.players.find(p => p.id === eliminatedId) : null;
  const caughtImpostor = eliminatedPlayer && eliminatedPlayer.isImpostor;

  // scoring
  if (caughtImpostor) {
    room.crewWins++;
    room.players.forEach(p => { if (!p.isImpostor) p.score += 3; });
    room.verdict = { result: 'crew_win', eliminatedId, caughtImpostor: true };
  } else {
    room.impWins++;
    room.impostors.forEach(id => {
      const p = room.players.find(x => x.id === id);
      if (p) p.score += 4;
    });
    room.verdict = { result: 'imp_win', eliminatedId, caughtImpostor: false };
  }

  room.phase = 'verdict';
  broadcast(room, {
    type: 'phase', phase: 'verdict',
    state: roomPublicState(room),
    theWord: room.theWord,
  });
}

// ─── WS HANDLER ──────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type } = msg;

    // CREATE ROOM
    if (type === 'create') {
      let code = genCode();
      while (rooms[code]) code = genCode();
      const playerId = uuid();
      const room = {
        code, host: playerId,
        phase: 'lobby',
        topic: 'animals',
        totalRounds: 3, currentRound: 1,
        timerDuration: 60, timerLeft: 60,
        timerInterval: null, timerPaused: false,
        players: [], votes: {}, impostors: [],
        crewWins: 0, impWins: 0,
        verdict: null, theWord: '',
      };
      const player = {
        id: playerId, ws,
        name: msg.name || 'Host',
        avatar: msg.avatar || '🧑',
        score: 0, connected: true,
        isImpostor: false, role: null,
        voted: false, eliminated: false,
      };
      room.players.push(player);
      rooms[code] = room;
      clients[ws] = { roomCode: code, playerId };
      send(ws, { type: 'joined', playerId, roomCode: code, state: roomPublicState(room), topics: Object.entries(TOPICS).map(([k,v])=>({id:k,label:k,icon:v.icon})) });
      return;
    }

    // JOIN ROOM
    if (type === 'join') {
      const room = rooms[msg.code];
      if (!room) { send(ws, { type: 'error', msg: 'Room not found' }); return; }
      if (room.phase !== 'lobby') { send(ws, { type: 'error', msg: 'Game already started' }); return; }
      if (room.players.length >= 15) { send(ws, { type: 'error', msg: 'Room is full (max 15)' }); return; }
      const playerId = uuid();
      const player = {
        id: playerId, ws,
        name: msg.name || `Player ${room.players.length + 1}`,
        avatar: msg.avatar || '🧑',
        score: 0, connected: true,
        isImpostor: false, role: null,
        voted: false, eliminated: false,
      };
      room.players.push(player);
      clients[ws] = { roomCode: msg.code, playerId };
      send(ws, { type: 'joined', playerId, roomCode: msg.code, state: roomPublicState(room), topics: Object.entries(TOPICS).map(([k,v])=>({id:k,label:k,icon:v.icon})) });
      broadcast(room, { type: 'playerJoined', state: roomPublicState(room) }, playerId);
      return;
    }

    // All other messages need a room
    const ctx = clients[ws];
    if (!ctx) return;
    const room = rooms[ctx.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === ctx.playerId);
    if (!player) return;
    const isHost = room.host === ctx.playerId;

    if (type === 'settings' && isHost) {
      if (msg.topic !== undefined) room.topic = msg.topic;
      if (msg.totalRounds !== undefined) room.totalRounds = msg.totalRounds;
      if (msg.timerDuration !== undefined) room.timerDuration = msg.timerDuration;
      broadcast(room, { type: 'settingsChanged', state: roomPublicState(room) });
    }

    if (type === 'startGame' && isHost) {
      if (room.players.length < 3) { send(ws, { type: 'error', msg: 'Need at least 3 players' }); return; }
      room.phase = 'playing';
      room.currentRound = 1;
      room.crewWins = 0; room.impWins = 0;
      room.players.forEach(p => { p.score = 0; });
      assignRoles(room);
      // Send each player their private role
      room.players.forEach(p => {
        send(p.ws, {
          type: 'roleAssigned',
          role: p.role,
          word: p.isImpostor ? null : room.theWord,
          topic: room.topic,
          state: roomPublicState(room),
        });
      });
      broadcast(room, { type: 'phase', phase: 'discussion', state: roomPublicState(room) });
      room.phase = 'discussion';
      startTimerTick(room);
    }

    if (type === 'pauseTimer' && isHost) {
      room.timerPaused = !room.timerPaused;
      broadcast(room, { type: 'timerPaused', paused: room.timerPaused });
    }

    if (type === 'skipTimer' && isHost) {
      stopTimer(room);
      startVoting(room);
    }

    if (type === 'vote') {
      if (room.phase !== 'voting') return;
      if (player.voted) return;
      player.voted = true;
      room.votes[player.id] = msg.targetId || null;
      broadcast(room, { type: 'voted', state: roomPublicState(room) });
      const allVoted = room.players.every(p => p.voted);
      if (allVoted) resolveVotes(room);
    }

    if (type === 'nextRound' && isHost) {
      if (room.currentRound >= room.totalRounds) {
        room.phase = 'scoreboard';
        broadcast(room, { type: 'phase', phase: 'scoreboard', state: roomPublicState(room), theWord: room.theWord });
        return;
      }
      room.currentRound++;
      room.phase = 'playing';
      assignRoles(room);
      room.players.forEach(p => {
        send(p.ws, {
          type: 'roleAssigned',
          role: p.role,
          word: p.isImpostor ? null : room.theWord,
          topic: room.topic,
          state: roomPublicState(room),
        });
      });
      room.phase = 'discussion';
      broadcast(room, { type: 'phase', phase: 'discussion', state: roomPublicState(room) });
      startTimerTick(room);
    }

    if (type === 'endGame' && isHost) {
      room.phase = 'scoreboard';
      broadcast(room, { type: 'phase', phase: 'scoreboard', state: roomPublicState(room), theWord: room.theWord });
    }

    if (type === 'restartGame' && isHost) {
      stopTimer(room);
      room.phase = 'lobby';
      room.currentRound = 1;
      room.crewWins = 0; room.impWins = 0;
      room.votes = {}; room.verdict = null; room.theWord = '';
      room.players.forEach(p => { p.score = 0; p.isImpostor = false; p.role = null; p.voted = false; });
      broadcast(room, { type: 'phase', phase: 'lobby', state: roomPublicState(room) });
    }
  });

  ws.on('close', () => {
    const ctx = clients[ws];
    if (!ctx) return;
    const room = rooms[ctx.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === ctx.playerId);
    if (player) player.connected = false;
    broadcast(room, { type: 'playerLeft', state: roomPublicState(room) });
    delete clients[ws];
    // Clean up empty rooms after 10 min
    const hasConnected = room.players.some(p => p.connected);
    if (!hasConnected) setTimeout(() => { if (rooms[ctx.roomCode]) delete rooms[ctx.roomCode]; }, 600000);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🕵️  Impostor Game running on http://localhost:${PORT}`));
