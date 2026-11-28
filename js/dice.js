import { state, showToast } from './supabase.js';
import { sfx } from './sound.js';
import { canCurrentUserAct } from './board.js';

const DICE_PIP_PATTERNS = {
  1: [4],
  2: [2, 6],
  3: [2, 4, 6],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8]
};

export function renderDiceFaces(val) {
  const safeVal = (val >= 1 && val <= 6) ? val : 6;
  const activePips = DICE_PIP_PATTERNS[safeVal] || [4];
  document.querySelectorAll('#diceBtn .pip').forEach((pipEl, idx) => {
    const isOn = activePips.includes(idx);
    pipEl.classList.toggle('on', isOn);
    pipEl.classList.toggle('red-pip', isOn && (safeVal === 1 || safeVal === 6));
  });
}

export function computeLegalTokens(seatIdx, diceVal) {
  const game = state.game;
  if (!game) return [];
  const seat = game.seats[seatIdx];
  if (!seat || seat.eliminated) return [];
  const legal = [];
  seat.tokens.forEach((prog, tIdx) => {
    if (prog === 56) return;
    if (prog === -1) {
      if (diceVal === 6) legal.push(tIdx);
    } else if (prog + diceVal <= 56) {
      legal.push(tIdx);
    }
  });
  return legal;
}

export async function executeDiceRoll(callbacks) {
  const {
    sendMatchEvent,
    sendPrivateDiceRollToRoller,
    syncGameUI,
    advanceTurn,
    executeTokenMove
  } = callbacks;

  const initialGame = state.game;
  if (!initialGame || initialGame.phase !== 'ROLL') return;

  const rollTurnSeq = initialGame.turnSeq || 1;
  const rollingSeatIdx = initialGame.turnSeat;

  initialGame.phase = 'ANIMATING';
  sfx.diceShake();
  const diceEl = document.getElementById('diceBtn');
  diceEl.classList.add('rolling');
  const flicker = setInterval(() => renderDiceFaces(Math.floor(Math.random() * 6) + 1), 65);
  await new Promise(r => setTimeout(r, 420));
  clearInterval(flicker);
  diceEl.classList.remove('rolling');

  if (!state.game || state.game.phase === 'GAMEOVER' || state.game.turnSeat !== rollingSeatIdx || (state.game.turnSeq || 1) !== rollTurnSeq) {
    return;
  }

  const game = state.game;
  const seatObj = game.seats[rollingSeatIdx];
  const allActiveTokensLocked = seatObj && seatObj.tokens.every(p => p === -1 || p === 56) && seatObj.tokens.some(p => p === -1);
  const rolled = allActiveTokensLocked ? 6 : (Math.floor(Math.random() * 6) + 1);

  game.diceValue = rolled;
  game.lastRolledValue = rolled;
  if (seatObj) seatObj.lastDiceRoll = rolled;
  renderDiceFaces(rolled);
  syncGameUI();

  let nextSixes = game.consecutiveSixes;
  if (rolled === 6) {
    nextSixes += 1;
    if (nextSixes >= 3) {
      showToast(`${seatObj.name} rolled three 6s! Turn shifted.`, 'danger');
      game.consecutiveSixes = 0;
      if (game.mode === 'online') {
        sendMatchEvent('dice_rolled', {
          seatIndex: rollingSeatIdx,
          turnSeq: rollTurnSeq,
          diceValue: rolled,
          lastRolledValue: rolled,
          lastDiceRoll: rolled,
          consecutiveSixes: 0,
          validTokens: [],
          phase: 'ROLL'
        });
      }
      await new Promise(r => setTimeout(r, 700));
      advanceTurn(false);
      return;
    }
  } else {
    nextSixes = 0;
  }

  const legal = computeLegalTokens(rollingSeatIdx, rolled);
  if (game.mode === 'online') {
    sendMatchEvent('dice_rolled', {
      seatIndex: rollingSeatIdx,
      turnSeq: rollTurnSeq,
      diceValue: rolled,
      lastRolledValue: rolled,
      lastDiceRoll: rolled,
      consecutiveSixes: nextSixes,
      validTokens: legal,
      phase: legal.length > 0 ? 'MOVE' : 'ROLL'
    });
  }

  if (game.mode === 'online') {
    game.consecutiveSixes = nextSixes;
    sfx.diceLand(rolled);

    if (legal.length === 0) {
      game.phase = 'ROLL';
      game.validTokens = [];
      sendPrivateDiceRollToRoller(seatObj, rolled, nextSixes, [], 'ROLL');
      syncGameUI();
      showToast(`You rolled ${rolled} — No move`, 'info');
      await new Promise(r => setTimeout(r, 750));
      advanceTurn(false);
      return;
    }

    game.phase = 'MOVE';
    game.validTokens = legal;
    sendPrivateDiceRollToRoller(seatObj, rolled, nextSixes, legal, 'MOVE');
    syncGameUI();

    const allInYard = legal.every(tIdx => seatObj.tokens[tIdx] === -1);
    if (legal.length === 1 || allInYard) {
      await new Promise(r => setTimeout(r, 340));
      await executeTokenMove(legal[0]);
    }
    return;
  }

  game.consecutiveSixes = nextSixes;
  sfx.diceLand(rolled);
  game.validTokens = legal;

  if (legal.length === 0) {
    game.phase = 'ROLL';
    syncGameUI();
    showToast(`${seatObj.name} rolled ${rolled} — No move`, 'info');
    await new Promise(r => setTimeout(r, 750));
    advanceTurn(false);
    return;
  }

  game.phase = 'MOVE';
  syncGameUI();

  const allInYard = legal.every(tIdx => seatObj.tokens[tIdx] === -1);
  if (legal.length === 1 || allInYard) {
    await new Promise(r => setTimeout(r, 340));
    await executeTokenMove(legal[0]);
  }
}

let isRollTriggered = false;

async function handleSafeRollRequest(onRollRequested) {
  if (isRollTriggered || !canCurrentUserAct() || !state.game || state.game.phase !== 'ROLL') return;
  isRollTriggered = true;
  const rollBtn = document.getElementById('rollActionBtn');
  if (rollBtn) rollBtn.disabled = true;
  try {
    await onRollRequested();
  } finally {
    isRollTriggered = false;
  }
}

export function initDiceBindings(onRollRequested) {
  document.getElementById('diceBtn').addEventListener('click', () => {
    handleSafeRollRequest(onRollRequested);
  });

  document.getElementById('rollActionBtn').addEventListener('click', () => {
    handleSafeRollRequest(onRollRequested);
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !document.getElementById('gameView').classList.contains('hidden')) {
      e.preventDefault();
      handleSafeRollRequest(onRollRequested);
    }
  });
}