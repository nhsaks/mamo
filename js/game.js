import {
  supabase,
  state,
  showToast,
  ACTIVE_GAME_KEY
} from './supabase.js';
import { sfx } from './sound.js';
import { refreshAccountBalance } from './player.js';
import { fetchRemotePlatformConfig, parsePotStakesInput } from './admin.js';
import {
  runMatchCoinRpc,
  creditWalletCoinsReliable,
  deductStakeOnMatchStart,
  deductPlayerWalletStakeOnce,
  resetMatchStakeLock,
  validateWalletActionButtons
} from './coin.js';
import {
  PLAYERS_META,
  SAFE_TRACK_INDICES,
  getGlobalTrackIndex,
  canCurrentUserAct,
  resizeCanvas,
  drawBoard
} from './board.js';
import { renderDiceFaces, executeDiceRoll } from './dice.js';

let matchmakingTimerInterval = null;
let matchmakingSecondsLeft = 30;
const MATCHMAKING_TIMEOUT_SECONDS = 30;

let turnTimerInterval = null;
let turnSecondsLeft = 30;
const TURN_DURATION_SECONDS = 30;

let homeRefreshCooldownUntil = 0;
let homeRefreshTimer = null;

let awaitingRejoinSync = false;
let rejoinSyncTimeout = null;
let rejoinSyncRetryInterval = null;
let handledTimeoutKey = null;

function getMaxMissedTurns() {
  const n = Number(state.platformConfig.maxMissedTurns ?? 5);
  return Number.isFinite(n) && n >= 1 ? n : 5;
}

export function getMasterClientMobile(game = state.game) {
  if (!game || game.mode !== 'online' || !Array.isArray(game.activeSeats)) return null;
  const aliveMobiles = game.activeSeats
    .map(idx => game.seats[idx])
    .filter(s => s && !s.eliminated && s.mobile && s.mobile !== 'LOCAL')
    .map(s => s.mobile)
    .sort();
  return aliveMobiles[0] || game.hostMobile || null;
}

export function isCurrentUserMasterClient(game = state.game) {
  if (!game || game.mode !== 'online') return true;
  const masterMobile = getMasterClientMobile(game);
  return Boolean(masterMobile && masterMobile === state.account.mobile);
}

export function isUserCurrentlyInMatchOrMatchmaking() {
  const activeGame = Boolean(state.game && state.game.phase !== 'GAMEOVER');
  const activeWaiting = Boolean(state.waitingRoomState && state.waitingRoomState.status === 'WAITING');
  return activeGame || activeWaiting || Boolean(state.autoMatchLocked);
}

function requestRejoinSyncState() {
  if (!awaitingRejoinSync || !state.game) return;
  const payload = {
    mobile: state.account.mobile,
    turnSeq: state.game.turnSeq || 0,
    roomCode: state.onlineRoomCode
  };
  if (state.realtimeChannel) {
    sendRoomBroadcast('rejoin_sync_req', payload);
  }
  sendMatchEvent('rejoin_sync_req', payload);
}

function beginRejoinSyncWait() {
  awaitingRejoinSync = true;
  state.isSyncingMatch = true;
  if (rejoinSyncTimeout) clearTimeout(rejoinSyncTimeout);
  rejoinSyncTimeout = setTimeout(() => {
    finishRejoinSyncWait();
    showToast('Live match sync timed out. Showing your saved state.', 'danger');
    restartTurnTimer();
  }, 5000);
}

function finishRejoinSyncWait() {
  awaitingRejoinSync = false;
  state.isSyncingMatch = false;
  if (rejoinSyncTimeout) {
    clearTimeout(rejoinSyncTimeout);
    rejoinSyncTimeout = null;
  }
  if (rejoinSyncRetryInterval) {
    clearInterval(rejoinSyncRetryInterval);
    rejoinSyncRetryInterval = null;
  }
}

function promoteHostAfterElimination(game, eliminatedSeatIdx) {
  if (game.mode !== 'online') return;
  const nextMaster = getMasterClientMobile(game);
  if (nextMaster) game.hostMobile = nextMaster;
  if (game.hostMobile !== game.seats[eliminatedSeatIdx]?.mobile) return;
  const nextHostIdx = game.activeSeats.find(seatIdx =>
    seatIdx !== eliminatedSeatIdx &&
    game.seats[seatIdx] &&
    !game.seats[seatIdx].eliminated &&
    game.seats[seatIdx].mobile &&
    game.seats[seatIdx].mobile !== 'LOCAL'
  );
  if (nextHostIdx !== undefined) game.hostMobile = game.seats[nextHostIdx].mobile;
}

function sendRoomBroadcast(event, payload) {
  if (!state.realtimeChannel) {
    return;
  }
  state.realtimeChannel.send({ type: 'broadcast', event, payload }).then(status => {
    if (status !== 'ok') console.error(`${event} broadcast failed: ${status}`);
  }).catch(err => {
    console.error(`${event} broadcast failed:`, err);
  });
}

const RTC_ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};
const rtcPeers = new Map();
let signalingUnsubscribeTimer = null;

export function updateAutoMatchButtonState() {
  const btn = document.getElementById('startAutoMatchBtn');
  if (!btn) return;
  const busy = isUserCurrentlyInMatchOrMatchmaking();
  btn.disabled = busy;
  if (state.waitingRoomState && state.waitingRoomState.status === 'WAITING') {
    btn.innerHTML = `⏳ Auto-Matching (${matchmakingSecondsLeft}s)...`;
  } else if (state.game && state.game.phase !== 'GAMEOVER') {
    btn.innerHTML = `🎲 In Match`;
  } else if (state.autoMatchLocked) {
    btn.innerHTML = `⏳ Matching Locked...`;
  } else {
    btn.innerHTML = `⚡ Auto Match (<span id="autoMatchBtnLabel">${state.selectedPlayerCount}P • ${state.selectedStake}</span>)`;
  }
}

export function renderStakeButtons() {
  const grid = document.getElementById('stakeGrid');
  if (!grid) return;
  const stakes = parsePotStakesInput(state.platformConfig.potStakes);
  state.platformConfig.potStakes = stakes;
  if (!stakes.includes(Number(state.selectedStake))) {
    state.selectedStake = stakes[0];
  }

  const tiers = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'VIP Royale'];
  const colors = ['text-amber-300', 'text-sky-300', 'text-purple-300', 'text-emerald-300', 'text-cyan-300', 'text-rose-300'];

  grid.innerHTML = '';
  stakes.forEach((amt, idx) => {
    const selected = Number(state.selectedStake) === Number(amt);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.stake = String(amt);
    btn.className = selected
      ? 'stake-btn rounded-xl p-2.5 border-2 border-amber-400 bg-amber-500/15 flex flex-col items-center cursor-pointer'
      : 'stake-btn rounded-xl p-2.5 border border-white/10 bg-slate-900/70 flex flex-col items-center cursor-pointer';
    btn.innerHTML = `
      <span class="text-[10px] font-bold uppercase ${colors[idx % colors.length]}">${tiers[idx % tiers.length]}</span>
      <span class="text-sm sm:text-base font-black text-white mt-0.5">${Number(amt).toLocaleString()}</span>
      <span class="text-[10px] text-slate-400">Coins</span>
    `;
    btn.addEventListener('click', () => {
      state.selectedStake = Number(amt);
      renderStakeButtons();
      refreshPotPreview();
    });
    grid.appendChild(btn);
  });
}

export function refreshPotPreview() {
  renderStakeButtons();
  const feePct = Number(state.platformConfig.gameFeePct ?? 20);
  document.getElementById('previewPotText').textContent = (state.selectedStake * state.selectedPlayerCount).toLocaleString();
  document.getElementById('feeSummaryText').textContent = `${feePct}% Fee`;
  updateAutoMatchButtonState();
}

export async function switchView(viewName) {
  document.getElementById('authView').classList.toggle('hidden', viewName !== 'auth');
  document.getElementById('lobbyView').classList.toggle('hidden', viewName !== 'lobby');
  document.getElementById('waitingRoomView').classList.toggle('hidden', viewName !== 'waiting');
  document.getElementById('gameView').classList.toggle('hidden', viewName !== 'game');
  document.getElementById('leaveMatchBtn').classList.toggle('hidden', viewName !== 'game' && viewName !== 'waiting');
  document.getElementById('forfeitMatchBtn').classList.toggle('hidden', viewName !== 'game');
  if (viewName === 'game') resizeCanvas();
  if (viewName === 'lobby') {
    await fetchRemotePlatformConfig(refreshPotPreview);
    checkSavedMatchForRejoin();
    updateAutoMatchButtonState();
  }
}

// ---------------------------------------------------------
// WEBRTC P2P MESH + MASTER CLIENT SYNC
// ---------------------------------------------------------
function updateP2PStatusBadge() {
  const badge = document.getElementById('p2pStatusBadge');
  if (!badge) return;
  if (!state.game || state.game.mode !== 'online') {
    badge.classList.add('hidden');
    return;
  }
  badge.classList.remove('hidden');
  let openCount = 0;
  rtcPeers.forEach(entry => {
    if (entry.dc && entry.dc.readyState === 'open') openCount++;
  });
  const masterTag = isCurrentUserMasterClient(state.game) ? ' • MASTER' : '';
  if (openCount > 0) {
    badge.textContent = `P2P (${openCount})${masterTag}`;
    badge.className = 'text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-400/40';
  } else {
    badge.textContent = `RELAY${masterTag}`;
    badge.className = 'text-[10px] font-bold px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-400/30';
  }
}

function closeAllRtcPeers() {
  if (signalingUnsubscribeTimer) {
    clearTimeout(signalingUnsubscribeTimer);
    signalingUnsubscribeTimer = null;
  }
  rtcPeers.forEach(entry => {
    try { entry.dc?.close(); } catch (e) {}
    try { entry.pc?.close(); } catch (e) {}
  });
  rtcPeers.clear();
  updateP2PStatusBadge();
}

function sendSignalingPacket(targetMobile, signalData) {
  if (!state.realtimeChannel || !targetMobile) return;
  state.realtimeChannel.send({
    type: 'broadcast',
    event: 'webrtc_signal',
    payload: {
      fromMobile: state.account.mobile,
      toMobile: targetMobile,
      signal: signalData
    }
  });
}

function bindDataChannelHandlers(peerMobile, dc) {
  dc.onopen = () => {
    const entry = rtcPeers.get(peerMobile);
    if (entry) entry.connected = true;
    updateP2PStatusBadge();

    if (state.game && state.game.mode === 'online' && !awaitingRejoinSync && isCurrentUserMasterClient(state.game)) {
      sendMatchEvent('rejoin_sync_state', {
        targetMobile: peerMobile,
        gameState: createRecoverableGameState(state.game)
      }, peerMobile);
    }
  };

  dc.onclose = () => {
    const entry = rtcPeers.get(peerMobile);
    if (entry) entry.connected = false;
    rtcPeers.delete(peerMobile);
    updateP2PStatusBadge();
  };

  dc.onerror = () => {
    updateP2PStatusBadge();
  };

  dc.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      handleIncomingMatchEvent(msg.event, msg.payload);
    } catch (e) {}
  };
}

async function getOrCreateRtcPeer(peerMobile, isInitiator) {
  if (!peerMobile || peerMobile === state.account.mobile || peerMobile === 'LOCAL') return null;
  let existing = rtcPeers.get(peerMobile);
  if (
    existing &&
    existing.pc &&
    existing.pc.connectionState !== 'closed' &&
    existing.pc.connectionState !== 'failed' &&
    existing.pc.connectionState !== 'disconnected'
  ) {
    return existing;
  }
  if (existing) {
    try { existing.dc?.close(); } catch (e) {}
    try { existing.pc?.close(); } catch (e) {}
    rtcPeers.delete(peerMobile);
  }

  const pc = new RTCPeerConnection(RTC_ICE_CONFIG);
  const entry = { pc, dc: null, connected: false };
  rtcPeers.set(peerMobile, entry);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendSignalingPacket(peerMobile, { type: 'candidate', candidate: e.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      entry.connected = false;
      updateP2PStatusBadge();
    }
  };

  if (isInitiator) {
    const dc = pc.createDataChannel('ludo-p2p', { ordered: true });
    entry.dc = dc;
    bindDataChannelHandlers(peerMobile, dc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignalingPacket(peerMobile, { type: 'offer', sdp: pc.localDescription });
  } else {
    pc.ondatachannel = (ev) => {
      entry.dc = ev.channel;
      bindDataChannelHandlers(peerMobile, ev.channel);
    };
  }

  return entry;
}

async function handleWebRtcSignal({ fromMobile, toMobile, signal }) {
  if (toMobile !== state.account.mobile || !fromMobile || !signal) return;
  try {
    if (signal.type === 'offer') {
      const entry = await getOrCreateRtcPeer(fromMobile, false);
      if (!entry) return;
      await entry.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      const answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);
      sendSignalingPacket(fromMobile, { type: 'answer', sdp: entry.pc.localDescription });
    } else if (signal.type === 'answer') {
      const entry = rtcPeers.get(fromMobile);
      if (entry && entry.pc.signalingState !== 'stable') {
        await entry.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      }
    } else if (signal.type === 'candidate' && signal.candidate) {
      const entry = rtcPeers.get(fromMobile);
      if (entry) {
        await entry.pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      }
    }
  } catch (e) {}
}

async function initiateMeshConnectionsForMatch(seats) {
  if (!Array.isArray(seats)) return;
  for (const seat of seats) {
    if (!seat || !seat.mobile || seat.mobile === 'LOCAL' || seat.mobile === state.account.mobile) continue;
    const shouldInitiate = state.account.mobile < seat.mobile;
    if (shouldInitiate) {
      await getOrCreateRtcPeer(seat.mobile, true);
    }
  }
}

export function sendMatchEvent(event, payload, targetMobile = null) {
  const serialized = JSON.stringify({ event, payload });
  let needsSupabaseFallback = false;

  if (targetMobile) {
    const peer = rtcPeers.get(targetMobile);
    if (peer && peer.dc && peer.dc.readyState === 'open') {
      peer.dc.send(serialized);
    } else {
      needsSupabaseFallback = true;
    }
  } else if (state.game && Array.isArray(state.game.seats)) {
    const opponents = state.game.seats.filter(s => s && s.mobile && s.mobile !== 'LOCAL' && s.mobile !== state.account.mobile);
    if (opponents.length === 0) return Promise.resolve();
    opponents.forEach(opp => {
      const peer = rtcPeers.get(opp.mobile);
      if (peer && peer.dc && peer.dc.readyState === 'open') {
        peer.dc.send(serialized);
      } else {
        needsSupabaseFallback = true;
      }
    });
  } else {
    needsSupabaseFallback = true;
  }

  if (needsSupabaseFallback && state.realtimeChannel) {
    return state.realtimeChannel.send({ type: 'broadcast', event, payload });
  }
  return Promise.resolve();
}

export function cleanupOnlineChannel() {
  finishRejoinSyncWait();
  closeAllRtcPeers();
  if (state.realtimeChannel) {
    supabase.removeChannel(state.realtimeChannel);
    state.realtimeChannel = null;
  }
  state.onlineRoomCode = null;
}

export function cleanupLobbyMatchmakerChannel() {
  if (state.lobbyMatchmakerChannel) {
    supabase.removeChannel(state.lobbyMatchmakerChannel);
    state.lobbyMatchmakerChannel = null;
  }
}

export function stopMatchmakingCountdown() {
  if (matchmakingTimerInterval) {
    clearInterval(matchmakingTimerInterval);
    matchmakingTimerInterval = null;
  }
}

let matchmakingStartedAt = 0;

function startMatchmakingCountdown() {
  stopMatchmakingCountdown();
  matchmakingStartedAt = Date.now();
  matchmakingSecondsLeft = MATCHMAKING_TIMEOUT_SECONDS;
  const badge = document.getElementById('matchmakingCountdownBadge');
  if (badge) badge.textContent = `Auto-Cancel in ${matchmakingSecondsLeft}s`;
  updateAutoMatchButtonState();

  matchmakingTimerInterval = setInterval(async () => {
    if (!state.waitingRoomState || state.waitingRoomState.status !== 'WAITING') {
      stopMatchmakingCountdown();
      state.autoMatchLocked = false;
      updateAutoMatchButtonState();
      return;
    }

    const elapsed = Math.floor((Date.now() - matchmakingStartedAt) / 1000);
    matchmakingSecondsLeft = Math.max(0, MATCHMAKING_TIMEOUT_SECONDS - elapsed);
    if (badge) badge.textContent = `Auto-Cancel in ${matchmakingSecondsLeft}s`;
    updateAutoMatchButtonState();

    if (matchmakingSecondsLeft <= 0) {
      stopMatchmakingCountdown();
      if (state.waitingRoomState && state.waitingRoomState.status === 'WAITING') {
        showToast('No player joined in 30s — matchmaking auto-cancelled!', 'gold');
        await cancelWaitingRoomAndUnlock();
      }
    }
  }, 500);
}

let isCancellingWaiting = false;

async function cancelWaitingRoomAndUnlock() {
  if (isCancellingWaiting) return;
  isCancellingWaiting = true;
  const cancelBtn = document.getElementById('cancelWaitingBtn');
  if (cancelBtn) cancelBtn.disabled = true;

  try {
    stopMatchmakingCountdown();
    const cancelledCode = state.waitingRoomState?.code;
    if (state.stakeDeductedForCurrentMatch && state.waitingRoomState && state.waitingRoomState.stake > 0) {
      await runMatchCoinRpc('payout', state.waitingRoomState.stake, 'Matchmaking Cancel Refund');
      resetMatchStakeLock();
    }
    state.waitingRoomState = null;
    if (cancelledCode) {
      state.liveOpenRoomsMap.delete(cancelledCode);
    }
    await updateLobbyPresenceRoom(null);
    cleanupOnlineChannel();
    renderHomeQueueBoards();
    state.autoMatchLocked = false;
    updateAutoMatchButtonState();
    const isLobbyVisible = !document.getElementById('lobbyView').classList.contains('hidden');
    if (!isLobbyVisible) {
      await switchView('lobby');
    } else {
      checkSavedMatchForRejoin();
    }
  } finally {
    if (cancelBtn) cancelBtn.disabled = false;
    isCancellingWaiting = false;
  }
}

export function startLobbyMatchmakerPresence() {
  cleanupLobbyMatchmakerChannel();
  state.lobbyMatchmakerChannel = supabase.channel('ludo-global-matchmaker-v1', {
    config: { presence: { key: state.account.mobile || `guest-${Math.random()}` } }
  });

  state.lobbyMatchmakerChannel
    .on('presence', { event: 'sync' }, () => {
      const presenceState = state.lobbyMatchmakerChannel.presenceState();
      state.liveOpenRoomsMap.clear();
      Object.values(presenceState).forEach(presences => {
        presences.forEach(p => {
          if (p.waitingRoom && p.waitingRoom.status === 'WAITING') {
            state.liveOpenRoomsMap.set(p.waitingRoom.code, p.waitingRoom);
          }
        });
      });
      renderHomeQueueBoards();
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await updateLobbyPresenceRoom(state.waitingRoomState);
      }
    });
}

async function updateLobbyPresenceRoom(roomObj) {
  if (!state.lobbyMatchmakerChannel) return;
  try {
    await state.lobbyMatchmakerChannel.track({
      mobile: state.account.mobile,
      username: state.account.username,
      waitingRoom: roomObj && roomObj.status === 'WAITING' ? roomObj : null
    });
  } catch (e) {}
}

function renderHomeQueueBoards() {
  const q2List = document.getElementById('liveQueue2List');
  const q4List = document.getElementById('liveQueue4List');
  const rooms2 = [];
  const rooms4 = [];

  state.liveOpenRoomsMap.forEach(r => {
    if (r.playerCount === 2) rooms2.push(r);
    else if (r.playerCount === 4) rooms4.push(r);
  });

  document.getElementById('queue2CountBadge').textContent = `${rooms2.length} Waiting`;
  document.getElementById('queue4CountBadge').textContent = `${rooms4.length} Waiting`;

  const renderList = (container, rooms, label) => {
    container.innerHTML = '';
    if (rooms.length === 0) {
      container.innerHTML = `<p class="text-slate-500 text-[11px] py-2">No ${label} tables waiting. Click Auto Match to host one!</p>`;
      return;
    }
    rooms.forEach(r => {
      const filled = r.seats.filter(Boolean).length;
      const isMyOwn = r.hostMobile === state.account.mobile;
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between bg-slate-900 border border-white/10 rounded-lg px-3 py-2';
      row.innerHTML = `
        <div>
          <div class="font-bold text-white">${r.hostName || 'Player'}'s Table <span class="text-amber-300">(${r.stake} Coins)</span></div>
          <div class="text-[10px] text-slate-400">Players: <strong class="text-emerald-300">${filled}/${r.playerCount}</strong> • Pot: ${r.pot}</div>
        </div>
        <button type="button" class="px-3 py-1.5 rounded-lg ${isMyOwn ? 'bg-slate-700 text-amber-300' : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950'} font-black text-[11px] cursor-pointer">
          ${isMyOwn ? 'Resume Wait' : 'Join Now'}
        </button>
      `;
      row.querySelector('button').addEventListener('click', async () => {
        if (isMyOwn && state.waitingRoomState) {
          renderWaitingRoom(state.waitingRoomState);
          switchView('waiting');
          return;
        }
        if (isUserCurrentlyInMatchOrMatchmaking()) {
          return showToast('Finish or leave your current match/matchmaking first.', 'danger');
        }
        if (Number(state.account.coins) < Number(r.stake)) {
          return showToast(`Need at least ${r.stake} coins to join this match.`, 'danger');
        }
        resetMatchStakeLock();
        state.autoMatchLocked = true;
        updateAutoMatchButtonState();
        joinRealtimeRoom(r.code, false);
      });
      container.appendChild(row);
    });
  };

  renderList(q2List, rooms2, '2P');
  renderList(q4List, rooms4, '4P');
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function hostOnlineTable(isPublicAutoMatch) {
  if (isUserCurrentlyInMatchOrMatchmaking() && !state.autoMatchLocked) {
    return showToast('Already in a match or matchmaking.', 'danger');
  }
  if (Number(state.account.coins) < Number(state.selectedStake)) {
    state.autoMatchLocked = false;
    updateAutoMatchButtonState();
    return showToast(`Insufficient balance (${state.account.coins}) for ${state.selectedStake} coin stake.`, 'danger');
  }
  resetMatchStakeLock();
  const code = generateRoomCode();
  const activeIndices = state.selectedPlayerCount === 2 ? [0, 2] : [0, 1, 2, 3];
  const seats = [null, null, null, null];
  seats[0] = {
    name: state.account.username,
    isAI: false,
    mobile: state.account.mobile,
    depositedByBroker: state.account.depositedByBroker || null,
    tokens: [-1, -1, -1, -1],
    finishedCount: 0,
    missedTurns: 0,
    eliminated: false,
    lastDiceRoll: null
  };
  state.waitingRoomState = {
    code,
    hostMobile: state.account.mobile,
    hostName: state.account.username,
    isPublic: isPublicAutoMatch,
    status: 'WAITING',
    playerCount: state.selectedPlayerCount,
    stake: state.selectedStake,
    pot: state.selectedStake * state.selectedPlayerCount,
    activeSeats: activeIndices,
    seats
  };
  state.mySeatIndex = 0;
  renderWaitingRoom(state.waitingRoomState);
  switchView('waiting');
  startMatchmakingCountdown();
  joinRealtimeRoom(code, true);
  if (isPublicAutoMatch) await updateLobbyPresenceRoom(state.waitingRoomState);
}

function renderWaitingRoom(room) {
  document.getElementById('waitingRoomTypeBadge').textContent = room.isPublic ? 'Auto Matchmaker Table' : 'Private Room';
  document.getElementById('waitingRoomCodeText').textContent = room.code;
  document.getElementById('waitingStakeText').textContent = room.stake.toLocaleString();
  document.getElementById('waitingPotText').textContent = room.pot.toLocaleString();
  const list = document.getElementById('waitingSeatsList');
  list.innerHTML = '';
  room.activeSeats.forEach(seatIdx => {
    const meta = PLAYERS_META[seatIdx];
    const occupant = room.seats[seatIdx];
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between bg-slate-900/90 border border-white/10 rounded-xl px-3.5 py-2.5';
    row.innerHTML = `
      <div class="flex items-center gap-2.5">
        <span class="w-3.5 h-3.5 rounded-full inline-block" style="background:${meta.color}"></span>
        <span class="text-xs font-extrabold text-white">${occupant ? occupant.name : 'Waiting for player...'}</span>
      </div>
      <span class="text-[11px] font-bold ${occupant ? 'text-emerald-400' : 'text-slate-500'}">${occupant ? 'READY' : 'OPEN'}</span>
    `;
    list.appendChild(row);
  });
}

function createInitialGameState({ mode, playerCount, stake, seats }) {
  handledTimeoutKey = null;
  const activeSeatIndices = playerCount === 2 ? [0, 2] : [0, 1, 2, 3];
  activeSeatIndices.forEach(idx => {
    if (seats[idx]) {
      seats[idx].missedTurns = seats[idx].missedTurns || 0;
      seats[idx].eliminated = Boolean(seats[idx].eliminated);
      seats[idx].lastDiceRoll = seats[idx].lastDiceRoll ?? null;
    }
  });
  const aliveMobiles = activeSeatIndices
    .map(i => seats[i]?.mobile)
    .filter(m => m && m !== 'LOCAL')
    .sort();
  return {
    mode,
    playerCount,
    stake,
    pot: mode === 'local' ? 0 : stake * playerCount,
    activeSeats: activeSeatIndices,
    masterMobile: aliveMobiles[0] || null,
    turnSeat: activeSeatIndices[0],
    turnSeq: 1,
    turnStartedAt: Date.now(),
    phase: 'ROLL',
    diceValue: null,
    consecutiveSixes: 0,
    validTokens: [],
    winnerSeat: null,
    seats
  };
}

export function persistActiveMatchSnapshot() {
  const game = state.game;
  if (!game || game.phase === 'GAMEOVER') {
    localStorage.removeItem(ACTIVE_GAME_KEY);
    return;
  }
  const mySeat = game.seats[state.mySeatIndex];
  if (!mySeat || mySeat.eliminated) {
    localStorage.removeItem(ACTIVE_GAME_KEY);
    return;
  }
  const savedGame = createRecoverableGameState(game);
  localStorage.setItem(ACTIVE_GAME_KEY, JSON.stringify({
    savedAt: Date.now(),
    roomCode: state.onlineRoomCode,
    mySeatIndex: state.mySeatIndex,
    game: savedGame
  }));
}

function createRecoverableGameState(game) {
  const savedGame = { ...game };
  if (game.phase !== 'ANIMATING') return savedGame;

  const movingTokenIdx = game.movingTokenIdx;
  const moveStartProg = game.moveStartProg;
  if (
    Number.isInteger(movingTokenIdx) &&
    typeof moveStartProg === 'number' &&
    game.seats[game.turnSeat]
  ) {
    savedGame.phase = 'MOVE';
    savedGame.validTokens = [movingTokenIdx];
    savedGame.seats = game.seats.map(seat => seat ? { ...seat, tokens: [...seat.tokens] } : seat);
    savedGame.seats[game.turnSeat].tokens[movingTokenIdx] = moveStartProg;
  } else {
    savedGame.phase = 'ROLL';
    savedGame.validTokens = [];
  }
  delete savedGame.movingTokenIdx;
  delete savedGame.moveStartProg;
  return savedGame;
}

export function checkSavedMatchForRejoin() {
  const banner = document.getElementById('rejoinMatchBanner');
  if (!banner) return;
  const raw = localStorage.getItem(ACTIVE_GAME_KEY);
  if (!raw) {
    banner.classList.add('hidden');
    return;
  }
  try {
    const snapshot = JSON.parse(raw);
    const mySeat = snapshot.game?.seats?.[snapshot.mySeatIndex];
    const maxMiss = getMaxMissedTurns();
    if (snapshot.game && snapshot.game.phase !== 'GAMEOVER' && mySeat && !mySeat.eliminated) {
      document.getElementById('rejoinMatchInfoText').textContent =
        snapshot.game.mode === 'online'
          ? `You are active in Online Room ${snapshot.roomCode} (${mySeat.missedTurns || 0}/${maxMiss} misses). Tap to resume!`
          : `You have an active Local Pass & Play match in progress. Tap to resume!`;
      banner.classList.remove('hidden');
    } else {
      localStorage.removeItem(ACTIVE_GAME_KEY);
      banner.classList.add('hidden');
    }
  } catch (e) {
    localStorage.removeItem(ACTIVE_GAME_KEY);
    banner.classList.add('hidden');
  }
}

function pushOnlineState(reliable = false) {
  persistActiveMatchSnapshot();
  if (state.game && state.game.mode === 'online') {
    state.game.masterMobile = getMasterClientMobile(state.game);
    const publicState = {
      ...state.game,
      validTokens: []
    };
    if (reliable && state.realtimeChannel) {
      return state.realtimeChannel.send({
        type: 'broadcast',
        event: 'game_state',
        payload: publicState
      });
    }
    return sendMatchEvent('game_state', publicState);
  }
  return Promise.resolve();
}

export async function forfeitCurrentPlayer() {
  const game = state.game;
  if (!game || game.phase === 'GAMEOVER') return;
  const forfeitingSeatIdx = state.mySeatIndex;
  const forfeitingSeat = game.seats[forfeitingSeatIdx];
  if (!forfeitingSeat || forfeitingSeat.eliminated) return;

  forfeitingSeat.eliminated = true;
  forfeitingSeat.forfeited = true;
  promoteHostAfterElimination(game, forfeitingSeatIdx);
  game.masterMobile = getMasterClientMobile(game);
  delete game.movingTokenIdx;
  delete game.moveStartProg;
  state.isAnimatingMove = false;

  const survivingSeats = game.activeSeats.filter(seatIdx =>
    game.seats[seatIdx] && !game.seats[seatIdx].eliminated
  );

  if (survivingSeats.length <= 1) {
    game.turnSeq = (game.turnSeq || 0) + 1;
    game.phase = 'GAMEOVER';
    game.winnerSeat = survivingSeats[0] ?? game.turnSeat;
    game.validTokens = [];
  } else {
    // Players are NOT alone: keep match alive and shift turn on time-based clock
    if (game.turnSeat === forfeitingSeatIdx) {
      const currentIndex = game.activeSeats.indexOf(game.turnSeat);
      for (let offset = 1; offset <= game.activeSeats.length; offset++) {
        const candidate = game.activeSeats[(currentIndex + offset) % game.activeSeats.length];
        if (game.seats[candidate] && !game.seats[candidate].eliminated) {
          game.turnSeat = candidate;
          break;
        }
      }
    }
    game.turnSeq = (game.turnSeq || 0) + 1;
    game.phase = 'ROLL';
    game.diceValue = null;
    game.consecutiveSixes = 0;
    game.validTokens = [];
    game.turnStartedAt = Date.now();
    restartTurnTimer();
  }

  syncGameUI();
  const sendStatus = await pushOnlineState(true);
  if (game.mode === 'online' && state.realtimeChannel && sendStatus !== 'ok') {
    throw new Error(`Forfeit broadcast failed (${sendStatus}).`);
  }
}

function sendPrivateDiceRollToRoller(seatObj, rolled, streak, legal, phase) {
  if (!state.game || state.game.mode !== 'online') return;
  if (!seatObj || !seatObj.mobile || seatObj.mobile === 'LOCAL') return;
  sendMatchEvent(
    'private_dice_roll',
    {
      targetMobile: seatObj.mobile,
      turnSeq: state.game.turnSeq,
      diceValue: rolled,
      consecutiveSixes: streak,
      validTokens: legal,
      phase
    },
    seatObj.mobile
  );
}

function handleIncomingMatchEvent(event, payload, isRejoinSync = false) {
  if (!payload && event !== 'rejoin_sync_req') return;

  if (event === 'rejoin_sync_req') {
    if (state.game && payload.mobile && payload.mobile !== state.account.mobile) {
      const isMaster = isCurrentUserMasterClient(state.game);
      const requesterTurnSeq = Number(payload.turnSeq || 0);
      const localTurnSeq = Number(state.game.turnSeq || 0);
      if (!isMaster && localTurnSeq < requesterTurnSeq) return;
      const syncPayload = {
        targetMobile: payload.mobile,
        gameState: createRecoverableGameState(state.game)
      };
      if (state.realtimeChannel) {
        sendRoomBroadcast('rejoin_sync_state', syncPayload);
      }
      sendMatchEvent('rejoin_sync_state', syncPayload, payload.mobile);
    }
    return;
  }

  if (event === 'rejoin_sync_state') {
    if (payload.targetMobile !== state.account.mobile || !payload.gameState) return;
    handleIncomingMatchEvent('game_state', payload.gameState, true);
    return;
  }

  if (event === 'dice_rolled') {
    if (!state.game || state.game.phase === 'GAMEOVER') return;
    const { seatIndex, diceValue, turnSeq } = payload;
    if (typeof turnSeq === 'number' && typeof state.game.turnSeq === 'number' && turnSeq < state.game.turnSeq) return;
    if (typeof seatIndex === 'number' && state.game.seats[seatIndex]) {
      state.game.seats[seatIndex].lastDiceRoll = diceValue;
    }
    if (seatIndex === state.game.turnSeat) {
      state.game.diceValue = diceValue;
      if (payload.phase === 'MOVE' || payload.phase === 'ROLL') {
        state.game.phase = payload.phase;
      }
      if (Array.isArray(payload.validTokens)) {
        state.game.validTokens = payload.validTokens;
      }
      if (typeof payload.consecutiveSixes === 'number') {
        state.game.consecutiveSixes = payload.consecutiveSixes;
      }
      renderDiceFaces(diceValue);
    }
    syncGameUI();
    persistActiveMatchSnapshot();
    return;
  }

  if (event === 'private_dice_roll') {
    if (payload.targetMobile !== state.account.mobile) return;
    if (!state.game || state.game.phase === 'GAMEOVER') return;
    if (typeof payload.turnSeq === 'number' && typeof state.game.turnSeq === 'number' && payload.turnSeq < state.game.turnSeq) return;
    state.game.diceValue = payload.diceValue;
    if (state.game.seats[state.game.turnSeat]) {
      state.game.seats[state.game.turnSeat].lastDiceRoll = payload.diceValue;
    }
    state.game.consecutiveSixes = payload.consecutiveSixes;
    state.game.validTokens = payload.validTokens || [];
    state.game.phase = payload.phase;
    renderDiceFaces(payload.diceValue);
    syncGameUI();
    persistActiveMatchSnapshot();
    return;
  }

  if (event === 'game_state') {
    if (payload && payload.mode === 'online' && Number(payload.stake || 0) > 0 && !state.stakeDeductedForCurrentMatch) {
      deductStakeOnMatchStart(payload.stake, state.onlineRoomCode || payload.code || 'ONLINE', payload.matchSessionId || '');
    }
    if (!state.game) {
      state.game = payload;
    } else {
      const localSeq = Number(state.game.turnSeq || 0);
      const incomingSeq = Number(payload.turnSeq || 0);
      if (state.game.phase === 'GAMEOVER' && payload.phase !== 'GAMEOVER') return;
      if (incomingSeq < localSeq && payload.phase !== 'GAMEOVER') return;
      if (awaitingRejoinSync && !isRejoinSync && incomingSeq <= localSeq) return;

      const prevDice = state.game.diceValue;
      const prevValid = state.game.validTokens;
      const prevPhase = state.game.phase;
      const prevSeats = state.game.seats;
      const prevTurnSeat = state.game.turnSeat;

      state.game = payload;

      if (Array.isArray(prevSeats) && Array.isArray(state.game.seats)) {
        state.game.seats.forEach((s, idx) => {
          if (!s) return;
          if (s.lastDiceRoll == null && prevSeats[idx]?.lastDiceRoll != null) {
            s.lastDiceRoll = prevSeats[idx].lastDiceRoll;
          }
          s.missedTurns = Math.max(Number(s.missedTurns || 0), Number(prevSeats[idx]?.missedTurns || 0));
          s.eliminated = Boolean(s.eliminated || prevSeats[idx]?.eliminated);
          s.forfeited = Boolean(s.forfeited || prevSeats[idx]?.forfeited);
        });
      }

      if (
        !awaitingRejoinSync &&
        state.game.turnSeat === state.mySeatIndex &&
        prevTurnSeat === state.mySeatIndex &&
        incomingSeq === localSeq &&
        prevPhase === 'MOVE' &&
        state.game.phase === 'MOVE' &&
        Array.isArray(prevValid) &&
        prevValid.length > 0
      ) {
        state.game.diceValue = prevDice;
        state.game.validTokens = prevValid;
        if (prevSeats[state.mySeatIndex]?.lastDiceRoll != null && state.game.seats[state.mySeatIndex]) {
          state.game.seats[state.mySeatIndex].lastDiceRoll = prevSeats[state.mySeatIndex].lastDiceRoll;
        }
      }
    }

    state.game.masterMobile = getMasterClientMobile(state.game);
    finishRejoinSyncWait();
    state.isAnimatingMove = false;
    if (
      state.game.phase !== 'GAMEOVER' &&
      state.game.seats[state.mySeatIndex]?.eliminated
    ) {
      persistActiveMatchSnapshot();
      stopTurnTimer();
      showToast('You were eliminated from this match.', 'danger');
      cleanupOnlineChannel();
      state.game = null;
      state.autoMatchLocked = false;
      updateAutoMatchButtonState();
      switchView('lobby');
      return;
    }
    persistActiveMatchSnapshot();
    restartTurnTimer();
    syncGameUI();
    if (state.game.phase === 'GAMEOVER' && state.game.winnerSeat !== null) {
      handleVictoryTrigger(state.game.winnerSeat);
    }
    return;
  }

  if (event === 'emoji') {
    spawnFloatingEmoji(payload.emoji, payload.seat);
  }
}

function joinRealtimeRoom(code, isHost, isRejoining = false, onConnected = null) {
  cleanupOnlineChannel();
  state.onlineRoomCode = code;
  if (isRejoining && !onConnected) beginRejoinSyncWait();
  state.realtimeChannel = supabase.channel(`ludo-mobile-${code}`, { config: { broadcast: { self: false } } });

  let onConnectedCalled = false;
  const runOnConnected = () => {
    if (!onConnected || onConnectedCalled) return;
    onConnectedCalled = true;
    Promise.resolve(onConnected()).catch(err => {
      showToast(err.message || 'Could not complete the requested match action.', 'danger');
    });
  };

  state.realtimeChannel
    .on('broadcast', { event: 'webrtc_signal' }, ({ payload }) => handleWebRtcSignal(payload))
    .on('broadcast', { event: 'player_join_req' }, async ({ payload }) => {
      if (!isHost || !state.waitingRoomState || state.waitingRoomState.status !== 'WAITING') return;
      const alreadySeated = state.waitingRoomState.seats.some(s => s && s.mobile === payload.mobile);
      if (alreadySeated) {
        state.realtimeChannel.send({ type: 'broadcast', event: 'room_sync', payload: state.waitingRoomState });
        return;
      }
      const openSeat = state.waitingRoomState.activeSeats.find(s => !state.waitingRoomState.seats[s]);
      if (openSeat === undefined) return;
      state.waitingRoomState.seats[openSeat] = {
        name: payload.name,
        isAI: false,
        mobile: payload.mobile,
        depositedByBroker: payload.depositedByBroker || null,
        tokens: [-1, -1, -1, -1],
        finishedCount: 0,
        missedTurns: 0,
        eliminated: false,
        lastDiceRoll: null
      };
      const allFull = state.waitingRoomState.activeSeats.every(s => state.waitingRoomState.seats[s] !== null);
      if (allFull) {
        stopMatchmakingCountdown();
        state.waitingRoomState.status = 'PLAYING';
        state.waitingRoomState.matchSessionId = `${state.waitingRoomState.code}-${Date.now()}`;
        state.autoMatchLocked = false;
        updateAutoMatchButtonState();
        await updateLobbyPresenceRoom(null);

        const stake = Number(state.waitingRoomState.stake || 0);
        const sessionId = state.waitingRoomState.matchSessionId;
        const seatedPlayers = state.waitingRoomState.activeSeats
          .map(idx => state.waitingRoomState.seats[idx])
          .filter(s => s && s.mobile && s.mobile !== 'LOCAL');

        for (const pSeat of seatedPlayers) {
          if (pSeat.mobile === state.account.mobile) {
            const selfOk = await deductStakeOnMatchStart(stake, state.waitingRoomState.code, sessionId);
            if (!selfOk) {
              showToast('Coin deduction failed — match aborted.', 'danger');
              await cancelWaitingRoomAndUnlock();
              return;
            }
          } else {
            const peerRes = await deductPlayerWalletStakeOnce(pSeat.mobile, stake, state.waitingRoomState.code, sessionId);
            if (!peerRes.ok) {
              showToast(`${pSeat.name}'s wallet deduction failed — match aborted.`, 'danger');
              await cancelWaitingRoomAndUnlock();
              return;
            }
          }
        }
      } else {
        await updateLobbyPresenceRoom(state.waitingRoomState);
      }
      state.realtimeChannel.send({ type: 'broadcast', event: 'room_sync', payload: state.waitingRoomState });
      if (state.waitingRoomState.status === 'PLAYING') {
        state.game = createInitialGameState(state.waitingRoomState);
        state.game.mode = 'online';
        state.game.hostMobile = state.account.mobile;
        state.game.masterMobile = getMasterClientMobile(state.game);
        state.game.matchSessionId = state.waitingRoomState.matchSessionId;
        await initiateMeshConnectionsForMatch(state.game.seats);
        await enterGameView();
        pushOnlineState(true);
        setTimeout(() => {
          if (state.game && state.game.mode === 'online' && state.game.turnSeq === 1) {
            pushOnlineState(true);
          }
        }, 600);
      } else {
        renderWaitingRoom(state.waitingRoomState);
      }
    })
    .on('broadcast', { event: 'rejoin_sync_req' }, ({ payload }) => handleIncomingMatchEvent('rejoin_sync_req', payload || {}))
    .on('broadcast', { event: 'rejoin_sync_state' }, ({ payload }) => handleIncomingMatchEvent('rejoin_sync_state', payload || {}))
    .on('broadcast', { event: 'room_sync' }, async ({ payload }) => {
      state.waitingRoomState = payload;
      const seatIdx = payload.seats.findIndex(s => s && s.mobile === state.account.mobile);
      if (seatIdx !== -1) state.mySeatIndex = seatIdx;
      if (payload.status === 'WAITING') {
        renderWaitingRoom(payload);
        switchView('waiting');
      } else if (payload.status === 'PLAYING') {
        stopMatchmakingCountdown();
        state.autoMatchLocked = false;
        updateAutoMatchButtonState();
        const deducted = await deductStakeOnMatchStart(payload.stake, payload.code, payload.matchSessionId || '');
        if (!deducted) {
          showToast('Coin deduction failed — could not enter match.', 'danger');
          cleanupOnlineChannel();
          state.waitingRoomState = null;
          await switchView('lobby');
          return;
        }
        state.game = createInitialGameState(payload);
        state.game.mode = 'online';
        state.game.hostMobile = payload.hostMobile;
        state.game.masterMobile = getMasterClientMobile(state.game);
        state.game.matchSessionId = payload.matchSessionId || '';
        await initiateMeshConnectionsForMatch(state.game.seats);
        await enterGameView();
      }
    })
    .on('broadcast', { event: 'dice_rolled' }, ({ payload }) => handleIncomingMatchEvent('dice_rolled', payload))
    .on('broadcast', { event: 'private_dice_roll' }, ({ payload }) => handleIncomingMatchEvent('private_dice_roll', payload))
    .on('broadcast', { event: 'game_state' }, ({ payload }) => handleIncomingMatchEvent('game_state', payload))
    .on('broadcast', { event: 'emoji' }, ({ payload }) => handleIncomingMatchEvent('emoji', payload))
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        if (onConnected) {
          runOnConnected();
        } else if (isRejoining) {
          if (state.game && Array.isArray(state.game.seats)) {
            initiateMeshConnectionsForMatch(state.game.seats);
          }
          if (awaitingRejoinSync) {
            requestRejoinSyncState();
            if (rejoinSyncRetryInterval) clearInterval(rejoinSyncRetryInterval);
            rejoinSyncRetryInterval = setInterval(requestRejoinSyncState, 1000);
          }
        } else if (!isHost) {
          const sendJoinReq = () => {
            if (!state.realtimeChannel || state.game || (state.waitingRoomState && state.waitingRoomState.status === 'PLAYING')) return;
            state.realtimeChannel.send({
              type: 'broadcast',
              event: 'player_join_req',
              payload: {
                mobile: state.account.mobile,
                name: state.account.username,
                depositedByBroker: state.account.depositedByBroker || null
              }
            });
          };
          sendJoinReq();
          const joinRetry = setInterval(() => {
            if (!state.realtimeChannel || state.game || (state.waitingRoomState && state.waitingRoomState.status === 'PLAYING')) {
              clearInterval(joinRetry);
              return;
            }
            sendJoinReq();
          }, 1200);
        }
      } else if (onConnected && (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED')) {
        runOnConnected();
      }
    });
}

export function stopTurnTimer() {
  if (turnTimerInterval) {
    clearInterval(turnTimerInterval);
    turnTimerInterval = null;
  }
}

function updateTimerBadgeUI() {
  const badge = document.getElementById('turnTimerBadge');
  if (!badge) return;
  badge.textContent = `${turnSecondsLeft}s`;
  if (turnSecondsLeft <= 7) {
    badge.className = 'px-2 py-0.5 rounded-full bg-rose-500/25 border border-rose-400/60 text-rose-300 font-black text-xs tabular-nums animate-pulse';
  } else if (turnSecondsLeft <= 15) {
    badge.className = 'px-2 py-0.5 rounded-full bg-amber-500/25 border border-amber-400/50 text-amber-300 font-black text-xs tabular-nums';
  } else {
    badge.className = 'px-2 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-400/40 text-emerald-300 font-black text-xs tabular-nums';
  }
}

function syncTurnCountdownFromClock() {
  const game = state.game;
  if (!game || game.phase === 'GAMEOVER') return;
  const startedAt = Number(game.turnStartedAt || Date.now());
  const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
  turnSecondsLeft = Math.max(0, TURN_DURATION_SECONDS - elapsedSec);
  updateTimerBadgeUI();

  if (turnSecondsLeft > 0 && turnSecondsLeft <= 5 && canCurrentUserAct() && !state.isAnimatingMove) {
    sfx.tickWarn();
  }

  if (turnSecondsLeft === 0) {
    stopTurnTimer();
    handleTurnTimeoutAutoShift();
  }
}

function restartTurnTimer() {
  stopTurnTimer();
  const game = state.game;
  if (!game || game.phase === 'GAMEOVER') return;
  if (awaitingRejoinSync) return;
  if (!game.turnStartedAt) game.turnStartedAt = Date.now();
  syncTurnCountdownFromClock();

  turnTimerInterval = setInterval(() => {
    if (!state.game || state.game.phase === 'GAMEOVER') return;
    syncTurnCountdownFromClock();
  }, 1000);
}

async function handleTurnTimeoutAutoShift() {
  const game = state.game;
  if (!game || game.phase === 'GAMEOVER') return;

  const timeoutKey = `${state.onlineRoomCode || game.mode}:${game.turnSeq || 1}:${game.turnSeat}`;
  if (handledTimeoutKey === timeoutKey) return;
  handledTimeoutKey = timeoutKey;

  const maxMiss = getMaxMissedTurns();
  const timedOutSeatIdx = game.turnSeat;
  const seat = game.seats[timedOutSeatIdx];
  if (!seat || seat.eliminated) {
    state.isAnimatingMove = false;
    advanceTurn(false);
    return;
  }

  if (Number.isInteger(game.movingTokenIdx) && typeof game.moveStartProg === 'number') {
    seat.tokens[game.movingTokenIdx] = game.moveStartProg;
    delete game.movingTokenIdx;
    delete game.moveStartProg;
  }
  state.isAnimatingMove = false;
  seat.missedTurns = (seat.missedTurns || 0) + 1;
  showToast(`⏰ ${seat.name} missed turn (${seat.missedTurns}/${maxMiss})`, 'danger');

  if (seat.missedTurns >= maxMiss) {
    seat.eliminated = true;
    promoteHostAfterElimination(game, timedOutSeatIdx);
    game.masterMobile = getMasterClientMobile(game);
    sfx.eliminate();
    showToast(`🚫 ${seat.name} missed ${maxMiss} turns and is OUT!`, 'danger');

    const survivingSeats = game.activeSeats.filter(sIdx => game.seats[sIdx] && !game.seats[sIdx].eliminated);
    if (survivingSeats.length <= 1) {
      const winnerSeatIdx = survivingSeats.length === 1 ? survivingSeats[0] : state.mySeatIndex;
      game.turnSeq = (game.turnSeq || 0) + 1;
      game.phase = 'GAMEOVER';
      game.winnerSeat = winnerSeatIdx;
      game.validTokens = [];
      syncGameUI();
      pushOnlineState(true);
      handleVictoryTrigger(winnerSeatIdx);
      return;
    }
  }

  game.consecutiveSixes = 0;
  advanceTurn(false);
}

export async function executeTokenMove(tokenIdx) {
  const game = state.game;
  if (!game || state.isAnimatingMove || game.phase !== 'MOVE' || !game.validTokens.includes(tokenIdx)) return;
  game.phase = 'ANIMATING';
  state.isAnimatingMove = true;
  game.validTokens = [];
  syncGameUI();
  const seatIdx = game.turnSeat;
  const seat = game.seats[seatIdx];
  const startProg = seat.tokens[tokenIdx];
  game.movingTokenIdx = tokenIdx;
  game.moveStartProg = startProg;

  try {
    const diceUsed = seat.lastDiceRoll || game.diceValue || 1;
    const steps = startProg === -1 ? 1 : diceUsed;

    for (let s = 1; s <= steps; s++) {
      if (state.game !== game || game.phase !== 'ANIMATING' || game.turnSeat !== seatIdx || seat.eliminated) {
        delete game.movingTokenIdx;
        delete game.moveStartProg;
        return;
      }
      seat.tokens[tokenIdx] = startProg === -1 ? 0 : startProg + s;
      sfx.step();
      drawBoard();
      await new Promise(r => setTimeout(r, 115));
    }

    delete game.movingTokenIdx;
    delete game.moveStartProg;
    const finalProg = seat.tokens[tokenIdx];
    let earnedBonusRoll = (diceUsed === 6);

    if (finalProg === 56) {
      seat.finishedCount = seat.tokens.filter(p => p === 56).length;
      sfx.homeGoal();
      earnedBonusRoll = true;
      if (seat.finishedCount === 4) {
        game.turnSeq = (game.turnSeq || 0) + 1;
        game.phase = 'GAMEOVER';
        game.winnerSeat = seatIdx;
        state.isAnimatingMove = false;
        syncGameUI();
        pushOnlineState(true);
        handleVictoryTrigger(seatIdx);
        return;
      }
    } else if (finalProg >= 0 && finalProg <= 50) {
      const landingGlobalIdx = getGlobalTrackIndex(seatIdx, finalProg);
      if (SAFE_TRACK_INDICES.has(landingGlobalIdx)) {
        sfx.safeZone();
      } else {
        let capturedSomeone = false;
        game.activeSeats.forEach(oppSeatIdx => {
          if (oppSeatIdx === seatIdx) return;
          const oppSeat = game.seats[oppSeatIdx];
          if (!oppSeat || oppSeat.eliminated) return;
          oppSeat.tokens.forEach((oppProg, oppTokIdx) => {
            if (oppProg >= 0 && oppProg <= 50 && getGlobalTrackIndex(oppSeatIdx, oppProg) === landingGlobalIdx) {
              game.seats[oppSeatIdx].tokens[oppTokIdx] = -1;
              capturedSomeone = true;
            }
          });
        });
        if (capturedSomeone) {
          sfx.capture();
          earnedBonusRoll = true;
          showToast(`💥 ${seat.name} captured a token!`, 'gold');
        }
      }
    }

    state.isAnimatingMove = false;
    drawBoard();
    advanceTurn(earnedBonusRoll);
  } catch (err) {
    delete game.movingTokenIdx;
    delete game.moveStartProg;
    state.isAnimatingMove = false;
    if (state.game === game && game.phase === 'ANIMATING' && game.turnSeat === seatIdx) {
      advanceTurn(false);
    }
  }
}

export function advanceTurn(bonusRoll) {
  const game = state.game;
  if (!game || game.phase === 'GAMEOVER') return;
  state.isAnimatingMove = false;

  const survivingSeats = game.activeSeats.filter(sIdx => game.seats[sIdx] && !game.seats[sIdx].eliminated);
  if (survivingSeats.length <= 1) {
    const winnerSeatIdx = survivingSeats.length === 1 ? survivingSeats[0] : game.turnSeat;
    game.turnSeq = (game.turnSeq || 0) + 1;
    game.phase = 'GAMEOVER';
    game.winnerSeat = winnerSeatIdx;
    syncGameUI();
    pushOnlineState(true);
    handleVictoryTrigger(winnerSeatIdx);
    return;
  }

  if (!bonusRoll || game.seats[game.turnSeat]?.eliminated) {
    const total = game.activeSeats.length;
    let nextIdx = (game.activeSeats.indexOf(game.turnSeat) + 1) % total;
    for (let guard = 0; guard < total; guard++) {
      const candidateSeat = game.activeSeats[nextIdx];
      if (game.seats[candidateSeat] && !game.seats[candidateSeat].eliminated) {
        game.turnSeat = candidateSeat;
        break;
      }
      nextIdx = (nextIdx + 1) % total;
    }
    game.consecutiveSixes = 0;
  }

  game.masterMobile = getMasterClientMobile(game);
  game.turnSeq = (game.turnSeq || 0) + 1;
  game.phase = 'ROLL';
  game.diceValue = null;
  game.validTokens = [];
  game.turnStartedAt = Date.now();
  restartTurnTimer();
  syncGameUI();
  pushOnlineState(true);
}

async function handleVictoryTrigger(winnerSeatIdx) {
  stopTurnTimer();
  localStorage.removeItem(ACTIVE_GAME_KEY);
  resetMatchStakeLock();
  state.autoMatchLocked = false;
  updateAutoMatchButtonState();

  await fetchRemotePlatformConfig(refreshPotPreview);

  const game = state.game;
  const winnerSeat = game.seats[winnerSeatIdx];
  const meta = PLAYERS_META[winnerSeatIdx];
  const isOnlineMatch = game.mode === 'online';
  const didLocalPlayerWin = isOnlineMatch && winnerSeatIdx === state.mySeatIndex;

  const pot = Number(game.pot || 0);
  const totalGameFeePct = Number(state.platformConfig.gameFeePct ?? 20);
  const brokerCutPct = Number(state.platformConfig.brokerFeePct ?? 10);

  let winnerBrokerMobile = winnerSeat?.depositedByBroker || null;
  if (isOnlineMatch && winnerSeat?.mobile && winnerSeat.mobile !== 'LOCAL') {
    const { data: winnerAccRow } = await supabase
      .from('mobile_accounts')
      .select('deposited_by_broker')
      .eq('mobile', winnerSeat.mobile)
      .single();
    if (winnerAccRow && winnerAccRow.deposited_by_broker) {
      winnerBrokerMobile = winnerAccRow.deposited_by_broker;
    }
  }

  const totalFeeCoins = Math.floor((pot * totalGameFeePct) / 100);
  const brokerCoins = winnerBrokerMobile ? Math.floor((pot * brokerCutPct) / 100) : 0;
  const adminGameFeeCoins = Math.max(0, totalFeeCoins - brokerCoins);
  const winnerNetCoins = Math.max(0, pot - totalFeeCoins);

  if (!state.payoutProcessedForMatch && didLocalPlayerWin && pot > 0) {
    state.payoutProcessedForMatch = true;

    if (winnerNetCoins > 0) {
      await runMatchCoinRpc('payout', winnerNetCoins, `Ludo Win (${state.onlineRoomCode || 'ONLINE'})`);
    }

    if (winnerBrokerMobile && brokerCoins > 0) {
      await creditWalletCoinsReliable(
        winnerBrokerMobile,
        brokerCoins,
        'broker_fee',
        `Broker game fees (${brokerCutPct}% of ${pot})`
      );
    }

    if (adminGameFeeCoins > 0) {
      const { data: adminAcc } = await supabase
        .from('mobile_accounts')
        .select('mobile')
        .eq('role', 'admin')
        .order('created_at', { ascending: true })
        .limit(1)
        .single();

      if (adminAcc && adminAcc.mobile) {
        await creditWalletCoinsReliable(
          adminAcc.mobile,
          adminGameFeeCoins,
          'game_fee',
          `Game fees (${totalGameFeePct}% pot minus ${brokerCutPct}% broker)`
        );
      }
    }

    await refreshAccountBalance(validateWalletActionButtons);
    sfx.winFanfare();
  } else if (!isOnlineMatch) {
    sfx.winFanfare();
  }

  document.getElementById('victoryWinnerName').textContent = `${winnerSeat.name} (${meta.name}) Wins!`;
  if (!isOnlineMatch) {
    document.getElementById('victorySubtitle').textContent = 'Free Pass & Play Match Finished';
    document.getElementById('victoryPayoutAmount').textContent = '0 Coins (Free)';
    document.getElementById('victoryFeeBreakdown').textContent = 'Offline pass & play has no coin deductions.';
  } else {
    document.getElementById('victorySubtitle').textContent = didLocalPlayerWin
      ? '🏆 Credited to Your Wallet!'
      : `Match Won by ${winnerSeat.name}`;
    document.getElementById('victoryPayoutAmount').textContent = `+${winnerNetCoins.toLocaleString()} Coins`;
    document.getElementById('victoryFeeBreakdown').textContent =
      `Pot: ${pot} • Game Fees (${totalGameFeePct}%): ${totalFeeCoins} (Admin: ${adminGameFeeCoins}` +
      (brokerCoins > 0 ? `, Broker: ${brokerCoins})` : ')');
  }
  document.getElementById('victoryModal').classList.remove('hidden');
}

function spawnFloatingEmoji(emoji, seatIdx = 0) {
  const overlay = document.getElementById('emojiOverlay');
  if (!overlay) return;
  const el = document.createElement('div');
  const positions = ['left-6 bottom-6', 'left-6 top-6', 'right-6 top-6', 'right-6 bottom-6'];
  el.className = `emoji-float absolute text-3xl sm:text-4xl drop-shadow-lg ${positions[seatIdx] || positions[0]}`;
  el.textContent = emoji;
  overlay.appendChild(el);
  setTimeout(() => el.remove(), 2150);
}

async function enterGameView() {
  state.payoutProcessedForMatch = false;
  await fetchRemotePlatformConfig(refreshPotPreview);
  persistActiveMatchSnapshot();
  switchView('game');
  updateP2PStatusBadge();
  renderDiceFaces(state.game.diceValue ?? 6);
  restartTurnTimer();
  syncGameUI();
  if (state.animFrameId) cancelAnimationFrame(state.animFrameId);
  const loop = () => {
    if (state.game) drawBoard();
    state.animFrameId = requestAnimationFrame(loop);
  };
  state.animFrameId = requestAnimationFrame(loop);
}

export function syncGameUI() {
  const game = state.game;
  if (!game) return;
  const maxMiss = getMaxMissedTurns();
  updateP2PStatusBadge();
  document.getElementById('activePotDisplay').textContent = game.mode === 'local' ? 'FREE' : game.pot.toLocaleString();
  const roomBadge = document.getElementById('roomBadgeInGame');
  if (game.mode === 'online' && state.onlineRoomCode) {
    roomBadge.textContent = `ROOM: ${state.onlineRoomCode}`;
    roomBadge.classList.remove('hidden');
  } else {
    roomBadge.classList.add('hidden');
  }

  const activeSeat = game.seats[game.turnSeat];
  const activeMeta = PLAYERS_META[game.turnSeat];
  const isMyTurn = canCurrentUserAct();
  const promptEl = document.getElementById('turnPromptText');
  const forfeitBtn = document.getElementById('forfeitMatchBtn');
  forfeitBtn.disabled = game.phase === 'GAMEOVER' || Boolean(game.seats[state.mySeatIndex]?.eliminated);
  const activeRollVal = game.diceValue ?? activeSeat?.lastDiceRoll ?? null;

  if (game.phase === 'GAMEOVER') {
    promptEl.textContent = `${game.seats[game.winnerSeat]?.name || activeSeat.name} Won!`;
  } else if (game.phase === 'MOVE') {
    promptEl.textContent = isMyTurn ? `Rolled ${activeRollVal ?? game.diceValue}: Pick token` : `${activeSeat.name}: Choosing move...`;
  } else {
    promptEl.textContent = isMyTurn ? `Your Turn — Roll Dice` : `${activeSeat.name}'s Turn`;
  }
  promptEl.style.color = activeMeta.light;

  if (game.diceValue != null) {
    renderDiceFaces(game.diceValue);
  } else {
    renderDiceFaces(6);
  }

  for (let i = 0; i < 4; i++) {
    const card = document.getElementById(`playerCard-${i}`);
    const seat = game.seats[i];
    const meta = PLAYERS_META[i];
    if (!seat) {
      card.innerHTML = `<div class="flex items-center gap-2 opacity-35"><span class="w-3 h-3 rounded-full" style="background:${meta.color}"></span><span class="text-xs font-bold text-slate-400">Empty Seat</span></div>`;
      card.classList.remove('turn-card-glow', 'opacity-45');
      continue;
    }
    card.classList.toggle('turn-card-glow', game.turnSeat === i && game.phase !== 'GAMEOVER' && !seat.eliminated);
    card.classList.toggle('opacity-45', Boolean(seat.eliminated));

    const pipsHtml = seat.tokens.map(p => {
      if (p === 56) return `<span class="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block"></span>`;
      if (p >= 0) return `<span class="w-2.5 h-2.5 rounded-full inline-block" style="background:${meta.color}"></span>`;
      return `<span class="w-2.5 h-2.5 rounded-full bg-slate-700 border border-white/20 inline-block"></span>`;
    }).join('');

    const lastRollText = seat.lastDiceRoll ? `🎲 ${seat.lastDiceRoll}` : '🎲 -';
    const misses = seat.missedTurns || 0;
    const statusLabel = seat.eliminated
      ? `<span class="text-[10px] font-black text-rose-400">${seat.forfeited ? 'FORFEIT' : `OUT (${maxMiss}/${maxMiss})`}</span>`
      : `<span class="text-[10px] font-bold ${misses >= Math.max(1, maxMiss - 1) ? 'text-rose-400' : 'text-slate-400'}">Miss: ${misses}/${maxMiss}</span>`;

    card.innerHTML = `
      <div class="flex items-center justify-between gap-1.5">
        <div class="flex items-center gap-1.5 min-w-0">
          <span class="w-3.5 h-3.5 rounded-full shrink-0" style="background:${meta.color}"></span>
          <span class="text-xs sm:text-sm font-extrabold text-white truncate">${seat.name}</span>
          <span class="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-400/40 text-amber-300 font-black text-[10px] shrink-0">${lastRollText}</span>
        </div>
        <span class="text-[10px] font-black px-1.5 py-0.5 rounded bg-slate-950/80 text-slate-300 shrink-0">
          ${seat.eliminated ? 'OUT' : (game.mode === 'online' && i === state.mySeatIndex ? 'YOU' : meta.name.toUpperCase())}
        </span>
      </div>
      <div class="mt-2 flex items-center justify-between">
        <div class="flex items-center gap-1">${pipsHtml}</div>
        <div class="flex items-center gap-2">
          ${statusLabel}
          <span class="text-[10px] font-bold text-amber-300">${seat.finishedCount}/4</span>
        </div>
      </div>
    `;
  }

  const canRoll = isMyTurn && game.phase === 'ROLL';
  const diceBtn = document.getElementById('diceBtn');
  const rollActionBtn = document.getElementById('rollActionBtn');
  diceBtn.classList.toggle('active-turn', canRoll);
  rollActionBtn.disabled = !canRoll;
  rollActionBtn.classList.toggle('opacity-45', !canRoll);
  rollActionBtn.textContent = canRoll ? 'Roll Dice' : (isMyTurn && game.phase === 'MOVE' ? `Rolled ${activeRollVal ?? game.diceValue}` : 'Wait...');
  drawBoard();
}

export async function triggerDiceRoll() {
  await executeDiceRoll({
    sendMatchEvent,
    sendPrivateDiceRollToRoller,
    syncGameUI,
    advanceTurn,
    executeTokenMove
  });
}

async function applyForfeitAndLeave() {
  document.getElementById('forfeitMatchBtn').disabled = true;
  document.getElementById('discardRejoinBtn').disabled = true;
  try {
    await forfeitCurrentPlayer();
  } catch (err) {
    showToast(`Forfeit sync failed: ${err.message || 'connection unavailable'}`, 'danger');
  } finally {
    localStorage.removeItem(ACTIVE_GAME_KEY);
    state.isAnimatingMove = false;
    state.autoMatchLocked = false;
    updateAutoMatchButtonState();
    stopTurnTimer();
    cleanupOnlineChannel();
    state.game = null;
    document.getElementById('victoryModal').classList.add('hidden');
    document.getElementById('forfeitMatchBtn').disabled = false;
    document.getElementById('discardRejoinBtn').disabled = false;
    await switchView('lobby');
  }
}

function updateHomeRefreshButtonUI() {
  const btn = document.getElementById('homeRefreshBtn');
  if (!btn) return;
  const now = Date.now();
  if (now < homeRefreshCooldownUntil) {
    const secs = Math.ceil((homeRefreshCooldownUntil - now) / 1000);
    btn.disabled = true;
    btn.textContent = `↻ ${secs}s`;
  } else {
    btn.disabled = false;
    btn.textContent = '↻ Refresh';
  }
}

export function initGameBindings() {
  renderStakeButtons();

  document.getElementById('homeRefreshBtn').addEventListener('click', async () => {
    if (Date.now() < homeRefreshCooldownUntil) return;
    homeRefreshCooldownUntil = Date.now() + 5000;
    updateHomeRefreshButtonUI();
    if (homeRefreshTimer) clearInterval(homeRefreshTimer);
    homeRefreshTimer = setInterval(() => {
      updateHomeRefreshButtonUI();
      if (Date.now() >= homeRefreshCooldownUntil) {
        clearInterval(homeRefreshTimer);
        homeRefreshTimer = null;
      }
    }, 200);

    await refreshAccountBalance(validateWalletActionButtons);
    await fetchRemotePlatformConfig(refreshPotPreview);
    checkSavedMatchForRejoin();
    renderHomeQueueBoards();
    showToast('Home refreshed (5s lock active)', 'success');
  });

  document.querySelectorAll('.pcount-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.selectedPlayerCount = parseInt(btn.dataset.pcount, 10);
      document.querySelectorAll('.pcount-btn').forEach(b => {
        b.classList.remove('bg-amber-500', 'text-slate-950', 'shadow');
        b.classList.add('text-slate-300');
      });
      btn.classList.add('bg-amber-500', 'text-slate-950', 'shadow');
      btn.classList.remove('text-slate-300');
      refreshPotPreview();
    });
  });

  document.getElementById('muteToggleBtn').addEventListener('click', () => {
    sfx.muted = !sfx.muted;
    document.getElementById('soundOnIcon').classList.toggle('hidden', sfx.muted);
    document.getElementById('soundOffIcon').classList.toggle('hidden', !sfx.muted);
  });

  document.getElementById('startAutoMatchBtn').addEventListener('click', async () => {
    if (isUserCurrentlyInMatchOrMatchmaking()) {
      return showToast('Cannot start matchmaking while in a game or already matching.', 'danger');
    }
    if (Number(state.account.coins) < Number(state.selectedStake)) {
      return showToast(`Insufficient balance (${state.account.coins}) for ${state.selectedStake} coin stake.`, 'danger');
    }

    state.autoMatchLocked = true;
    updateAutoMatchButtonState();

    let matchingRoom = null;
    state.liveOpenRoomsMap.forEach(r => {
      if (!matchingRoom && r.playerCount === state.selectedPlayerCount && r.stake === state.selectedStake && r.hostMobile !== state.account.mobile) {
        matchingRoom = r;
      }
    });

    if (matchingRoom) {
      resetMatchStakeLock();
      showToast(`Matched into ${matchingRoom.hostName}'s table!`, 'success');
      joinRealtimeRoom(matchingRoom.code, false);
    } else {
      await hostOnlineTable(true);
    }
  });

  document.getElementById('createOnlineRoomBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled || isUserCurrentlyInMatchOrMatchmaking()) {
      return showToast('Finish or leave your active match/matchmaking first.', 'danger');
    }
    if (Number(state.account.coins) < Number(state.selectedStake)) {
      return showToast(`Insufficient balance (${state.account.coins}) for ${state.selectedStake} coin stake.`, 'danger');
    }
    btn.disabled = true;
    state.autoMatchLocked = true;
    updateAutoMatchButtonState();
    try {
      await hostOnlineTable(false);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('joinOnlineRoomBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled || isUserCurrentlyInMatchOrMatchmaking()) {
      return showToast('Finish or leave your active match/matchmaking first.', 'danger');
    }
    const code = document.getElementById('joinRoomCodeInput').value.trim().toUpperCase();
    if (code.length < 4) return showToast('Enter a valid room code.', 'danger');
    const queuedRoom = state.liveOpenRoomsMap.get(code);
    const entryCost = queuedRoom ? queuedRoom.stake : state.selectedStake;
    if (Number(state.account.coins) < Number(entryCost)) {
      return showToast(`Insufficient balance (${state.account.coins}) for ${entryCost} coin stake.`, 'danger');
    }
    btn.disabled = true;
    state.autoMatchLocked = true;
    updateAutoMatchButtonState();
    resetMatchStakeLock();
    joinRealtimeRoom(code, false);
    setTimeout(() => { btn.disabled = false; }, 1500);
  });

  document.getElementById('startLocalBtn').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    if (btn.disabled || isUserCurrentlyInMatchOrMatchmaking()) return;
    btn.disabled = true;
    setTimeout(() => { btn.disabled = false; }, 1000);
    cleanupOnlineChannel();
    const seats = [null, null, null, null];
    const activeIndices = state.selectedPlayerCount === 2 ? [0, 2] : [0, 1, 2, 3];
    activeIndices.forEach((seatIdx, i) => {
      seats[seatIdx] = {
        name: i === 0 ? state.account.username : `${PLAYERS_META[seatIdx].name} P${i + 1}`,
        isAI: false,
        mobile: i === 0 ? state.account.mobile : 'LOCAL',
        depositedByBroker: null,
        tokens: [-1, -1, -1, -1],
        finishedCount: 0,
        missedTurns: 0,
        eliminated: false,
        lastDiceRoll: null
      };
    });
    state.mySeatIndex = 0;
    state.game = createInitialGameState({ mode: 'local', playerCount: state.selectedPlayerCount, stake: 0, seats });
    showToast('Free Pass & Play started (0 coins deducted)', 'success');
    enterGameView();
  });

  document.getElementById('copyRoomCodeBtn').addEventListener('click', () => {
    const code = document.getElementById('waitingRoomCodeText').textContent;
    navigator.clipboard?.writeText(code);
    showToast(`Copied ${code}`, 'success');
  });

  document.getElementById('cancelWaitingBtn').addEventListener('click', cancelWaitingRoomAndUnlock);

  let isRejoiningInProgress = false;
  document.getElementById('rejoinMatchBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (isRejoiningInProgress || btn.disabled) return;
    const raw = localStorage.getItem(ACTIVE_GAME_KEY);
    if (!raw) return;

    isRejoiningInProgress = true;
    btn.disabled = true;
    const origText = btn.textContent;
    btn.textContent = 'Rejoining...';

    try {
      const snapshot = JSON.parse(raw);
      state.game = snapshot.game;
      state.mySeatIndex = snapshot.mySeatIndex;
      state.isAnimatingMove = false;
      if (state.game.mode === 'online' && snapshot.roomCode) {
        joinRealtimeRoom(snapshot.roomCode, state.game.hostMobile === state.account.mobile, true);
      }
      await enterGameView();
      showToast('Reconnected back to your match!', 'success');
    } catch (err) {
      localStorage.removeItem(ACTIVE_GAME_KEY);
      checkSavedMatchForRejoin();
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = origText;
        isRejoiningInProgress = false;
      }, 1500);
    }
  });

  document.getElementById('discardRejoinBtn').addEventListener('click', () => {
    if (!window.confirm('Forfeit this match? Your seat will be eliminated.')) return;
    const raw = localStorage.getItem(ACTIVE_GAME_KEY);
    if (!raw) return;
    try {
      const snapshot = JSON.parse(raw);
      state.game = snapshot.game;
      state.mySeatIndex = snapshot.mySeatIndex;
      state.isAnimatingMove = false;
      if (state.game.mode === 'online' && snapshot.roomCode) {
        joinRealtimeRoom(
          snapshot.roomCode,
          state.game.hostMobile === state.account.mobile,
          true,
          applyForfeitAndLeave
        );
      } else {
        applyForfeitAndLeave();
      }
    } catch (e) {
      localStorage.removeItem(ACTIVE_GAME_KEY);
      checkSavedMatchForRejoin();
      showToast(e.message || 'Could not forfeit the saved match.', 'danger');
    }
  });

  document.getElementById('forfeitMatchBtn').addEventListener('click', async () => {
    if (!state.game || state.game.phase === 'GAMEOVER') return;
    if (!window.confirm('Forfeit this match? Your seat will be eliminated.')) return;
    document.getElementById('forfeitMatchBtn').disabled = true;
    await applyForfeitAndLeave();
  });

  document.getElementById('leaveMatchBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      if (!state.game && state.waitingRoomState && state.waitingRoomState.status === 'WAITING') {
        await cancelWaitingRoomAndUnlock();
        return;
      }
      if (state.game && state.game.phase !== 'GAMEOVER' && !state.game.seats[state.mySeatIndex]?.eliminated) {
        persistActiveMatchSnapshot();
        showToast('Exited board — you can rejoin from Lobby while still active!', 'gold');
      }
      state.autoMatchLocked = false;
      updateAutoMatchButtonState();
      stopTurnTimer();
      stopMatchmakingCountdown();
      state.isAnimatingMove = false;
      cleanupOnlineChannel();
      state.game = null;
      document.getElementById('victoryModal').classList.add('hidden');
      await switchView('lobby');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('victoryLobbyBtn').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;
    setTimeout(() => { btn.disabled = false; }, 1000);
    document.getElementById('victoryModal').classList.add('hidden');
    state.isAnimatingMove = false;
    cleanupOnlineChannel();
    state.game = null;
    switchView('lobby');
  });

  document.getElementById('victoryRematchBtn').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;
    setTimeout(() => { btn.disabled = false; }, 1200);
    document.getElementById('victoryModal').classList.add('hidden');
    const prevMode = state.game?.mode || 'online';
    state.isAnimatingMove = false;
    cleanupOnlineChannel();
    state.game = null;
    switchView('lobby');
    if (prevMode === 'local') document.getElementById('startLocalBtn').click();
    else document.getElementById('startAutoMatchBtn').click();
  });

  document.querySelectorAll('.emoji-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const emoji = btn.dataset.emoji;
      spawnFloatingEmoji(emoji, state.mySeatIndex);
      if (state.game && state.game.mode === 'online') {
        sendMatchEvent('emoji', { emoji, seat: state.mySeatIndex });
      }
    });
  });

  document.addEventListener('visibilitychange', () => {
    if (state.game && state.game.phase !== 'GAMEOVER') {
      if (document.hidden) {
        persistActiveMatchSnapshot();
      } else {
        syncTurnCountdownFromClock();
      }
    }
  });

  window.addEventListener('beforeunload', () => {
    if (state.game && state.game.phase !== 'GAMEOVER' && !state.game.seats[state.mySeatIndex]?.eliminated) {
      persistActiveMatchSnapshot();
    }
  });
}