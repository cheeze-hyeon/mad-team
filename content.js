/**
 * MADteam for Notion - Content Script
 * 1단계: 사이드바 에이전트 패널 + 드래그 앤 드롭 + 모드 팝업
 * 2단계: 인시튜 앵커 + 확장형 대화창 + 상태 표시
 * 3단계: 구조화 맵 UI + 맥락 재시작 (프론트만)
 */

// ----- 상태 (2·3단계에서 사용) -----
const state = {
  sessions: [], // { blockId, blockText, agentId, mode, messages[], anchorEl? }
  currentDropTarget: null, // 드롭 직후 블록/컨텍스트
};

// ----- Shadow DOM 루트 생성 (body에는 사이드바 다음에 붙여서 드롭이 host에 안 걸리게) -----
const host = document.createElement('div');
host.id = 'mad-team-root';
host.style.pointerEvents = 'none'; // 드롭/클릭이 host를 통과해 노션 쪽으로 가도록
const shadow = host.attachShadow({ mode: 'open' });

// Shadow 내부 스타일 (팝업·대화창·맵만 — 노션 CSS 격리)
const style = document.createElement('style');
style.textContent = `
  :host * { pointer-events: auto; } /* Shadow 내부 UI만 클릭/드롭 받기 */
  .mad-mode-popup {
    position: fixed;
    z-index: 10000;
    background: #fff;
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.15);
    padding: 12px;
    min-width: 180px;
  }
  .mad-mode-popup h4 { margin: 0 0 8px 0; font-size: 12px; color: #555; }
  .mad-mode-btn {
    display: block;
    width: 100%;
    padding: 8px 12px;
    margin: 4px 0;
    border: none;
    border-radius: 6px;
    background: #f5f5f5;
    cursor: pointer;
    font-size: 13px;
    text-align: left;
  }
  .mad-mode-btn:hover { background: #e8e8e8; }
  .mad-mode-btn.selected { background: #3f51b5; color: #fff; }
  .mad-anchor {
    position: absolute;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #3f51b5;
    color: #fff;
    font-size: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    z-index: 9997;
    box-shadow: 0 1px 4px rgba(0,0,0,0.2);
  }
  .mad-chat-panel {
    position: fixed;
    top: 80px;
    right: 60px;
    width: 320px;
    max-height: 400px;
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.12);
    z-index: 9999;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .mad-chat-header { padding: 12px; border-bottom: 1px solid #eee; font-size: 13px; font-weight: 600; }
  .mad-chat-messages { flex: 1; overflow-y: auto; padding: 12px; font-size: 13px; }
  .mad-chat-msg { margin-bottom: 8px; }
  .mad-chat-status {
    padding: 8px 12px;
    font-size: 12px;
    color: #666;
    border-top: 1px solid #eee;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .mad-chat-status .dot { width: 6px; height: 6px; border-radius: 50%; background: #3f51b5; animation: pulse 1s infinite; }
  @keyframes pulse { 0%,100%{ opacity:1 } 50%{ opacity:0.4 } }
  .mad-map-view {
    position: fixed;
    bottom: 24px;
    right: 80px;
    width: 280px;
    max-height: 240px;
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.12);
    z-index: 9998;
    padding: 12px;
    overflow-y: auto;
  }
  .mad-map-view h4 { margin: 0 0 8px 0; font-size: 12px; color: #555; }
  .mad-map-node {
    padding: 6px 10px;
    margin: 4px 0;
    border-radius: 6px;
    background: #f5f5f5;
    cursor: pointer;
    font-size: 12px;
  }
  .mad-map-node:hover { background: #e8e8e8; }
`;
shadow.appendChild(style);

// ----- 1-1. 사이드바 에이전트 패널 (light DOM — 드래그가 노션 블록까지 나가도록) -----
const sidebar = document.createElement('div');
sidebar.id = 'mad-sidebar';
const agents = [
  { id: 'agent-1', label: 'A1' },
  { id: 'agent-2', label: 'A2' },
];
agents.forEach((a) => {
  const icon = document.createElement('div');
  icon.className = 'mad-agent-icon';
  icon.draggable = true;
  icon.dataset.agentId = a.id;
  icon.textContent = a.label;
  sidebar.appendChild(icon);
});
document.body.appendChild(sidebar);
document.body.appendChild(host);

// ----- 1-2. 드래그 앤 드롭 -----
const MAD_DRAG_TYPE = 'application/x-mad-agent';

sidebar.querySelectorAll('.mad-agent-icon').forEach((el) => {
  el.addEventListener('dragstart', (e) => {
    const data = JSON.stringify({ agentId: el.dataset.agentId });
    e.dataTransfer.setData(MAD_DRAG_TYPE, data);
    e.dataTransfer.setData('text/plain', data);
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setDragImage(el, 20, 20);
  });
});

document.addEventListener(
  'dragover',
  (e) => {
    const types = e.dataTransfer?.types || [];
    if (types.includes(MAD_DRAG_TYPE) || types.includes('text/plain')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  },
  true
);

document.addEventListener(
  'drop',
  (e) => {
    const types = e.dataTransfer?.types || [];
    const hasData = types.includes(MAD_DRAG_TYPE) || types.includes('text/plain');
    if (!hasData) return;
    e.preventDefault();
    e.stopPropagation();

  // 노션 블록: .notion-selectable 또는 data-block-id 가진 요소
  const block =
    e.target.closest('.notion-selectable') ||
    e.target.closest('[data-block-id]') ||
    e.target.closest('.notion-block');
  if (!block) {
    console.log('[MAD] 드롭됐지만 블록 없음 — target:', e.target?.className || e.target?.tagName);
    return;
  }
  let payload;
  try {
    const raw =
      e.dataTransfer.getData(MAD_DRAG_TYPE) || e.dataTransfer.getData('text/plain');
    payload = JSON.parse(raw);
  } catch (_) {
    return;
  }
  const blockId = block.getAttribute('data-block-id') || '';
  const blockText = (block.innerText || '').trim();
  console.log('[MAD] 드롭 성공 — blockId:', blockId, 'blockText:', blockText.slice(0, 50), 'agentId:', payload.agentId);
  state.currentDropTarget = { block, blockId, blockText, agentId: payload.agentId };
  showModePopup(state.currentDropTarget);
  },
  true
);

// ----- 1-3. 인터랙션 모드 팝업 -----
function showModePopup({ block, blockId, blockText, agentId }) {
  const popup = document.createElement('div');
  popup.className = 'mad-mode-popup';
  const rect = block.getBoundingClientRect();
  popup.style.left = `${rect.left}px`;
  popup.style.top = `${rect.bottom + 8}px`;

  const title = document.createElement('h4');
  title.textContent = '모드 선택';
  popup.appendChild(title);

  const modes = ['Debate', 'Ideation', 'Evaluation'];
  modes.forEach((mode) => {
    const btn = document.createElement('button');
    btn.className = 'mad-mode-btn';
    btn.textContent = mode;
    btn.addEventListener('click', () => {
      const session = {
        blockId,
        blockText,
        agentId,
        mode,
        messages: [{ role: 'user', text: blockText }],
      };
      state.sessions.push(session);
      shadow.removeChild(popup);
      state.currentDropTarget = null;
      addAnchorForSession(session, block);
      showMapNode(session);
    });
    popup.appendChild(btn);
  });

  shadow.appendChild(popup);
}

// ----- 2-1. 인시튜 앵커 -----
function addAnchorForSession(session, block) {
  const anchor = document.createElement('div');
  anchor.className = 'mad-anchor';
  anchor.textContent = 'M';
  anchor.title = `대화 (${session.mode})`;
  const updatePosition = () => {
    const rect = block.getBoundingClientRect();
    anchor.style.top = `${rect.top}px`;
    anchor.style.left = `${rect.left - 28}px`;
  };
  updatePosition();
  window.addEventListener('scroll', updatePosition, { passive: true });
  session.anchorEl = anchor;
  shadow.appendChild(anchor);

  anchor.addEventListener('click', () => openChatPanel(session));
}

// ----- 2-2. 확장형 대화창 -----
let chatPanelEl = null;

function openChatPanel(session) {
  if (chatPanelEl && chatPanelEl.parentNode) shadow.removeChild(chatPanelEl);
  chatPanelEl = document.createElement('div');
  chatPanelEl.className = 'mad-chat-panel';
  chatPanelEl.innerHTML = `
    <div class="mad-chat-header">${session.mode} · 블록</div>
    <div class="mad-chat-messages"></div>
    <div class="mad-chat-status"><span class="dot"></span> 대화 중</div>
  `;
  const messagesEl = chatPanelEl.querySelector('.mad-chat-messages');
  session.messages.forEach((m) => {
    const p = document.createElement('div');
    p.className = 'mad-chat-msg';
    p.textContent = `${m.role === 'user' ? 'You' : 'Agent'}: ${m.text}`;
    messagesEl.appendChild(p);
  });
  shadow.appendChild(chatPanelEl);
}

// ----- 3-1. 구조화 맵 UI (프론트) -----
let mapViewEl = null;

function showMapNode(session) {
  if (!mapViewEl) {
    mapViewEl = document.createElement('div');
    mapViewEl.className = 'mad-map-view';
    mapViewEl.innerHTML = '<h4>대화 맵</h4><div class="mad-map-nodes"></div>';
    shadow.appendChild(mapViewEl);
  }
  const nodes = mapViewEl.querySelector('.mad-map-nodes');
  const node = document.createElement('div');
  node.className = 'mad-map-node';
  node.textContent = `${session.mode}: ${session.blockText.slice(0, 30)}...`;
  const sessionIndex = state.sessions.length - 1;
  node.addEventListener('click', () => {
    const s = state.sessions[sessionIndex];
    if (s) openChatPanel(s);
  });
  nodes.appendChild(node);
}
