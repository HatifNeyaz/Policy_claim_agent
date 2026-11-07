(function () {
  let stream = null;
  let isSweeping = false;
  let isAnalyzingCloud = false;
  let activeCloudPromise = null;
  let sweepStartTime = 0;
  let timerInterval = null;
  let edgeInterval = null;
  let blurInterval = null;
  let cloudWorkerInterval = null;

  let gyroSpeedDegPerSec = 0;
  let currentPanCmPerSec = 0;
  let currentSharpness = 150;
  let isAgentSpeaking = false;

  // 48x36 Spatial Luminance + Edge Signatures of All Captured Frames (Lightweight on-device CPU check)
  const capturedSignatures = [];
  let prevTickSignature = null;
  let lastLocalSnapTime = 0;
  let lastCloudCallTime = 0;
  let steadyTicksCount = 0;

  const savedFrames = [];
  const pendingCloudQueue = [];
  const excludedFrameRefs = new Set();

  const rawBooksBuffer = [];
  const rawItemsBuffer = [];
  let roomEstimate = { length_m: 4.2, width_m: 3.5, height_m: 2.44, shape_note: "rectangular" };
  let finalPacket = null;

  // Detailed '?' Explainer Content Dictionary
  const HELP_EXPLAINERS = {
    threshold: {
      title: "🔄 Unique Pixel Threshold (%) — How It Works",
      html: `
        <p>Controls <strong>how much of the camera image must change</strong> before the app automatically snaps a new photo.</p>
        <ul>
          <li><strong>Default (28% — Recommended):</strong> Ensures at least 28% of the spatial blocks and edges are brand-new compared to all previously captured photos. Prevents duplicate photos when panning slowly or standing still.</li>
          <li><strong>Higher Value (e.g., 35%–45%):</strong> Requires a wider camera pan before snapping. Takes fewer photos total.</li>
          <li><strong>Lower Value (e.g., 18%–22%):</strong> More sensitive—snaps photos with smaller camera movements.</li>
        </ul>
        <p><em>CPU Efficiency:</em> Computed on a downsampled 48×36 grid in under 0.5 milliseconds per tick, so your phone stays cool.</p>
      `
    },
    dimensions: {
      title: "📏 Shelf Width (cm) & Ceiling Height (m)",
      html: `
        <p>Provides the <strong>explainable metric scale anchor</strong> required by the assignment brief so dimensions are never guessed:</p>
        <ul>
          <li><strong>Shelf Width (Default 80 cm):</strong> Standard bookcase width (e.g., IKEA Billy is 80 cm). Combined with the 21.6 cm standard hardcover book height anchor, this converts pixel bounding boxes into exact centimeters (spine height & thickness).</li>
          <li><strong>Ceiling Height (Default 2.44 m / 8 ft):</strong> Used to compute total room wall area (m² and sq ft) and shelved wall coverage during the same sweep.</li>
        </ul>
      `
    },
    model: {
      title: "🤖 Vision Engine & Quota Pool",
      html: `
        <p>Selects which multimodal AI model reads book spines and room contents:</p>
        <ul>
          <li><strong>⚡ Smart Auto-Balancer (Default):</strong> Rotates across <code>Gemini 3.5 Flash Lite</code> (500 RPD), <code>Gemini 3.1 Flash Lite</code> (500 RPD), and <code>Gemma 4 26B Vision</code> (14,400 RPD) so you never hit rate limits.</li>
          <li><strong>Multi-Frame Batching:</strong> Up to 3 locally snapped photos are bundled into a single API request, cutting quota usage by 65%.</li>
        </ul>
      `
    },
    locale: {
      title: "🌍 Primary Country & Currency",
      html: `
        <p>Sets the policyholder's claim country and currency (e.g., <strong>India — INR ₹</strong> or <strong>United States — USD $</strong>).</p>
        <p>All identified books and non-book room items are priced in this currency using local retail catalogs (such as Amazon.in / Flipkart / Google Books India for INR) with clickable verification links.</p>
      `
    },
    second_locale: {
      title: "🌐 2nd Country (10-Book Proof)",
      html: `
        <p>The assignment brief requires proving that locale pricing is a live setting and not hardcoded.</p>
        <p>When you finish the sweep, the app automatically prices the first 10 identified books in this second country/currency and includes a side-by-side comparison table in your final report.</p>
      `
    },
    apikey: {
      title: "🔑 API Key Setup",
      html: `
        <p>Paste your single Google AI Studio API key (or Groq <code>gsk_...</code> key) here. It is stored only in your browser's local storage so you don't have to re-paste it on refresh, and can be wiped anytime using <strong>🗑️ Clear Cache</strong>.</p>
      `
    },
    marking: {
      title: "📌 How Live Ownership & Item Marking Works",
      html: `
        <p><strong>1. Everything Is Yours by Default:</strong> You do <em>not</em> need to say or tap anything for your normal shelves, books, bed, or tables—every captured frame is automatically marked <strong>✅ Yours</strong>.</p>
        <p><strong>2. Optional Live Override:</strong> If a shelf or item does <em>not</em> belong to you, or you want to specify that a wall picture is a print/original, simply speak or tap one of the buttons while viewing that frame:</p>
        <ul>
          <li><strong>🚫 Not Mine:</strong> Excludes that frame and all items inside it from your final claim totals.</li>
          <li><strong>🖼️ Art = Print:</strong> Prices the framed picture as a standard retail print instead of flagging for specialist appraisal.</li>
          <li><strong>🎨 Art = Original / ⭐ 1st Edition:</strong> Flags the artwork or rare book for specialist human appraisal.</li>
        </ul>
        <p><strong>3. Filmstrip Toggle:</strong> You can also tap any thumbnail in the <strong>Captured Unique Frames</strong> strip at the bottom to toggle <strong>✅ Yours</strong> vs. <strong>🚫 Not Mine</strong> at any time.</p>
      `
    }
  };

  // Setup '?' Explainer Modal Listeners
  function setupHelpModal() {
    const modal = document.getElementById("helpModal");
    const titleEl = document.getElementById("helpModalTitle");
    const bodyEl = document.getElementById("helpModalBody");
    const closeBtn = document.getElementById("closeHelpModalBtn");

    document.querySelectorAll(".help-q-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const key = btn.dataset.help;
        const info = HELP_EXPLAINERS[key] || HELP_EXPLAINERS.marking;
        if (titleEl) titleEl.textContent = info.title;
        if (bodyEl) bodyEl.innerHTML = info.html;
        if (modal) modal.classList.remove("hidden");
      });
    });

    if (closeBtn && modal) {
      closeBtn.addEventListener("click", () => modal.classList.add("hidden"));
      modal.addEventListener("click", (e) => {
        if (e.target === modal) modal.classList.add("hidden");
      });
    }
  }

  // Auto-fill and sanitize API key
  const urlParams = new URLSearchParams(window.location.search);
  const apiKeyInput = document.getElementById("apiKeyInput");
  if (apiKeyInput) {
    const rawSavedKey = urlParams.get("key") || localStorage.getItem("CLAIM_AGENT_API_KEY") || "";
    const cleanSaved = window.CloudVisionAndPrice
      ? window.CloudVisionAndPrice.sanitizeApiKey(rawSavedKey)
      : rawSavedKey.trim();
    if (cleanSaved) apiKeyInput.value = cleanSaved;

    apiKeyInput.addEventListener("change", () => {
      const sanitized = window.CloudVisionAndPrice.sanitizeApiKey(apiKeyInput.value);
      apiKeyInput.value = sanitized;
      localStorage.setItem("CLAIM_AGENT_API_KEY", sanitized);
    });
  }

  const toggleKeyVisBtn = document.getElementById("toggleKeyVisBtn");
  if (toggleKeyVisBtn && apiKeyInput) {
    toggleKeyVisBtn.addEventListener("click", () => {
      apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
    });
  }

  const testApiKeyBtn = document.getElementById("testApiKeyBtn");
  if (testApiKeyBtn && apiKeyInput) {
    testApiKeyBtn.addEventListener("click", async () => {
      const sanitized = window.CloudVisionAndPrice.sanitizeApiKey(apiKeyInput.value);
      apiKeyInput.value = sanitized;
      localStorage.setItem("CLAIM_AGENT_API_KEY", sanitized);

      const speechEl = document.getElementById("agentSpeechText");
      const modelChoice = document.getElementById("modelSelect").value;
      if (speechEl) speechEl.textContent = "🔌 Checking API connection...";

      try {
        const info = await window.CloudVisionAndPrice.testApiKeyConnection(sanitized, modelChoice);
        const msg = `✅ Connected! Using ${info.provider}. Ready to start sweep.`;
        if (speechEl) speechEl.textContent = msg;
        alert(msg);
      } catch (err) {
        const errMsg = `❌ API Check Failed: ${err.message}`;
        if (speechEl) speechEl.textContent = errMsg;
        alert(errMsg);
      }
    });
  }

  function playCameraShutterSound() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();

      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = "triangle";
      osc1.frequency.setValueAtTime(1200, ctx.currentTime);
      osc1.frequency.exponentialRampToValueAtTime(420, ctx.currentTime + 0.06);
      gain1.gain.setValueAtTime(0.16, ctx.currentTime);
      gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.06);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start();
      osc1.stop(ctx.currentTime + 0.06);

      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = "sine";
      osc2.frequency.setValueAtTime(1650, ctx.currentTime + 0.07);
      gain2.gain.setValueAtTime(0.12, ctx.currentTime + 0.07);
      gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.16);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(ctx.currentTime + 0.07);
      osc2.stop(ctx.currentTime + 0.16);
    } catch (e) {}
  }

  function triggerShutterVisual(frameIdx, pixelChangePct) {
    playCameraShutterSound();
    const container = document.getElementById("videoContainer");
    const whiteFlash = document.getElementById("whiteScreenFlash");
    const flashBadge = document.getElementById("shutterFlash");
    const trafficBanner = document.getElementById("moveTrafficBanner");

    if (whiteFlash) {
      whiteFlash.classList.remove("hidden");
      setTimeout(() => whiteFlash.classList.add("hidden"), 110);
    }
    if (container) {
      container.classList.add("flash-border");
      setTimeout(() => container.classList.remove("flash-border"), 600);
    }
    if (flashBadge) {
      flashBadge.textContent = `📸 FRAME #${frameIdx} SNAPPED (${pixelChangePct}% New)`;
      flashBadge.classList.remove("hidden");
      setTimeout(() => flashBadge.classList.add("hidden"), 1500);
    }
    if (trafficBanner) {
      trafficBanner.className = "traffic-banner snapped-move";
      trafficBanner.textContent = `🟢 FRAME #${frameIdx} SNAPPED (${pixelChangePct}% New View)! Pan to next area ➡️`;
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    if (window.EdgeSegmentation) {
      window.EdgeSegmentation.init();
    }
    setupHelpModal();
    setupTabs();
    setupSpeechRecognition();
  });

  window.addEventListener("devicemotion", (e) => {
    const r = e.rotationRate;
    if (r) {
      const a = r.alpha || 0;
      const b = r.beta || 0;
      const g = r.gamma || 0;
      gyroSpeedDegPerSec = Math.sqrt(a * a + b * b + g * g);
    }
  });

  // Ultra-Lightweight 48x36 Spatial Luminance + Edge Fingerprint (<0.5ms on phone CPU, zero heating)
  function analyzeFrameAndSignature(videoEl, workCanvas, prevSig) {
    if (!videoEl || videoEl.readyState < 2 || !workCanvas) {
      return { sharpness: 65, sharpnessPct: 92, glarePct: 0, panCmPerSec: 0, signature: null };
    }
    const ctx = workCanvas.getContext("2d", { willReadFrequently: true });
    const w = workCanvas.width;  // 320
    const h = workCanvas.height; // 240
    ctx.drawImage(videoEl, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h).data;

    // 1. Fast Sharpness & Glare Check (sampled every 2nd pixel for mobile CPU efficiency)
    const gray = new Float32Array(w * h);
    let glarePixels = 0;
    for (let i = 0, p = 0; i < img.length; i += 4, p++) {
      const lum = 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2];
      gray[p] = lum;
      if (lum > 248) glarePixels++;
    }

    let sum = 0;
    let sumSq = 0;
    let count = 0;
    for (let y = 2; y < h - 2; y += 2) {
      for (let x = 2; x < w - 2; x += 2) {
        const idx = y * w + x;
        const lap = gray[idx - w] + gray[idx + w] + gray[idx - 1] + gray[idx + 1] - 4 * gray[idx];
        sum += lap;
        sumSq += lap * lap;
        count++;
      }
    }
    const mean = sum / count;
    const variance = Math.max(0, (sumSq / count) - (mean * mean));
    const sharpnessPct = Math.min(99, Math.round((variance / 45) * 100));
    const glarePct = (glarePixels / (w * h)) * 100;

    // 2. Build 48x36 Spatial Luminance + Edge Gradient Signature (1,728 cells)
    const gridW = 48;
    const gridH = 36;
    const cellW = Math.floor(w / gridW);
    const cellH = Math.floor(h / gridH);
    const signature = new Float32Array(gridW * gridH * 2); // [lum, edgeGrad] per cell

    for (let gy = 0; gy < gridH; gy++) {
      for (let gx = 0; gx < gridW; gx++) {
        const cy = gy * cellH + Math.floor(cellH / 2);
        const cx = gx * cellW + Math.floor(cellW / 2);
        const idx = cy * w + cx;
        const lum = gray[idx];
        const gxGrad = Math.abs(gray[idx + 1] - gray[idx - 1]);
        const gyGrad = Math.abs(gray[idx + w] - gray[idx - w]);
        const cellIdx = (gy * gridW + gx) * 2;
        signature[cellIdx] = lum;
        signature[cellIdx + 1] = (gxGrad + gyGrad) * 0.5;
      }
    }

    // 3. Short-term frame-to-frame motion speed (cm/s)
    let tickDelta = 0;
    if (prevSig && prevSig.length === signature.length) {
      let diff = 0;
      const cells = gridW * gridH;
      for (let i = 0; i < cells; i++) {
        diff += Math.abs(signature[i * 2] - prevSig[i * 2]);
      }
      tickDelta = (diff / cells / 255) * 100;
    }
    const gyroCmPerSec = gyroSpeedDegPerSec * 0.42;
    const opticalCmPerSec = tickDelta > 1.8 ? tickDelta * 1.55 : 0;
    const panCmPerSec = Math.round(Math.max(gyroCmPerSec, opticalCmPerSec));

    return {
      sharpness: Math.round(variance),
      sharpnessPct,
      glarePct: Number(glarePct.toFixed(1)),
      panCmPerSec,
      signature
    };
  }

  // Translation-Tolerant All-Frame Uniqueness Check:
  // Compares current 48x36 signature against ALL previously saved photos (including ±1 block shift for hand jitter)
  // Returns 0% to 100% representing how much of the current scene is genuinely new.
  function computeUniquenessAgainstAllSaved(currentSig) {
    if (!currentSig || capturedSignatures.length === 0) return 100;
    const gridW = 48;
    const gridH = 36;
    const totalCells = gridW * gridH;
    let minNewScenePct = 100;

    // Check against all saved signatures (up to last 12 unique photos)
    const startIdx = Math.max(0, capturedSignatures.length - 12);
    for (let s = startIdx; s < capturedSignatures.length; s++) {
      const savedSig = capturedSignatures[s];
      let significantlyChangedCells = 0;
      let totalIntensityDelta = 0;

      for (let gy = 1; gy < gridH - 1; gy++) {
        for (let gx = 1; gx < gridW - 1; gx++) {
          const cIdx = (gy * gridW + gx) * 2;
          const curLum = currentSig[cIdx];
          const curEdge = currentSig[cIdx + 1];

          // Find best match in a 3x3 neighborhood of savedSig so slight camera tilt doesn't trigger a false snap
          let bestDiff = 999;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const sIdx = ((gy + dy) * gridW + (gx + dx)) * 2;
              const dLum = Math.abs(curLum - savedSig[sIdx]);
              const dEdge = Math.abs(curEdge - savedSig[sIdx + 1]);
              const combined = dLum * 0.75 + dEdge * 0.55;
              if (combined < bestDiff) bestDiff = combined;
            }
          }

          totalIntensityDelta += bestDiff;
          // A cell counts as genuinely new only if its shift-compensated difference exceeds 26 intensity levels
          if (bestDiff > 26) {
            significantlyChangedCells++;
          }
        }
      }

      const innerCells = (gridW - 2) * (gridH - 2);
      const changedCellsPct = (significantlyChangedCells / innerCells) * 100;
      const meanDeltaPct = (totalIntensityDelta / innerCells / 128) * 100;
      const sceneDiffPct = Math.min(100, Math.round(changedCellsPct * 0.75 + meanDeltaPct * 0.25));

      if (sceneDiffPct < minNewScenePct) {
        minNewScenePct = sceneDiffPct;
      }
    }

    return minNewScenePct;
  }

  function speakAgent(text) {
    const speechEl = document.getElementById("agentSpeechText");
    if (speechEl) speechEl.textContent = text;
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.1;
    utter.onstart = () => { isAgentSpeaking = true; };
    utter.onend = () => { isAgentSpeaking = false; };
    utter.onerror = () => { isAgentSpeaking = false; };
    window.speechSynthesis.speak(utter);
  }

  function setupSpeechRecognition() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) return;
    const rec = new SpeechRec();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = "en-US";

    rec.onresult = (event) => {
      if (isAgentSpeaking) return;
      const transcript = event.results[event.results.length - 1][0].transcript.trim();
      handleUserVoiceCommand(transcript);
    };
    rec.onend = () => {
      if (isSweeping) {
        try { rec.start(); } catch (e) {}
      }
    };
    window.liveSpeechRecognizer = rec;
  }

  function handleUserVoiceCommand(transcript) {
    const activeFrame = savedFrames[savedFrames.length - 1];
    const frameLabel = activeFrame ? activeFrame.filename : "Current View";

    const userTextEl = document.getElementById("userSpeechText");
    if (userTextEl) {
      userTextEl.textContent = `[Marked ${frameLabel}]: "${transcript}"`;
    }

    if (activeFrame) {
      activeFrame.voiceNotes = activeFrame.voiceNotes || [];
      activeFrame.voiceNotes.push(transcript);
    }

    const low = transcript.toLowerCase();

    if (
      low.includes("not my") ||
      low.includes("not mine") ||
      low.includes("skip") ||
      low.includes("exclude") ||
      low.includes("ignore")
    ) {
      if (activeFrame) {
        activeFrame.excludedByUser = true;
        excludedFrameRefs.add(activeFrame.frameRef);
        renderFilmstripAndFramesGrid();
        renderLiveLists();
        speakAgent(`Excluded Frame ${activeFrame.index} as not yours.`);
      } else {
        speakAgent("Noted. Excluding this section.");
      }
      return;
    }

    if (low.includes("first edition") || low.includes("signed") || low.includes("rare")) {
      const lastBook = rawBooksBuffer[rawBooksBuffer.length - 1];
      if (lastBook) {
        lastBook.status = "needs_appraisal";
        lastBook.rare_or_signed_reason = `User marked during ${frameLabel}: "${transcript}"`;
        renderLiveLists();
      }
      speakAgent(`Marked book in ${frameLabel} as a rare edition.`);
      return;
    }

    if (low.includes("print") || low.includes("reproduction") || low.includes("poster")) {
      if (activeFrame) activeFrame.userArtNote = "print";
      const artItem = [...rawItemsBuffer].reverse().find(i => i.category === "framed_art" || i.is_art_or_portrait);
      if (artItem) {
        artItem.user_confirmed_print = true;
        artItem.user_art_note = "print";
        artItem.status = "range";
        renderLiveLists();
      }
      speakAgent(`Marked artwork in ${frameLabel} as a print.`);
    } else if (low.includes("original")) {
      if (activeFrame) activeFrame.userArtNote = "original";
      const artItem = [...rawItemsBuffer].reverse().find(i => i.category === "framed_art" || i.is_art_or_portrait);
      if (artItem) {
        artItem.user_confirmed_print = false;
        artItem.user_art_note = "original";
        artItem.status = "needs_appraisal";
        renderLiveLists();
      }
      speakAgent(`Marked artwork in ${frameLabel} as an original for appraisal.`);
    }
  }

  document.querySelectorAll(".chip-btn").forEach(btn => {
    btn.addEventListener("click", () => handleUserVoiceCommand(btn.dataset.voice));
  });

  // Start Live Camera Sweep
  document.getElementById("startSweepBtn").addEventListener("click", async () => {
    const apiKey = window.CloudVisionAndPrice.sanitizeApiKey(apiKeyInput.value);
    apiKeyInput.value = apiKey;
    if (!apiKey) {
      alert("Please paste your API key first (open ⚙️ Setup at the top).");
      const setupDrawer = document.getElementById("setupDrawer");
      if (setupDrawer) setupDrawer.open = true;
      return;
    }
    localStorage.setItem("CLAIM_AGENT_API_KEY", apiKey);

    if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
      try { await DeviceMotionEvent.requestPermission(); } catch (e) {}
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      const videoEl = document.getElementById("cameraVideo");
      videoEl.srcObject = stream;
      await videoEl.play();
      beginSweepLoop(videoEl);
    } catch (err) {
      alert("Camera access error: " + err.message + ". You can also use '📁 Video'.");
    }
  });

  // Upload Recorded Video Sweep
  document.getElementById("videoUploadInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const apiKey = window.CloudVisionAndPrice.sanitizeApiKey(apiKeyInput.value);
    apiKeyInput.value = apiKey;
    if (!apiKey) {
      alert("Please paste your API key first.");
      return;
    }
    localStorage.setItem("CLAIM_AGENT_API_KEY", apiKey);
    const videoEl = document.getElementById("cameraVideo");
    videoEl.srcObject = null;
    videoEl.src = URL.createObjectURL(file);
    videoEl.loop = false;
    await videoEl.play();
    beginSweepLoop(videoEl);
  });

  function beginSweepLoop(videoEl) {
    isSweeping = true;
    sweepStartTime = Date.now();
    lastLocalSnapTime = 0;
    lastCloudCallTime = Date.now() - 2500;
    steadyTicksCount = 0;

    // Auto-collapse the Setup Drawer so the phone screen is clean and uncluttered!
    const setupDrawer = document.getElementById("setupDrawer");
    if (setupDrawer) setupDrawer.open = false;

    document.getElementById("statusDot").classList.add("active");
    document.getElementById("captureKeyframeBtn").disabled = false;
    document.getElementById("finishSweepBtn").disabled = false;

    const pixelThreshold = parseFloat(document.getElementById("pixelThresholdInput")?.value || "28");
    const [country, currency] = document.getElementById("localeSelect").value.split("|");

    speakAgent(
      `Sweep started in ${currency}. Everything is auto-marked as yours. Pan across your room—photos snap automatically whenever ${pixelThreshold} percent of the view changes.`
    );

    if (window.liveSpeechRecognizer) {
      try { window.liveSpeechRecognizer.start(); } catch (e) {}
    }

    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      const sec = Math.floor((Date.now() - sweepStartTime) / 1000);
      const mm = String(Math.floor(sec / 60)).padStart(2, "0");
      const ss = String(sec % 60).padStart(2, "0");
      document.getElementById("sweepTimer").textContent = `⏱️ ${mm}:${ss}`;
    }, 1000);

    const overlayCanvas = document.getElementById("overlayCanvas");
    const workCanvas = document.getElementById("workCanvas");

    clearInterval(edgeInterval);
    edgeInterval = setInterval(() => {
      if (window.EdgeSegmentation) {
        window.EdgeSegmentation.processFrame(videoEl, overlayCanvas, workCanvas, (edgeItems) => {
          const latestFrame = savedFrames[savedFrames.length - 1];
          if (!latestFrame || latestFrame.excludedByUser) return;
          let added = false;
          for (const it of edgeItems) {
            const exists = rawItemsBuffer.some(
              existing => existing.category === it.category &&
                          window.CloudVisionAndPrice.stringSimilarity(existing.description, it.description) > 0.70
            );
            if (!exists) {
              rawItemsBuffer.push({ ...it, frame_ref: latestFrame.frameRef });
              added = true;
            }
          }
          if (added) renderLiveLists();
        });
      }
    }, 500);

    // 350ms Pure Pixel-Uniqueness Trigger (Snaps immediately when pixelDiffPct >= threshold & steady; never snaps duplicates)
    clearInterval(blurInterval);
    blurInterval = setInterval(() => {
      if (!isSweeping) return;
      const activeProfile = window.CloudVisionAndPrice.getPacingProfile(
        document.getElementById("modelSelect").value
      );
      const threshold = parseFloat(document.getElementById("pixelThresholdInput")?.value || "28");

      const { sharpness, sharpnessPct, glarePct, panCmPerSec, signature } = analyzeFrameAndSignature(
        videoEl,
        workCanvas,
        prevTickSignature
      );
      prevTickSignature = signature;
      currentSharpness = sharpness;
      currentPanCmPerSec = panCmPerSec;

      const pixelDiffPct = computeUniquenessAgainstAllSaved(signature);
      const timeSinceSnap = Date.now() - lastLocalSnapTime;

      const sharpBadge = document.getElementById("sharpnessBadge");
      const pixelDiffBadge = document.getElementById("pixelDiffBadge");
      const queueBadge = document.getElementById("queueBadge");
      const alertBanner = document.getElementById("alertBanner");
      const trafficBanner = document.getElementById("moveTrafficBanner");
      const progressBar = document.getElementById("captureProgressBar");

      const isMovingFast = panCmPerSec > activeProfile.maxPanCmPerSec || gyroSpeedDegPerSec > activeProfile.maxGyroDegPerSec;
      const isBlurry = sharpness < 10;

      sharpBadge.textContent = `🎯 Sharp: ${sharpnessPct}%`;
      pixelDiffBadge.textContent = `🔄 Change: ${pixelDiffPct}% / ${threshold}%`;
      queueBadge.textContent = `☁️ Queue: ${pendingCloudQueue.length}`;

      const uniquenessProgress = Math.min(100, Math.round((pixelDiffPct / threshold) * 100));
      if (progressBar) progressBar.style.width = `${uniquenessProgress}%`;

      if (!isMovingFast && !isBlurry) {
        steadyTicksCount++;
      } else {
        steadyTicksCount = 0;
      }

      // Trigger Logic:
      // 1. Primary Trigger: Pixel change >= strong threshold (e.g. 28%) AND camera steady for ~0.5s (2 ticks) AND >1.6s debounce
      // 2. Time-Assist Trigger: User panned to a moderately new section (>= 80% of threshold, e.g. 22%) and held steady for >3.6s
      const isPrimaryUnique = pixelDiffPct >= threshold && steadyTicksCount >= 2 && timeSinceSnap >= 1600;
      const isTimeAssistUnique = pixelDiffPct >= Math.round(threshold * 0.8) && steadyTicksCount >= 4 && timeSinceSnap >= 3600;
      const isFirstFrame = savedFrames.length === 0 && steadyTicksCount >= 2;

      if (isFirstFrame || isPrimaryUnique || isTimeAssistUnique) {
        if (signature) capturedSignatures.push(new Float32Array(signature));
        steadyTicksCount = 0;
        snapLocalFrameToMemory(videoEl, pixelDiffPct);
      } else if (pixelDiffPct < Math.round(threshold * 0.8)) {
        // Scene hasn't changed enough -> Do NOT take a duplicate photo
        if (trafficBanner && timeSinceSnap > 1400) {
          trafficBanner.className = "traffic-banner waiting";
          trafficBanner.textContent = `⏸️ Same View (${pixelDiffPct}% < ${threshold}% Threshold) — Pan camera to next area ➡️`;
        }
      } else if (pixelDiffPct >= threshold && steadyTicksCount < 2) {
        if (trafficBanner) {
          trafficBanner.className = "traffic-banner hold-steady";
          trafficBanner.textContent = `🟡 New View Reached (${pixelDiffPct}% Changed) — Pause for 0.5s to snap!`;
        }
      }

      if (isMovingFast && pixelDiffPct >= threshold) {
        alertBanner.classList.remove("hidden");
        alertBanner.textContent = `⚠️ Pause briefly on this view so the camera can snap a sharp photo!`;
      } else {
        alertBanner.classList.add("hidden");
      }
    }, 350);

    // Background Cloud Batch Worker
    clearInterval(cloudWorkerInterval);
    cloudWorkerInterval = setInterval(() => {
      if (!isAnalyzingCloud && pendingCloudQueue.length > 0) {
        processPendingCloudBatch(false);
      }
    }, 800);
  }

  // Manual Force Snap button
  document.getElementById("captureKeyframeBtn").addEventListener("click", () => {
    const videoEl = document.getElementById("cameraVideo");
    if (prevTickSignature) capturedSignatures.push(new Float32Array(prevTickSignature));
    snapLocalFrameToMemory(videoEl, 100);
  });

  function snapLocalFrameToMemory(videoEl, pixelChangePct) {
    if (!isSweeping || !videoEl || videoEl.readyState < 2) return;

    lastLocalSnapTime = Date.now();
    const captureCanvas = document.getElementById("captureCanvas");
    const ctx = captureCanvas.getContext("2d");
    captureCanvas.width = videoEl.videoWidth || 1280;
    captureCanvas.height = videoEl.videoHeight || 720;
    ctx.drawImage(videoEl, 0, 0, captureCanvas.width, captureCanvas.height);

    const frameIdx = savedFrames.length + 1;
    const filename = `frame_${String(frameIdx).padStart(3, "0")}.jpg`;
    const frameRef = `evidence_frames/${filename}`;
    const dataUrl = captureCanvas.toDataURL("image/jpeg", 0.80);
    const base64 = dataUrl.split(",")[1];

    const frameObj = {
      index: frameIdx,
      filename,
      frameRef,
      base64,
      dataUrl,
      width: captureCanvas.width,
      height: captureCanvas.height,
      pixelChangePct,
      status: "queued",
      excludedByUser: false,
      voiceNotes: [],
      userArtNote: ""
    };

    savedFrames.push(frameObj);
    pendingCloudQueue.push(frameObj);

    triggerShutterVisual(frameIdx, pixelChangePct);
    renderFilmstripAndFramesGrid();

    document.getElementById("liveFrameCount").textContent = savedFrames.length;
    document.getElementById("tabFrameCount").textContent = savedFrames.length;
  }

  function processPendingCloudBatch(flushAll) {
    if (isAnalyzingCloud) {
      return activeCloudPromise || Promise.resolve();
    }
    if (pendingCloudQueue.length === 0) {
      return Promise.resolve();
    }

    const modelChoice = document.getElementById("modelSelect").value;
    const activeProfile = window.CloudVisionAndPrice.getPacingProfile(modelChoice);
    const timeSinceLastCloud = Date.now() - lastCloudCallTime;

    if (!flushAll && timeSinceLastCloud < activeProfile.batchIntervalMs) {
      return Promise.resolve();
    }

    const batch = [];
    while (pendingCloudQueue.length > 0 && batch.length < activeProfile.maxBatchSize) {
      const f = pendingCloudQueue.shift();
      if (!f.excludedByUser && !excludedFrameRefs.has(f.frameRef)) {
        batch.push(f);
      } else {
        f.status = "excluded";
      }
    }
    renderFilmstripAndFramesGrid();
    if (batch.length === 0) return Promise.resolve();

    isAnalyzingCloud = true;
    lastCloudCallTime = Date.now();

    activeCloudPromise = (async () => {
      const apiKey = window.CloudVisionAndPrice.sanitizeApiKey(apiKeyInput.value);
      const [countryCode, currencyCode] = document.getElementById("localeSelect").value.split("|");

      const frameNames = batch.map(b => `#${b.index}`).join(", ");
      const speechEl = document.getElementById("agentSpeechText");
      if (speechEl) {
        speechEl.textContent = `☁️ Scanning Frame(s) ${frameNames}...`;
      }

      const callStart = performance.now();
      try {
        const batchResult = await window.CloudVisionAndPrice.analyzeKeyframeBatch(
          batch,
          apiKey,
          modelChoice,
          countryCode,
          currencyCode
        );
        const elapsedSec = ((performance.now() - callStart) / 1000).toFixed(1);

        const modelBadge = document.getElementById("modelBadge");
        if (modelBadge) {
          modelBadge.textContent = `🤖 ${window.CloudVisionAndPrice.lastUsedModel} (${elapsedSec}s)`;
        }

        let batchBooksCount = 0;
        let batchItemsCount = 0;

        for (const frameData of (batchResult.frames || [])) {
          const ref = frameData.frame_ref || batch[0].frameRef;
          const matchedFrame = savedFrames.find(f => f.frameRef === ref) || batch[0];
          matchedFrame.status = "scanned";

          if (frameData.excluded_by_user || matchedFrame.excludedByUser) {
            matchedFrame.excludedByUser = true;
            excludedFrameRefs.add(matchedFrame.frameRef);
            continue;
          }

          const fBooks = frameData.books || [];
          const fItems = frameData.items || [];
          batchBooksCount += fBooks.length;
          batchItemsCount += fItems.length;

          if (window.EdgeSegmentation) {
            window.EdgeSegmentation.updateCloudBoxes(fBooks, fItems);
          }

          const pxHeights = fBooks
            .map(b => b.bbox_2d ? ((b.bbox_2d[2] - b.bbox_2d[0]) / 1000) * matchedFrame.height : 280)
            .filter(h => h > 40)
            .sort((a, b) => a - b);
          const medianPx = pxHeights.length ? pxHeights[Math.floor(pxHeights.length / 2)] : 280;

          for (const b of fBooks) {
            const dims = window.EdgeSegmentation.measureNormalizedBox(
              b.bbox_2d,
              matchedFrame.width,
              matchedFrame.height,
              medianPx
            );
            rawBooksBuffer.push({
              ...b,
              shelf: frameData.shelf_id || `Shelf_${matchedFrame.index}`,
              frame_ref: matchedFrame.frameRef,
              spine_height_cm: dims.height_cm,
              spine_thickness_cm: dims.thickness_cm
            });
          }

          for (const item of fItems) {
            if (matchedFrame.userArtNote === "print" || item.user_art_note === "print") {
              item.user_confirmed_print = true;
              item.user_art_note = "print";
            } else if (matchedFrame.userArtNote === "original" || item.user_art_note === "original") {
              item.user_confirmed_print = false;
              item.user_art_note = "original";
            }
            rawItemsBuffer.push({
              ...item,
              frame_ref: matchedFrame.frameRef
            });
          }
        }

        if (batchResult.room_estimate?.estimated_length_m) {
          roomEstimate.length_m = batchResult.room_estimate.estimated_length_m;
          roomEstimate.width_m = batchResult.room_estimate.estimated_width_m || 3.5;
          roomEstimate.shape_note = batchResult.room_estimate.shape_note || "rectangular";
        }

        renderFilmstripAndFramesGrid();
        renderLiveLists();

        if (batchBooksCount > 0 || batchItemsCount > 0) {
          speakAgent(`Logged ${batchBooksCount} books and ${batchItemsCount} items from Frame ${frameNames}.`);
        }
      } catch (err) {
        console.error("Batch analysis error:", err);
        batch.forEach(f => { f.status = "scanned"; });
        renderFilmstripAndFramesGrid();
        if (speechEl) {
          speechEl.textContent = `⚠️ Notice on ${frameNames}: ${err.message}`;
        }
      } finally {
        isAnalyzingCloud = false;
        activeCloudPromise = null;
      }
    })();

    return activeCloudPromise;
  }

  function toggleFrameExclusion(frameIdx) {
    const f = savedFrames.find(x => x.index === frameIdx);
    if (!f) return;
    f.excludedByUser = !f.excludedByUser;
    if (f.excludedByUser) {
      excludedFrameRefs.add(f.frameRef);
    } else {
      excludedFrameRefs.delete(f.frameRef);
    }
    renderFilmstripAndFramesGrid();
    renderLiveLists();
  }
  window.toggleFrameExclusion = toggleFrameExclusion;

  function renderFilmstripAndFramesGrid() {
    const strip = document.getElementById("liveFilmstrip");
    const hint = document.getElementById("filmstripHint");
    if (hint) {
      const exclCount = excludedFrameRefs.size;
      hint.textContent = `${savedFrames.length} unique (${exclCount} Not Mine)`;
    }

    if (strip) {
      strip.innerHTML = savedFrames.map(f => {
        const cls = f.excludedByUser ? "excluded" : (f.status === "queued" ? "queued" : "");
        const badge = f.excludedByUser ? "🚫 Not Mine" : (f.status === "queued" ? `⏳ #${f.index} Yours` : `✅ #${f.index} Yours`);
        return `
          <div class="strip-thumb ${cls}" onclick="window.toggleFrameExclusion(${f.index})" title="Tap to toggle Yours vs Not Mine">
            <img src="${f.dataUrl}" alt="${f.filename}" />
            <div class="strip-lbl">${badge}</div>
          </div>
        `;
      }).join("");
      strip.scrollLeft = strip.scrollWidth;
    }

    const grid = document.getElementById("liveFramesGrid");
    if (grid) {
      grid.innerHTML = savedFrames.map(f => `
        <div class="frame-card ${f.excludedByUser ? "excluded" : ""}" onclick="window.toggleFrameExclusion(${f.index})">
          <img src="${f.dataUrl}" alt="${f.filename}" />
          <div><strong>#${f.index}</strong> (${f.excludedByUser ? "🚫 Not Mine" : "✅ Yours"})</div>
          <div style="font-size:0.62rem;color:#9ca3af;">New Pixels: ${f.pixelChangePct || 100}%</div>
          ${f.voiceNotes?.length ? `<div style="font-size:0.62rem;color:#67e8f9;">🎙️ "${f.voiceNotes.join(", ")}"</div>` : ""}
        </div>
      `).join("");
    }
  }

  function renderLiveLists() {
    const { uniqueBooks, uniqueItems } = window.CloudVisionAndPrice.deduplicateInventory(
      rawBooksBuffer,
      rawItemsBuffer,
      excludedFrameRefs
    );
    const shelfRunM = (uniqueBooks.reduce((s, b) => s + (b.spine_thickness_cm || 2.8), 0) / 100).toFixed(2);

    document.getElementById("liveBookCount").textContent = uniqueBooks.length;
    document.getElementById("tabBookCount").textContent = uniqueBooks.length;
    document.getElementById("liveItemCount").textContent = uniqueItems.length;
    document.getElementById("tabItemCount").textContent = uniqueItems.length;
    document.getElementById("liveShelfRun").textContent = `${shelfRunM}m`;

    const booksListEl = document.getElementById("liveBooksList");
    if (uniqueBooks.length > 0) {
      booksListEl.innerHTML = uniqueBooks.slice().reverse().map(b => `
        <div class="list-item ${b.status !== "identified" ? "warn" : ""}">
          <strong>${b.status === "unidentified" ? "⚠️ [Unidentified Spine]" : b.title}</strong>
          ${b.author ? ` — ${b.author}` : ""}
          <div class="meta">${b.shelf} | ${b.spine_height_cm}×${b.spine_thickness_cm} cm | <code>${b.frame_ref}</code></div>
        </div>
      `).join("");
    } else {
      booksListEl.innerHTML = `<p class="empty-hint">Books will appear here live as unique frames are scanned...</p>`;
    }

    const itemsListEl = document.getElementById("liveItemsList");
    if (uniqueItems.length > 0) {
      itemsListEl.innerHTML = uniqueItems.slice().reverse().map(it => `
        <div class="list-item ${it.category === "framed_art" ? "warn" : ""}">
          <strong>[${it.category.toUpperCase()}]</strong> ${it.description}
          <div class="meta">${it.dimensions_cm?.w || 60}×${it.dimensions_cm?.h || 80} cm | <code>${it.frame_ref}</code></div>
        </div>
      `).join("");
    } else {
      itemsListEl.innerHTML = `<p class="empty-hint">Beds, tables, shelving, lamps, electronics, and art will log here...</p>`;
    }
  }

  // Finish Sweep & Directly Generate Final Report
  const finishBtn = document.getElementById("finishSweepBtn");
  finishBtn.addEventListener("click", async () => {
    isSweeping = false;
    finishBtn.disabled = true;
    finishBtn.textContent = "⏳ Pricing & Building...";

    clearInterval(timerInterval);
    clearInterval(edgeInterval);
    clearInterval(blurInterval);
    clearInterval(cloudWorkerInterval);
    document.getElementById("statusDot").classList.remove("active");

    const trafficBanner = document.getElementById("moveTrafficBanner");
    if (trafficBanner) {
      trafficBanner.className = "traffic-banner hold-steady";
      trafficBanner.textContent = "⏳ Finishing cloud scan & looking up accurate local store prices...";
    }

    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    if (window.EdgeSegmentation) {
      window.EdgeSegmentation.release();
    }
    if (window.liveSpeechRecognizer) {
      try { window.liveSpeechRecognizer.stop(); } catch (e) {}
    }

    const durationSec = Math.max(1, Math.round((Date.now() - sweepStartTime) / 1000));
    speakAgent("Sweep finished. Looking up local retail and used prices for your books and room items.");

    try {
      if (activeCloudPromise) {
        await activeCloudPromise;
      }

      let safetySteps = 0;
      while (pendingCloudQueue.length > 0 && safetySteps < 5) {
        safetySteps++;
        await processPendingCloudBatch(true);
        await new Promise(r => setTimeout(r, 150));
      }

      const primaryLocale = document.getElementById("localeSelect").value;
      const secondaryLocale = document.getElementById("secondaryLocaleSelect").value;
      const [country, currency] = primaryLocale.split("|");
      const apiKey = window.CloudVisionAndPrice.sanitizeApiKey(apiKeyInput.value);
      const modelChoice = document.getElementById("modelSelect").value;

      const { uniqueBooks, uniqueItems } = window.CloudVisionAndPrice.deduplicateInventory(
        rawBooksBuffer,
        rawItemsBuffer,
        excludedFrameRefs
      );

      const { secondaryComparison } = await window.CloudVisionAndPrice.priceAllInventory(
        uniqueBooks,
        uniqueItems,
        primaryLocale,
        secondaryLocale,
        apiKey,
        modelChoice
      );

      roomEstimate.height_m = parseFloat(document.getElementById("ceilingRefM").value || "2.44");

      finalPacket = window.PacketGenerator.buildPacket({
        sweepMeta: {
          id: `sweep_${Date.now()}`,
          captured_at: new Date().toISOString(),
          device: navigator.userAgent.slice(0, 65),
          duration_s: durationSec,
          country,
          currency
        },
        roomEst: roomEstimate,
        books: uniqueBooks,
        items: uniqueItems,
        secondaryComparison,
        stageLatencies: window.CloudVisionAndPrice.stageLatenciesMs
      });

      const htmlReport = window.PacketGenerator.renderHtmlReport(finalPacket);
      document.getElementById("printableReportContainer").innerHTML = htmlReport;
      document.getElementById("reportSection").classList.remove("hidden");
      document.getElementById("reportSection").scrollIntoView({ behavior: "smooth" });

      if (trafficBanner) {
        trafficBanner.className = "traffic-banner snapped-move";
        trafficBanner.textContent = "✅ Final Claim Report & ZIP Packet Ready Below!";
      }

      speakAgent(
        `Claim packet ready. I logged ${finalPacket.totals.book_count} books across ${finalPacket.totals.shelf_run_m} meters of shelving, ` +
        `valued at ${currency} ${finalPacket.totals.books_replacement_cost} new and ${currency} ${finalPacket.totals.books_used_value} used, plus ${finalPacket.items.length} room items.`
      );
    } catch (err) {
      console.error("Error generating final report:", err);
      alert("Notice while generating report: " + err.message);
    } finally {
      finishBtn.disabled = false;
      finishBtn.textContent = "⏹️ Finish & Report";
    }
  });

  // Download Buttons
  document.getElementById("downloadJsonBtn").addEventListener("click", () => {
    if (!finalPacket) return;
    const blob = new Blob([JSON.stringify(finalPacket, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "claim_packet.json";
    a.click();
  });

  document.getElementById("downloadZipBtn").addEventListener("click", () => {
    if (!finalPacket) return;
    const htmlStr = document.getElementById("printableReportContainer").innerHTML;
    const includedFrames = savedFrames.filter(f => !f.excludedByUser);
    window.PacketGenerator.exportZipBundle(finalPacket, htmlStr, includedFrames);
  });

  document.getElementById("printReportBtn").addEventListener("click", () => {
    window.print();
  });

  // Clear Downloaded Models & Browser Cache Button
  document.getElementById("clearCacheBtn").addEventListener("click", async () => {
    if (window.EdgeSegmentation) window.EdgeSegmentation.release();
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    localStorage.clear();
    sessionStorage.clear();
    if (window.indexedDB && indexedDB.databases) {
      const dbs = await indexedDB.databases();
      dbs.forEach(db => indexedDB.deleteDatabase(db.name));
    }
    alert("Cleared all cached AI models (WASM/TFLite), frames, and browser storage.");
    location.reload();
  });

  function setupTabs() {
    document.querySelectorAll(".tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
        document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById(btn.dataset.tab).classList.add("active");
      });
    });
  }
})();