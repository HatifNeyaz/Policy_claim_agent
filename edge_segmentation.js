import { ObjectDetector, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

// Maps COCO 80-class labels from MediaPipe EfficientDet into insurance non-book categories
const COCO_TO_CLAIM_CATEGORY = {
  chair: { category: "furniture", desc: "Upholstered / Room Chair", dims: { w: 60, h: 85, d: 60 } },
  couch: { category: "furniture", desc: "Sofa / Couch", dims: { w: 180, h: 85, d: 90 } },
  bed: { category: "furniture", desc: "Bed Frame & Mattress", dims: { w: 160, h: 100, d: 200 } },
  "dining table": { category: "furniture", desc: "Wooden Desk / Table", dims: { w: 120, h: 75, d: 70 } },
  bench: { category: "furniture", desc: "Indoor Bench / Ottoman", dims: { w: 110, h: 48, d: 45 } },
  tv: { category: "electronics", desc: "Flat-Panel Display / Monitor", dims: { w: 95, h: 58, d: 8 } },
  laptop: { category: "electronics", desc: "Portable Laptop Computer", dims: { w: 35, h: 24, d: 2 } },
  keyboard: { category: "electronics", desc: "Computer Keyboard", dims: { w: 44, h: 14, d: 4 } },
  mouse: { category: "electronics", desc: "Computer Mouse", dims: { w: 12, h: 7, d: 4 } },
  "cell phone": { category: "electronics", desc: "Smartphone Device", dims: { w: 15, h: 8, d: 1 } },
  remote: { category: "electronics", desc: "Media Remote Control", dims: { w: 18, h: 5, d: 2 } },
  microwave: { category: "electronics", desc: "Countertop Appliance", dims: { w: 50, h: 30, d: 38 } },
  refrigerator: { category: "electronics", desc: "Mini Fridge / Cooler", dims: { w: 55, h: 85, d: 58 } },
  clock: { category: "decor", desc: "Wall / Desk Clock", dims: { w: 30, h: 30, d: 5 } },
  vase: { category: "decor", desc: "Decorative Ceramic Vase", dims: { w: 18, h: 32, d: 18 } },
  "potted plant": { category: "decor", desc: "Indoor Potted Plant & Planter", dims: { w: 35, h: 55, d: 35 } },
  bottle: { category: "decor", desc: "Glass / Insulated Bottle", dims: { w: 9, h: 26, d: 9 } },
  cup: { category: "decor", desc: "Ceramic Mug / Cup", dims: { w: 10, h: 12, d: 10 } },
  backpack: { category: "decor", desc: "Backpack / Carry Bag", dims: { w: 34, h: 46, d: 20 } },
  handbag: { category: "decor", desc: "Leather Handbag / Tote", dims: { w: 36, h: 28, d: 15 } },
  suitcase: { category: "decor", desc: "Hard-Shell Suitcase", dims: { w: 45, h: 68, d: 26 } },
  umbrella: { category: "decor", desc: "Room Umbrella", dims: { w: 12, h: 85, d: 12 } },
  "teddy bear": { category: "decor", desc: "Plush Decor Item", dims: { w: 25, h: 35, d: 20 } }
};

window.EdgeSegmentation = {
  detector: null,
  isReady: false,
  lastDetections: { bookBoxes: [], itemBoxes: [], scaleCmPerPx: 0.045 },
  cloudOverlayBoxes: { books: [], items: [] },
  currentScaleCmPerPx: 0.045,
  tickCount: 0,

  async init() {
    const badge = document.getElementById("modelBadge");
    if (!badge) return;
    try {
      badge.textContent = "🧠 Loading 4.4MB Edge AI...";
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
      );
      try {
        this.detector = await ObjectDetector.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite",
            delegate: "GPU"
          },
          scoreThreshold: 0.18,
          runningMode: "IMAGE"
        });
        this.isReady = true;
        badge.textContent = "🧠 Edge AI: Active (WebGL2)";
      } catch (gpuErr) {
        console.warn("Edge GPU delegate unavailable, falling back to CPU WASM:", gpuErr);
        this.detector = await ObjectDetector.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite",
            delegate: "CPU"
          },
          scoreThreshold: 0.18,
          runningMode: "IMAGE"
        });
        this.isReady = true;
        badge.textContent = "🧠 Edge AI: Active (WASM)";
      }
    } catch (err) {
      console.warn("Edge AI initialization error, using Sobel Spine CV fallback:", err);
      badge.textContent = "🧠 Edge CV: Sobel Active";
    }
  },

  // Stores latest Gemini cloud bounding boxes so they render on the live segmentation canvas too
  updateCloudBoxes(books, items) {
    this.cloudOverlayBoxes = {
      books: Array.isArray(books) ? books.slice(-18) : [],
      items: Array.isArray(items) ? items.slice(-10) : []
    };
  },

  // Runs every 500ms to segment objects & slice book spines
  processFrame(videoEl, overlayCanvas, workCanvas, onEdgeObjectsFound) {
    if (!videoEl || videoEl.readyState < 2 || !overlayCanvas || !workCanvas) return;
    this.tickCount++;

    const ctx = overlayCanvas.getContext("2d");
    const fullW = videoEl.videoWidth || 1280;
    const fullH = videoEl.videoHeight || 720;
    overlayCanvas.width = fullW;
    overlayCanvas.height = fullH;
    ctx.clearRect(0, 0, fullW, fullH);

    // Draw current video frame onto 320x240 workCanvas for fast stateless Edge AI & Sobel CV
    const wCtx = workCanvas.getContext("2d", { willReadFrequently: true });
    const wW = workCanvas.width;
    const wH = workCanvas.height;
    wCtx.drawImage(videoEl, 0, 0, wW, wH);

    const scaleX = fullW / wW;
    const scaleY = fullH / wH;

    let detections = [];
    if (this.isReady && this.detector) {
      try {
        const res = this.detector.detect(workCanvas);
        detections = res.detections || [];
      } catch (e) {
        detections = [];
      }
    }

    // Calibrate pixel-to-cm scale using standard trade book height (21.6 cm) or user shelf width
    const shelfRefCm = parseFloat(document.getElementById("shelfRefCm")?.value || "80");
    this.currentScaleCmPerPx = shelfRefCm / (fullW * 0.75);

    const bookBoxes = [];
    const itemBoxes = [];

    for (const det of detections) {
      const cat = det.categories?.[0]?.categoryName?.toLowerCase() || "item";
      const score = det.categories?.[0]?.score || 0;
      const rawBb = det.boundingBox;
      if (!rawBb) continue;

      // Scale bounding box from workCanvas (320x240) to overlayCanvas (1280x720)
      const bb = {
        originX: rawBb.originX * scaleX,
        originY: rawBb.originY * scaleY,
        width: rawBb.width * scaleX,
        height: rawBb.height * scaleY
      };

      if (cat === "book") {
        const sliced = this.sliceWideBookCluster(bb, workCanvas, fullW, fullH);
        bookBoxes.push(...sliced);
      } else if (COCO_TO_CLAIM_CATEGORY[cat] || score >= 0.24) {
        itemBoxes.push({ category: cat, score, bb });
      }
    }

    // Autonomous 2D Sobel Vertical Spine Segmenter:
    // If MediaPipe misses tightly packed vertical spines on a shelf, scan horizontal bands for vertical spine edges
    if (bookBoxes.length < 3) {
      const sobelSpines = this.detectAutonomousSobelSpines(wCtx, wW, wH, scaleX, scaleY);
      bookBoxes.push(...sobelSpines);
    }

    // Anchor scale to median detected book spine height = 21.6 cm if books are visible
    if (bookBoxes.length >= 2) {
      const heights = bookBoxes.map(b => Math.max(b.height, b.width)).sort((a, b) => a - b);
      const medianPx = heights[Math.floor(heights.length / 2)];
      if (medianPx > 35) {
        this.currentScaleCmPerPx = 21.6 / medianPx;
      }
    }

    // 1. Draw glowing emerald segmentation masks on on-device segmented book spines
    for (const b of bookBoxes) {
      const hCm = (Math.max(b.height, b.width) * this.currentScaleCmPerPx).toFixed(1);
      const tCm = (Math.min(b.height, b.width) * this.currentScaleCmPerPx).toFixed(1);

      ctx.fillStyle = "rgba(16, 185, 129, 0.26)";
      ctx.strokeStyle = "#10b981";
      ctx.lineWidth = 2;
      ctx.fillRect(b.originX, b.originY, b.width, b.height);
      ctx.strokeRect(b.originX, b.originY, b.width, b.height);

      ctx.fillStyle = "#ecfdf5";
      ctx.font = "bold 11px sans-serif";
      ctx.fillText(`${hCm}x${tCm}cm`, b.originX + 3, Math.max(18, b.originY + 14));
    }

    // 2. Draw cyan segmentation masks on on-device detected non-book contents
    const discoveredEdgeItems = [];
    for (const item of itemBoxes) {
      const { originX, originY, width, height } = item.bb;
      const wCm = Math.max(10, Math.round(width * this.currentScaleCmPerPx));
      const hCm = Math.max(10, Math.round(height * this.currentScaleCmPerPx));

      ctx.fillStyle = "rgba(6, 182, 212, 0.24)";
      ctx.strokeStyle = "#06b6d4";
      ctx.lineWidth = 2.5;
      ctx.fillRect(originX, originY, width, height);
      ctx.strokeRect(originX, originY, width, height);

      const label = `${item.category.toUpperCase()} (${wCm}x${hCm}cm)`;
      ctx.fillStyle = "rgba(11, 15, 25, 0.78)";
      ctx.fillRect(originX, Math.max(0, originY - 20), ctx.measureText(label).width + 12, 20);
      ctx.fillStyle = "#67e8f9";
      ctx.font = "bold 12px sans-serif";
      ctx.fillText(label, originX + 5, Math.max(14, originY - 5));

      const mapped = COCO_TO_CLAIM_CATEGORY[item.category];
      if (mapped && item.score >= 0.28) {
        discoveredEdgeItems.push({
          category: mapped.category,
          description: `${mapped.desc} (Edge AI detected)`,
          brand_model: "",
          dimensions_cm: { w: wCm || mapped.dims.w, h: hCm || mapped.dims.h, d: mapped.dims.d },
          is_art_or_portrait: false,
          confidence: Number(item.score.toFixed(2))
        });
      }
    }

    // Pass high-confidence on-device non-book detections to app.js so room items populate even before cloud OCR finishes
    if (typeof onEdgeObjectsFound === "function" && discoveredEdgeItems.length > 0) {
      onEdgeObjectsFound(discoveredEdgeItems);
    }

    // 3. Draw Cloud OCR confirmed bounding boxes (if any exist from latest keyframe)
    for (const cb of (this.cloudOverlayBoxes.books || [])) {
      if (!Array.isArray(cb.bbox_2d) || cb.bbox_2d.length < 4) continue;
      const [ymin, xmin, ymax, xmax] = cb.bbox_2d;
      const x = (xmin / 1000) * fullW;
      const y = (ymin / 1000) * fullH;
      const w = ((xmax - xmin) / 1000) * fullW;
      const h = ((ymax - ymin) / 1000) * fullH;
      ctx.strokeStyle = "#34d399";
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
      if (cb.title) {
        ctx.fillStyle = "rgba(4, 47, 46, 0.85)";
        const shortTitle = cb.title.slice(0, 16);
        ctx.fillRect(x, Math.max(0, y - 16), shortTitle.length * 6.5 + 8, 16);
        ctx.fillStyle = "#a7f3d0";
        ctx.font = "bold 10px sans-serif";
        ctx.fillText(shortTitle, x + 3, Math.max(11, y - 4));
      }
    }

    // 4. Draw Live On-Canvas Segmentation Status HUD at Top-Left so user sees active segmentation proof
    const totalSpinesShown = bookBoxes.length + (this.cloudOverlayBoxes.books?.length || 0);
    const totalItemsShown = itemBoxes.length + (this.cloudOverlayBoxes.items?.length || 0);
    const hudText = `🟢 SEGMENTATION ACTIVE | Spines: ${totalSpinesShown} | Non-Book Objects: ${totalItemsShown} | Scale: ${this.currentScaleCmPerPx.toFixed(3)} cm/px`;
    ctx.fillStyle = "rgba(11, 15, 25, 0.82)";
    ctx.fillRect(10, 10, Math.min(fullW - 20, 620), 28);
    ctx.strokeStyle = "#10b981";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(10, 10, Math.min(fullW - 20, 620), 28);
    ctx.fillStyle = "#10b981";
    ctx.font = "bold 13px monospace";
    ctx.fillText(hudText, 18, 29);

    this.lastDetections = { bookBoxes, itemBoxes, scaleCmPerPx: this.currentScaleCmPerPx };
  },

  // Scans the central horizontal band of workCanvas for vertical spine edge periodicity
  detectAutonomousSobelSpines(wCtx, wW, wH, scaleX, scaleY) {
    try {
      const bandY = Math.floor(wH * 0.22);
      const bandH = Math.floor(wH * 0.52);
      const bandX = Math.floor(wW * 0.08);
      const bandW = Math.floor(wW * 0.84);
      const imgData = wCtx.getImageData(bandX, bandY, bandW, bandH).data;

      const vProfile = new Float32Array(bandW);
      let meanV = 0;
      let meanH = 0;

      for (let x = 1; x < bandW - 1; x++) {
        let colV = 0;
        let colH = 0;
        for (let y = 1; y < bandH - 1; y += 2) {
          const idxL = (y * bandW + (x - 1)) * 4;
          const idxR = (y * bandW + (x + 1)) * 4;
          const idxU = ((y - 1) * bandW + x) * 4;
          const idxD = ((y + 1) * bandW + x) * 4;

          const lumL = 0.299 * imgData[idxL] + 0.587 * imgData[idxL + 1] + 0.114 * imgData[idxL + 2];
          const lumR = 0.299 * imgData[idxR] + 0.587 * imgData[idxR + 1] + 0.114 * imgData[idxR + 2];
          const lumU = 0.299 * imgData[idxU] + 0.587 * imgData[idxU + 1] + 0.114 * imgData[idxU + 2];
          const lumD = 0.299 * imgData[idxD] + 0.587 * imgData[idxD + 1] + 0.114 * imgData[idxD + 2];

          colV += Math.abs(lumR - lumL);
          colH += Math.abs(lumD - lumU);
        }
        const samples = Math.floor(bandH / 2);
        vProfile[x] = colV / samples;
        meanV += vProfile[x];
        meanH += colH / samples;
      }
      meanV /= bandW;
      meanH /= bandW;

      // Require strong vertical edge dominance typical of vertical book spines
      if (meanV < 11 || meanV < meanH * 0.95) return [];

      const minStep = 8;
      const maxStep = 34;
      const peaks = [];
      for (let x = minStep; x < bandW - minStep; x++) {
        if (
          vProfile[x] > meanV * 1.35 &&
          vProfile[x] >= vProfile[x - 1] &&
          vProfile[x] >= vProfile[x + 1]
        ) {
          if (peaks.length === 0 || x - peaks[peaks.length - 1] >= minStep) {
            peaks.push(x);
          }
        }
      }

      const spines = [];
      for (let i = 0; i < peaks.length - 1; i++) {
        const span = peaks[i + 1] - peaks[i];
        if (span >= minStep && span <= maxStep) {
          spines.push({
            originX: (bandX + peaks[i]) * scaleX,
            originY: (bandY + bandH * 0.1) * scaleY,
            width: span * 0.92 * scaleX,
            height: bandH * 0.8 * scaleY
          });
        }
      }
      return spines.length >= 3 ? spines.slice(0, 14) : [];
    } catch (e) {
      return [];
    }
  },

  // Splits a wide bounding box covering multiple books into individual spine segments
  sliceWideBookCluster(bb, workCanvas, fullW, fullH) {
    const aspect = bb.width / Math.max(1, bb.height);
    if (aspect < 0.45) {
      return [bb];
    }

    if (workCanvas && fullW > 0 && fullH > 0) {
      try {
        const wCtx = workCanvas.getContext("2d", { willReadFrequently: true });
        const scaleX = workCanvas.width / fullW;
        const scaleY = workCanvas.height / fullH;
        const rx = Math.max(1, Math.floor(bb.originX * scaleX));
        const ry = Math.max(0, Math.floor(bb.originY * scaleY));
        const rw = Math.min(workCanvas.width - rx - 1, Math.floor(bb.width * scaleX));
        const rh = Math.min(workCanvas.height - ry, Math.floor(bb.height * scaleY));

        if (rw > 16 && rh > 12) {
          const imgData = wCtx.getImageData(rx - 1, ry, rw + 2, rh).data;
          const stride = rw + 2;
          const profile = new Float32Array(rw);
          let meanGrad = 0;

          for (let x = 0; x < rw; x++) {
            let colSum = 0;
            for (let y = 0; y < rh; y++) {
              const leftIdx = (y * stride + x) * 4;
              const rightIdx = (y * stride + (x + 2)) * 4;
              const lumL = 0.299 * imgData[leftIdx] + 0.587 * imgData[leftIdx + 1] + 0.114 * imgData[leftIdx + 2];
              const lumR = 0.299 * imgData[rightIdx] + 0.587 * imgData[rightIdx + 1] + 0.114 * imgData[rightIdx + 2];
              colSum += Math.abs(lumR - lumL);
            }
            profile[x] = colSum / rh;
            meanGrad += profile[x];
          }
          meanGrad /= rw;

          const minStepPx = Math.max(4, Math.floor(rh * 0.12));
          const splitPoints = [0];
          for (let x = minStepPx; x < rw - minStepPx; x++) {
            if (
              profile[x] > meanGrad * 1.25 &&
              profile[x] >= profile[x - 1] &&
              profile[x] >= profile[x + 1] &&
              x - splitPoints[splitPoints.length - 1] >= minStepPx
            ) {
              splitPoints.push(x);
            }
          }
          splitPoints.push(rw);

          if (splitPoints.length >= 3 && splitPoints.length <= 16) {
            const slices = [];
            for (let i = 0; i < splitPoints.length - 1; i++) {
              const startX = bb.originX + (splitPoints[i] / rw) * bb.width;
              const segW = ((splitPoints[i + 1] - splitPoints[i]) / rw) * bb.width;
              slices.push({
                originX: startX,
                originY: bb.originY,
                width: segW * 0.95,
                height: bb.height
              });
            }
            return slices;
          }
        }
      } catch (e) {}
    }

    const estimatedSpines = Math.min(12, Math.max(1, Math.round(aspect / 0.22)));
    const sliceW = bb.width / estimatedSpines;
    const slices = [];
    for (let i = 0; i < estimatedSpines; i++) {
      slices.push({
        originX: bb.originX + i * sliceW,
        originY: bb.originY,
        width: sliceW * 0.94,
        height: bb.height
      });
    }
    return slices;
  },

  // Converts normalized [ymin, xmin, ymax, xmax] (0-1000) into metric cm using calibrated scale
  measureNormalizedBox(box2d, frameW = 1280, frameH = 720, medianBookHeightPx = 320) {
    const scale = 21.6 / Math.max(80, medianBookHeightPx);
    if (!Array.isArray(box2d) || box2d.length < 4) {
      return { height_cm: 21.5, thickness_cm: 2.8 };
    }
    const [ymin, xmin, ymax, xmax] = box2d;
    const pxH = ((ymax - ymin) / 1000) * frameH;
    const pxW = ((xmax - xmin) / 1000) * frameW;
    const major = Math.max(pxH, pxW);
    const minor = Math.min(pxH, pxW);
    return {
      height_cm: Number(Math.min(42, Math.max(11, major * scale)).toFixed(1)),
      thickness_cm: Number(Math.min(9.5, Math.max(0.8, minor * scale)).toFixed(1))
    };
  },

  release() {
    if (this.detector) {
      try {
        this.detector.close();
      } catch (e) {}
      this.detector = null;
      this.isReady = false;
    }
  }
};