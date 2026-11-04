import { STRINGS, MAX_FRET, buildNotePool, describeMidi, describeFrequency } from "./notes.js";
import { detectPitch, runPitchSelfTest } from "./pitch.js";

const TILE_H = 78;
const CENTS_WINDOW = 40;
const BEST_KEY = "guitar-tiles-best";
const START_LIVES = 5;

const pool = buildNotePool();
const byMidi = new Map(pool.map((note) => [note.midi, note]));

const canvas = document.querySelector("#stage");
const ctx = canvas.getContext("2d");
const overlay = document.querySelector("#overlay");
const menuCard = document.querySelector("#menu");
const gameoverCard = document.querySelector("#gameover");
const startButton = document.querySelector("#start");
const againButton = document.querySelector("#again");
const micError = document.querySelector("#mic-error");
const fileWarn = document.querySelector("#file-warn");
const scoreEl = document.querySelector("#score");
const streakEl = document.querySelector("#streak");
const livesEl = document.querySelector("#lives");
const hud = document.querySelector("#hud");
const heardNote = document.querySelector("#heard-note");
const heardDetail = document.querySelector("#heard-detail");
const meterFill = document.querySelector("#meter-fill");
const gateInput = document.querySelector("#gate");
const gateMark = document.querySelector("#gate-mark");
const menuBest = document.querySelector("#menu-best");
const finalScore = document.querySelector("#final-score");
const fretboard = document.querySelector("#fretboard");

const cells = [];
let audioCtx = null;
let analyser = null;
let mediaStream = null;
let timeBuffer = null;
let gate = Number(gateInput.value);

let mode = "menu";
let countdown = 0;
let score = 0;
let streak = 0;
let lives = START_LIVES;
let clears = 0;
let tiles = [];
let particles = [];
let floaters = [];
let bag = [];
let spawnIn = 0;
let armed = true;
let quietFrames = 0;
let recent = [];
let detection = null;
let lastListen = 0;
let lastFrame = performance.now();
let forced = { midi: 0, frames: 0 };
let pointer = { width: 1, height: 1, floor: 1, lanes: 4, laneW: 1 };

const pitchFailures = runPitchSelfTest();
if (pitchFailures.length) {
  console.error("Pitch self-test failures", pitchFailures);
}

function bestScore() {
  return Number(localStorage.getItem(BEST_KEY) || 0);
}

function rememberScore() {
  if (score > bestScore()) localStorage.setItem(BEST_KEY, String(score));
}

function renderBest() {
  const best = bestScore();
  menuBest.textContent = best > 0 ? `Best score ${best}` : "No saved score yet";
}

function renderFretboard() {
  const numbers = document.createElement("div");
  numbers.className = "corner";
  fretboard.append(numbers);
  const open = document.createElement("div");
  open.className = "fret-num";
  open.textContent = "open";
  fretboard.append(open);
  for (let fret = 1; fret <= MAX_FRET; fret++) {
    const label = document.createElement("div");
    label.className = "fret-num";
    label.textContent = String(fret);
    fretboard.append(label);
  }

  for (const string of STRINGS) {
    const name = document.createElement("div");
    name.className = "string-name";
    name.textContent = string.label;
    fretboard.append(name);
    for (let fret = 0; fret <= MAX_FRET; fret++) {
      const cell = document.createElement("div");
      cell.className = fret === 0 ? "cell nut" : "cell";
      cell.dataset.midi = String(string.openMidi + fret);
      const dot = document.createElement("span");
      dot.className = "dot";
      cell.append(dot);
      fretboard.append(cell);
      cells.push(cell);
    }
  }
}

function paintFretboard() {
  const heard = detection && detection.inRange ? detection.midi : null;
  const falling = new Set(tiles.filter((tile) => !tile.dying).map((tile) => tile.midi));
  for (const cell of cells) {
    const midi = Number(cell.dataset.midi);
    cell.classList.toggle("queued", falling.has(midi));
    cell.classList.toggle("lit", heard === midi);
  }
}

function renderLives() {
  livesEl.replaceChildren();
  for (let i = 0; i < START_LIVES; i++) {
    const mark = document.createElement("span");
    mark.className = i < lives ? "life on" : "life";
    livesEl.append(mark);
  }
}

function updateHud() {
  scoreEl.textContent = String(score);
  streakEl.textContent = String(streak);
  renderLives();
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  pointer = viewOf(rect.width, rect.height);
}

function viewOf(width, height) {
  const lanes = width < 720 ? 3 : width < 1100 ? 4 : 5;
  return {
    width,
    height,
    floor: height - 18,
    lanes,
    laneW: width / lanes,
  };
}

function tileSize() {
  return {
    w: Math.min(156, pointer.laneW - 22),
    h: TILE_H,
  };
}

function laneX(lane, tileW) {
  const safeLane = Math.min(lane, pointer.lanes - 1);
  return safeLane * pointer.laneW + (pointer.laneW - tileW) / 2;
}

function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function pickLane() {
  let best = null;
  let bestTop = -1;
  for (let lane = 0; lane < pointer.lanes; lane++) {
    let top = Infinity;
    for (const tile of tiles) {
      if (tile.lane === lane && !tile.dying) top = Math.min(top, tile.y);
    }
    if (top === Infinity) return lane;
    if (top > bestTop) {
      bestTop = top;
      best = lane;
    }
  }
  if (best == null || bestTop < TILE_H + 36) return null;
  return best;
}

function pullNote() {
  if (bag.length === 0) bag = shuffle(pool.map((note) => note.midi));
  const blocked = new Set(tiles.filter((tile) => !tile.dying).map((tile) => tile.midi));
  const stable = stableMidi();
  if (stable != null) blocked.add(stable);
  const index = bag.findIndex((midi) => !blocked.has(midi));
  if (index === -1) return null;
  return byMidi.get(bag.splice(index, 1)[0]);
}

function spawn() {
  if (pointer.height < 120) return;
  const lane = pickLane();
  if (lane == null) return;
  const note = pullNote();
  if (!note) return;
  tiles.push({
    midi: note.midi,
    label: note.label,
    color: note.color,
    lane,
    y: -TILE_H - 8,
    dying: false,
    dieT: 0,
    missed: false,
  });
}

function intervalSeconds() {
  return Math.max(1.15, 2.45 - clears * 0.03);
}

function fallSpeed() {
  const travel = Math.max(4.2, 8.1 - clears * 0.09);
  return (pointer.height + TILE_H) / travel;
}

function stableMidi() {
  if (recent.length < 2) return null;
  const last = recent[recent.length - 1];
  const prev = recent[recent.length - 2];
  return last != null && last === prev ? last : null;
}

function applyDetection(next) {
  detection = next;
  const midi = next && next.playable ? next.midi : null;
  recent.push(midi);
  if (recent.length > 3) recent.shift();
  if (midi == null) quietFrames += 1;
  else quietFrames = 0;
  if (quietFrames >= 3) armed = true;
}

function synthetic(midi) {
  const note = describeMidi(midi);
  return {
    rms: 0.08,
    frequency: note.frequency,
    confidence: 1,
    midi,
    cents: 0,
    label: note.label,
    playable: true,
    inRange: true,
  };
}

function readForced() {
  if (forced.frames <= 0) return null;
  forced.frames -= 1;
  return synthetic(forced.midi);
}

function readMic() {
  if (!analyser || !timeBuffer) return null;
  analyser.getFloatTimeDomainData(timeBuffer);
  const found = detectPitch(timeBuffer, audioCtx.sampleRate);
  if (found.rms < gate || found.frequency == null || found.confidence < 0.82) {
    return { rms: found.rms, frequency: null, confidence: found.confidence, playable: false };
  }
  const described = describeFrequency(found.frequency);
  const inRange = byMidi.has(described.midi);
  const playable = inRange && Math.abs(described.cents) <= CENTS_WINDOW;
  return {
    rms: found.rms,
    frequency: found.frequency,
    confidence: found.confidence,
    midi: described.midi,
    cents: described.cents,
    label: described.label,
    inRange,
    playable,
  };
}

function listen() {
  const forcedRead = readForced();
  if (forcedRead) {
    applyDetection(forcedRead);
    return;
  }
  const now = performance.now();
  if (now - lastListen < 45) return;
  lastListen = now;
  applyDetection(readMic());
}

function lowestTile(midi) {
  let best = null;
  for (const tile of tiles) {
    if (tile.midi !== midi || tile.dying) continue;
    if (!best || tile.y > best.y) best = tile;
  }
  return best;
}

function burst(tile) {
  const { w } = tileSize();
  const x = laneX(tile.lane, w) + w / 2;
  const y = tile.y + TILE_H / 2;
  for (let i = 0; i < 14; i++) {
    const angle = (Math.PI * 2 * i) / 14;
    const speed = 70 + Math.random() * 110;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 30,
      life: 0.45,
      max: 0.45,
      color: tile.color,
    });
  }
  floaters.push({ text: `+${10 * streak}`, x, y, life: 0.7, max: 0.7 });
}

function loseLife() {
  streak = 0;
  lives -= 1;
  armed = true;
  if (lives <= 0) {
    lives = 0;
    mode = "over";
    rememberScore();
    showGameOver();
  }
}

function tryHit() {
  if (mode !== "play" || countdown > 0) return;
  const midi = stableMidi();
  if (midi == null || !armed) return;
  const tile = lowestTile(midi);
  if (!tile) return;
  armed = false;
  quietFrames = 0;
  streak += 1;
  score += 10 * streak;
  clears += 1;
  tile.dying = true;
  burst(tile);
}

function update(dt) {
  pointer = viewOf(canvas.clientWidth, canvas.clientHeight);
  listen();
  paintHeard();
  paintFretboard();

  if (mode === "play" && countdown > 0) {
    countdown = Math.max(0, countdown - dt);
    if (countdown === 0) spawnIn = 0.35;
  }

  if (mode === "play" && countdown === 0) {
    spawnIn -= dt;
    if (spawnIn <= 0) {
      spawn();
      spawnIn = intervalSeconds();
    }
    const speed = fallSpeed();
    for (const tile of tiles) {
      if (tile.dying) continue;
      tile.y += speed * dt;
      if (tile.y + TILE_H >= pointer.floor) {
        tile.dying = true;
        tile.missed = true;
        loseLife();
        if (mode !== "play") break;
      }
    }
    tryHit();
  }

  for (const tile of tiles) {
    if (tile.dying) tile.dieT += dt;
  }
  tiles = tiles.filter((tile) => !(tile.dying && tile.dieT > 0.22));

  for (const particle of particles) {
    particle.life -= dt;
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.vy += 280 * dt;
  }
  particles = particles.filter((particle) => particle.life > 0);

  for (const floater of floaters) floater.life -= dt;
  floaters = floaters.filter((floater) => floater.life > 0);

  if (mode === "play" || mode === "over") updateHud();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawTile(tile) {
  const { w, h } = tileSize();
  const x = laneX(tile.lane, w);
  const y = tile.y;
  const progress = tile.dying ? tile.dieT / 0.22 : 0;
  ctx.save();
  ctx.globalAlpha = tile.dying ? 1 - progress : 1;
  const cx = x + w / 2;
  const cy = y + h / 2;
  ctx.translate(cx, cy);
  const scale = tile.dying && !tile.missed ? 1 + progress * 0.35 : 1;
  ctx.scale(scale, scale);
  ctx.translate(-cx, -cy);

  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 8;
  roundRect(x, y, w, h, 14);
  ctx.fillStyle = "#f4ecdf";
  ctx.fill();
  ctx.shadowColor = "transparent";

  ctx.fillStyle = tile.color;
  roundRect(x, y, 10, h, 8);
  ctx.fill();
  ctx.fillRect(x + 6, y, 8, h);

  const danger = pointer.floor - (y + h) < 90;
  if (danger && !tile.dying) {
    ctx.fillStyle = "rgba(212, 83, 58, 0.16)";
    roundRect(x, y, w, h, 14);
    ctx.fill();
  }

  ctx.fillStyle = "#1b140f";
  ctx.font = "700 34px Bahnschrift, Segoe UI, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(tile.label, x + w / 2 + 4, y + h / 2 + 1);
  ctx.restore();
}

function draw() {
  const { width, height, floor, lanes, laneW } = pointer;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#16100c";
  ctx.fillRect(0, 0, width, height);

  for (let lane = 0; lane < lanes; lane++) {
    ctx.fillStyle = lane % 2 === 0 ? "rgba(255,244,220,0.025)" : "rgba(0,0,0,0.18)";
    ctx.fillRect(lane * laneW, 0, laneW, floor);
  }

  const dangerTop = floor - 88;
  const gradient = ctx.createLinearGradient(0, dangerTop, 0, floor);
  gradient.addColorStop(0, "rgba(212, 83, 58, 0)");
  gradient.addColorStop(1, "rgba(212, 83, 58, 0.22)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, dangerTop, width, floor - dangerTop);

  ctx.strokeStyle = "rgba(231, 162, 58, 0.85)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(16, floor);
  ctx.lineTo(width - 16, floor);
  ctx.stroke();

  for (const tile of tiles) drawTile(tile);

  for (const particle of particles) {
    ctx.globalAlpha = Math.max(0, particle.life / particle.max);
    ctx.fillStyle = particle.color;
    ctx.beginPath();
    ctx.arc(particle.x, particle.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  for (const floater of floaters) {
    ctx.globalAlpha = Math.max(0, floater.life / floater.max);
    ctx.fillStyle = "#f4ecdf";
    ctx.font = "700 22px Bahnschrift, Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(floater.text, floater.x, floater.y - (1 - floater.life / floater.max) * 36);
    ctx.globalAlpha = 1;
  }

  if (mode === "play" && countdown > 0) {
    ctx.fillStyle = "rgba(10, 7, 5, 0.45)";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#f4ecdf";
    ctx.font = "700 92px Bahnschrift, Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(Math.ceil(countdown)), width / 2, height / 2);
  }
}

function paintHeard() {
  const level = detection ? Math.min(1, detection.rms / 0.12) : 0;
  meterFill.style.width = `${level * 100}%`;

  if (!mediaStream && forced.frames <= 0 && mode === "menu") {
    heardNote.textContent = "—";
    heardDetail.textContent = "Waiting to listen";
    return;
  }
  if (!detection || detection.rms < gate) {
    heardNote.textContent = "—";
    heardDetail.textContent = mediaStream
      ? "Too quiet. Move closer, or lower the noise gate."
      : "Listening is off";
    return;
  }
  if (detection.frequency == null) {
    heardNote.textContent = "…";
    heardDetail.textContent = "Hearing the room, not a clear note yet";
    return;
  }
  heardNote.textContent = detection.label;
  heardNote.style.color = detection.playable ? "#f4ecdf" : "#e7a23a";
  const cents = Math.round(detection.cents);
  const signed = `${cents > 0 ? "+" : ""}${cents} cents`;
  if (!detection.inRange) {
    heardDetail.textContent = `${detection.label} is outside open through the 5th fret`;
    return;
  }
  if (!detection.playable) {
    heardDetail.textContent = `Near ${detection.label}, ${signed}. A little closer to the note.`;
    return;
  }
  heardDetail.textContent = `${signed} · in tune enough to clear`;
}

function showMenu() {
  overlay.hidden = false;
  menuCard.hidden = false;
  gameoverCard.hidden = true;
  hud.hidden = true;
  renderBest();
}

function showGameOver() {
  overlay.hidden = false;
  menuCard.hidden = true;
  gameoverCard.hidden = false;
  const best = bestScore();
  finalScore.textContent = `Score ${score}. Cleared ${clears}. Best ${best}.`;
}

function resetRound() {
  score = 0;
  streak = 0;
  lives = START_LIVES;
  clears = 0;
  tiles = [];
  particles = [];
  floaters = [];
  bag = [];
  spawnIn = 0;
  armed = true;
  quietFrames = 0;
  recent = [];
  countdown = 3;
  mode = "play";
  overlay.hidden = true;
  hud.hidden = false;
  updateHud();
}

async function openMic() {
  const audio = {
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio });
  } catch {
    return navigator.mediaDevices.getUserMedia({ audio: true });
  }
}

async function startListening() {
  micError.hidden = true;
  startButton.disabled = true;
  againButton.disabled = true;
  try {
    if (!mediaStream) {
      mediaStream = await openMic();
      audioCtx = new AudioContext();
      if (audioCtx.state === "suspended") await audioCtx.resume();
      const source = audioCtx.createMediaStreamSource(mediaStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0;
      source.connect(analyser);
      timeBuffer = new Float32Array(analyser.fftSize);
    }
    resetRound();
  } catch (error) {
    const denied = error && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError");
    const missing = error && error.name === "NotFoundError";
    micError.textContent = denied
      ? "Microphone permission was blocked. Allow it for this page in the browser site settings, then try again."
      : missing
        ? "No microphone was found."
        : "The microphone could not be opened.";
    micError.hidden = false;
    showMenu();
  } finally {
    startButton.disabled = false;
    againButton.disabled = false;
  }
}

function placeGateMark() {
  const min = Number(gateInput.min);
  const max = Number(gateInput.max);
  const value = Number(gateInput.value);
  const ratio = (value - min) / (max - min);
  gateMark.style.left = `${ratio * 100}%`;
}

function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  update(dt);
  draw();
  requestAnimationFrame(frame);
}

if (location.protocol === "file:") {
  fileWarn.hidden = false;
}

renderFretboard();
renderBest();
placeGateMark();
resize();
new ResizeObserver(resize).observe(canvas);
window.addEventListener("resize", resize);

gateInput.addEventListener("input", () => {
  gate = Number(gateInput.value);
  placeGateMark();
});
startButton.addEventListener("click", () => {
  startListening();
});
againButton.addEventListener("click", () => {
  startListening();
});

const debug = new URLSearchParams(location.search).has("debug");
if (debug) {
  window.__guitar = {
    startWithoutMic() {
      mediaStream = null;
      resetRound();
      countdown = 0;
      spawnIn = 0.05;
    },
    play(midi) {
      forced = { midi, frames: 8 };
    },
    step(dt) {
      update(dt);
      draw();
    },
    tiles() {
      return tiles.map((tile) => ({ midi: tile.midi, label: tile.label, y: tile.y, dying: tile.dying }));
    },
    score: () => score,
    lives: () => lives,
    mode: () => mode,
    clears: () => clears,
    pitchFailures,
  };
}

requestAnimationFrame(frame);
