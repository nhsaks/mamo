import { state } from './supabase.js';

export const PLAYERS_META = [
  { id: 0, name: 'Red', color: '#ef4444', dark: '#991b1b', light: '#fca5a5', startTrackIdx: 0, yardCoords: [[1.8, 10.8], [3.8, 10.8], [1.8, 12.8], [3.8, 12.8]], homeStretch: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9], [7, 8]] },
  { id: 1, name: 'Green', color: '#10b981', dark: '#065f46', light: '#6ee7b7', startTrackIdx: 13, yardCoords: [[1.8, 1.8], [3.8, 1.8], [1.8, 3.8], [3.8, 3.8]], homeStretch: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7]] },
  { id: 2, name: 'Yellow', color: '#f59e0b', dark: '#92400e', light: '#fde68a', startTrackIdx: 26, yardCoords: [[10.8, 1.8], [12.8, 1.8], [10.8, 3.8], [12.8, 3.8]], homeStretch: [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5], [7, 6]] },
  { id: 3, name: 'Blue', color: '#3b82f6', dark: '#1e40af', light: '#93c5fd', startTrackIdx: 39, yardCoords: [[10.8, 10.8], [12.8, 10.8], [10.8, 12.8], [12.8, 12.8]], homeStretch: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7], [8, 7]] }
];

export const MAIN_TRACK = [
  [6, 13], [6, 12], [6, 11], [6, 10], [6, 9], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8], [0, 7], [0, 6],
  [1, 6], [2, 6], [3, 6], [4, 6], [5, 6], [6, 5], [6, 4], [6, 3], [6, 2], [6, 1], [6, 0], [7, 0], [8, 0],
  [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [9, 6], [10, 6], [11, 6], [12, 6], [13, 6], [14, 6], [14, 7], [14, 8],
  [13, 8], [12, 8], [11, 8], [10, 8], [9, 8], [8, 9], [8, 10], [8, 11], [8, 12], [8, 13], [8, 14], [7, 14], [6, 14]
];

export const SAFE_TRACK_INDICES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
export const STAR_ONLY_INDICES = new Set([8, 21, 34, 47]);

export function getTokenGridPos(playerIdx, tokenIdx, progress) {
  const meta = PLAYERS_META[playerIdx];
  if (progress === -1) return meta.yardCoords[tokenIdx];
  if (progress >= 0 && progress <= 50) return MAIN_TRACK[(meta.startTrackIdx + progress) % 52];
  if (progress >= 51 && progress <= 56) return meta.homeStretch[progress - 51];
  return [7, 7];
}

export function getGlobalTrackIndex(playerIdx, progress) {
  if (progress < 0 || progress > 50) return -1;
  return (PLAYERS_META[playerIdx].startTrackIdx + progress) % 52;
}

const canvas = document.getElementById('ludoCanvas');
const ctx = canvas.getContext('2d');
let boardPixelSize = 480;
let renderedTokenHitboxes = [];

export function canCurrentUserAct() {
  const game = state.game;
  if (!game || state.isAnimatingMove || state.isSyncingMatch || game.phase === 'GAMEOVER') return false;
  const currentSeatObj = game.seats[game.turnSeat];
  if (!currentSeatObj || currentSeatObj.eliminated) return false;
  if (game.mode === 'online') return game.turnSeat === state.mySeatIndex;
  return true;
}

export function resizeCanvas() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxSize = vw >= 1024 ? Math.min(vh - 135, vw - 560, 560) : Math.min(vw - 28, vh - 295, 460);
  boardPixelSize = Math.max(270, Math.floor(maxSize));
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${boardPixelSize}px`;
  canvas.style.height = `${boardPixelSize}px`;
  canvas.width = boardPixelSize * dpr;
  canvas.height = boardPixelSize * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBoard();
}

function drawStar(cx, cy, spikes, outerR, innerR, fillStyle) {
  let rot = Math.PI / 2 * 3;
  const step = Math.PI / spikes;
  ctx.beginPath();
  ctx.moveTo(cx, cy - outerR);
  for (let i = 0; i < spikes; i++) {
    ctx.lineTo(cx + Math.cos(rot) * outerR, cy + Math.sin(rot) * outerR);
    rot += step;
    ctx.lineTo(cx + Math.cos(rot) * innerR, cy + Math.sin(rot) * innerR);
    rot += step;
  }
  ctx.closePath();
  ctx.fillStyle = fillStyle;
  ctx.fill();
}

export function drawBoard() {
  const S = boardPixelSize;
  const cell = S / 15;
  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, S, S);

  const yards = [
    { x: 0, y: 9, color: PLAYERS_META[0].color, coords: PLAYERS_META[0].yardCoords },
    { x: 0, y: 0, color: PLAYERS_META[1].color, coords: PLAYERS_META[1].yardCoords },
    { x: 9, y: 0, color: PLAYERS_META[2].color, coords: PLAYERS_META[2].yardCoords },
    { x: 9, y: 9, color: PLAYERS_META[3].color, coords: PLAYERS_META[3].yardCoords }
  ];

  yards.forEach(y => {
    ctx.fillStyle = y.color;
    ctx.fillRect(y.x * cell, y.y * cell, 6 * cell, 6 * cell);
    const pad = cell * 0.85;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(y.x * cell + pad, y.y * cell + pad, 6 * cell - pad * 2, 6 * cell - pad * 2, cell * 0.65);
    ctx.fill();
    y.coords.forEach(([gx, gy]) => {
      ctx.beginPath();
      ctx.arc((gx + 0.5) * cell, (gy + 0.5) * cell, cell * 0.44, 0, Math.PI * 2);
      ctx.fillStyle = y.color + '28';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = y.color;
      ctx.stroke();
    });
  });

  PLAYERS_META.forEach(meta => {
    for (let i = 0; i < 5; i++) {
      const [gx, gy] = meta.homeStretch[i];
      ctx.fillStyle = meta.color;
      ctx.fillRect(gx * cell, gy * cell, cell, cell);
    }
    const [sx, sy] = MAIN_TRACK[meta.startTrackIdx];
    ctx.fillStyle = meta.color;
    ctx.fillRect(sx * cell, sy * cell, cell, cell);
    drawStar((sx + 0.5) * cell, (sy + 0.5) * cell, 5, cell * 0.3, cell * 0.14, 'rgba(255,255,255,0.85)');
  });

  STAR_ONLY_INDICES.forEach(idx => {
    const [gx, gy] = MAIN_TRACK[idx];
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(gx * cell, gy * cell, cell, cell);
    drawStar((gx + 0.5) * cell, (gy + 0.5) * cell, 5, cell * 0.32, cell * 0.15, '#64748b');
  });

  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1;
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      const inYard = (r < 6 && c < 6) || (r < 6 && c > 8) || (r > 8 && c < 6) || (r > 8 && c > 8);
      const inCenter = (r >= 6 && r <= 8 && c >= 6 && c <= 8);
      if (!inYard && !inCenter) ctx.strokeRect(c * cell, r * cell, cell, cell);
    }
  }

  const cx = 7.5 * cell, cy = 7.5 * cell;
  const x0 = 6 * cell, y0 = 6 * cell, x1 = 9 * cell, y1 = 9 * cell;
  [
    { pts: [[x0, y1], [x1, y1], [cx, cy]], color: PLAYERS_META[0].color },
    { pts: [[x0, y0], [x0, y1], [cx, cy]], color: PLAYERS_META[1].color },
    { pts: [[x0, y0], [x1, y0], [cx, cy]], color: PLAYERS_META[2].color },
    { pts: [[x1, y0], [x1, y1], [cx, cy]], color: PLAYERS_META[3].color }
  ].forEach(t => {
    ctx.beginPath();
    ctx.moveTo(t.pts[0][0], t.pts[0][1]);
    ctx.lineTo(t.pts[1][0], t.pts[1][1]);
    ctx.lineTo(t.pts[2][0], t.pts[2][1]);
    ctx.closePath();
    ctx.fillStyle = t.color;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });

  ctx.beginPath();
  ctx.arc(cx, cy, cell * 0.42, 0, Math.PI * 2);
  ctx.fillStyle = '#0f172a';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#fbbf24';
  ctx.stroke();
  drawStar(cx, cy, 5, cell * 0.25, cell * 0.11, '#fbbf24');

  renderedTokenHitboxes = [];
  const game = state.game;
  if (!game) return;

  const cellGroups = new Map();
  game.activeSeats.forEach(seatIdx => {
    const seat = game.seats[seatIdx];
    if (!seat || seat.eliminated) return;
    seat.tokens.forEach((prog, tokenIdx) => {
      const [gx, gy] = getTokenGridPos(seatIdx, tokenIdx, prog);
      const key = `${gx.toFixed(1)},${gy.toFixed(1)}`;
      if (!cellGroups.has(key)) cellGroups.set(key, []);
      cellGroups.get(key).push({ seatIdx, tokenIdx, prog, gx, gy });
    });
  });

  const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 160);
  cellGroups.forEach(group => {
    const count = group.length;
    group.forEach((item, idx) => {
      const meta = PLAYERS_META[item.seatIdx];
      let offsetX = 0, offsetY = 0, scale = 1;
      if (count > 1 && item.prog !== -1) {
        scale = count === 2 ? 0.82 : 0.72;
        const angle = (idx / count) * Math.PI * 2 - Math.PI / 4;
        offsetX = Math.cos(angle) * (cell * 0.2);
        offsetY = Math.sin(angle) * (cell * 0.2);
      }
      const px = (item.gx + 0.5) * cell + offsetX;
      const py = (item.gy + 0.5) * cell + offsetY;
      const radius = cell * 0.36 * scale;
      const isMovable = game.phase === 'MOVE' && game.turnSeat === item.seatIdx && game.validTokens.includes(item.tokenIdx) && canCurrentUserAct();

      if (isMovable) {
        ctx.beginPath();
        ctx.arc(px, py, radius + 3 + pulse * 4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(251, 191, 36, ${0.35 + pulse * 0.35})`;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#fbbf24';
        ctx.stroke();
      }

      const grad = ctx.createRadialGradient(px - radius * 0.3, py - radius * 0.35, radius * 0.1, px, py, radius);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.28, meta.color);
      grad.addColorStop(1, meta.dark);

      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.lineWidth = isMovable ? 2.4 : 1.8;
      ctx.strokeStyle = isMovable ? '#fef08a' : '#ffffff';
      ctx.stroke();

      if (isMovable) {
        renderedTokenHitboxes.push({ seatIdx: item.seatIdx, tokenIdx: item.tokenIdx, x: px, y: py, r: Math.max(radius * 1.45, 22) });
      }
    });
  });
}

export function initBoardBindings(onExecuteTokenMove) {
  window.addEventListener('resize', resizeCanvas);

  canvas.addEventListener('click', (e) => {
    if (!canCurrentUserAct() || state.game.phase !== 'MOVE') return;
    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    let closest = null;
    let minDist = Infinity;
    renderedTokenHitboxes.forEach(hb => {
      const d = Math.hypot(clickX - hb.x, clickY - hb.y);
      if (d <= hb.r && d < minDist) {
        minDist = d;
        closest = hb;
      }
    });
    if (closest) onExecuteTokenMove(closest.tokenIdx);
  });
}
