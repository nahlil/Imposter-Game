const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const { v4: uuid } = require('uuid');
const path = require('path');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

const TOPICS = {
  animals:    { icon:'🐾', words:['dog','cat','elephant','sheep','shark','penguin','giraffe','wolf','lion','dolphin','zebra','crocodile'] },
  fruits:     { icon:'🍉', words:['mango','apple','watermelon','grape','pineapple','banana','kiwi','papaya','durian','guava','lychee','dragonfruit'] },
  countries:  { icon:'🌍', words:['Japan','Brazil','Ethiopia','Canada','Australia','Egypt','Norway','Mexico','Nigeria','Thailand','Argentina','Sweden'] },
  sports:     { icon:'⚽', words:['soccer','tennis','swimming','boxing','basketball','cycling','rugby','golf','volleyball','archery','fencing','sumo'] },
  movies:     { icon:'🎬', words:['Titanic','Zootopia','Minions','Avatar','Joker','Dune','Interstellar','Frozen','Spider-Man','Alien','Gladiator','Matrix'] },
  foods:      { icon:'🍕', words:['pizza','sushi','tacos','pasta','burger','injera','ramen','Firfir','Enkulal','Ertb','biryani','Ktfo'] },
  jobs:       { icon:'💼', words:['teacher','doctor','pilot','chef','lawyer','engineer','farmer','musician','astronaut','spy','firefighter','surgeon'] },
  colors:     { icon:'🎨', words:['crimson','turquoise','violet','amber','ivory','navy','scarlet','olive','magenta','cobalt','teal','vermillion'] },
  vehicles:   { icon:'🚀', words:['motorcycle','submarine','helicopter','tractor','speedboat','tram','rocket','skateboard','zeppelin','hovercraft','gondola','snowmobile'] },
  superheroes:{ icon:'🦸', words:['Spider-Man','Batman','Wonder Woman','Thor','Black Panther','Hulk','Flash','Superman','Deadpool','Aquaman','Iron Man','Wolverine'] },
  music:      { icon:'🎵', words:['guitar','piano','drums','violin','trumpet','saxophone','flute','cello','ukulele','harp','banjo','accordion'] },
  nature:     { icon:'🌿', words:['volcano','glacier','rainforest','desert','coral reef','waterfall','canyon','tundra','savanna','mangrove','geyser','fjord'] },
  girls:      { icon:'👧', words:['Saron 😍','Bitaniya (mia)','Leah (Shele one)','Melkam (Ahh)','Emrachel 😘','Maleda 🤢','Amal 🍑','Awnan 🍒','FeVen 👩🏿','FeBen (KSI)'] },
};

const rooms = {};
const clients = new Map(); // ws -> { roomCode, playerId }

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

function safeSend(ws, msg) {
  try {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  } catch(e) {}
}

function broadcast(room, msg, excludeId = null) {
  room.players.forEach(p => {
    if (p.id !== excludeId) safeSend(p.ws, msg);
  });
}

function broadcastAll(room, msg) {
  room.players.forEach(p => safeSend(p.ws, msg));
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
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      connected: p.connected,
      voted: p.voted,
      ready: p.readyForDiscussion || false,
    })),
    votes: room.phase === 'verdict' ? room.votes : {},
    crewWins: room.crewWins,
    impWins: room.impWins,
    verdict: room.verdict || null,
    theWord: (room.phase === 'verdict' || room.phase === 'scoreboard') ? room.theWord : undefined,
  };
}

function stopTimer(room) {
  if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
}

function startTimerTick(room) {
  stopTimer(room);
  if (!room.timerDuration) return;
  room.timerLeft = room.timerDuration;
  room.timerPaused = false;
  room.timerInterval = setInterval(() => {
    if (room.timerPaused) return;
    room.timerLeft--;
    broadcastAll(room, { type: 'timer', timerLeft: room.timerLeft });
    if (room.timerLeft <= 0) {
      stopTimer(room);
      startVoting(room);
    }
  }, 1000);
}

function assignRoles(room) {
  const n = room.players.length;
  const numImp = impostorCount(n);
  const impIdxs = new Set(shuffle([...Array(n).keys()]).slice(0, numImp));
  const topicData = TOPICS[room.topic] || TOPICS['animals'];
  const word = topicData.words[Math.floor(Math.random() * topicData.words.length)];
  room.theWord = word;
  room.impostors = [];
  room.players.forEach((p, i) => {
    p.isImpostor = impIdxs.has(i);
    p.role = p.isImpostor ? 'impostor' : 'crewmate';
    p.voted = false;
    p.readyForDiscussion = false;
    if (p.isImpostor) room.impostors.push(p.id);
  });
}

function startVoting(room) {
  stopTimer(room);
  room.phase = 'voting';
  room.votes = {};
  room.players.forEach(p => { p.voted = false; });
  broadcastAll(room, { type: 'phase', phase: 'voting', state: roomPublicState(room) });
}

function resolveVotes(room) {
  const tally = {};
  room.players.forEach(p => { tally[p.id] = 0; });
  Object.values(room.votes).forEach(v => { if (v && tally[v] !== undefined) tally[v]++; });
  const maxV = Math.max(0, ...Object.values(tally));
  const candidates = Object.keys(tally).filter(k => tally[k] === maxV && maxV > 0);
  const eliminatedId = candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : null;
  const eliminatedPlayer = eliminatedId ? room.players.find(p => p.id === eliminatedId) : null;
  const caughtImpostor = !!(eliminatedPlayer && eliminatedPlayer.isImpostor);

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
  broadcastAll(room, { type: 'phase', phase: 'verdict', state: roomPublicState(room), theWord: room.theWord });
}

function doNextRound(room) {
  room.currentRound++;
  room.phase = 'roles';
  assignRoles(room);
  room.players.forEach(p => {
    safeSend(p.ws, {
      type: 'roleAssigned',
      role: p.role,
      word: p.isImpostor ? null : room.theWord,
      topic: room.topic,
      state: roomPublicState(room),
    });
  });
}

wss.on('connection', ws => {
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type } = msg;

    // ── CREATE ROOM ──
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
      const player = { id: playerId, ws, name: msg.name || 'Host', avatar: msg.avatar || '🧑', score: 0, connected: true, isImpostor: false, role: null, voted: false, readyForDiscussion: false };
      room.players.push(player);
      rooms[code] = room;
      clients.set(ws, { roomCode: code, playerId });
      const topicList = Object.entries(TOPICS).map(([k,v]) => ({ id:k, label:k, icon:v.icon }));
      safeSend(ws, { type: 'joined', playerId, roomCode: code, state: roomPublicState(room), topics: topicList });
      return;
    }

    // ── JOIN ROOM ──
    if (type === 'join') {
      const code = (msg.code || '').trim().toUpperCase();
      const room = rooms[code];
      if (!room) { safeSend(ws, { type: 'error', msg: 'Room not found. Check the code!' }); return; }
      if (room.phase !== 'lobby') { safeSend(ws, { type: 'error', msg: 'Game already started!' }); return; }
      if (room.players.length >= 15) { safeSend(ws, { type: 'error', msg: 'Room is full (max 15)' }); return; }
      const playerId = uuid();
      const player = { id: playerId, ws, name: msg.name || `Player ${room.players.length + 1}`, avatar: msg.avatar || '🧑', score: 0, connected: true, isImpostor: false, role: null, voted: false, readyForDiscussion: false };
      room.players.push(player);
      clients.set(ws, { roomCode: code, playerId });
      const topicList = Object.entries(TOPICS).map(([k,v]) => ({ id:k, label:k, icon:v.icon }));
      safeSend(ws, { type: 'joined', playerId, roomCode: code, state: roomPublicState(room), topics: topicList });
      broadcast(room, { type: 'playerJoined', state: roomPublicState(room) }, playerId);
      return;
    }

    // ── AUTHENTICATED MESSAGES ──
    const ctx = clients.get(ws);
    if (!ctx) return;
    const room = rooms[ctx.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === ctx.playerId);
    if (!player) return;
    const isHost = room.host === ctx.playerId;

    if (type === 'settings' && isHost && room.phase === 'lobby') {
      if (msg.topic !== undefined) room.topic = msg.topic;
      if (msg.totalRounds !== undefined) room.totalRounds = Number(msg.totalRounds);
      if (msg.timerDuration !== undefined) room.timerDuration = Number(msg.timerDuration);
      broadcastAll(room, { type: 'settingsChanged', state: roomPublicState(room) });
    }

    if (type === 'startGame' && isHost) {
      if (room.phase !== 'lobby') return;
      if (room.players.length < 3) { safeSend(ws, { type: 'error', msg: 'Need at least 3 players to start!' }); return; }
      room.phase = 'roles';
      room.currentRound = 1;
      room.crewWins = 0; room.impWins = 0;
      room.players.forEach(p => { p.score = 0; });
      assignRoles(room);
      room.players.forEach(p => {
        safeSend(p.ws, {
          type: 'roleAssigned',
          role: p.role,
          word: p.isImpostor ? null : room.theWord,
          topic: room.topic,
          state: roomPublicState(room),
        });
      });
    }

    // Player taps "I'm ready" after seeing their role
    if (type === 'readyForDiscussion') {
      if (room.phase !== 'roles') return;
      player.readyForDiscussion = true;
      const readyCount = room.players.filter(p => p.readyForDiscussion).length;
      const total = room.players.length;
      broadcastAll(room, { type: 'waitingReady', readyCount, total, state: roomPublicState(room) });
      if (readyCount === total) {
        room.phase = 'discussion';
        broadcastAll(room, { type: 'phase', phase: 'discussion', state: roomPublicState(room) });
        startTimerTick(room);
      }
    }

    if (type === 'pauseTimer' && isHost) {
      room.timerPaused = !room.timerPaused;
      broadcastAll(room, { type: 'timerPaused', paused: room.timerPaused });
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
      broadcastAll(room, { type: 'voted', state: roomPublicState(room) });
      if (room.players.every(p => p.voted)) resolveVotes(room);
    }

    if (type === 'nextRound' && isHost) {
      if (room.phase !== 'verdict') return;
      if (room.currentRound >= room.totalRounds) {
        room.phase = 'scoreboard';
        broadcastAll(room, { type: 'phase', phase: 'scoreboard', state: roomPublicState(room), theWord: room.theWord });
        return;
      }
      doNextRound(room);
    }

    if (type === 'endGame' && isHost) {
      room.phase = 'scoreboard';
      broadcastAll(room, { type: 'phase', phase: 'scoreboard', state: roomPublicState(room), theWord: room.theWord });
    }

    if (type === 'restartGame' && isHost) {
      stopTimer(room);
      room.phase = 'lobby';
      room.currentRound = 1;
      room.crewWins = 0; room.impWins = 0;
      room.votes = {}; room.verdict = null; room.theWord = '';
      room.players.forEach(p => { p.score = 0; p.isImpostor = false; p.role = null; p.voted = false; p.readyForDiscussion = false; });
      broadcastAll(room, { type: 'phase', phase: 'lobby', state: roomPublicState(room) });
    }
  });

  ws.on('close', () => {
    const ctx = clients.get(ws);
    if (!ctx) return;
    clients.delete(ws);
    const room = rooms[ctx.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === ctx.playerId);
    if (player) player.connected = false;
    broadcast(room, { type: 'playerLeft', state: roomPublicState(room) });
    const hasConnected = room.players.some(p => p.connected);
    if (!hasConnected) setTimeout(() => { delete rooms[ctx.roomCode]; }, 600000);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🕵️  Impostor Game running on port ${PORT}`));
