(function () {
  let stream = null;
  let isSweeping = false;
  let isAnalyzingCloud = false;
  let sweepStartTime = 0;
  let timerInterval = null;
  let edgeInterval = null;
  let blurInterval = null;
  let autoCaptureInterval = null;

  let gyroSpeedDegPerSec = 0;
  let currentPanCmPerSec = 0;
  let currentSharpness = 150;
  let isAgentSpeaking = false;
  let skipNextShelfFlag = false;
  let lastKeyframeGray = null;
  let prevTickGray = null;
  let lastCaptureTime = 0;

  const savedFrames = [];
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

  // Update Pan Speed Guidance whenever user switches model in dropdown
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

  // Show/Hide API Key button
  const toggleKeyVisBtn = document.getElementById("toggleKeyVisBtn");
  if (toggleKeyVisBtn && apiKeyInput) {
    toggleKeyVisBtn.addEventListener("click", () => {
      apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
    });
  }

  // 1-Click Test API Key button
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

  // Subtle WebAudio shutter beep so user hears instant confirmation when a frame snaps
  function playShutterBeep() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.12);
    } catch (e) {}
  }

  // Visual shutter flash on video border & pill
  function triggerShutterVisual(frameIdx) {
    playShutterBeep();
    const container = document.getElementById("videoContainer");
    const flashBadge = document.getElementById("shutterFlash");
    if (container) {
      container.classList.add("flash-border");
      setTimeout(() => container.classList.remove("flash-border"), 450);
    }
    if (flashBadge) {
      flashBadge.textContent = `📸 FRAME #${frameIdx} CAPTURED`;
      flashBadge.classList.remove("hidden");
      setTimeout(() => flashBadge.classList.add("hidden"), 1100);
    }
  }

  // Initialize On-Device Edge AI
  window.addEventListener("DOMContentLoaded", () => {
    if (window.EdgeSegmentation) {
      window.EdgeSegmentation.init();
    }
    updateModelPacingUI();
    setupTabs();
    setupSpeechRecognition();
  });

  // Gyroscope Listener
  window.addEventListener("devicemotion", (e) => {
    const r = e.rotationRate;
    if (r) {
      const a = r.alpha || 0;
      const b = r.beta || 0;
      const g = r.gamma || 0;
      gyroSpeedDegPerSec = Math.sqrt(a * a + b * b + g * g);
    }
  });

  // 2D Laplacian Sharpness, Glare & Optical Pan Speed (cm/s) Calculator on 320x240 canvas
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

    // Estimate pan speed in cm/s from both gyroscope and frame-to-frame optical motion
    let opticalDeltaPct = 0;
    if (prevGray && prevGray.length === gray.length) {
      let diff = 0;
      for (let i = 0; i < gray.length; i += 4) {
        diff += Math.abs(gray[i] - prevGray[i]);
      }
      opticalDeltaPct = (diff / (gray.length / 4) / 255) * 100;
    }
    // Convert 250ms optical delta + gyro deg/s into approximate shelf pan speed (cm/s)
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

  // Checks if camera view has changed by at least 3.2% mean absolute pixel difference
  function hasSceneChanged(currentGray, prevGray) {
    if (!currentGray || !prevGray || currentGray.length !== prevGray.length) return true;
    let diffSum = 0;
    for (let i = 0; i < currentGray.length; i += 4) {
      diffSum += Math.abs(currentGray[i] - prevGray[i]);
    }
    const meanDiffPct = (diffSum / (currentGray.length / 4) / 255) * 100;
    return meanDiffPct >= 3.2;
  }

  // Voice Output (Web Speech Synthesis) with Half-Duplex Lock
  function speakAgent(text) {
    const speechEl = document.getElementById("agentSpeechText");
    if (speechEl) speechEl.textContent = text;
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.08;
    utter.onstart = () => { isAgentSpeaking = true; };
    utter.onend = () => { isAgentSpeaking = false; };
    utter.onerror = () => { isAgentSpeaking = false; };
    window.speechSynthesis.speak(utter);
  }

  // Voice Input (Web Speech Recognition) + Interruption Parser
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
    const userTextEl = document.getElementById("userSpeechText");
    if (userTextEl) userTextEl.textContent = `"${transcript}"`;
    const low = transcript.toLowerCase();

    if (low.includes("skip") && low.includes("shelf")) {
      skipNextShelfFlag = true;
      speakAgent("Understood. Skipping the current shelf section.");
    } else if (low.includes("first edition") || low.includes("signed") || low.includes("rare")) {
      const lastBook = rawBooksBuffer[rawBooksBuffer.length - 1];
      if (lastBook) {
        lastBook.status = "needs_appraisal";
        lastBook.rare_or_signed_reason = `Policyholder voice statement: "${transcript}"`;
        renderLiveLists();
      }
      speakAgent("Flagged that title for specialist rare-book appraisal.");
    } else if (low.includes("print") || low.includes("reproduction") || low.includes("poster")) {
      const artItem = [...rawItemsBuffer].reverse().find(i => i.category === "framed_art" || i.is_art_or_portrait);
      if (artItem) {
        artItem.user_confirmed_print = true;
        artItem.status = "range";
        renderLiveLists();
      }
      speakAgent("Noted as a reproduction print and added to standard replacement pricing.");
    } else if (low.includes("original")) {
      speakAgent("Logged artwork as an original piece requiring specialist appraisal.");
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
    videoEl.loop = true;
    await videoEl.play();
    beginSweepLoop(videoEl);
  });

  function beginSweepLoop(videoEl) {
    isSweeping = true;
    sweepStartTime = Date.now();
    lastCaptureTime = Date.now() - 2500;
    document.getElementById("statusDot").classList.add("active");
    document.getElementById("captureKeyframeBtn").disabled = false;
    document.getElementById("finishSweepBtn").disabled = false;

    updateModelPacingUI();
    const profile = window.CloudVisionAndPrice.getPacingProfile(modelSelectEl.value);
    const [country, currency] = document.getElementById("localeSelect").value.split("|");
    const secPerShelf = Math.round(profile.intervalMs / 1000);

    speakAgent(
      `Sweep started for ${country} in ${currency}. Pan at about ${profile.maxPanCmPerSec} centimeters per second, spending ${secPerShelf} seconds per shelf. Hold steady on the first shelf now.`
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
          const latestFrameRef = savedFrames.length > 0
            ? savedFrames[savedFrames.length - 1].frameRef
            : "evidence_frames/frame_001.jpg";
          let added = false;
          for (const it of edgeItems) {
            const exists = rawItemsBuffer.some(
              existing => existing.category === it.category &&
                          window.CloudVisionAndPrice.stringSimilarity(existing.description, it.description) > 0.70
            );
            if (!exists) {
              rawItemsBuffer.push({ ...it, frame_ref: latestFrameRef });
              added = true;
            }
          }
          if (added) renderLiveLists();
        });
      }
    }, 500);

    let lastBlurWarn = 0;
    let latestGrayBuffer = null;
    clearInterval(blurInterval);
    blurInterval = setInterval(() => {
      const activeProfile = window.CloudVisionAndPrice.getPacingProfile(modelSelectEl.value);
      const { sharpness, sharpnessPct, glarePct, panCmPerSec, grayBuffer } = computeSharpnessGlareAndPanSpeed(
        videoEl,
        workCanvas,
        prevTickGray
      );
      prevTickGray = grayBuffer;
      currentSharpness = sharpness;
      currentPanCmPerSec = panCmPerSec;
      latestGrayBuffer = grayBuffer;

      const sharpBadge = document.getElementById("sharpnessBadge");
      const motionBadge = document.getElementById("motionBadge");
      const alertBanner = document.getElementById("alertBanner");
      const captureBadge = document.getElementById("captureStateBadge");
      const progressBar = document.getElementById("captureProgressBar");

      const isTooFast = panCmPerSec > activeProfile.maxPanCmPerSec || gyroSpeedDegPerSec > activeProfile.maxGyroDegPerSec;
      const isBlurry = sharpness < 12;

      sharpBadge.textContent = `🎯 Sharpness: ${sharpnessPct}% (${isBlurry ? "BLURRY" : "GOOD"})`;
      motionBadge.textContent = `🧭 Pan: ${panCmPerSec} cm/s (Limit: ≤${activeProfile.maxPanCmPerSec} cm/s)`;

      // Update Cooldown & Capture Readiness Bar
      const elapsedSinceCapture = Date.now() - lastCaptureTime;
      const progressPct = Math.min(100, Math.round((elapsedSinceCapture / activeProfile.intervalMs) * 100));
      if (progressBar) progressBar.style.width = `${progressPct}%`;

      if (isAnalyzingCloud) {
        if (captureBadge) {
          captureBadge.className = "capture-badge capturing";
          captureBadge.textContent = `🔍 Frame #${savedFrames.length} Captured — AI Reading...`;
        }
      } else if (progressPct < 100) {
        const remSec = Math.max(0.1, ((activeProfile.intervalMs - elapsedSinceCapture) / 1000)).toFixed(1);
        if (captureBadge) {
          captureBadge.className = "capture-badge cooldown";
          captureBadge.textContent = `⏳ Next Auto-Snap in ${remSec}s (Pan slowly to next section)`;
        }
      } else {
        if (captureBadge) {
          captureBadge.className = "capture-badge ready";
          captureBadge.textContent = `🟢 Ready to Snap! Hold steady on shelf`;
        }
      }

      if (isTooFast || isBlurry || glarePct > 28) {
        alertBanner.classList.remove("hidden");
        if (isTooFast) {
          alertBanner.textContent = `⚠️ Panning too fast (${panCmPerSec} cm/s)! Slow down to ≤${activeProfile.maxPanCmPerSec} cm/s so frames stay sharp and within rate limits.`;
        } else if (glarePct > 28) {
          alertBanner.textContent = `⚠️ Strong glare detected on book spines! Angle the phone slightly.`;
        } else {
          alertBanner.textContent = `⚠️ Image is blurry! Hold steady on this shelf for a second.`;
        }

        if (Date.now() - lastBlurWarn > 7500) {
          lastBlurWarn = Date.now();
          if (isTooFast) {
            speakAgent(`Slow down your pan slightly to about ${activeProfile.maxPanCmPerSec} centimeters per second.`);
          } else if (glarePct > 28) {
            speakAgent("I see glare on those spines. Please angle the camera slightly.");
          } else {
            speakAgent("Hold steady for a second so I can capture a sharp frame.");
          }
        }
      } else {
        alertBanner.classList.add("hidden");
      }
    }, 250);

    // Capture first frame at 1.6s, then dynamically trigger whenever model interval is reached & camera is steady
    setTimeout(() => {
      if (isSweeping) {
        lastKeyframeGray = latestGrayBuffer ? new Float32Array(latestGrayBuffer) : null;
        captureAndAnalyzeKeyframe(videoEl, true);
      }
    }, 1600);

    clearInterval(autoCaptureInterval);
    autoCaptureInterval = setInterval(() => {
      if (!isSweeping || isAnalyzingCloud) return;
      const activeProfile = window.CloudVisionAndPrice.getPacingProfile(modelSelectEl.value);
      const timeSinceLast = Date.now() - lastCaptureTime;

      if (
        timeSinceLast >= activeProfile.intervalMs &&
        currentSharpness >= 10 &&
        currentPanCmPerSec <= activeProfile.maxPanCmPerSec &&
        (savedFrames.length < 2 || hasSceneChanged(latestGrayBuffer, lastKeyframeGray))
      ) {
        lastKeyframeGray = latestGrayBuffer ? new Float32Array(latestGrayBuffer) : null;
        captureAndAnalyzeKeyframe(videoEl, false);
      }
    }, 400);
  }

  document.getElementById("captureKeyframeBtn").addEventListener("click", () => {
    if (isAnalyzingCloud) {
      alert("Current frame is still being analyzed. Please wait 1 second.");
      return;
    }
    captureAndAnalyzeKeyframe(document.getElementById("cameraVideo"), true);
  });

  async function captureAndAnalyzeKeyframe(videoEl, forceCapture) {
    if (!isSweeping || !videoEl || videoEl.readyState < 2) return;
    if (isAnalyzingCloud && !forceCapture) return;
    if (skipNextShelfFlag) {
      skipNextShelfFlag = false;
      return;
    }

    lastCaptureTime = Date.now();
    const captureCanvas = document.getElementById("captureCanvas");
    const ctx = captureCanvas.getContext("2d");
    captureCanvas.width = videoEl.videoWidth || 1280;
    captureCanvas.height = videoEl.videoHeight || 720;
    ctx.drawImage(videoEl, 0, 0, captureCanvas.width, captureCanvas.height);

    const frameIdx = savedFrames.length + 1;
    const filename = `frame_${String(frameIdx).padStart(3, "0")}.jpg`;
    const frameRef = `evidence_frames/${filename}`;
    const dataUrl = captureCanvas.toDataURL("image/jpeg", 0.82);
    const base64 = dataUrl.split(",")[1];

    savedFrames.push({ filename, frameRef, base64, dataUrl });
    renderFramesGrid();
    document.getElementById("liveFrameCount").textContent = savedFrames.length;

    // Immediate Visual + Audio Confirmation that Frame #X Has Been Captured
    triggerShutterVisual(frameIdx);

    const apiKey = window.CloudVisionAndPrice.sanitizeApiKey(apiKeyInput.value);
    const modelChoice = document.getElementById("modelSelect").value;
    const [countryCode] = document.getElementById("localeSelect").value.split("|");

    const speechEl = document.getElementById("agentSpeechText");
    if (speechEl) {
      speechEl.textContent = `📸 Frame #${frameIdx} (${filename}) captured! Reading spines & items...`;
    }

    isAnalyzingCloud = true;
    const callStart = performance.now();
    try {
      const result = await window.CloudVisionAndPrice.analyzeKeyframe(base64, apiKey, modelChoice, countryCode);
      const elapsedSec = ((performance.now() - callStart) / 1000).toFixed(1);

      const modelBadge = document.getElementById("modelBadge");
      if (modelBadge) {
        modelBadge.textContent = `🤖 ${window.CloudVisionAndPrice.lastUsedModel} (${elapsedSec}s)`;
      }

      const rawBooks = result.books || [];
      const rawItems = result.items || [];

      if (window.EdgeSegmentation) {
        window.EdgeSegmentation.updateCloudBoxes(rawBooks, rawItems);
      }

      const pxHeights = rawBooks
        .map(b => b.bbox_2d ? ((b.bbox_2d[2] - b.bbox_2d[0]) / 1000) * captureCanvas.height : 280)
        .filter(h => h > 40)
        .sort((a, b) => a - b);
      const medianPx = pxHeights.length ? pxHeights[Math.floor(pxHeights.length / 2)] : 280;

      for (const b of rawBooks) {
        const dims = window.EdgeSegmentation.measureNormalizedBox(
          b.bbox_2d,
          captureCanvas.width,
          captureCanvas.height,
          medianPx
        );
        rawBooksBuffer.push({
          ...b,
          shelf: result.shelf_id || `Shelf_${Math.min(4, Math.ceil(frameIdx / 2))}`,
          frame_ref: frameRef,
          spine_height_cm: dims.height_cm,
          spine_thickness_cm: dims.thickness_cm
        });
      }

      let foundNewArt = false;
      for (const item of rawItems) {
        if (item.category === "framed_art" || item.is_art_or_portrait) {
          foundNewArt = true;
        }
        rawItemsBuffer.push({
          ...item,
          frame_ref: frameRef
        });
      }

      if (result.room_estimate?.estimated_length_m) {
        roomEstimate.length_m = result.room_estimate.estimated_length_m;
        roomEstimate.width_m = result.room_estimate.estimated_width_m || 3.5;
        roomEstimate.shape_note = result.room_estimate.shape_note || "rectangular";
      }

      renderLiveLists();

      // Dynamic Voice Pacing Guidance: tells the user what was captured AND when to move/pan next
      if (foundNewArt) {
        speakAgent(
          `Frame ${frameIdx} captured. Logged ${rawBooks.length} books and a framed picture—is that an original or a print? You can pan slowly to the next section now.`
        );
      } else if (result.capture_feedback) {
        speakAgent(`Frame ${frameIdx} captured. ${result.capture_feedback}`);
      } else if (rawBooks.length > 0 || rawItems.length > 0) {
        speakAgent(
          `Frame ${frameIdx} captured in ${elapsedSec} seconds: saw ${rawBooks.length} books and ${rawItems.length} room items. Keep panning smoothly to the next section.`
        );
      } else {
        speakAgent(
          `Frame ${frameIdx} captured—no new spines in this view. Pan toward the next bookshelf or room corner.`
        );
      }
    } catch (err) {
      console.error("Keyframe analysis error:", err);
      if (speechEl) {
        speechEl.textContent = `⚠️ Frame #${frameIdx} Notice: ${err.message}`;
      }
    } finally {
      isAnalyzingCloud = false;
    }
  }

  function renderLiveLists() {
    const { uniqueBooks, uniqueItems } = window.CloudVisionAndPrice.deduplicateInventory(rawBooksBuffer, rawItemsBuffer);
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
    }

    const itemsListEl = document.getElementById("liveItemsList");
    if (uniqueItems.length > 0) {
      itemsListEl.innerHTML = uniqueItems.slice().reverse().map(it => `
        <div class="list-item ${it.category === "framed_art" ? "warn" : ""}">
          <strong>[${it.category.toUpperCase()}]</strong> ${it.description}
          <div class="meta">${it.dimensions_cm?.w || 60}×${it.dimensions_cm?.h || 80} cm | <code>${it.frame_ref}</code></div>
        </div>
      `).join("");
    }
  }

  function renderFramesGrid() {
    const grid = document.getElementById("liveFramesGrid");
    grid.innerHTML = savedFrames.map(f => `
      <div class="frame-card">
        <img src="${f.dataUrl}" alt="${f.filename}" />
        <div>${f.filename}</div>
      </div>
    `).join("");
  }

  // Finish Sweep, Release Phone RAM, Price Inventory, and Generate Packet
  document.getElementById("finishSweepBtn").addEventListener("click", async () => {
    isSweeping = false;
    clearInterval(timerInterval);
    clearInterval(edgeInterval);
    clearInterval(blurInterval);
    clearInterval(autoCaptureInterval);
    document.getElementById("statusDot").classList.remove("active");

    const captureBadge = document.getElementById("captureStateBadge");
    if (captureBadge) {
      captureBadge.className = "capture-badge ready";
      captureBadge.textContent = "✅ Sweep Complete — Pricing Inventory...";
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
    speakAgent("Sweep finished. Releasing camera memory and pricing your books and room items.");

    const primaryLocale = document.getElementById("localeSelect").value;
    const secondaryLocale = document.getElementById("secondaryLocaleSelect").value;
    const [country, currency] = primaryLocale.split("|");

    const { uniqueBooks, uniqueItems } = window.CloudVisionAndPrice.deduplicateInventory(rawBooksBuffer, rawItemsBuffer);
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

    if (captureBadge) {
      captureBadge.textContent = "✅ Claim Packet Generated";
    }

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
    window.PacketGenerator.exportZipBundle(finalPacket, htmlStr, savedFrames);
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