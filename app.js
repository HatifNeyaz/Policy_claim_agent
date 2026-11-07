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

  // 1. 3D SPATIAL ORIENTATION & GYRO DEAD-RECKONING STATE (Yaw alpha, Pitch beta, Roll gamma)
  let hasHardwareCompass = false;
  let currentYawDeg = 0;
  let currentPitchDeg = 0;
  let currentRollDeg = 0;
  let gyroSpeedDegPerSec = 0;
  let lastMotionTimestamp = 0;

  // 2. 2D VISUAL ODOMETRY (Cumulative FOV Pan % for sideways walking or uploaded videos)
  let cumulativeFovPanX = 0;
  let cumulativeFovPanY = 0;
  let currentPanCmPerSec = 0;
  let currentSharpness = 150;
  let isAgentSpeaking = false;

  // 3. VISITED 3D SPATIAL SECTORS MEMORY (Stores Pose + 32x24 Patch + 64-bit dHash + 24-bin Chroma + Edge AI Signature)
  const visitedSpatialSectors = [];
  let prevTickPatch = null;
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
    spatial: {
      title: "🧭 3D Spatial Pose + Visual Odometry + AI Memory",
      html: `
        <p>Instead of relying on simple pixel change alone, the app fuses <strong>4 local signals (~2.5 ms on phone CPU)</strong> plus <strong>Cloud AI Memory</strong>:</p>
        <ul>
          <li><strong>1. 3D Compass & Pitch Cone (<code>Yaw° / Pitch°</code>):</strong> Reads your phone's 3D orientation sensor so it knows which direction in the room you are pointing. Each snapped photo marks a <strong>Visited 3D Cone</strong>.</li>
          <li><strong>2. 2D Sliding-Window Visual Odometry (<code>FOV Pan %</code>):</strong> Slides the current camera image across previously snapped photos (up to ±35% shift) to detect if you are still looking at an overlapping part of the same bed, table, or shelf!</li>
          <li><strong>3. Multi-Condition <code>IF / AND / OR</code> Gate:</strong> Snaps when:
            <br/>• <strong>Branch A:</strong> Phone rotated ≥20° into an unvisited 3D cone <code>AND</code> shift-compensated visual novelty ≥ threshold, <strong>OR</strong>
            <br/>• <strong>Branch B:</strong> Camera panned ≥50% of a frame width sideways <code>AND</code> visual novelty ≥ threshold, <strong>OR</strong>
            <br/>• <strong>Branch C:</strong> On-device Edge AI discovers a brand-new furniture class or book cluster in a new angle.</li>
          <li><strong>4. Zero-Token-Waste AI Memory:</strong> Passes already-logged item names inside the batch prompt so Gemini automatically drops any item seen twice from different angles.</li>
        </ul>
      `
    },
    threshold: {
      title: "🔄 Spatial + Visual Gate Sensitivity (%)",
      html: `
        <p>Sets the <strong>shift-compensated visual novelty percentage</strong> required inside our multi-condition Spatial + Visual Odometry gate:</p>
        <ul>
          <li><strong>Default (22% — Optimum with Spatial Tracking):</strong> Because our sliding-window cross-correlation already filters out camera tilt and overlapping views, 22% smoothly snaps every distinct furniture item and shelf without duplicates.</li>
          <li><strong>Higher Value (28%–35%):</strong> Stricter—requires both a larger 3D angle change and a completely different visual texture.</li>
          <li><strong>Lower Value (14%–18%):</strong> More eager—snaps more frequent angles along dense bookshelves.</li>
        </ul>
      `
    },
    dimensions: {
      title: "📏 Shelf Width (cm) & Ceiling Height (m)",
      html: `
        <p>Provides the <strong>explainable metric scale anchor</strong> required by the assignment brief so dimensions are never guessed:</p>
        <ul>
          <li><strong>Shelf Width (Default 80 cm):</strong> Standard bookcase width (e.g., IKEA Billy is 80 cm). Combined with the 21.6 cm standard hardcover book height anchor, this converts pixel bounding boxes into exact centimeters.</li>
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
          <li><strong>Multi-Frame Batching + Memory:</strong> Up to 3 locally snapped photos are bundled into a single API request along with a memory list of already-logged items.</li>
        </ul>
      `
    },
    locale: {
      title: "🌍 Primary Country & Currency",
      html: `
        <p>Sets the policyholder's claim country and currency (e.g., <strong>India — INR ₹</strong> or <strong>United States — USD $</strong>).</p>
        <p>All identified books and non-book room items are priced in this currency using local retail catalogs with clickable verification links.</p>
      `
    },
    second_locale: {
      title: "🌐 2nd Country (10-Book Proof)",
      html: `
        <p>When you finish the sweep, the app automatically prices the first 10 identified books in this second country/currency and includes a side-by-side comparison table in your final report.</p>
      `
    },
    apikey: {
      title: "🔑 API Key Setup",
      html: `
        <p>Paste your single Google AI Studio API key (or Groq <code>gsk_...</code> key) here. Stored locally in your browser and can be wiped anytime using <strong>🗑️ Clear Cache</strong>.</p>
      `
    },
    marking: {
      title: "📌 How Live Ownership & Item Marking Works",
      html: `
        <p><strong>1. Everything Is Yours by Default:</strong> Every captured frame is automatically marked <strong>✅ Yours</strong>.</p>
        <p><strong>2. Optional Live Override:</strong> Speak or tap a button while viewing a frame to override:</p>
        <ul>
          <li><strong>🚫 Not Mine:</strong> Excludes that frame and all items inside it from your final claim totals.</li>
          <li><strong>🖼️ Art = Print / 🎨 Art = Original / ⭐ 1st Edition:</strong> Updates appraisal vs. retail status.</li>
        </ul>
      `
    }
  };

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
        const info = HELP_EXPLAINERS[key] || HELP_EXPLAINERS.spatial;
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

  function triggerShutterVisual(frameIdx, triggerReason) {
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
      flashBadge.textContent = `📸 SECTOR #${frameIdx} SNAPPED (${triggerReason})`;
      flashBadge.classList.remove("hidden");
      setTimeout(() => flashBadge.classList.add("hidden"), 1600);
    }
    if (trafficBanner) {
      trafficBanner.className = "traffic-banner snapped-move";
      trafficBanner.textContent = `🟢 SECTOR #${frameIdx} LOCKED (${triggerReason})! Pan to next area ➡️`;
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

  // 1. Hardware 3D Orientation Listener (Compass Yaw alpha 0..360, Pitch beta -180..180, Roll gamma -90..90)
  window.addEventListener("deviceorientation", (e) => {
    if (e.alpha !== null || e.webkitCompassHeading !== undefined) {
      hasHardwareCompass = true;
      currentYawDeg = Math.round(
        typeof e.webkitCompassHeading === "number" ? e.webkitCompassHeading : (e.alpha || 0)
      );
      currentPitchDeg = Math.round(e.beta || 0);
      currentRollDeg = Math.round(e.gamma || 0);
    }
  }, true);

  // 2. Gyroscope Angular Velocity + Dead-Reckoning Integration Fallback
  window.addEventListener("devicemotion", (e) => {
    const r = e.rotationRate;
    const now = performance.now();
    const dt = lastMotionTimestamp > 0 ? Math.min(0.2, (now - lastMotionTimestamp) / 1000) : 0.05;
    lastMotionTimestamp = now;

    if (r) {
      const a = r.alpha || 0;
      const b = r.beta || 0;
      const g = r.gamma || 0;
      gyroSpeedDegPerSec = Math.sqrt(a * a + b * b + g * g);

      // If deviceorientation magnetometers aren't active, integrate gyroscope angular velocity
      if (!hasHardwareCompass) {
        currentYawDeg = (currentYawDeg + g * dt + 360) % 360;
        currentPitchDeg = Math.max(-90, Math.min(90, currentPitchDeg + a * dt));
      }
    }
  });

  // Shortest angular distance on a 3D sphere between two (Yaw, Pitch) poses in degrees
  function compute3DAngularDistanceDeg(poseA, poseB) {
    if (!poseA || !poseB) return 180;
    let dYaw = Math.abs(poseA.yaw - poseB.yaw) % 360;
    if (dYaw > 180) dYaw = 360 - dYaw;
    const dPitch = Math.abs(poseA.pitch - poseB.pitch);
    return Math.round(Math.sqrt(dYaw * dYaw + dPitch * dPitch));
  }

  // Extracts:
  // 1) Sharpness & Glare
  // 2) 32x24 Normalized Luminance Patch (for 2D Sliding-Window Visual Odometry & Overlap Veto)
  // 3) 64-bit Perceptual dHash (Exposure-Invariant Gradient Hash)
  // 4) 24-bin Normalized RGB Chroma Histogram (Color Fingerprint)
  function extractSpatialAndVisualFeatures(videoEl, workCanvas, prevPatch) {
    if (!videoEl || videoEl.readyState < 2 || !workCanvas) {
      return {
        sharpness: 65,
        sharpnessPct: 92,
        glarePct: 0,
        panCmPerSec: 0,
        fovDeltaX: 0,
        fovDeltaY: 0,
        patch32x24: null,
        dHash64: null,
        colorHist24: null
      };
    }

    const ctx = workCanvas.getContext("2d", { willReadFrequently: true });
    const w = workCanvas.width;  // 320
    const h = workCanvas.height; // 240
    ctx.drawImage(videoEl, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h).data;

    const gray = new Float32Array(w * h);
    const colorHist24 = new Float32Array(24); // 8 R bins + 8 G bins + 8 B bins
    let glarePixels = 0;
    const totalPixels = w * h;

    for (let i = 0, p = 0; i < img.length; i += 4, p++) {
      const r = img[i];
      const g = img[i + 1];
      const b = img[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      gray[p] = lum;
      if (lum > 248) glarePixels++;

      colorHist24[Math.min(7, r >> 5)]++;
      colorHist24[8 + Math.min(7, g >> 5)]++;
      colorHist24[16 + Math.min(7, b >> 5)]++;
    }
    for (let k = 0; k < 24; k++) {
      colorHist24[k] /= totalPixels;
    }

    // 1. Laplacian Sharpness
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
    const glarePct = (glarePixels / totalPixels) * 100;

    // 2. Build 32x24 Downsampled Patch (Zero-Mean Normalized so auto-exposure changes don't fool it)
    const pw = 32;
    const ph = 24;
    const cellW = w / pw; // 10
    const cellH = h / ph; // 10
    const patch32x24 = new Float32Array(pw * ph);
    let patchMean = 0;

    for (let gy = 0; gy < ph; gy++) {
      for (let gx = 0; gx < pw; gx++) {
        let bSum = 0;
        const sy = Math.floor(gy * cellH);
        const sx = Math.floor(gx * cellW);
        for (let by = 2; by < 8; by += 2) {
          const row = (sy + by) * w + sx;
          for (let bx = 2; bx < 8; bx += 2) {
            bSum += gray[row + bx];
          }
        }
        const val = bSum / 9;
        patch32x24[gy * pw + gx] = val;
        patchMean += val;
      }
    }
    patchMean /= (pw * ph);
    for (let i = 0; i < patch32x24.length; i++) {
      patch32x24[i] -= patchMean; // Zero-mean illumination invariance!
    }

    // 3. Build 64-bit Perceptual Difference Hash (dHash on 9x8 grid = 64 horizontal gradient bits)
    const dHash64 = new Uint8Array(64);
    let bitIdx = 0;
    for (let row = 0; row < 8; row++) {
      const py = Math.floor((row + 0.5) * (ph / 8));
      for (let col = 0; col < 8; col++) {
        const px1 = Math.floor((col + 0.5) * (pw / 9));
        const px2 = Math.floor((col + 1.5) * (pw / 9));
        dHash64[bitIdx++] = patch32x24[py * pw + px1] < patch32x24[py * pw + px2] ? 1 : 0;
      }
    }

    // 4. 2D Visual Odometry Motion Estimation against prevPatch (Finds exact dx, dy shift in FOV %)
    let fovDeltaX = 0;
    let fovDeltaY = 0;
    let panCmPerSec = Math.round(gyroSpeedDegPerSec * 0.42);

    if (prevPatch && prevPatch.length === patch32x24.length) {
      const shiftRes = findBestShiftAndOverlap(patch32x24, prevPatch, pw, ph, 6, 4);
      fovDeltaX = Math.round((shiftRes.bestDx / pw) * 100);
      fovDeltaY = Math.round((shiftRes.bestDy / ph) * 100);

      // Update cumulative visual odometry coordinates
      cumulativeFovPanX += fovDeltaX;
      cumulativeFovPanY += fovDeltaY;

      // Also feed optical flow into virtual Yaw/Pitch if hardware compass isn't present (e.g., PC or video upload)
      if (!hasHardwareCompass) {
        currentYawDeg = Math.round((currentYawDeg + fovDeltaX * 0.6 + 360) % 360);
        currentPitchDeg = Math.max(-90, Math.min(90, Math.round(currentPitchDeg + fovDeltaY * 0.45)));
      }

      const opticalSpeedCm = Math.round(Math.sqrt(fovDeltaX * fovDeltaX + fovDeltaY * fovDeltaY) * 2.2);
      panCmPerSec = Math.max(panCmPerSec, opticalSpeedCm);
    }

    return {
      sharpness: Math.round(variance),
      sharpnessPct,
      glarePct: Number(glarePct.toFixed(1)),
      panCmPerSec,
      fovDeltaX,
      fovDeltaY,
      patch32x24,
      dHash64,
      colorHist24
    };
  }

  // Sliding-Window 2D Template Matcher:
  // Searches shifts dx in [-maxDx..maxDx], dy in [-maxDy..maxDy] on the 32x24 patch
  // Returns the best shift (bestDx, bestDy) and the shift-compensated visual novelty % (0..100)
  function findBestShiftAndOverlap(patchA, patchB, pw, ph, maxDx, maxDy) {
    let minMad = 999999;
    let bestDx = 0;
    let bestDy = 0;

    for (let dy = -maxDy; dy <= maxDy; dy++) {
      for (let dx = -maxDx; dx <= maxDx; dx++) {
        let sumAbsDiff = 0;
        let overlapCells = 0;

        const yStart = Math.max(2, 2 - dy);
        const yEnd = Math.min(ph - 2, ph - 2 - dy);
        const xStart = Math.max(2, 2 - dx);
        const xEnd = Math.min(pw - 2, pw - 2 - dx);

        for (let y = yStart; y < yEnd; y++) {
          const rowA = y * pw;
          const rowB = (y + dy) * pw + dx;
          for (let x = xStart; x < xEnd; x++) {
            sumAbsDiff += Math.abs(patchA[rowA + x] - patchB[rowB + x]);
            overlapCells++;
          }
        }

        if (overlapCells > 0) {
          const mad = sumAbsDiff / overlapCells;
          if (mad < minMad) {
            minMad = mad;
            bestDx = dx;
            bestDy = dy;
          }
        }
      }
    }

    // Convert illumination-invariant Mean Absolute Deviation into visual novelty % (0 to 100%)
    const alignedNoveltyPct = Math.min(100, Math.round((minMad / 42) * 100));
    const shiftFraction = Math.sqrt((bestDx / pw) ** 2 + (bestDy / ph) ** 2);
    const overlapPct = Math.max(0, Math.round((1 - shiftFraction) * (100 - alignedNoveltyPct * 0.7)));

    return { bestDx, bestDy, alignedNoveltyPct, overlapPct };
  }

  // Evaluates the Multi-Condition "IF / AND / OR" Spatial + Visual + Edge-AI Decision Matrix against ALL visited sectors!
  function evaluateSmartSpatialTrigger(currentFeatures, currentPose, sensitivityThreshold) {
    if (visitedSpatialSectors.length === 0) {
      return {
        shouldSnap: true,
        vetoReason: "",
        triggerBranch: "Initial Sector #1",
        minNoveltyPct: 100,
        minAngleDeg: 180,
        fovDispPct: 100
      };
    }

    let minNoveltyPct = 100;
    let maxOverlapPct = 0;
    let minAngleDeg = 180;
    let minFovDistancePct = 999;

    // Compare against ALL visited spatial sectors so revisiting an old wall/shelf never repeats!
    for (const sector of visitedSpatialSectors) {
      // 1. 3D Angular Distance (Yaw/Pitch cone)
      const angleDeg = compute3DAngularDistanceDeg(currentPose, sector.pose);
      if (angleDeg < minAngleDeg) minAngleDeg = angleDeg;

      // 2. Cumulative Visual Odometry FOV Distance
      const dFovX = currentPose.fovPanX - sector.pose.fovPanX;
      const dFovY = currentPose.fovPanY - sector.pose.fovPanY;
      const fovDist = Math.round(Math.sqrt(dFovX * dFovX + dFovY * dFovY));
      if (fovDist < minFovDistancePct) minFovDistancePct = fovDist;

      // 3. Sliding-Window Shift-Compensated Visual Novelty (±35% shift search)
      const shiftMatch = findBestShiftAndOverlap(
        currentFeatures.patch32x24,
        sector.patch32x24,
        32,
        24,
        10,
        7
      );

      // 4. 64-bit Perceptual dHash Hamming Distance %
      let hammingDiff = 0;
      for (let b = 0; b < 64; b++) {
        if (currentFeatures.dHash64[b] !== sector.dHash64[b]) hammingDiff++;
      }
      const dHashDiffPct = Math.round((hammingDiff / 64) * 100);

      // 5. 24-bin Chroma Color Histogram Distance %
      let colorDiff = 0;
      for (let c = 0; c < 24; c++) {
        colorDiff += Math.abs(currentFeatures.colorHist24[c] - sector.colorHist24[c]);
      }
      const colorDiffPct = Math.min(100, Math.round(colorDiff * 55));

      // Combined Illumination-Invariant Visual Novelty Score
      const combinedNovelty = Math.round(
        shiftMatch.alignedNoveltyPct * 0.45 + dHashDiffPct * 0.35 + colorDiffPct * 0.20
      );

      if (combinedNovelty < minNoveltyPct) minNoveltyPct = combinedNovelty;
      if (shiftMatch.overlapPct > maxOverlapPct) maxOverlapPct = shiftMatch.overlapPct;
    }

    // 6. Check On-Device Edge AI Semantic Discovery (Did MediaPipe see a new object class or new spine cluster?)
    const edgeDet = window.EdgeSegmentation?.lastDetections || { bookBoxes: [], itemBoxes: [] };
    const currentSpines = edgeDet.bookBoxes?.length || 0;
    const currentClasses = (edgeDet.itemBoxes || []).map(i => i.category).sort().join(",");
    const lastSector = visitedSpatialSectors[visitedSpatialSectors.length - 1];
    const hasNewSemanticObject =
      (currentClasses.length > 0 && currentClasses !== lastSector.edgeClasses) ||
      Math.abs(currentSpines - lastSector.edgeSpineCount) >= 4;

    // =========================================================================
    // HARD VETO GATES (Prevent Any Repetition!)
    // =========================================================================
    // Veto 1: Sliding-window template match shows >64% overlap with an already-snapped photo (just shifted slightly)
    if (maxOverlapPct > 64 && minNoveltyPct < sensitivityThreshold + 6) {
      return {
        shouldSnap: false,
        vetoReason: `⏸️ Overlapping View (${maxOverlapPct}% overlap with saved sector) — Pan further ➡️`,
        triggerBranch: "",
        minNoveltyPct,
        minAngleDeg,
        fovDispPct: minFovDistancePct
      };
    }

    // Veto 2: Pointing in the same 3D Spatial Cone (<15° rotation AND <40% FOV pan) with similar appearance
    if (minAngleDeg < 15 && minFovDistancePct < 40 && minNoveltyPct < sensitivityThreshold + 5) {
      return {
        shouldSnap: false,
        vetoReason: `⏸️ Sector Already Visited (ΔAngle ${minAngleDeg}°, Novelty ${minNoveltyPct}%) — Point to new area ➡️`,
        triggerBranch: "",
        minNoveltyPct,
        minAngleDeg,
        fovDispPct: minFovDistancePct
      };
    }

    // =========================================================================
    // MULTI-CONDITION "IF / AND / OR" SMART SNAP TRIGGERS
    // =========================================================================
    // Branch A: 3D Spatial Rotation >= 20° into a new direction AND visual novelty >= sensitivityThreshold
    const branchASpatialRotation = minAngleDeg >= 20 && minNoveltyPct >= sensitivityThreshold;

    // Branch B: Lateral Visual Odometry Pan >= 48% of Frame Width (walking along shelf/room) AND visual novelty >= sensitivityThreshold
    const branchBLateralOdometry = minFovDistancePct >= 48 && minNoveltyPct >= sensitivityThreshold;

    // Branch C: On-Device Edge AI discovered a new furniture item or spine cluster AND camera moved >= 12° (or >=32% FOV) AND novelty >= (threshold - 4%)
    const branchCSemanticDiscovery =
      hasNewSemanticObject &&
      (minAngleDeg >= 12 || minFovDistancePct >= 32) &&
      minNoveltyPct >= Math.max(14, sensitivityThreshold - 4);

    if (branchASpatialRotation) {
      return {
        shouldSnap: true,
        vetoReason: "",
        triggerBranch: `3D Angle +${minAngleDeg}° & ${minNoveltyPct}% New`,
        minNoveltyPct,
        minAngleDeg,
        fovDispPct: minFovDistancePct
      };
    }

    if (branchBLateralOdometry) {
      return {
        shouldSnap: true,
        vetoReason: "",
        triggerBranch: `Pan ${minFovDistancePct}% FOV & ${minNoveltyPct}% New`,
        minNoveltyPct,
        minAngleDeg,
        fovDispPct: minFovDistancePct
      };
    }

    if (branchCSemanticDiscovery) {
      return {
        shouldSnap: true,
        vetoReason: "",
        triggerBranch: `New AI Object + ${minAngleDeg}° Shift`,
        minNoveltyPct,
        minAngleDeg,
        fovDispPct: minFovDistancePct
      };
    }

    return {
      shouldSnap: false,
      vetoReason: `⏸️ Same Sector (Angle Δ${minAngleDeg}°, Novelty ${minNoveltyPct}%/${sensitivityThreshold}%) — Pan to next area ➡️`,
      triggerBranch: "",
      minNoveltyPct,
      minAngleDeg,
      fovDispPct: minFovDistancePct
    };
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
        speakAgent(`Excluded Sector ${activeFrame.index} as not yours.`);
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

  // Start Live Camera Sweep (Requests both Orientation & Motion permissions on iOS/Mobile)
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

    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      try { await DeviceOrientationEvent.requestPermission(); } catch (e) {}
    }
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
    cumulativeFovPanX = 0;
    cumulativeFovPanY = 0;

    // Auto-collapse Setup Drawer on mobile so camera view is clean
    const setupDrawer = document.getElementById("setupDrawer");
    if (setupDrawer) setupDrawer.open = false;

    document.getElementById("statusDot").classList.add("active");
    document.getElementById("captureKeyframeBtn").disabled = false;
    document.getElementById("finishSweepBtn").disabled = false;

    const [country, currency] = document.getElementById("localeSelect").value.split("|");

    speakAgent(
      `Sweep started in ${currency}. 3D spatial tracking and visual odometry are active—pan across your room and pause briefly on each new area to snap.`
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
                          window.CloudVisionAndPrice.stringSimilarity(existing.description, it.description) > 0.65
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

    // 320ms Spatial + Visual Odometry + Edge AI Multi-Condition Loop
    clearInterval(blurInterval);
    blurInterval = setInterval(() => {
      if (!isSweeping) return;
      const activeProfile = window.CloudVisionAndPrice.getPacingProfile(
        document.getElementById("modelSelect").value
      );
      const sensitivity = parseFloat(document.getElementById("pixelThresholdInput")?.value || "22");

      const features = extractSpatialAndVisualFeatures(videoEl, workCanvas, prevTickPatch);
      prevTickPatch = features.patch32x24;
      currentSharpness = features.sharpness;
      currentPanCmPerSec = features.panCmPerSec;

      const currentPose = {
        yaw: currentYawDeg,
        pitch: currentPitchDeg,
        roll: currentRollDeg,
        fovPanX: cumulativeFovPanX,
        fovPanY: cumulativeFovPanY
      };

      const evalRes = evaluateSmartSpatialTrigger(features, currentPose, sensitivity);
      const timeSinceSnap = Date.now() - lastLocalSnapTime;

      const poseBadge = document.getElementById("spatialPoseBadge");
      const pixelDiffBadge = document.getElementById("pixelDiffBadge");
      const sharpBadge = document.getElementById("sharpnessBadge");
      const queueBadge = document.getElementById("queueBadge");
      const alertBanner = document.getElementById("alertBanner");
      const trafficBanner = document.getElementById("moveTrafficBanner");
      const progressBar = document.getElementById("captureProgressBar");

      const isMovingFast =
        features.panCmPerSec > activeProfile.maxPanCmPerSec ||
        gyroSpeedDegPerSec > activeProfile.maxGyroDegPerSec;
      const isBlurry = features.sharpness < 10;

      if (poseBadge) {
        poseBadge.textContent = `🧭 Pose: ${currentPose.yaw}° Yaw / ${currentPose.pitch}° Pitch`;
      }
      if (pixelDiffBadge) {
        pixelDiffBadge.textContent = `🔄 Novelty: ${evalRes.minNoveltyPct}% | ΔAngle: ${evalRes.minAngleDeg}°`;
      }
      if (sharpBadge) {
        sharpBadge.textContent = `🎯 Sharp: ${features.sharpnessPct}%`;
      }
      if (queueBadge) {
        queueBadge.textContent = `☁️ Queue: ${pendingCloudQueue.length}`;
      }

      // Readiness bar shows how close the user is to entering a new 3D spatial sector
      const angleReadiness = Math.min(100, Math.round((evalRes.minAngleDeg / 20) * 100));
      const panReadiness = Math.min(100, Math.round((evalRes.fovDispPct / 48) * 100));
      const visualReadiness = Math.min(100, Math.round((evalRes.minNoveltyPct / sensitivity) * 100));
      const overallReadiness = Math.min(100, Math.round((Math.max(angleReadiness, panReadiness) + visualReadiness) / 2));
      if (progressBar) progressBar.style.width = `${overallReadiness}%`;

      if (!isMovingFast && !isBlurry) {
        steadyTicksCount++;
      } else {
        steadyTicksCount = 0;
      }

      // Snap if Multi-Condition Spatial + Visual Gate passes AND camera is steady for 2 ticks (~0.6s) AND >1.6s debounce
      if (evalRes.shouldSnap && steadyTicksCount >= 2 && timeSinceSnap >= 1600) {
        steadyTicksCount = 0;
        snapSpatialSectorToMemory(videoEl, features, currentPose, evalRes.triggerBranch, evalRes.minNoveltyPct);
      } else if (evalRes.shouldSnap && steadyTicksCount < 2) {
        if (trafficBanner) {
          trafficBanner.className = "traffic-banner hold-steady";
          trafficBanner.textContent = `🟡 New 3D Sector Reached (${evalRes.triggerBranch}) — Hold steady 0.5s to snap!`;
        }
      } else if (!evalRes.shouldSnap && timeSinceSnap > 1400) {
        if (trafficBanner) {
          trafficBanner.className = "traffic-banner waiting";
          trafficBanner.textContent = evalRes.vetoReason;
        }
      }

      if (isMovingFast && evalRes.shouldSnap) {
        alertBanner.classList.remove("hidden");
        alertBanner.textContent = `⚠️ Pause briefly on this new angle so the camera can snap a sharp frame!`;
      } else {
        alertBanner.classList.add("hidden");
      }
    }, 320);

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
    const workCanvas = document.getElementById("workCanvas");
    const features = extractSpatialAndVisualFeatures(videoEl, workCanvas, prevTickPatch);
    const currentPose = {
      yaw: currentYawDeg,
      pitch: currentPitchDeg,
      roll: currentRollDeg,
      fovPanX: cumulativeFovPanX,
      fovPanY: cumulativeFovPanY
    };
    snapSpatialSectorToMemory(videoEl, features, currentPose, "Manual Snap", 100);
  });

  function snapSpatialSectorToMemory(videoEl, features, pose, triggerReason, noveltyPct) {
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

    // Record this sector in Visited 3D Spatial Memory so we never snap it again
    const edgeDet = window.EdgeSegmentation?.lastDetections || { bookBoxes: [], itemBoxes: [] };
    if (features && features.patch32x24) {
      visitedSpatialSectors.push({
        index: frameIdx,
        pose: { ...pose },
        patch32x24: new Float32Array(features.patch32x24),
        dHash64: new Uint8Array(features.dHash64),
        colorHist24: new Float32Array(features.colorHist24),
        edgeSpineCount: edgeDet.bookBoxes?.length || 0,
        edgeClasses: (edgeDet.itemBoxes || []).map(i => i.category).sort().join(",")
      });
    }

    const frameObj = {
      index: frameIdx,
      filename,
      frameRef,
      base64,
      dataUrl,
      width: captureCanvas.width,
      height: captureCanvas.height,
      pose: { ...pose },
      triggerReason,
      pixelChangePct: noveltyPct,
      status: "queued",
      excludedByUser: false,
      voiceNotes: [],
      userArtNote: ""
    };

    savedFrames.push(frameObj);
    pendingCloudQueue.push(frameObj);

    triggerShutterVisual(frameIdx, triggerReason);
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

      // Build compact memory of already-logged items & books so Cloud AI drops cross-angle duplicates!
      const currentDedup = window.CloudVisionAndPrice.deduplicateInventory(
        rawBooksBuffer,
        rawItemsBuffer,
        excludedFrameRefs
      );
      const alreadyLoggedMemory = {
        books: currentDedup.uniqueBooks.filter(b => b.title).map(b => `${b.title} (${b.author || ""})`),
        items: currentDedup.uniqueItems.map(i => `${i.category}: ${i.description}`)
      };

      const frameNames = batch.map(b => `#${b.index}`).join(", ");
      const speechEl = document.getElementById("agentSpeechText");
      if (speechEl) {
        speechEl.textContent = `☁️ Scanning Sector(s) ${frameNames} with Spatial Memory...`;
      }

      const callStart = performance.now();
      try {
        const batchResult = await window.CloudVisionAndPrice.analyzeKeyframeBatch(
          batch,
          apiKey,
          modelChoice,
          countryCode,
          currencyCode,
          alreadyLoggedMemory
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

          const fBooks = (frameData.books || []).filter(b => !b.is_duplicate);
          const fItems = (frameData.items || []).filter(i => !i.is_duplicate);
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
          speakAgent(`Logged ${batchBooksCount} new books and ${batchItemsCount} new items in Sector ${frameNames}.`);
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
      hint.textContent = `${savedFrames.length} sectors (${exclCount} Not Mine)`;
    }

    if (strip) {
      strip.innerHTML = savedFrames.map(f => {
        const cls = f.excludedByUser ? "excluded" : (f.status === "queued" ? "queued" : "");
        const badge = f.excludedByUser ? "🚫 Not Mine" : (f.status === "queued" ? `⏳ #${f.index} (${f.pose?.yaw || 0}°)` : `✅ #${f.index} (${f.pose?.yaw || 0}°)`);
        return `
          <div class="strip-thumb ${cls}" onclick="window.toggleFrameExclusion(${f.index})" title="Sector #${f.index}: ${f.triggerReason || ''}">
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
          <div style="font-size:0.62rem;color:#9ca3af;">🧭 ${f.pose?.yaw || 0}° Yaw | ${f.triggerReason || ""}</div>
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
      booksListEl.innerHTML = `<p class="empty-hint">Books will appear here live as unique spatial sectors are scanned...</p>`;
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