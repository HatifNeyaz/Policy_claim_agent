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
  let currentSharpness = 150;
  let isAgentSpeaking = false;
  let skipNextShelfFlag = false;
  let lastKeyframeGray = null;

  const savedFrames = [];
  const rawBooksBuffer = [];
  const rawItemsBuffer = [];
  let roomEstimate = { length_m: 4.2, width_m: 3.5, height_m: 2.44, shape_note: "rectangular" };
  let finalPacket = null;

  // Auto-fill API key if ?key= is in URL or saved in localStorage
  const urlParams = new URLSearchParams(window.location.search);
  const apiKeyInput = document.getElementById("apiKeyInput");
  if (apiKeyInput) {
    const savedKey = urlParams.get("key") || localStorage.getItem("CLAIM_AGENT_API_KEY") || "";
    if (savedKey) apiKeyInput.value = savedKey;
    apiKeyInput.addEventListener("input", () => {
      localStorage.setItem("CLAIM_AGENT_API_KEY", apiKeyInput.value.trim());
    });
  }

  // Initialize On-Device Edge AI
  window.addEventListener("DOMContentLoaded", () => {
    if (window.EdgeSegmentation) {
      window.EdgeSegmentation.init();
    }
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

  // 2D Laplacian Variance Sharpness & Glare Calculator on 320x240 canvas
  function computeSharpnessAndGlare(videoEl, workCanvas) {
    if (!videoEl || videoEl.readyState < 2 || !workCanvas) {
      return { sharpness: 65, sharpnessPct: 92, glarePct: 0, grayBuffer: null };
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
    return {
      sharpness: Math.round(variance),
      sharpnessPct,
      glarePct: Number(glarePct.toFixed(1)),
      grayBuffer: gray
    };
  }

  // Checks if camera view has changed by at least 3.5% mean absolute pixel difference
  function hasSceneChanged(currentGray, prevGray) {
    if (!currentGray || !prevGray || currentGray.length !== prevGray.length) return true;
    let diffSum = 0;
    for (let i = 0; i < currentGray.length; i += 4) {
      diffSum += Math.abs(currentGray[i] - prevGray[i]);
    }
    const meanDiffPct = (diffSum / (currentGray.length / 4) / 255) * 100;
    return meanDiffPct >= 3.5;
  }

  // Voice Output (Web Speech Synthesis) with Half-Duplex Lock
  function speakAgent(text) {
    const speechEl = document.getElementById("agentSpeechText");
    if (speechEl) speechEl.textContent = text;
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.04;
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

  // Quick voice chip buttons
  document.querySelectorAll(".chip-btn").forEach(btn => {
    btn.addEventListener("click", () => handleUserVoiceCommand(btn.dataset.voice));
  });

  // Start Live Camera Sweep
  document.getElementById("startSweepBtn").addEventListener("click", async () => {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
      alert("Please paste your free Gemini (AIza...) or Groq (gsk_...) API key first.");
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

  // Upload Recorded Video Sweep (For easy testing or desktop review)
  document.getElementById("videoUploadInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const apiKey = apiKeyInput.value.trim();
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
    document.getElementById("statusDot").classList.add("active");
    document.getElementById("captureKeyframeBtn").disabled = false;
    document.getElementById("finishSweepBtn").disabled = false;

    const [country, currency] = document.getElementById("localeSelect").value.split("|");
    speakAgent(`Sweep started for ${country} in ${currency}. Pan slowly across each bookshelf and room wall in one continuous pass.`);

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

    // 500ms On-Device Segmentation Loop + Edge Non-Book Object Bridge
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

    // 250ms Sharpness, Glare & Gyro Speed Check Loop
    let lastBlurWarn = 0;
    let latestGrayBuffer = null;
    clearInterval(blurInterval);
    blurInterval = setInterval(() => {
      const { sharpness, sharpnessPct, glarePct, grayBuffer } = computeSharpnessAndGlare(videoEl, workCanvas);
      currentSharpness = sharpness;
      latestGrayBuffer = grayBuffer;

      const sharpBadge = document.getElementById("sharpnessBadge");
      const motionBadge = document.getElementById("motionBadge");
      const alertBanner = document.getElementById("alertBanner");

      const isFast = gyroSpeedDegPerSec > 85;
      const isBlurry = sharpness < 12;

      sharpBadge.textContent = `🎯 Sharpness: ${sharpnessPct}% (${isBlurry ? "BLURRY" : "GOOD"})`;

      if (isFast || isBlurry || glarePct > 28) {
        alertBanner.classList.remove("hidden");
        motionBadge.textContent = isFast ? "📱 Motion: Too Fast!" : "📱 Hold Steady";
        if (Date.now() - lastBlurWarn > 8000) {
          lastBlurWarn = Date.now();
          if (glarePct > 28) {
            speakAgent("I see strong glare on those spines. Please angle the camera slightly.");
          } else {
            speakAgent("Hold steady for a second, that shelf section is slightly blurry.");
          }
        }
      } else {
        alertBanner.classList.add("hidden");
        motionBadge.textContent = "📱 Motion: Steady";
      }
    }, 250);

    // Capture first keyframe at 1.8s, then every 5.5s when camera is steady
    setTimeout(() => {
      if (isSweeping) {
        lastKeyframeGray = latestGrayBuffer ? new Float32Array(latestGrayBuffer) : null;
        captureAndAnalyzeKeyframe(videoEl, true);
      }
    }, 1800);

    clearInterval(autoCaptureInterval);
    autoCaptureInterval = setInterval(() => {
      if (
        isSweeping &&
        !isAnalyzingCloud &&
        currentSharpness >= 10 &&
        gyroSpeedDegPerSec <= 85 &&
        (savedFrames.length < 3 || hasSceneChanged(latestGrayBuffer, lastKeyframeGray))
      ) {
        lastKeyframeGray = latestGrayBuffer ? new Float32Array(latestGrayBuffer) : null;
        captureAndAnalyzeKeyframe(videoEl, false);
      }
    }, 5500);
  }

  document.getElementById("captureKeyframeBtn").addEventListener("click", () => {
    captureAndAnalyzeKeyframe(document.getElementById("cameraVideo"), true);
  });

  async function captureAndAnalyzeKeyframe(videoEl, forceCapture) {
    if (!isSweeping || !videoEl || videoEl.readyState < 2) return;
    if (isAnalyzingCloud && !forceCapture) return;
    if (skipNextShelfFlag) {
      skipNextShelfFlag = false;
      return;
    }

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

    const apiKey = apiKeyInput.value.trim();
    const modelChoice = document.getElementById("modelSelect").value;
    const [countryCode] = document.getElementById("localeSelect").value.split("|");

    const speechEl = document.getElementById("agentSpeechText");
    if (speechEl) {
      speechEl.textContent = `🔍 Analyzing ${filename} with Cloud Vision AI...`;
    }

    isAnalyzingCloud = true;
    try {
      const result = await window.CloudVisionAndPrice.analyzeKeyframe(base64, apiKey, modelChoice, countryCode);

      const rawBooks = result.books || [];
      const rawItems = result.items || [];

      // Feed Gemini bounding boxes back to EdgeSegmentation so they render on the live canvas
      if (window.EdgeSegmentation) {
        window.EdgeSegmentation.updateCloudBoxes(rawBooks, rawItems);
      }

      // Compute median spine pixel height in this frame for metric scale calibration
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

      if (foundNewArt) {
        speakAgent("I logged a framed picture on the wall. Is that an original work or a print?");
      } else if (result.capture_feedback) {
        speakAgent(result.capture_feedback);
      } else if (rawBooks.length > 0 || rawItems.length > 0) {
        speakAgent(`Logged ${rawBooks.length} books and ${rawItems.length} room items in ${filename}. Keep panning smoothly.`);
      } else {
        if (speechEl) {
          speechEl.textContent = `Scanned ${filename}. Point camera at bookshelves or room items and click "Snap Shelf Now".`;
        }
      }
    } catch (err) {
      console.error("Keyframe analysis error:", err);
      if (speechEl) {
        speechEl.textContent = `⚠️ Vision API Warning on ${filename}: ${err.message}. Check API key or switch Vision Engine dropdown.`;
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
    speakAgent("Sweep finished. Releasing camera memory and pricing your inventory against local catalogs.");

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

    speakAgent(
      `Claim packet ready. I logged ${finalPacket.totals.book_count} books across ${finalPacket.totals.shelf_run_m} meters of shelving, ` +
      `valued at ${currency} ${finalPacket.totals.books_replacement_cost}, plus ${finalPacket.items.length} room items.`
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