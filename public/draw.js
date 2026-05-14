// Draw page — text prompt → AI agent draws on the board via browser.

const els = {
  status: document.getElementById("status"),
  prompt: document.getElementById("prompt"),
  drawBtn: document.getElementById("draw-btn"),
  result: document.getElementById("result"),
  modal: document.getElementById("turnstile-modal"),
  turnstileWidget: document.getElementById("turnstile-widget"),
  toast: document.getElementById("toast"),
};

function setStatus(text, cls) {
  els.status.textContent = text;
  els.status.className = "status" + (cls ? " " + cls : "");
}

function setResult(text, cls) {
  els.result.textContent = text;
  els.result.className = "result-box" + (cls ? " " + cls : "");
}

function showToast(msg, ms = 2200) {
  els.toast.textContent = msg;
  els.toast.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => els.toast.classList.add("hidden"), ms);
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
          els.drawBtn.disabled = false;
          setResult("Ready. Type a prompt and click Draw.");
          setStatus("Authenticated", "connected");
        } else {
          showToast("Verification failed");
        }
      },
    });
  };
  tryRender();
}

els.drawBtn.addEventListener("click", async () => {
  const prompt = els.prompt.value.trim();
  if (!prompt) { showToast("Enter a prompt first"); return; }

  els.drawBtn.disabled = true;
  setResult("⏳ Planning pixel art…");

  try {
    const res = await fetch("/api/draw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
      credentials: "same-origin",
    });

    if (res.status === 401) {
      showTurnstile();
      setResult("Session expired — verify again.");
      return;
    }

    let data;
    try {
      data = await res.json();
    } catch {
      const text = await res.text().catch(() => "(no body)");
      setResult(`Error ${res.status}: non-JSON response\n\n${text.slice(0, 500)}`, "err");
      return;
    }

    if (!res.ok) {
      setResult(`Error: ${data.error ?? res.status}\n\n${data.raw ?? ""}`, "err");
      return;
    }

    const browserErrors = data.browserLogs?.filter(l => l.includes("FAIL") || l.includes("ERR")).join("\n") || "";
    setResult(
      `✓ Done!\n\nPrompt: "${data.prompt}"\nPixels planned: ${data.pixelsPlanned}\nPixels drawn: ${data.pixelsDrawn}` +
      (browserErrors ? `\n\nBrowser errors:\n${browserErrors}` : "") +
      `\n\nPixel plan (x,y,color):\n${data.pixels?.map(p => `(${p.x},${p.y}) → color ${p.color}`).join("\n") ?? "n/a"}`,
      "ok"
    );
  } catch (err) {
    setResult(`Network error: ${err}`, "err");
  } finally {
    els.drawBtn.disabled = false;
  }
});

els.prompt.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") els.drawBtn.click();
});

async function bootstrap() {
  const r = await fetch("/api/whoami", { credentials: "same-origin" });
  const data = await r.json();
  window.__SITE_KEY__ = data.siteKey;

  if (data.authenticated) {
    els.drawBtn.disabled = false;
    setResult("Ready. Type a prompt and click Draw.");
    setStatus("Authenticated", "connected");
  } else {
    showTurnstile();
  }
}

bootstrap();
