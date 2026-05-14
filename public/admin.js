// Admin panel — board viewer + clear + AI recognize.
// Protocol: 1-byte type, then payload.
//   0x00 INIT [4096 bytes]
//   0x01 PIXEL [x, y, color]

const MSG_INIT = 0x00;
const MSG_PIXEL = 0x01;
const BOARD_SIZE = 64;

const els = {
  status: document.getElementById("status"),
  canvas: document.getElementById("board"),
  clean: document.getElementById("clean-btn"),
  recognize: document.getElementById("recognize-btn"),
  aiResults: document.getElementById("ai-results"),
  modal: document.getElementById("turnstile-modal"),
  turnstileWidget: document.getElementById("turnstile-widget"),
  toast: document.getElementById("toast"),
};

const ctx = els.canvas.getContext("2d");
const imageData = ctx.createImageData(BOARD_SIZE, BOARD_SIZE);
let palette = [];
let ws = null;
let wsBackoff = 1000;

function setStatus(text, cls) {
  els.status.textContent = text;
  els.status.className = "status" + (cls ? " " + cls : "");
}

function showToast(msg, ms = 2200) {
  els.toast.textContent = msg;
  els.toast.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => els.toast.classList.add("hidden"), ms);
}

function paintLocal(x, y, color) {
  const hex = palette[color];
  if (!hex) return;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const off = (y * BOARD_SIZE + x) * 4;
  imageData.data[off] = r;
  imageData.data[off + 1] = g;
  imageData.data[off + 2] = b;
  imageData.data[off + 3] = 255;
  ctx.putImageData(imageData, 0, 0);
}

function applySnapshot(board) {
  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      const color = board[y * BOARD_SIZE + x] & 0x0f;
      const hex = palette[color];
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      const off = (y * BOARD_SIZE + x) * 4;
      imageData.data[off] = r;
      imageData.data[off + 1] = g;
      imageData.data[off + 2] = b;
      imageData.data[off + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

function connectWS() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/api/ws`);
  ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => {
    setStatus("Connected", "connected");
    wsBackoff = 1000;
  });

  ws.addEventListener("message", (ev) => {
    const data = new Uint8Array(ev.data);
    const type = data[0];
    if (type === MSG_INIT) {
      applySnapshot(data.subarray(1));
    } else if (type === MSG_PIXEL) {
      paintLocal(data[1], data[2], data[3] & 0x0f);
    }
  });

  ws.addEventListener("close", () => {
    setStatus("Disconnected — reconnecting…", "disconnected");
    setTimeout(connectWS, wsBackoff);
    wsBackoff = Math.min(wsBackoff * 2, 30000);
  });

  ws.addEventListener("error", () => {});
}

function showTurnstile() {
  els.modal.classList.remove("hidden");
  els.turnstileWidget.innerHTML = "";
  const tryRender = () => {
    if (!window.turnstile) { setTimeout(tryRender, 100); return; }
    window.turnstile.render(els.turnstileWidget, {
      sitekey: window.__SITE_KEY__,
      callback: async (token) => {
        const res = await fetch("/api/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
          credentials: "same-origin",
        });
        if (res.ok) {
          els.modal.classList.add("hidden");
          connectWS();
        } else {
          showToast("Verification failed");
        }
      },
    });
  };
  tryRender();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function bootstrap() {
  const r = await fetch("/api/whoami", { credentials: "same-origin" });
  const data = await r.json();
  window.__SITE_KEY__ = data.siteKey;
  palette = data.palette;

  els.clean.addEventListener("click", async () => {
    if (!confirm("Clear the entire board?")) return;
    els.clean.disabled = true;
    try {
      const res = await fetch("/api/board/clear", {
        method: "POST",
        credentials: "same-origin",
      });
      if (res.status === 401) { showTurnstile(); return; }
      if (!res.ok) { showToast(`Error ${res.status}`); return; }
      imageData.data.fill(255);
      ctx.putImageData(imageData, 0, 0);
    } catch (err) {
      showToast("Network error");
      console.error(err);
    } finally {
      els.clean.disabled = false;
    }
  });

  els.recognize.addEventListener("click", async () => {
    els.recognize.disabled = true;
    els.aiResults.innerHTML = `
      <div class="ai-card loading"><div class="name">Kimi K2.6</div><div class="answer">Thinking</div></div>
      <div class="ai-card loading"><div class="name">Gemma 4 26B</div><div class="answer">Thinking</div></div>
    `;
    try {
      const res = await fetch("/api/recognize", {
        method: "POST",
        credentials: "same-origin",
      });
      if (res.status === 401) { showTurnstile(); return; }
      if (!res.ok) { showToast(`AI error: ${res.status}`); return; }
      const d = await res.json();
      els.aiResults.innerHTML = `
        <div class="ai-card"><div class="name">Kimi K2.6 <span class="latency">${d.latency.kimi}ms</span></div><div class="answer">${escapeHtml(d.kimi)}</div></div>
        <div class="ai-card"><div class="name">Gemma 4 26B <span class="latency">${d.latency.gemma}ms</span></div><div class="answer">${escapeHtml(d.gemma)}</div></div>
      `;
    } finally {
      els.recognize.disabled = false;
    }
  });

  if (data.authenticated) {
    connectWS();
  } else {
    showTurnstile();
  }
}

bootstrap();
