import { ObjectDetector, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

window.EdgeSegmentation = {
  detector: null,
  isReady: false,
  lastDetections: [],
  currentScaleCmPerPx: 0.045, // Dynamically calibrated on every frame

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
          scoreThreshold: 0.32,
          runningMode: "VIDEO"
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
          scoreThreshold: 0.32,
          runningMode: "VIDEO"
        });
        this.isReady = true;
        badge.textContent = "🧠 Edge AI: Active (WASM)";
      }
    } catch (err) {
      console.warn("Edge AI initialization error:", err);
      badge.textContent = "🧠 Edge AI: Fallback Mode";
    }
  },

  // Runs every 500ms to segment objects & slice book spines without heating the phone
  processFrame(videoEl, overlayCanvas, workCanvas) {
    if (!videoEl || videoEl.readyState < 2 || !overlayCanvas) return;
    const ctx = overlayCanvas.getContext("2d");
    overlayCanvas.width = videoEl.videoWidth || 1280;
    overlayCanvas.height = videoEl.videoHeight || 720;
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    let detections = [];
    if (this.isReady && this.detector) {
      try {
        const res = this.detector.detectForVideo(videoEl, performance.now());
        detections = res.detections || [];
      } catch (e) {
        detections = [];
      }
    }

    // Calibrate pixel-to-cm scale using standard trade book height (21.6 cm) or user shelf width
    const shelfRefCm = parseFloat(document.getElementById("shelfRefCm")?.value || "80");
    this.currentScaleCmPerPx = shelfRefCm / (overlayCanvas.width * 0.75);

    const bookBoxes = [];
    const itemBoxes = [];

    for (const det of detections) {
      const cat = det.categories?.[0]?.categoryName?.toLowerCase() || "item";
      const score = det.categories?.[0]?.score || 0;
      const bb = det.boundingBox;
      if (!bb) continue;

      if (cat === "book") {
        // Slice wide book clusters into individual book spine masks using 1D vertical Sobel gradient peaks
        const sliced = this.sliceWideBookCluster(bb, workCanvas, overlayCanvas.width, overlayCanvas.height);
        bookBoxes.push(...sliced);
      } else {
        itemBoxes.push({ category: cat, score, bb });
      }
    }

    // Anchor scale to median detected book spine height = 21.6 cm if books are visible
    if (bookBoxes.length >= 2) {
      const heights = bookBoxes.map(b => Math.max(b.height, b.width)).sort((a, b) => a - b);
      const medianPx = heights[Math.floor(heights.length / 2)];
      if (medianPx > 25) {
        this.currentScaleCmPerPx = 21.6 / medianPx;
      }
    }

    // Draw glowing green segmentation masks on individual book spines
    for (const b of bookBoxes) {
      const hCm = (Math.max(b.height, b.width) * this.currentScaleCmPerPx).toFixed(1);
      const tCm = (Math.min(b.height, b.width) * this.currentScaleCmPerPx).toFixed(1);

      ctx.fillStyle = "rgba(16, 185, 129, 0.28)";
      ctx.strokeStyle = "#10b981";
      ctx.lineWidth = 2;
      ctx.fillRect(b.originX, b.originY, b.width, b.height);
      ctx.strokeRect(b.originX, b.originY, b.width, b.height);

      ctx.fillStyle = "#ecfdf5";
      ctx.font = "bold 11px sans-serif";
      ctx.fillText(`${hCm}x${tCm}cm`, b.originX + 3, Math.max(14, b.originY + 13));
    }

    // Draw cyan segmentation masks on non-book contents
    for (const item of itemBoxes) {
      const { originX, originY, width, height } = item.bb;
      const wCm = Math.round(width * this.currentScaleCmPerPx);
      const hCm = Math.round(height * this.currentScaleCmPerPx);

      ctx.fillStyle = "rgba(6, 182, 212, 0.22)";
      ctx.strokeStyle = "#06b6d4";
      ctx.lineWidth = 2;
      ctx.fillRect(originX, originY, width, height);
      ctx.strokeRect(originX, originY, width, height);

      ctx.fillStyle = "#cffafe";
      ctx.font = "bold 12px sans-serif";
      ctx.fillText(`${item.category} (${wCm}x${hCm}cm)`, originX + 4, Math.max(16, originY + 16));
    }

    this.lastDetections = { bookBoxes, itemBoxes, scaleCmPerPx: this.currentScaleCmPerPx };
  },

  // Splits a wide bounding box covering multiple books into individual spine segments using 1D vertical Sobel projection P(x)
  sliceWideBookCluster(bb, workCanvas, fullW, fullH) {
    const aspect = bb.width / Math.max(1, bb.height);
    if (aspect < 0.45) {
      return [bb]; // Already a single narrow vertical spine
    }

    // Attempt 1D Vertical Sobel Spine Partitioning on workCanvas if available
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

          // Locate vertical spine boundary peaks separated by at least minimum spine thickness
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
      } catch (e) {
        // Fallback to geometric aspect-ratio slicing below
      }
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