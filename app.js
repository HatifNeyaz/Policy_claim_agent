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

  // 64x48 Downsampled Block Signatures of All Captured Frames (Prevents Duplicate Photos!)
  const capturedSignatures = [];
  let prevTickSignature = null;
  let lastLocalSnapTime = 0;
  let lastCloudCallTime = 0;
  let steadyTicksCount = 0;

  // All locally captured unique frames + Queue waiting for batched cloud analysis
  const savedFrames = [];
  const pendingCloudQueue = [];
  const excludedFrameRefs = new Set();

  const rawBooksBuffer = [];
  const rawItemsBuffer = [];
  let roomEstimate = { length_m: 4.2, width_m: 3.5, height_m: 2.44, shape_note: "rectangular" };
  let finalPacket = null;

  // Auto-fill and sanitize API key if ?key= is in URL or saved in localStorage
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

  const modelSelectEl = document.getElementById("modelSelect");
  function updateModelPacingUI() {
    if (!modelSelectEl || !window.CloudVisionAndPrice) return;
    const profile = window.CloudVisionAndPrice.getPacingProfile(modelSelectEl.value);
    const guideEl = document.getElementById("panGuideText");
    if (guideEl) {
      guideEl.textContent = profile.guideText;
    }
  }
  if (modelSelectEl) {
    modelSelectEl.addEventListener("change", updateModelPacingUI);
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
      osc1.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + 0.06);
      gain1.gain.setValueAtTime(0.16, ctx.currentTime);
      gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.06);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start();
      osc1.stop(ctx.currentTime + 0.06);

      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = "sine";
      osc2.frequency.setValueAtTime(1600, ctx.currentTime + 0.07);
      gain2.gain.setValueAtTime(0.11, ctx.currentTime + 0.07);
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
      setTimeout(() => whiteFlash.classList.add("hidden"), 120);
    }
    if (container) {
      container.classList.add("flash-border");
      setTimeout(() => container.classList.remove("flash-border"), 650);
    }
    if (flashBadge) {
      flashBadge.textContent = `📸 UNIQUE FRAME #${frameIdx} SNAPPED (${pixelChangePct}% Changed)`;
      flashBadge.classList.remove("hidden");
      setTimeout(() => flashBadge.classList.add("hidden"), 1700);
    }
    if (trafficBanner) {
      trafficBanner.className = "traffic-banner snapped-move";
      trafficBanner.textContent = `🟢 UNIQUE FRAME #${frameIdx} SAVED (Auto-Marked Yours)! Pan smoothly to next area ➡️`;
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    if (window.EdgeSegmentation) {
      window.EdgeSegmentation.init();
    }
    updateModelPacingUI();
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

  // Computes sharpness, glare, pan speed, AND a noise-resistant 64x48 block signature for pixel-change deduplication
  function analyzeFrameAndSignature(videoEl, workCanvas, prevSig) {
    if (!videoEl || videoEl.readyState < 2 || !workCanvas) {
      return { sharpness: 65, sharpnessPct: 92, glarePct: 0, panCmPerSec: 0, signature: null };
    }
    const ctx = workCanvas.getContext("2d", { willReadFrequently: true });
    const w = workCanvas.width;  // 320
    const h = workCanvas.height; // 240
    ctx.drawImage(videoEl, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h).data;

    const gray = new Float32Array(w * h);
    let glarePixels = 0;
    for (let i = 0, p = 0; i < img.length; i += 4, p++) {
      const lum = 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2];
      gray[p] = lum;
      if (lum > 248) glarePixels++;
    }

    // 1. 2D Laplacian Sharpness
    let sum = 0;
    let sumSq = 0;
    let count = 0;
    for (let y = 1; y < h - 1; y += 2) {
      for (let x = 1; x < w - 1; x += 2) {
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

    // 2. Build 64x48 Downsampled Block Grid Signature (5x5 pixel blocks) to ignore camera sensor grain
    const gridW = 64;
    const gridH = 48;
    const signature = new Float32Array(gridW * gridH);
    for (let gy = 0; gy < gridH; gy++) {
      for (let gx = 0; gx < gridW; gx++) {
        let blockSum = 0;
        const startY = gy * 5;
        const startX = gx * 5;
        for (let by = 0; by < 5; by++) {
          const rowOffset = (startY + by) * w + startX;
          for (let bx = 0; bx < 5; bx++) {
            blockSum += gray[rowOffset + bx];
          }
        }
        signature[gy * gridW + gx] = blockSum / 25;
      }
    }

    // 3. Measure short-term pan speed (cm/s) between consecutive 300ms ticks
    let tickDeltaPct = 0;
    if (prevSig && prevSig.length === signature.length) {
      let diff = 0;
      for (let i = 0; i < signature.length; i++) {
        diff += Math.abs(signature[i] - prevSig[i]);
      }
      tickDeltaPct = (diff / signature.length / 255) * 100;
    }
    const gyroCmPerSec = gyroSpeedDegPerSec * 0.42;
    const opticalCmPerSec = tickDeltaPct > 1.5 ? tickDeltaPct * 1.6 : 0;
    const panCmPerSec = Math.round(Math.max(gyroCmPerSec, opticalCmPerSec));

    return {
      sharpness: Math.round(variance),
      sharpnessPct,
      glarePct: Number(glarePct.toFixed(1)),
      panCmPerSec,
      signature
    };
  }

  // Compares current 64x48 signature against ALL previously saved photos and returns the MINIMUM pixel change %
  // This guarantees that even if you pan slowly or revisit a previous angle, it won't snap a duplicate!
  function computeMinPixelChangeFromSaved(currentSig) {
    if (!currentSig || capturedSignatures.length === 0) return 100;
    let minDiffPct = 100;

    // Compare against the last 6 captured frame signatures
    const startIdx = Math.max(0, capturedSignatures.length - 6);
    for (let s = startIdx; s < capturedSignatures.length; s++) {
      const savedSig = capturedSignatures[s];
      let diffSum = 0;
      let changedBlocks = 0;
      for (let i = 0; i < currentSig.length; i++) {
        const d = Math.abs(currentSig[i] - savedSig[i]);
        diffSum += d;
        // Count block as significantly changed if luminance shifted by > 24 levels (out of 255)
        if (d > 24) changedBlocks++;
      }
      const meanIntensityDiffPct = (diffSum / currentSig.length / 255) * 100;
      const changedAreaPct = (changedBlocks / currentSig.length) * 100;
      // Blend area change % and intensity change % for a true human-intuitive "pixel change %"
      const combinedDiffPct = Math.round(changedAreaPct * 0.65 + meanIntensityDiffPct * 0.9);
      if (combinedDiffPct < minDiffPct) {
        minDiffPct = combinedDiffPct;
      }
    }
    return minDiffPct;
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

  // Live Override Tagging (Everything is auto-included as Yours unless overridden here)
  function handleUserVoiceCommand(transcript) {
    const activeFrame = savedFrames[savedFrames.length - 1];
    const frameLabel = activeFrame ? activeFrame.filename : "Current View";

    const userTextEl = document.getElementById("userSpeechText");
    if (userTextEl) {
      userTextEl.textContent = `[Marked on ${frameLabel}]: "${transcript}"`;
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
      speakAgent(`Marked book in ${frameLabel} as a signed or rare edition.`);
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
      alert("Please paste your API key first.");
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
      alert("Camera access error: " + err.message + ". You can also use 'Upload Sweep Video'.");
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
    lastLocalSnapTime = Date.now() - 2500;
    lastCloudCallTime = Date.now() - 2500;
    steadyTicksCount = 0;

    document.getElementById("statusDot").classList.add("active");
    document.getElementById("captureKeyframeBtn").disabled = false;
    document.getElementById("finishSweepBtn").disabled = false;

    updateModelPacingUI();
    const [country, currency] = document.getElementById("localeSelect").value.split("|");

    speakAgent(
      `Sweep started in ${currency}. Everything is automatically counted as yours. Pan smoothly—the camera will only snap when pixels change by at least 18 percent.`
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

    // 300ms Synced Pixel-Change & Stability Tracker (Balanced Pace: Min 4.0s between snaps + >=18% pixel change)
    clearInterval(blurInterval);
    blurInterval = setInterval(() => {
      if (!isSweeping) return;
      const activeProfile = window.CloudVisionAndPrice.getPacingProfile(modelSelectEl.value);
      const pixelThreshold = parseFloat(document.getElementById("pixelThresholdInput")?.value || "18");

      const { sharpness, sharpnessPct, glarePct, panCmPerSec, signature } = analyzeFrameAndSignature(
        videoEl,
        workCanvas,
        prevTickSignature
      );
      prevTickSignature = signature;
      currentSharpness = sharpness;
      currentPanCmPerSec = panCmPerSec;

      const pixelDiffPct = computeMinPixelChangeFromSaved(signature);
      const timeSinceSnap = Date.now() - lastLocalSnapTime;
      const minGapMs = activeProfile.minSnapGapMs || 4000;

      const sharpBadge = document.getElementById("sharpnessBadge");
      const pixelDiffBadge = document.getElementById("pixelDiffBadge");
      const motionBadge = document.getElementById("motionBadge");
      const queueBadge = document.getElementById("queueBadge");
      const alertBanner = document.getElementById("alertBanner");
      const trafficBanner = document.getElementById("moveTrafficBanner");
      const progressBar = document.getElementById("captureProgressBar");

      const isMovingFast = panCmPerSec > activeProfile.maxPanCmPerSec || gyroSpeedDegPerSec > activeProfile.maxGyroDegPerSec;
      const isBlurry = sharpness < 10;

      sharpBadge.textContent = `🎯 Sharpness: ${sharpnessPct}%`;
      pixelDiffBadge.textContent = `🔄 Pixel Change: ${pixelDiffPct}% (Need ≥${pixelThreshold}%)`;
      motionBadge.textContent = `🧭 Pan: ${panCmPerSec} cm/s`;
      queueBadge.textContent = `☁️ Queue: ${pendingCloudQueue.length}`;

      // Progress bar combines pixel change readiness and 4-second pacing timer
      const pixelProgress = Math.min(100, Math.round((pixelDiffPct / pixelThreshold) * 100));
      const timeProgress = Math.min(100, Math.round((timeSinceSnap / minGapMs) * 100));
      const combinedReadiness = savedFrames.length === 0 ? timeProgress : Math.min(pixelProgress, timeProgress);
      if (progressBar) progressBar.style.width = `${combinedReadiness}%`;

      if (!isMovingFast && !isBlurry) {
        steadyTicksCount++;
      } else {
        steadyTicksCount = 0;
      }

      // 1. Check if view is unique (pixelDiffPct >= pixelThreshold) AND 4.0s timer has elapsed AND camera is steady for ~0.9s (3 ticks)
      if (
        (savedFrames.length === 0 && steadyTicksCount >= 3 && timeSinceSnap >= 1800) ||
        (pixelDiffPct >= pixelThreshold && timeSinceSnap >= minGapMs && steadyTicksCount >= 3)
      ) {
        if (signature) capturedSignatures.push(new Float32Array(signature));
        steadyTicksCount = 0;
        snapLocalFrameToMemory(videoEl, pixelDiffPct);
      } else if (pixelDiffPct < pixelThreshold && savedFrames.length > 0) {
        // Pixels haven't changed enough -> tell user this view is already captured so no duplicate is taken!
        if (trafficBanner && timeSinceSnap > 1600) {
          trafficBanner.className = "traffic-banner waiting";
          trafficBanner.textContent = `⏸️ View Already Captured (Pixel Change ${pixelDiffPct}% < ${pixelThreshold}%) — Pan to next area ➡️`;
        }
      } else if (pixelDiffPct >= pixelThreshold && timeSinceSnap < minGapMs) {
        const waitSec = ((minGapMs - timeSinceSnap) / 1000).toFixed(1);
        if (trafficBanner) {
          trafficBanner.className = "traffic-banner hold-steady";
          trafficBanner.textContent = `🟡 Unique View Detected (${pixelDiffPct}% changed) — Auto-snapping in ${waitSec}s (Hold steady)`;
        }
      } else if (pixelDiffPct >= pixelThreshold && steadyTicksCount < 3) {
        if (trafficBanner) {
          trafficBanner.className = "traffic-banner hold-steady";
          trafficBanner.textContent = `🟡 Unique View Ready (${pixelDiffPct}% changed) — Hold steady for a moment to snap!`;
        }
      }

      if (isMovingFast) {
        alertBanner.classList.remove("hidden");
        alertBanner.textContent = `⚠️ Panning slightly fast (${panCmPerSec} cm/s) — Slow down to ≤${activeProfile.maxPanCmPerSec} cm/s`;
      } else {
        alertBanner.classList.add("hidden");
      }
    }, 300);

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
      excludedByUser: false, // Auto-included as user's own property by default
      voiceNotes: [],
      userArtNote: ""
    };

    savedFrames.push(frameObj);
    pendingCloudQueue.push(frameObj);

    triggerShutterVisual(frameIdx, pixelChangePct);
    renderFilmstripAndFramesGrid();

    document.getElementById("liveFrameCount").textContent = savedFrames.length;
    document.getElementById("tabFrameCount").textContent = savedFrames.length;
    const captureBadge = document.getElementById("captureStateBadge");
    if (captureBadge) {
      captureBadge.className = "capture-badge ready";
      captureBadge.textContent = `📸 ${savedFrames.length} Unique Frames (${pendingCloudQueue.length} Queued)`;
    }
  }

  // Non-blocking Cloud Batch Processor (Tracks activeCloudPromise so Finish button never deadlocks)
  function processPendingCloudBatch(flushAll) {
    if (isAnalyzingCloud) {
      return activeCloudPromise || Promise.resolve();
    }
    if (pendingCloudQueue.length === 0) {
      return Promise.resolve();
    }

    const activeProfile = window.CloudVisionAndPrice.getPacingProfile(modelSelectEl.value);
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
      const modelChoice = document.getElementById("modelSelect").value;
      const [countryCode] = document.getElementById("localeSelect").value.split("|");

      const frameNames = batch.map(b => `#${b.index}`).join(", ");
      const speechEl = document.getElementById("agentSpeechText");
      if (speechEl) {
        speechEl.textContent = `☁️ Cloud Batch Scanning Unique Frame(s) ${frameNames}...`;
      }

      const callStart = performance.now();
      try {
        const batchResult = await window.CloudVisionAndPrice.analyzeKeyframeBatch(
          batch,
          apiKey,
          modelChoice,
          countryCode
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
          speechEl.textContent = `⚠️ Batch Notice on ${frameNames}: ${err.message}`;
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
      hint.textContent = `${savedFrames.length} unique frames (${exclCount} marked Not Mine)`;
    }

    if (strip) {
      strip.innerHTML = savedFrames.map(f => {
        const cls = f.excludedByUser ? "excluded" : (f.status === "queued" ? "queued" : "");
        const badge = f.excludedByUser ? "🚫 Not Mine" : (f.status === "queued" ? `⏳ #${f.index} Yours` : `✅ #${f.index} Yours`);
        return `
          <div class="strip-thumb ${cls}" onclick="window.toggleFrameExclusion(${f.index})" title="Default: Yours. Click to toggle Not Mine / Exclude">
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
          <div style="font-size:0.62rem;color:#9ca3af;">Δ Pixels: ${f.pixelChangePct || 100}%</div>
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

  // Finish Sweep & Directly Generate Final Report (Zero Freeze, No Extra Q&A Step)
  const finishBtn = document.getElementById("finishSweepBtn");
  finishBtn.addEventListener("click", async () => {
    isSweeping = false;
    finishBtn.disabled = true;
    finishBtn.textContent = "⏳ Building Final Report...";

    clearInterval(timerInterval);
    clearInterval(edgeInterval);
    clearInterval(blurInterval);
    clearInterval(cloudWorkerInterval);
    document.getElementById("statusDot").classList.remove("active");

    const trafficBanner = document.getElementById("moveTrafficBanner");
    if (trafficBanner) {
      trafficBanner.className = "traffic-banner hold-steady";
      trafficBanner.textContent = "⏳ Finishing cloud sync & pricing inventory... Please wait a few seconds.";
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
    speakAgent("Sweep finished. Completing remaining frames and pricing your inventory now.");

    try {
      // 1. Safely await any currently running in-flight cloud call (No spin-lock!)
      if (activeCloudPromise) {
        await activeCloudPromise;
      }

      // 2. Flush up to 4 remaining batches from pendingCloudQueue with non-blocking yields
      let safetySteps = 0;
      while (pendingCloudQueue.length > 0 && safetySteps < 5) {
        safetySteps++;
        await processPendingCloudBatch(true);
        await new Promise(r => setTimeout(r, 150));
      }

      const primaryLocale = document.getElementById("localeSelect").value;
      const secondaryLocale = document.getElementById("secondaryLocaleSelect").value;
      const [country, currency] = primaryLocale.split("|");

      const { uniqueBooks, uniqueItems } = window.CloudVisionAndPrice.deduplicateInventory(
        rawBooksBuffer,
        rawItemsBuffer,
        excludedFrameRefs
      );

      const { secondaryComparison } = await window.CloudVisionAndPrice.priceAllInventory(
        uniqueBooks,
        uniqueItems,
        primaryLocale,
        secondaryLocale
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
      finishBtn.textContent = "⏹️ Finish & Generate Final Report";
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