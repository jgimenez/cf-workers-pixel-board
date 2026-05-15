// Draw page — text prompt → AI agent draws on the board via browser.

const els = {
  prompt: document.getElementById("prompt"),
  drawBtn: document.getElementById("draw-btn"),
  result: document.getElementById("result"),
  imagePrompt: document.getElementById("image-prompt"),
  imageBtn: document.getElementById("image-btn"),
  imageResult: document.getElementById("image-result"),
  fluxPreviewWrap: document.getElementById("flux-preview-wrap"),
  fluxPreview: document.getElementById("flux-preview"),
  gemmaCodeWrap: document.getElementById("gemma-code-wrap"),
  gemmaCode: document.getElementById("gemma-code"),
  tabDraw: document.getElementById("tab-draw"),
  tabImage: document.getElementById("tab-image"),
  sectionDraw: document.getElementById("section-draw"),
  sectionImage: document.getElementById("section-image"),
  modal: document.getElementById("turnstile-modal"),
  turnstileWidget: document.getElementById("turnstile-widget"),
  toast: document.getElementById("toast"),
};

// ---- Tab switching ----
els.tabDraw.addEventListener("click", () => {
  els.tabDraw.classList.add("active");
  els.tabImage.classList.remove("active");
  els.sectionDraw.style.display = "";
  els.sectionImage.style.display = "none";
});
els.tabImage.addEventListener("click", () => {
  els.tabImage.classList.add("active");
  els.tabDraw.classList.remove("active");
  els.sectionImage.style.display = "";
  els.sectionDraw.style.display = "none";
});

function setResult(text, cls) {
  els.result.textContent = text;
  els.result.className = "result-box" + (cls ? " " + cls : "");
}

function setImageResult(text, cls) {
  els.imageResult.textContent = text;
  els.imageResult.className = "result-box" + (cls ? " " + cls : "");
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
          els.imageBtn.disabled = false;
          setResult("Ready. Type a prompt and click Draw.");
          setImageResult("Ready. Describe an image and click Draw Image.");
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

// Decode a data URL image to a flat RGBA array at targetSize×targetSize using Canvas
function decodeImageToRGBA(dataUrl, targetSize) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = targetSize;
      canvas.height = targetSize;
      canvas.getContext("2d").drawImage(img, 0, 0, targetSize, targetSize);
      resolve(Array.from(canvas.getContext("2d").getImageData(0, 0, targetSize, targetSize).data));
    };
    img.onerror = () => reject(new Error("Failed to decode image"));
    img.src = dataUrl;
  });
}

// ---- Draw Image handler (two steps: generate → decode → paint) ----
els.imageBtn.addEventListener("click", async () => {
  const prompt = els.imagePrompt.value.trim();
  if (!prompt) { showToast("Enter a prompt first"); return; }

  els.imageBtn.disabled = true;
  els.fluxPreviewWrap.style.display = "none";
  els.gemmaCodeWrap.style.display = "none";
  setImageResult("⏳ Generating image with Flux…");

  try {
    // Step 1: Generate image with Flux
    const step1 = await fetch("/api/draw-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
      credentials: "same-origin",
    });

    if (step1.status === 401) { showTurnstile(); setImageResult("Session expired — verify again."); return; }

    const d1 = await step1.json().catch(async () => ({ error: await step1.text().catch(() => "parse error") }));
    if (!step1.ok) { setImageResult(`Error: ${d1.error ?? step1.status}`, "err"); return; }

    // Show Flux preview right away
    els.fluxPreview.src = d1.fluxImageDataUrl;
    els.fluxPreviewWrap.style.display = "";
    setImageResult("🎨 Gemma is writing the worker code to paint it…");

    // Step 2: Decode image in browser (supports any format Flux returns)
    const rgbaFlat = await decodeImageToRGBA(d1.fluxImageDataUrl, 64);

    // Step 3: Send RGBA to backend → Gemma writes Dynamic Worker → pixels painted
    const step2 = await fetch("/api/draw-pixels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rgbaFlat, boardSize: 64 }),
      credentials: "same-origin",
    });

    if (step2.status === 401) { showTurnstile(); setImageResult("Session expired — verify again."); return; }

    const d2 = await step2.json().catch(async () => ({ error: await step2.text().catch(() => "parse error") }));
    if (!step2.ok) { setImageResult(`Error: ${d2.error ?? step2.status}`, "err"); return; }

    if (d2.gemmaCode) {
      els.gemmaCode.textContent = d2.gemmaCode;
      els.gemmaCodeWrap.style.display = "";
    }

    setImageResult(
      `✓ Done!\n\nPrompt: "${prompt}"\nPixels painted: ${d2.painted}` +
      (d2.workerError ? `\n\nWorker error:\n${d2.workerError}` : ""),
      "ok"
    );
  } catch (err) {
    setImageResult(`Error: ${err}`, "err");
  } finally {
    els.imageBtn.disabled = false;
  }
});

els.imagePrompt.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") els.imageBtn.click();
});

async function bootstrap() {
  const r = await fetch("/api/whoami", { credentials: "same-origin" });
  const data = await r.json();
  window.__SITE_KEY__ = data.siteKey;

  if (data.authenticated) {
    els.drawBtn.disabled = false;
    els.imageBtn.disabled = false;
    setResult("Ready. Type a prompt and click Draw.");
    setImageResult("Ready. Describe an image and click Draw Image.");
  } else {
    showTurnstile();
  }
}

bootstrap();
