(function () {
  let stream = null;
  let isSweeping = false;
  let isAnalyzingCloud = false;
  let sweepStartTime = 0;
  let timerInterval = null;
  let edgeInterval = null;
  let blurInterval = null;
  let cloudWorkerInterval = null;

  let gyroSpeedDegPerSec = 0;
  let currentPanCmPerSec = 0;
  let currentSharpness = 150;
  let isAgentSpeaking = false;

  // Local Optical Scene Memory (Decoupled from Cloud API so zero views are missed!)
  let lastSnappedGray = null;
  let prevTickGray = null;
  let lastLocalSnapTime = 0;
  let lastCloudCallTime = 0;
  let steadyTicksCount = 0;

  // All locally captured frames + Queue waiting for batched cloud analysis
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

  // Distinct two-tone camera shutter click sound so user immediately hears every snap without looking
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
      gain1.gain.setValueAtTime(0.18, ctx.currentTime);
      gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.06);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start();
      osc1.stop(ctx.currentTime + 0.06);

      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = "sine";
      osc2.frequency.setValueAtTime(1600, ctx.currentTime + 0.07);
      gain2.gain.setValueAtTime(0.12, ctx.currentTime + 0.07);
      gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.16);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(ctx.currentTime + 0.07);
      osc2.stop(ctx.currentTime + 0.16);
    } catch (e) {}
  }

  // Unmistakable Full-Screen Shutter Flash + Traffic Light "YOU CAN MOVE ON" Update
  function triggerShutterVisual(frameIdx) {
    playCameraShutterSound();
    const container = document.getElementById("videoContainer");
    const whiteFlash = document.getElementById("whiteScreenFlash");
    const flashBadge = document.getElementById("shutterFlash");
    const trafficBanner = document.getElementById("moveTrafficBanner");

    if (whiteFlash) {
      whiteFlash.classList.remove("hidden");
      setTimeout(() => whiteFlash.classList.add("hidden"), 130);
    }
    if (container) {
      container.classList.add("flash-border");
      setTimeout(() => container.classList.remove("flash-border"), 650);
    }
    if (flashBadge) {
      flashBadge.textContent = `📸 SNAPPED FRAME #${frameIdx}! MOVE TO NEXT VIEW ➡️`;
      flashBadge.classList.remove("hidden");
      setTimeout(() => flashBadge.classList.add("hidden"), 1600);
    }
    if (trafficBanner) {
      trafficBanner.className = "traffic-banner snapped-move";
      trafficBanner.textContent = `🟢 FRAME #${frameIdx} CAPTURED IN MEMORY! Pan to the next item/shelf now ➡️`;
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

  function computeSharpnessGlareAndPanSpeed(videoEl, workCanvas, prevGray) {
    if (!videoEl || videoEl.readyState < 2 || !workCanvas) {
      return { sharpness: 65, sharpnessPct: 92, glarePct: 0, panCmPerSec: 0, grayBuffer: null };
    }
    const ctx = workCanvas.getContext("2d", { willReadFrequently: true });
    const w = workCanvas.width;
    const h = workCanvas.height;
    ctx.drawImage(videoEl, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h).data;

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
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
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

    let opticalDeltaPct = 0;
    if (prevGray && prevGray.length === gray.length) {
      let diff = 0;
      for (let i = 0; i < gray.length; i += 4) {
        diff += Math.abs(gray[i] - prevGray[i]);
      }
      opticalDeltaPct = (diff / (gray.length / 4) / 255) * 100;
    }
    const gyroCmPerSec = gyroSpeedDegPerSec * 0.42;
    const opticalCmPerSec = opticalDeltaPct > 1.8 ? opticalDeltaPct * 1.65 : 0;
    const panCmPerSec = Math.round(Math.max(gyroCmPerSec, opticalCmPerSec));

    return {
      sharpness: Math.round(variance),
      sharpnessPct,
      glarePct: Number(glarePct.toFixed(1)),
      panCmPerSec,
      grayBuffer: gray
    };
  }

  // Returns percentage of scene change between current view and last locally snapped frame (0 to 100)
  function computeSceneNoveltyPct(currentGray, lastSnapped) {
    if (!currentGray || !lastSnapped || currentGray.length !== lastSnapped.length) return 100;
    let diffSum = 0;
    for (let i = 0; i < currentGray.length; i += 4) {
      diffSum += Math.abs(currentGray[i] - lastSnapped[i]);
    }
    return (diffSum / (currentGray.length / 4) / 255) * 100;
  }

  function speakAgent(text) {
    const speechEl = document.getElementById("agentSpeechText");
    if (speechEl) speechEl.textContent = text;
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.12;
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

  // Frame-Bound Live Voice Memory: Links spoken statements directly to the current active frame!
  function handleUserVoiceCommand(transcript) {
    const activeFrame = savedFrames[savedFrames.length - 1];
    const frameLabel = activeFrame ? activeFrame.filename : "Current View";

    const userTextEl = document.getElementById("userSpeechText");
    if (userTextEl) {
      userTextEl.textContent = `[Bound to ${frameLabel}]: "${transcript}"`;
    }

    if (activeFrame) {
      activeFrame.voiceNotes = activeFrame.voiceNotes || [];
      activeFrame.voiceNotes.push(transcript);
    }

    const low = transcript.toLowerCase();

    // 1. User says "Not my shelf", "Not mine", "Exclude", or "Skip" -> Excludes the current frame!
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
        speakAgent(`Marked Frame ${activeFrame.index} as not yours—it will be excluded from the final report.`);
      } else {
        speakAgent("Noted. I will exclude this section.");
      }
      return;
    }

    // 2. User says "first edition", "signed", or "rare"
    if (low.includes("first edition") || low.includes("signed") || low.includes("rare")) {
      const lastBook = rawBooksBuffer[rawBooksBuffer.length - 1];
      if (lastBook) {
        lastBook.status = "needs_appraisal";
        lastBook.rare_or_signed_reason = `User stated during ${frameLabel}: "${transcript}"`;
        renderLiveLists();
      }
      speakAgent(`Tagged book in ${frameLabel} as a rare or signed edition.`);
      return;
    }

    // 3. User says "print" / "reproduction" vs "original"
    if (low.includes("print") || low.includes("reproduction") || low.includes("poster")) {
      if (activeFrame) activeFrame.userArtNote = "print";
      const artItem = [...rawItemsBuffer].reverse().find(i => i.category === "framed_art" || i.is_art_or_portrait);
      if (artItem) {
        artItem.user_confirmed_print = true;
        artItem.user_art_note = "print";
        artItem.status = "range";
        renderLiveLists();
      }
      speakAgent(`Tagged picture in ${frameLabel} as a print.`);
    } else if (low.includes("original")) {
      if (activeFrame) activeFrame.userArtNote = "original";
      const artItem = [...rawItemsBuffer].reverse().find(i => i.category === "framed_art" || i.is_art_or_portrait);
      if (artItem) {
        artItem.user_confirmed_print = false;
        artItem.user_art_note = "original";
        artItem.status = "needs_appraisal";
        renderLiveLists();
      }
      speakAgent(`Tagged picture in ${frameLabel} as an original artwork for appraisal.`);
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
    lastLocalSnapTime = 0;
    lastCloudCallTime = Date.now() - 2500;
    steadyTicksCount = 0;

    document.getElementById("statusDot").classList.add("active");
    document.getElementById("captureKeyframeBtn").disabled = false;
    document.getElementById("finishSweepBtn").disabled = false;

    updateModelPacingUI();
    const [country, currency] = document.getElementById("localeSelect").value.split("|");

    speakAgent(
      `Sweep started for ${country}. Pause for half a second on each area—like your table, bed, or shelf—until you hear the camera shutter click, then move to the next.`
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

    // 250ms Local Scene Tracker: Snaps every distinct room view into local memory immediately!
    clearInterval(blurInterval);
    blurInterval = setInterval(() => {
      if (!isSweeping) return;
      const activeProfile = window.CloudVisionAndPrice.getPacingProfile(modelSelectEl.value);
      const { sharpness, sharpnessPct, glarePct, panCmPerSec, grayBuffer } = computeSharpnessGlareAndPanSpeed(
        videoEl,
        workCanvas,
        prevTickGray
      );
      prevTickGray = grayBuffer;
      currentSharpness = sharpness;
      currentPanCmPerSec = panCmPerSec;

      const sharpBadge = document.getElementById("sharpnessBadge");
      const motionBadge = document.getElementById("motionBadge");
      const queueBadge = document.getElementById("queueBadge");
      const alertBanner = document.getElementById("alertBanner");
      const trafficBanner = document.getElementById("moveTrafficBanner");
      const progressBar = document.getElementById("captureProgressBar");

      const isMovingFast = panCmPerSec > 18 || gyroSpeedDegPerSec > 55;
      const isBlurry = sharpness < 10;

      sharpBadge.textContent = `🎯 Sharpness: ${sharpnessPct}%`;
      motionBadge.textContent = `🧭 Pan: ${panCmPerSec} cm/s`;
      queueBadge.textContent = `☁️ Queue: ${pendingCloudQueue.length} pending`;

      // Calculate how different the current camera view is from the last locally snapped frame
      const noveltyPct = computeSceneNoveltyPct(grayBuffer, lastSnappedGray);
      const timeSinceSnap = Date.now() - lastLocalSnapTime;

      // Show novelty progress bar (when novelty >= 10.5% and user pauses for 2 ticks = 0.5s, it snaps!)
      const readinessPct = Math.min(100, Math.round((noveltyPct / 10.5) * 100));
      if (progressBar) progressBar.style.width = `${readinessPct}%`;

      if (!isMovingFast && !isBlurry) {
        steadyTicksCount++;
      } else {
        steadyTicksCount = 0;
      }

      // If user panned to a new area (novelty >= 10.5%) AND paused briefly (steadyTicksCount >= 2, >1.4s since last snap)
      if (
        (savedFrames.length === 0 && steadyTicksCount >= 2) ||
        (noveltyPct >= 10.5 && steadyTicksCount >= 2 && timeSinceSnap >= 1400)
      ) {
        lastSnappedGray = grayBuffer ? new Float32Array(grayBuffer) : null;
        steadyTicksCount = 0;
        snapLocalFrameToMemory(videoEl);
      } else if (noveltyPct >= 10.5 && (isMovingFast || steadyTicksCount < 2)) {
        // User has moved to a new item (e.g. Bed) -> tell them to pause for 0.4s so it snaps!
        if (trafficBanner) {
          trafficBanner.className = "traffic-banner hold-steady";
          trafficBanner.textContent = `🟡 NEW VIEW DETECTED — Hold steady for 0.5s to snap photo!`;
        }
      }

      if (isMovingFast && timeSinceSnap > 2200) {
        alertBanner.classList.remove("hidden");
        alertBanner.textContent = `⚠️ Pause briefly on this item so the camera can snap a sharp frame!`;
      } else {
        alertBanner.classList.add("hidden");
      }
    }, 250);

    // Background Cloud Batch Worker: Sends up to 3 queued local frames in ONE single API call!
    clearInterval(cloudWorkerInterval);
    cloudWorkerInterval = setInterval(() => {
      processPendingCloudBatch(false);
    }, 600);
  }

  // Manual Force Snap button
  document.getElementById("captureKeyframeBtn").addEventListener("click", () => {
    const videoEl = document.getElementById("cameraVideo");
    snapLocalFrameToMemory(videoEl);
  });

  // Immediately captures the current video frame into local memory + filmstrip (0ms lag, 0 API cost)
  function snapLocalFrameToMemory(videoEl) {
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
      status: "queued", // "queued" | "scanned"
      excludedByUser: false,
      voiceNotes: [],
      userArtNote: ""
    };

    savedFrames.push(frameObj);
    pendingCloudQueue.push(frameObj);

    // Unmistakable visual + audio shutter click + green "MOVE ON" banner
    triggerShutterVisual(frameIdx);
    renderFilmstripAndFramesGrid();

    document.getElementById("liveFrameCount").textContent = savedFrames.length;
    document.getElementById("tabFrameCount").textContent = savedFrames.length;
    const captureBadge = document.getElementById("captureStateBadge");
    if (captureBadge) {
      captureBadge.className = "capture-badge ready";
      captureBadge.textContent = `📸 ${savedFrames.length} Snapped (${pendingCloudQueue.length} in Cloud Queue)`;
    }
  }

  // Background Cloud Batch Processor: bundles up to 3 local frames into 1 API call to respect rate limits
  async function processPendingCloudBatch(flushAll) {
    if (isAnalyzingCloud || pendingCloudQueue.length === 0) return;

    const activeProfile = window.CloudVisionAndPrice.getPacingProfile(modelSelectEl.value);
    const timeSinceLastCloud = Date.now() - lastCloudCallTime;

    if (!flushAll && timeSinceLastCloud < activeProfile.batchIntervalMs) return;

    // Pop up to maxBatchSize (3) non-excluded frames from the queue
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
    if (batch.length === 0) return;

    isAnalyzingCloud = true;
    lastCloudCallTime = Date.now();

    const apiKey = window.CloudVisionAndPrice.sanitizeApiKey(apiKeyInput.value);
    const modelChoice = document.getElementById("modelSelect").value;
    const [countryCode] = document.getElementById("localeSelect").value.split("|");

    const frameNames = batch.map(b => `#${b.index}`).join(", ");
    const speechEl = document.getElementById("agentSpeechText");
    if (speechEl) {
      speechEl.textContent = `☁️ Cloud Batch Analyzing Frame(s) ${frameNames} in 1 API call... (Keep panning!)`;
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
        modelBadge.textContent = `🤖 ${window.CloudVisionAndPrice.lastUsedModel} (${elapsedSec}s batch)`;
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
        speakAgent(
          `Processed Frame ${frameNames}: logged ${batchBooksCount} books and ${batchItemsCount} room items.`
        );
      }
    } catch (err) {
      console.error("Batch analysis error:", err);
      // Mark frames so user sees status
      batch.forEach(f => { f.status = "scanned"; });
      renderFilmstripAndFramesGrid();
      if (speechEl) {
        speechEl.textContent = `⚠️ Batch Notice on ${frameNames}: ${err.message}`;
      }
    } finally {
      isAnalyzingCloud = false;
    }
  }

  // Toggles whether a specific captured frame is included or excluded ("Not Mine")
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

  // Renders both the live bottom-of-video Filmstrip Memory and the All Frames Tab
  function renderFilmstripAndFramesGrid() {
    const strip = document.getElementById("liveFilmstrip");
    const hint = document.getElementById("filmstripHint");
    if (hint) {
      const exclCount = excludedFrameRefs.size;
      hint.textContent = `${savedFrames.length} snapped (${exclCount} excluded)`;
    }

    if (strip) {
      strip.innerHTML = savedFrames.map(f => {
        const cls = f.excludedByUser ? "excluded" : (f.status === "queued" ? "queued" : "");
        const badge = f.excludedByUser ? "🚫 Not Mine" : (f.status === "queued" ? `⏳ #${f.index}` : `✅ #${f.index}`);
        return `
          <div class="strip-thumb ${cls}" onclick="window.toggleFrameExclusion(${f.index})" title="Click to toggle Include vs Exclude (Not Mine)">
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
          <div><strong>#${f.index}</strong> (${f.excludedByUser ? "🚫 Excluded" : "✅ Included"})</div>
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
      booksListEl.innerHTML = `<p class="empty-hint">No active books in included frames yet.</p>`;
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
      itemsListEl.innerHTML = `<p class="empty-hint">No active room items in included frames yet.</p>`;
    }
  }

  // Step 1 on Clicking "Finish & Review Q&A": Flush remaining queue & open Visual Q&A + Frame Audit Session!
  document.getElementById("finishSweepBtn").addEventListener("click", async () => {
    isSweeping = false;
    clearInterval(timerInterval);
    clearInterval(edgeInterval);
    clearInterval(blurInterval);
    clearInterval(cloudWorkerInterval);
    document.getElementById("statusDot").classList.remove("active");

    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    if (window.EdgeSegmentation) {
      window.EdgeSegmentation.release();
    }

    // Flush any remaining frames in pendingCloudQueue before opening Q&A
    while (pendingCloudQueue.length > 0) {
      await processPendingCloudBatch(true);
    }

    openPreReportVisualQaSession();
  });

  // Builds the Pre-Report Interactive Visual Q&A & Frame Audit UI (Shows exact photo + highlight box for every question!)
  function openPreReportVisualQaSession() {
    const qaSection = document.getElementById("qaReviewSection");
    const questionsContainer = document.getElementById("qaQuestionsContainer");
    const framesAuditGrid = document.getElementById("qaFramesAuditGrid");

    qaSection.classList.remove("hidden");
    qaSection.scrollIntoView({ behavior: "smooth" });

    const { uniqueBooks, uniqueItems } = window.CloudVisionAndPrice.deduplicateInventory(
      rawBooksBuffer,
      rawItemsBuffer,
      excludedFrameRefs
    );

    const qaCardsHtml = [];
    const drawTasks = [];

    // 1. Find all Framed Art / Wall Pictures or Uncertain Items needing user confirmation
    uniqueItems.forEach((item, idx) => {
      if (item.category === "framed_art" || item.is_art_or_portrait || item.description.toLowerCase().includes("picture") || item.description.toLowerCase().includes("portrait") || item.description.toLowerCase().includes("art")) {
        const canvasId = `qa_art_canvas_${idx}`;
        const currentChoice = item.user_art_note || (item.user_confirmed_print ? "print" : "original");
        qaCardsHtml.push(`
          <div class="qa-item-card" id="qa_card_item_${idx}">
            <canvas id="${canvasId}" width="480" height="270"></canvas>
            <div>
              <strong>🖼️ Question on <code>${item.frame_ref}</code>:</strong>
              <p style="font-size:0.8rem;color:#d1d5db;margin-top:2px;">
                We detected <strong>"${item.description}"</strong> (highlighted in cyan above). Is this a reproduction print or an original artwork?
              </p>
            </div>
            <div class="qa-opt-btns">
              <button type="button" class="qa-opt-btn ${currentChoice === "print" ? "selected" : ""}" onclick="window.setQaItemDecision('${item.frame_ref}', '${item.description.replace(/'/g, "")}', 'print', this)">
                🖼️ It's a Print (Price Normally)
              </button>
              <button type="button" class="qa-opt-btn ${currentChoice === "original" ? "selected" : ""}" onclick="window.setQaItemDecision('${item.frame_ref}', '${item.description.replace(/'/g, "")}', 'original', this)">
                🎨 Original Art (Needs Appraisal)
              </button>
              <button type="button" class="qa-opt-btn" onclick="window.setQaItemDecision('${item.frame_ref}', '${item.description.replace(/'/g, "")}', 'exclude', this)">
                🚫 Not Mine / Exclude
              </button>
            </div>
          </div>
        `);
        drawTasks.push({ canvasId, frameRef: item.frame_ref, bbox: item.bbox_2d, color: "#06b6d4", label: item.description });
      }
    });

    // 2. Find any Flagged / Rare Books
    uniqueBooks.forEach((book, idx) => {
      if (book.status === "needs_appraisal" || book.rare_or_signed_reason) {
        const canvasId = `qa_book_canvas_${idx}`;
        qaCardsHtml.push(`
          <div class="qa-item-card" id="qa_card_book_${idx}">
            <canvas id="${canvasId}" width="480" height="270"></canvas>
            <div>
              <strong>📚 Book Check on <code>${book.frame_ref}</code>:</strong>
              <p style="font-size:0.8rem;color:#d1d5db;margin-top:2px;">
                <strong>"${book.title || "Spine"}"</strong> was flagged (${book.rare_or_signed_reason || "Appraisal check"}). How should we handle it?
              </p>
            </div>
            <div class="qa-opt-btns">
              <button type="button" class="qa-opt-btn selected" onclick="window.setQaBookDecision('${book.frame_ref}', '${(book.title || "").replace(/'/g, "")}', 'appraisal', this)">
                ⭐ Keep Flagged for Appraisal
              </button>
              <button type="button" class="qa-opt-btn" onclick="window.setQaBookDecision('${book.frame_ref}', '${(book.title || "").replace(/'/g, "")}', 'standard', this)">
                📗 Standard Edition (Price Normally)
              </button>
              <button type="button" class="qa-opt-btn" onclick="window.setQaBookDecision('${book.frame_ref}', '${(book.title || "").replace(/'/g, "")}', 'exclude', this)">
                🚫 Not Mine / Exclude
              </button>
            </div>
          </div>
        `);
        drawTasks.push({ canvasId, frameRef: book.frame_ref, bbox: book.bbox_2d, color: "#10b981", label: book.title || "Book" });
      }
    });

    if (qaCardsHtml.length === 0) {
      questionsContainer.innerHTML = `
        <div class="qa-item-card">
          <strong>✅ Zero Ambiguous Artworks or Unresolved Questions!</strong>
          <p style="font-size:0.82rem;color:#9ca3af;">
            All detected items are clear. You can still review the captured frames below to exclude any shelf or area that is not yours, then click <strong>"Confirm All & Generate Final Claim Report"</strong>.
          </p>
        </div>
      `;
      speakAgent("Sweep complete! Please verify your captured frames below, then click Confirm to generate your priced claim report.");
    } else {
      questionsContainer.innerHTML = qaCardsHtml.join("");
      speakAgent(
        `Sweep complete! I have ${qaCardsHtml.length} visual question${qaCardsHtml.length > 1 ? "s" : ""} shown with their exact photo below. Click an option on each photo, then click Confirm.`
      );
    }

    // Draw the exact frame image + highlighted bounding box on each question canvas
    setTimeout(() => {
      for (const task of drawTasks) {
        const c = document.getElementById(task.canvasId);
        const frameObj = savedFrames.find(f => f.frameRef === task.frameRef) || savedFrames[0];
        if (!c || !frameObj) continue;
        const ctx = c.getContext("2d");
        const img = new Image();
        img.onload = () => {
          ctx.drawImage(img, 0, 0, c.width, c.height);
          if (Array.isArray(task.bbox) && task.bbox.length === 4) {
            const [ymin, xmin, ymax, xmax] = task.bbox;
            const x = (xmin / 1000) * c.width;
            const y = (ymin / 1000) * c.height;
            const w = ((xmax - xmin) / 1000) * c.width;
            const h = ((ymax - ymin) / 1000) * c.height;
            ctx.strokeStyle = task.color;
            ctx.lineWidth = 4;
            ctx.strokeRect(x, y, w, h);
            ctx.fillStyle = "rgba(11, 15, 25, 0.85)";
            ctx.fillRect(x, Math.max(0, y - 22), Math.min(c.width - x, 240), 22);
            ctx.fillStyle = "#fff";
            ctx.font = "bold 12px sans-serif";
            ctx.fillText(`🎯 ${task.label.slice(0, 28)}`, x + 5, Math.max(15, y - 6));
          }
        };
        img.src = frameObj.dataUrl;
      }
    }, 60);

    // Render Frame Audit Grid inside Q&A modal
    renderQaFramesAuditGrid(framesAuditGrid);
  }

  function renderQaFramesAuditGrid(container) {
    if (!container) return;
    container.innerHTML = savedFrames.map(f => `
      <div class="frame-card ${f.excludedByUser ? "excluded" : ""}" onclick="window.toggleFrameInQa(${f.index})">
        <img src="${f.dataUrl}" alt="${f.filename}" />
        <div style="padding:4px;">
          <strong>Frame #${f.index}</strong><br/>
          <span style="color:${f.excludedByUser ? "#ef4444" : "#10b981"};font-weight:700;">
            ${f.excludedByUser ? "🚫 Excluded (Not Mine)" : "✅ Included in Claim"}
          </span>
          ${f.voiceNotes?.length ? `<div style="font-size:0.65rem;color:#67e8f9;margin-top:2px;">🎙️ "${f.voiceNotes.join("; ")}"</div>` : ""}
        </div>
      </div>
    `).join("");
  }

  window.toggleFrameInQa = function (frameIdx) {
    toggleFrameExclusion(frameIdx);
    renderQaFramesAuditGrid(document.getElementById("qaFramesAuditGrid"));
  };

  window.setQaItemDecision = function (frameRef, descSnippet, decision, btnEl) {
    if (btnEl && btnEl.parentElement) {
      btnEl.parentElement.querySelectorAll(".qa-opt-btn").forEach(b => b.classList.remove("selected"));
      btnEl.classList.add("selected");
    }
    for (const it of rawItemsBuffer) {
      if (it.frame_ref === frameRef || it.description.replace(/'/g, "") === descSnippet) {
        if (decision === "print") {
          it.user_confirmed_print = true;
          it.user_art_note = "print";
          it.status = "range";
          it.excluded_by_user = false;
        } else if (decision === "original") {
          it.user_confirmed_print = false;
          it.user_art_note = "original";
          it.status = "needs_appraisal";
          it.excluded_by_user = false;
        } else if (decision === "exclude") {
          it.excluded_by_user = true;
        }
      }
    }
    renderLiveLists();
  };

  window.setQaBookDecision = function (frameRef, titleSnippet, decision, btnEl) {
    if (btnEl && btnEl.parentElement) {
      btnEl.parentElement.querySelectorAll(".qa-opt-btn").forEach(b => b.classList.remove("selected"));
      btnEl.classList.add("selected");
    }
    for (const b of rawBooksBuffer) {
      if (b.frame_ref === frameRef && (b.title || "").replace(/'/g, "") === titleSnippet) {
        if (decision === "appraisal") {
          b.status = "needs_appraisal";
          b.excluded_by_user = false;
        } else if (decision === "standard") {
          b.status = "identified";
          b.user_forced_standard = true;
          b.excluded_by_user = false;
        } else if (decision === "exclude") {
          b.excluded_by_user = true;
        }
      }
    }
    renderLiveLists();
  };

  // Step 2: Confirm Q&A & Generate Final Priced Claim Packet
  document.getElementById("confirmQaAndGenerateBtn").addEventListener("click", async () => {
    if (window.liveSpeechRecognizer) {
      try { window.liveSpeechRecognizer.stop(); } catch (e) {}
    }

    const durationSec = Math.max(1, Math.round((Date.now() - sweepStartTime) / 1000));
    speakAgent("Pricing your confirmed inventory against local catalogs and building your final claim packet.");

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
    document.getElementById("qaReviewSection").classList.add("hidden");
    document.getElementById("reportSection").classList.remove("hidden");
    document.getElementById("reportSection").scrollIntoView({ behavior: "smooth" });

    speakAgent(
      `Claim packet ready. I logged ${finalPacket.totals.book_count} books across ${finalPacket.totals.shelf_run_m} meters of shelving, ` +
      `valued at ${currency} ${finalPacket.totals.books_replacement_cost} new and ${currency} ${finalPacket.totals.books_used_value} used, plus ${finalPacket.items.length} room items.`
    );
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