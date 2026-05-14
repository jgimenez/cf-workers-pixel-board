// Pixel AI frontend. Vanilla JS module, no build step.
// Protocol: 1-byte type, then payload.
//   0x00 INIT [4096 bytes]
//   0x01 PIXEL [x, y, color]

const MSG_INIT = 0x00;
const MSG_PIXEL = 0x01;
const BOARD_SIZE = 64;

const els = {
  status: document.getElementById("status"),
  canvas: document.getElementById("board"),
  palette: document.getElementById("palette"),
  modal: document.getElementById("turnstile-modal"),
  turnstileWidget: document.getElementById("turnstile-widget"),
  toast: document.getElementById("toast"),
};

const ctx = els.canvas.getContext("2d");
const imageData = ctx.createImageData(BOARD_SIZE, BOARD_SIZE);

let palette = [];
let selectedColor = 3; // default black
let ws = null;
let wsBackoff = 1000;
let isDrawing = false;
let lastDrawnCell = null; // "x,y" — skip re-sending same cell during a drag

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

function buildPalette(colors) {
  palette = colors;
  els.palette.innerHTML = "";
  colors.forEach((hex, i) => {
    const sw = document.createElement("div");
    sw.className = "swatch" + (i === selectedColor ? " selected" : "");
    sw.style.background = hex;
    sw.title = `${i}: ${hex}`;
    sw.setAttribute("role", "option");
    sw.setAttribute("aria-selected", String(i === selectedColor));
    sw.addEventListener("click", () => {
      selectedColor = i;
      document.querySelectorAll(".swatch").forEach((el, idx) => {
        el.classList.toggle("selected", idx === selectedColor);
        el.setAttribute("aria-selected", String(idx === selectedColor));
      });
    });
    els.palette.appendChild(sw);
  });

  // Keyboard shortcuts: 1-9, q-w-e-r-t-y-u for the remaining 7
  const keys = ["1","2","3","4","5","6","7","8","9","q","w","e","r","t","y","u"];
  window.addEventListener("keydown", (ev) => {
    const i = keys.indexOf(ev.key.toLowerCase());
    if (i >= 0 && i < palette.length) {
      selectedColor = i;
      document.querySelectorAll(".swatch").forEach((el, idx) => {
        el.classList.toggle("selected", idx === selectedColor);
      });
    }
  });
}

function canvasCoordsFromEvent(ev) {
  const rect = els.canvas.getBoundingClientRect();
  const px = ev.clientX - rect.left;
  const py = ev.clientY - rect.top;
  const x = Math.floor((px / rect.width) * BOARD_SIZE);
  const y = Math.floor((py / rect.height) * BOARD_SIZE);
  return { x, y };
}

async function paintPixel(x, y, color) {
  const key = `${x},${y}`;
  if (lastDrawnCell === key) return;
  lastDrawnCell = key;
  paintLocal(x, y, color); // optimistic
  try {
    const res = await fetch("/api/pixel", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-pixel-id": `${x},${y}` },
      body: JSON.stringify({ x, y, color }),
      credentials: "same-origin",
    });
    if (res.status === 429) {
      showToast("Too fast");
      return;
    }
    if (res.status === 401) {
      showTurnstile();
      return;
    }
    if (!res.ok) {
      showToast(`Error ${res.status}`);
    }
  } catch (err) {
    showToast("Network error");
    console.error(err);
  }
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
      const x = data[1];
      const y = data[2];
      const c = data[3] & 0x0f;
      paintLocal(x, y, c);
    }
  });

  ws.addEventListener("close", () => {
    setStatus("Disconnected — reconnecting…", "disconnected");
    setTimeout(connectWS, wsBackoff);
    wsBackoff = Math.min(wsBackoff * 2, 30000);
  });

  ws.addEventListener("error", () => {
    // close handler will reconnect
  });
}

function showTurnstile() {
  els.modal.classList.remove("hidden");
  els.turnstileWidget.innerHTML = "";
  const tryRender = () => {
    if (!window.turnstile) {
      setTimeout(tryRender, 100);
      return;
    }
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

async function bootstrap() {
  const r = await fetch("/api/whoami", { credentials: "same-origin" });
  const data = await r.json();
  window.__SITE_KEY__ = data.siteKey;
  buildPalette(data.palette);

  // Press + drag → paint (pointer events cover mouse, touch, and stylus)
  els.canvas.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    ev.preventDefault();
    els.canvas.setPointerCapture(ev.pointerId);
    isDrawing = true;
    lastDrawnCell = null;
    const { x, y } = canvasCoordsFromEvent(ev);
    if (x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE) {
      paintPixel(x, y, selectedColor);
    }
  });
  els.canvas.addEventListener("pointermove", (ev) => {
    if (!isDrawing) return;
    const { x, y } = canvasCoordsFromEvent(ev);
    if (x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE) {
      paintPixel(x, y, selectedColor);
    }
  });
  els.canvas.addEventListener("pointerup", () => {
    isDrawing = false;
    lastDrawnCell = null;
  });
  els.canvas.addEventListener("pointercancel", () => {
    isDrawing = false;
    lastDrawnCell = null;
  });

  if (data.authenticated) {
    connectWS();
  } else {
    showTurnstile();
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

bootstrap();
