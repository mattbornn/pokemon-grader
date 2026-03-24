/* ================================================================
   PSA Card Grader – app.js
   Real-time Pokémon card PSA grading estimation using OpenCV.js
   ================================================================ */

// ─── State ──────────────────────────────────────────────────────
let cvReady = false;
let cameraStream = null;
let video, overlay, ctx;
let analysisRunning = false;
let lastGrade = null;
let frameCount = 0;
let fpsTime = performance.now();
let displayedFps = 0;
let panelCollapsed = false;
let capturedAnalysis = null;
let blinkPhase = 0; // for PSA 10 centering blink animation

// Smoothing buffers for stable readings
const SMOOTH_FRAMES = 8;
const gradeHistory = {
  centering: [], corners: [], edges: [], surface: [], overall: [],
  centerLR: [], centerTB: [],
  cornerTL: [], cornerTR: [], cornerBL: [], cornerBR: [],
  edgeT: [], edgeB: [], edgeL: [], edgeR: [],
  centerLPx: [], centerRPx: [], centerTPx: [], centerBPx: []
};

// ─── OpenCV Ready ───────────────────────────────────────────────
function onOpenCvReady() {
  if (typeof cv === 'undefined' || typeof cv.Mat === 'undefined') {
    setTimeout(onOpenCvReady, 100);
    return;
  }
  cvReady = true;
  document.getElementById('loading-status').textContent = 'Ready!';
  document.getElementById('progress-fill').style.width = '100%';
  setTimeout(() => {
    document.getElementById('loading-screen').classList.add('fade-out');
    setTimeout(() => {
      document.getElementById('loading-screen').classList.add('hidden');
      document.getElementById('instructions-overlay').classList.remove('hidden');
    }, 500);
  }, 400);
}

// Fake progress while opencv loads
(function fakeProgress() {
  let p = 0;
  const bar = document.getElementById('progress-fill');
  const iv = setInterval(() => {
    if (cvReady) { clearInterval(iv); return; }
    p = Math.min(p + Math.random() * 8, 90);
    bar.style.width = p + '%';
  }, 300);
})();

// ─── DOM Ready ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  video = document.getElementById('camera');
  overlay = document.getElementById('overlay');
  ctx = overlay.getContext('2d');

  document.getElementById('start-btn').addEventListener('click', startCamera);
  document.getElementById('capture-btn').addEventListener('click', captureDetail);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('save-btn').addEventListener('click', saveAnalysis);
  document.getElementById('panel-handle').addEventListener('click', togglePanel);
});

// ─── Camera ─────────────────────────────────────────────────────
async function startCamera() {
  document.getElementById('instructions-overlay').classList.add('hidden');
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    });
    video.srcObject = cameraStream;
    video.addEventListener('loadedmetadata', () => {
      overlay.width = video.videoWidth;
      overlay.height = video.videoHeight;
      document.getElementById('scan-line').classList.remove('hidden');
      startAnalysisLoop();
    });
  } catch (err) {
    alert('Camera access denied. Please allow camera access and reload.');
  }
}

// ─── Analysis Loop ──────────────────────────────────────────────
function startAnalysisLoop() {
  analysisRunning = true;
  let lastAnalysis = 0;
  const TARGET_INTERVAL = 1000 / 15; // 15 fps target

  function loop(timestamp) {
    if (!analysisRunning) return;

    frameCount++;
    if (timestamp - fpsTime >= 1000) {
      displayedFps = frameCount;
      frameCount = 0;
      fpsTime = timestamp;
      document.getElementById('fps-counter').textContent = displayedFps + ' fps';
    }

    if (timestamp - lastAnalysis >= TARGET_INTERVAL && video.readyState >= 2) {
      lastAnalysis = timestamp;
      analyseFrame();
    }

    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

// ─── Main Analysis ──────────────────────────────────────────────
function analyseFrame() {
  let src, gray, edges, contours, hierarchy;
  try {
    src = new cv.Mat(video.videoHeight, video.videoWidth, cv.CV_8UC4);
    const cap = new cv.VideoCapture(video);
    cap.read(src);

    gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);

    // Edge detection
    edges = new cv.Mat();
    cv.Canny(gray, edges, 50, 150);

    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.dilate(edges, edges, kernel);
    kernel.delete();

    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let cardContour = findCardContour(contours, src.cols, src.rows);

    // Adaptive thresholding fallback when Canny fails (e.g. poor lighting)
    if (!cardContour) {
      let adaptiveEdges = null, adaptiveContours = null, adaptiveHierarchy = null;
      try {
        adaptiveEdges = new cv.Mat();
        cv.adaptiveThreshold(gray, adaptiveEdges, 255,
          cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 11, 2);
        const kernel2 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
        cv.morphologyEx(adaptiveEdges, adaptiveEdges, cv.MORPH_CLOSE, kernel2);
        kernel2.delete();
        adaptiveContours = new cv.MatVector();
        adaptiveHierarchy = new cv.Mat();
        cv.findContours(adaptiveEdges, adaptiveContours, adaptiveHierarchy,
          cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        cardContour = findCardContour(adaptiveContours, src.cols, src.rows);
      } finally {
        if (adaptiveEdges) adaptiveEdges.delete();
        if (adaptiveContours) adaptiveContours.delete();
        if (adaptiveHierarchy) adaptiveHierarchy.delete();
      }
    }

    ctx.clearRect(0, 0, overlay.width, overlay.height);

    if (cardContour) {
      const grade = gradeCard(src, cardContour);
      if (!grade) {
        document.getElementById('detection-status').textContent = 'Card distorted - adjust angle';
        drawNoCardOverlay();
        cardContour.delete();
      } else {
        drawOverlay(cardContour, grade);
        updateUI(grade);
        lastGrade = grade;
        document.getElementById('capture-btn').disabled = false;
        document.getElementById('detection-status').textContent = 'Card detected';
        document.getElementById('scan-line').classList.add('hidden');
      }
    } else {
      document.getElementById('detection-status').textContent = 'No card detected';
      document.getElementById('capture-btn').disabled = true;
      document.getElementById('scan-line').classList.remove('hidden');
      drawNoCardOverlay();
    }
  } catch (e) {
    // Silently skip frame on error
  } finally {
    if (src) src.delete();
    if (gray) gray.delete();
    if (edges) edges.delete();
    if (contours) contours.delete();
    if (hierarchy) hierarchy.delete();
  }
}

// ─── Card Detection ─────────────────────────────────────────────
function findCardContour(contours, imgW, imgH) {
  const imgArea = imgW * imgH;
  let bestContour = null;
  let bestArea = 0;

  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const area = cv.contourArea(cnt);

    if (area < imgArea * 0.05 || area > imgArea * 0.95) {
      cnt.delete();
      continue;
    }

    const peri = cv.arcLength(cnt, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

    if (approx.rows === 4 && cv.isContourConvex(approx)) {
      const rect = cv.boundingRect(approx);
      const aspect = Math.max(rect.width, rect.height) / Math.min(rect.width, rect.height);

      if (aspect >= 1.2 && aspect <= 1.7 && area > bestArea) {
        if (bestContour) bestContour.delete();
        bestContour = approx;
        bestArea = area;
      } else {
        approx.delete();
      }
    } else {
      approx.delete();
    }
    cnt.delete();
  }

  return bestContour;
}

// ─── Order Points (TL, TR, BR, BL) ─────────────────────────────
function orderPoints(contour) {
  const pts = [];
  for (let i = 0; i < 4; i++) {
    pts.push({ x: contour.data32S[i * 2], y: contour.data32S[i * 2 + 1] });
  }

  const sums = pts.map(p => p.x + p.y);
  const diffs = pts.map(p => p.y - p.x);

  const tl = pts[sums.indexOf(Math.min(...sums))];
  const br = pts[sums.indexOf(Math.max(...sums))];
  const tr = pts[diffs.indexOf(Math.min(...diffs))];
  const bl = pts[diffs.indexOf(Math.max(...diffs))];

  return [tl, tr, br, bl];
}

// ─── Perspective Correction ─────────────────────────────────────
function getWarpedCard(src, contour) {
  const ordered = orderPoints(contour);
  const [tl, tr, br, bl] = ordered;

  const widthTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const widthBot = Math.hypot(br.x - bl.x, br.y - bl.y);
  const maxW = Math.round(Math.max(widthTop, widthBot));

  const heightLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const heightRight = Math.hypot(br.x - tr.x, br.y - tr.y);
  const maxH = Math.round(Math.max(heightLeft, heightRight));

  const w = 350;
  const h = Math.round(w * 1.4); // ~490

  const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y
  ]);
  const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0, w, 0, w, h, 0, h
  ]);

  // Quality check: reject distorted homographies
  const sideRatioW = Math.min(widthTop, widthBot) / Math.max(widthTop, widthBot);
  const sideRatioH = Math.min(heightLeft, heightRight) / Math.max(heightLeft, heightRight);
  if (sideRatioW < 0.6 || sideRatioH < 0.6) {
    srcPts.delete();
    dstPts.delete();
    return null;
  }

  if (maxW < 50 || maxH < 50) {
    srcPts.delete();
    dstPts.delete();
    return null;
  }

  const M = cv.getPerspectiveTransform(srcPts, dstPts);
  const warped = new cv.Mat();
  cv.warpPerspective(src, warped, M, new cv.Size(w, h));

  srcPts.delete();
  dstPts.delete();
  M.delete();

  return { warped, w, h, ordered };
}

// ─── Grade Card ─────────────────────────────────────────────────
function gradeCard(src, contour) {
  let warped = null, grayWarped = null;
  try {
    const result = getWarpedCard(src, contour);
    if (!result) return null;
    warped = result.warped;
    const { w, h, ordered } = result;

    grayWarped = new cv.Mat();
    cv.cvtColor(warped, grayWarped, cv.COLOR_RGBA2GRAY);

    const centering = analyseCentering(grayWarped, w, h);
    const corners = analyseCorners(grayWarped, w, h);
    const edgesGrade = analyseEdges(grayWarped, w, h);
    const surface = analyseSurface(grayWarped, w, h);

    const overall = centering.score * 0.35 + corners.score * 0.30 +
                    edgesGrade.score * 0.20 + surface.score * 0.15;

    return {
      centering, corners, edges: edgesGrade, surface,
      overall, ordered,
      psaGrade: toPSA(overall)
    };
  } finally {
    if (warped) warped.delete();
    if (grayWarped) grayWarped.delete();
  }
}

// ─── Centering Analysis ─────────────────────────────────────────
function analyseCentering(gray, w, h) {
  // Combined: intensity profile segmentation + edge detection fallback
  // Pokemon cards have a colored play area inset ~8-10% from card edges
  let edgeMat = null;
  try {
    // Method 1: Intensity profile segmentation
    const colorResult = findInnerBorderByIntensity(gray, w, h);

    // Method 2: Edge-based fallback
    edgeMat = new cv.Mat();
    cv.Canny(gray, edgeMat, 80, 200);
    const edgeResult = findInnerBorderByEdge(edgeMat, w, h);

    let leftMargin, rightMargin, topMargin, bottomMargin;
    if (colorResult.confidence > 0.5) {
      leftMargin = colorResult.left;
      rightMargin = colorResult.right;
      topMargin = colorResult.top;
      bottomMargin = colorResult.bottom;
    } else {
      leftMargin = edgeResult.left;
      rightMargin = edgeResult.right;
      topMargin = edgeResult.top;
      bottomMargin = edgeResult.bottom;
    }

    const totalLR = leftMargin + rightMargin;
    const totalTB = topMargin + bottomMargin;

    const lr = totalLR > 0
      ? [Math.round(leftMargin / totalLR * 100), Math.round(rightMargin / totalLR * 100)]
      : [50, 50];
    const tb = totalTB > 0
      ? [Math.round(topMargin / totalTB * 100), Math.round(bottomMargin / totalTB * 100)]
      : [50, 50];

    const lrDev = Math.abs(lr[0] - 50);
    const tbDev = Math.abs(tb[0] - 50);
    const maxDev = Math.max(lrDev, tbDev);

    let score;
    if (maxDev <= 5) score = 10;
    else if (maxDev <= 10) score = 9;
    else if (maxDev <= 15) score = 8;
    else if (maxDev <= 20) score = 7;
    else if (maxDev <= 25) score = 6;
    else score = Math.max(1, 5 - (maxDev - 25) / 10);

    return {
      score: clamp(score, 1, 10), lr, tb,
      leftPx: Math.round(leftMargin), rightPx: Math.round(rightMargin),
      topPx: Math.round(topMargin), bottomPx: Math.round(bottomMargin)
    };
  } finally {
    if (edgeMat) edgeMat.delete();
  }
}

// Detect inner border via intensity gradient profiles
function findInnerBorderByIntensity(gray, w, h) {
  const sampleLines = 20;

  // Horizontal profile (left/right margins) - average rows in middle 40%
  const hProfile = new Float32Array(w);
  const startRow = Math.floor(h * 0.3);
  const endRow = Math.floor(h * 0.7);
  const rowStep = Math.max(1, Math.floor((endRow - startRow) / sampleLines));
  let rowCount = 0;
  for (let r = startRow; r < endRow; r += rowStep) {
    for (let c = 0; c < w; c++) hProfile[c] += gray.ucharAt(r, c);
    rowCount++;
  }
  for (let c = 0; c < w; c++) hProfile[c] /= rowCount;

  // Vertical profile (top/bottom margins) - average cols in middle 40%
  const vProfile = new Float32Array(h);
  const startCol = Math.floor(w * 0.3);
  const endCol = Math.floor(w * 0.7);
  const colStep = Math.max(1, Math.floor((endCol - startCol) / sampleLines));
  let colCount = 0;
  for (let c = startCol; c < endCol; c += colStep) {
    for (let r = 0; r < h; r++) vProfile[r] += gray.ucharAt(r, c);
    colCount++;
  }
  for (let r = 0; r < h; r++) vProfile[r] /= colCount;

  const left = findProfileEdge(hProfile, w, 0.04, 0.20, 'forward');
  const right = findProfileEdge(hProfile, w, 0.04, 0.20, 'reverse');
  const top = findProfileEdge(vProfile, h, 0.04, 0.20, 'forward');
  const bottom = findProfileEdge(vProfile, h, 0.04, 0.20, 'reverse');

  const ranges = [left / w, right / w, top / h, bottom / h];
  const inRange = ranges.filter(r => r >= 0.04 && r <= 0.18).length;

  return { left, right, top, bottom, confidence: inRange / 4 };
}

function findProfileEdge(profile, dim, minPct, maxPct, direction) {
  const minPx = Math.floor(dim * minPct);
  const maxPx = Math.floor(dim * maxPct);
  let maxGradient = 0;
  let bestPos = Math.round(dim * 0.09);

  const win = 3;
  for (let i = minPx + win; i <= maxPx - win; i++) {
    const pos = direction === 'forward' ? i : dim - 1 - i;
    const posL = direction === 'forward' ? i - win : dim - 1 - i + win;
    const posR = direction === 'forward' ? i + win : dim - 1 - i - win;
    const gradient = Math.abs(profile[posR] - profile[posL]);
    if (gradient > maxGradient) {
      maxGradient = gradient;
      bestPos = i;
    }
  }
  return bestPos;
}

// Edge-based fallback for inner border
function findInnerBorderByEdge(edgeMat, w, h) {
  return {
    left: scanBorderEdge(edgeMat, 'left', w, h, 0.05, 0.25),
    right: w - scanBorderEdge(edgeMat, 'right', w, h, 0.05, 0.25),
    top: scanBorderEdge(edgeMat, 'top', w, h, 0.05, 0.25),
    bottom: h - scanBorderEdge(edgeMat, 'bottom', w, h, 0.05, 0.25)
  };
}

function scanBorderEdge(edgeMat, side, w, h, minPct, maxPct) {
  const rows = edgeMat.rows;
  const cols = edgeMat.cols;
  let bestPos = 0;
  let bestDensity = 0;

  const isHoriz = side === 'left' || side === 'right';
  const minPx = Math.floor((isHoriz ? w : h) * minPct);
  const maxPx = Math.floor((isHoriz ? w : h) * maxPct);

  for (let pos = minPx; pos <= maxPx; pos++) {
    let edgeCount = 0, sampleCount = 0;

    if (isHoriz) {
      const col = side === 'left' ? pos : cols - 1 - pos;
      const startRow = Math.floor(rows * 0.2);
      const endRow = Math.floor(rows * 0.8);
      for (let r = startRow; r < endRow; r += 2) {
        if (edgeMat.ucharAt(r, col) > 0) edgeCount++;
        sampleCount++;
      }
    } else {
      const row = side === 'top' ? pos : rows - 1 - pos;
      const startCol = Math.floor(cols * 0.2);
      const endCol = Math.floor(cols * 0.8);
      for (let c = startCol; c < endCol; c += 2) {
        if (edgeMat.ucharAt(row, c) > 0) edgeCount++;
        sampleCount++;
      }
    }

    const density = sampleCount > 0 ? edgeCount / sampleCount : 0;
    if (density > bestDensity && density > 0.15) {
      bestDensity = density;
      bestPos = pos;
    }
  }

  if (bestDensity < 0.15) {
    return Math.round((isHoriz ? w : h) * 0.08);
  }
  return bestPos;
}

// ─── Corner Analysis ────────────────────────────────────────────
function analyseCorners(gray, w, h) {
  const cropSize = Math.round(Math.min(w, h) * 0.15);
  const corners = {
    TL: cropAndScoreCorner(gray, 0, 0, cropSize),
    TR: cropAndScoreCorner(gray, w - cropSize, 0, cropSize),
    BL: cropAndScoreCorner(gray, 0, h - cropSize, cropSize),
    BR: cropAndScoreCorner(gray, w - cropSize, h - cropSize, cropSize)
  };

  const scores = [corners.TL, corners.TR, corners.BL, corners.BR];
  const minScore = Math.min(...scores);
  const avg = scores.reduce((a, b) => a + b, 0) / 4;
  const score = minScore * 0.6 + avg * 0.4;

  return { score: clamp(score, 1, 10), individual: corners };
}

function cropAndScoreCorner(gray, x, y, size) {
  let roi = null, laplacian = null;
  try {
    const rect = new cv.Rect(
      clamp(x, 0, gray.cols - size),
      clamp(y, 0, gray.rows - size),
      Math.min(size, gray.cols - x),
      Math.min(size, gray.rows - y)
    );
    roi = gray.roi(rect);

    laplacian = new cv.Mat();
    cv.Laplacian(roi, laplacian, cv.CV_64F);
    const mean = new cv.Mat();
    const stddev = new cv.Mat();
    cv.meanStdDev(laplacian, mean, stddev);
    const variance = stddev.doubleAt(0, 0) ** 2;
    mean.delete();
    stddev.delete();

    const sharpnessScore = clamp(variance / 80, 1, 10);

    const cornerMean = new cv.Mat();
    const cornerStd = new cv.Mat();
    cv.meanStdDev(roi, cornerMean, cornerStd);
    const avgBrightness = cornerMean.doubleAt(0, 0);
    cornerMean.delete();
    cornerStd.delete();

    let whiteningPenalty = 0;
    if (avgBrightness > 220) whiteningPenalty = 2;
    else if (avgBrightness > 200) whiteningPenalty = 1;

    return clamp(sharpnessScore - whiteningPenalty, 1, 10);
  } finally {
    if (roi) roi.delete();
    if (laplacian) laplacian.delete();
  }
}

// ─── Edge Analysis ──────────────────────────────────────────────
function analyseEdges(gray, w, h) {
  const edgeWidth = Math.round(Math.min(w, h) * 0.05);
  const edges = {
    top: scoreEdge(gray, 0, 0, w, edgeWidth),
    bottom: scoreEdge(gray, 0, h - edgeWidth, w, edgeWidth),
    left: scoreEdge(gray, 0, 0, edgeWidth, h),
    right: scoreEdge(gray, w - edgeWidth, 0, edgeWidth, h)
  };

  const scores = [edges.top, edges.bottom, edges.left, edges.right];
  const avg = scores.reduce((a, b) => a + b, 0) / 4;
  const minE = Math.min(...scores);
  const score = minE * 0.5 + avg * 0.5;

  return { score: clamp(score, 1, 10), individual: edges };
}

function scoreEdge(gray, x, y, w, h) {
  let roi = null, sobelX = null, sobelY = null;
  try {
    const rect = new cv.Rect(
      clamp(x, 0, gray.cols - 1),
      clamp(y, 0, gray.rows - 1),
      Math.min(w, gray.cols - x),
      Math.min(h, gray.rows - y)
    );
    if (rect.width <= 0 || rect.height <= 0) return 8;

    roi = gray.roi(rect);

    const mean = new cv.Mat();
    const stddev = new cv.Mat();
    cv.meanStdDev(roi, mean, stddev);
    const uniformity = stddev.doubleAt(0, 0);
    mean.delete();
    stddev.delete();

    let score = 10;

    if (uniformity > 60) score -= 3;
    else if (uniformity > 45) score -= 2;
    else if (uniformity > 30) score -= 1;

    let brightPixels = 0;
    let totalPixels = 0;
    const data = roi.data;
    for (let i = 0; i < data.length; i += 4) {
      totalPixels++;
      if (data[i] > 230) brightPixels++;
    }
    const brightRatio = totalPixels > 0 ? brightPixels / totalPixels : 0;
    if (brightRatio > 0.3) score -= 2;
    else if (brightRatio > 0.15) score -= 1;

    sobelX = new cv.Mat();
    cv.Sobel(roi, sobelX, cv.CV_64F, 1, 0, 3);
    const sMean = new cv.Mat();
    const sStd = new cv.Mat();
    cv.meanStdDev(sobelX, sMean, sStd);
    const edgeIntensity = sStd.doubleAt(0, 0);
    sMean.delete();
    sStd.delete();

    if (edgeIntensity > 80) score -= 1;

    return clamp(score, 1, 10);
  } finally {
    if (roi) roi.delete();
    if (sobelX) sobelX.delete();
    if (sobelY) sobelY.delete();
  }
}

// ─── Surface Analysis ───────────────────────────────────────────
function analyseSurface(gray, w, h) {
  let roi = null, laplacian = null, blurred = null, diff = null;
  try {
    const mx = Math.round(w * 0.15);
    const my = Math.round(h * 0.15);
    const rect = new cv.Rect(mx, my, w - mx * 2, h - my * 2);
    roi = gray.roi(rect);

    laplacian = new cv.Mat();
    cv.Laplacian(roi, laplacian, cv.CV_64F);
    const lapMean = new cv.Mat();
    const lapStd = new cv.Mat();
    cv.meanStdDev(laplacian, lapMean, lapStd);
    const lapVariance = lapStd.doubleAt(0, 0) ** 2;
    lapMean.delete();
    lapStd.delete();

    blurred = new cv.Mat();
    cv.GaussianBlur(roi, blurred, new cv.Size(15, 15), 0);
    diff = new cv.Mat();
    cv.absdiff(roi, blurred, diff);
    const diffMean = new cv.Mat();
    const diffStd = new cv.Mat();
    cv.meanStdDev(diff, diffMean, diffStd);
    const localContrastAnomaly = diffStd.doubleAt(0, 0);
    diffMean.delete();
    diffStd.delete();

    const texMean = new cv.Mat();
    const texStd = new cv.Mat();
    cv.meanStdDev(roi, texMean, texStd);
    texMean.delete();
    texStd.delete();

    let score = 10;
    if (lapVariance > 3000) score -= 1;
    if (lapVariance > 5000) score -= 1;
    if (localContrastAnomaly > 30) score -= 1;
    if (localContrastAnomaly > 50) score -= 1;

    return { score: clamp(score, 1, 10) };
  } finally {
    if (roi) roi.delete();
    if (laplacian) laplacian.delete();
    if (blurred) blurred.delete();
    if (diff) diff.delete();
  }
}

// ─── PSA Mapping ────────────────────────────────────────────────
function toPSA(score) {
  if (score >= 9.5) return 10;
  if (score >= 8.5) return 9;
  if (score >= 7.5) return 8;
  if (score >= 6.5) return 7;
  if (score >= 5.5) return 6;
  return Math.max(1, Math.round(score));
}

function gradeClass(psa) {
  if (psa >= 10) return 'grade-psa10';
  if (psa >= 9) return 'grade-psa9';
  if (psa >= 8) return 'grade-psa8';
  if (psa >= 7) return 'grade-psa7';
  return 'grade-low';
}

function barClass(psa) {
  if (psa >= 10) return 'bar-psa10';
  if (psa >= 9) return 'bar-psa9';
  if (psa >= 8) return 'bar-psa8';
  if (psa >= 7) return 'bar-psa7';
  return 'bar-low';
}

function gradeColor(psa) {
  if (psa >= 10) return '#FFD700';
  if (psa >= 9) return '#00C851';
  if (psa >= 8) return '#33b5e5';
  if (psa >= 7) return '#ff8800';
  return '#ff4444';
}

// ─── Smoothing ──────────────────────────────────────────────────
function smooth(key, value) {
  const buf = gradeHistory[key];
  buf.push(value);
  if (buf.length > SMOOTH_FRAMES) buf.shift();
  return buf.reduce((a, b) => a + b, 0) / buf.length;
}

// ─── Draw Overlay ───────────────────────────────────────────────
function drawOverlay(contour, grade) {
  const pts = grade.ordered;
  const color = gradeColor(grade.psaGrade);

  // Check if centering is within PSA 10 threshold for blink animation
  const lrDev = Math.abs(grade.centering.lr[0] - 50);
  const tbDev = Math.abs(grade.centering.tb[0] - 50);
  const centeringIsPSA10 = Math.max(lrDev, tbDev) <= 5;

  // Blink animation: oscillate opacity when centering is PSA 10
  blinkPhase = (blinkPhase + 0.15) % (Math.PI * 2);
  const blinkAlpha = centeringIsPSA10 ? 0.5 + 0.5 * Math.sin(blinkPhase) : 1.0;

  // Card outline (thicker + blink when PSA 10 centering)
  ctx.globalAlpha = blinkAlpha;
  ctx.lineWidth = centeringIsPSA10 ? 4 : 3;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.stroke();

  ctx.fillStyle = color + '15';
  ctx.fill();
  ctx.globalAlpha = 1.0;

  // Corner indicators
  const cornerScores = grade.corners.individual;
  const cornerNames = ['TL', 'TR', 'BR', 'BL'];
  for (let i = 0; i < 4; i++) {
    const s = cornerScores[cornerNames[i]];
    const cColor = s >= 8 ? '#00C851' : s >= 6 ? '#ff8800' : '#ff4444';
    ctx.beginPath();
    ctx.arc(pts[i].x, pts[i].y, 8, 0, Math.PI * 2);
    ctx.fillStyle = cColor;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Edge indicators
  const edgeScores = grade.edges.individual;
  const edgePairs = [
    { from: 0, to: 1, score: edgeScores.top },
    { from: 1, to: 2, score: edgeScores.right },
    { from: 2, to: 3, score: edgeScores.bottom },
    { from: 3, to: 0, score: edgeScores.left }
  ];
  for (const e of edgePairs) {
    const eColor = e.score >= 8 ? '#00C851' : e.score >= 6 ? '#ff8800' : '#ff4444';
    ctx.strokeStyle = eColor;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(pts[e.from].x, pts[e.from].y);
    ctx.lineTo(pts[e.to].x, pts[e.to].y);
    ctx.stroke();
  }

  drawCenteringRulers(pts, grade.centering);

  // Center crosshair
  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(cx - 15, cy); ctx.lineTo(cx + 15, cy);
  ctx.moveTo(cx, cy - 15); ctx.lineTo(cx, cy + 15);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawCenteringRulers(pts, centering) {
  const [tl, tr, br, bl] = pts;

  // L/R ruler at top
  const topMidY = (tl.y + tr.y) / 2 - 20;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(tl.x, topMidY);
  ctx.lineTo(tr.x, topMidY);
  ctx.stroke();

  ctx.fillStyle = '#fff';
  ctx.font = '12px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(
    centering.lr[0] + ':' + centering.lr[1] + ' (L:R)',
    (tl.x + tr.x) / 2, topMidY - 4
  );

  // T/B ruler at left
  const leftMidX = (tl.x + bl.x) / 2 - 20;
  ctx.beginPath();
  ctx.moveTo(leftMidX, tl.y);
  ctx.lineTo(leftMidX, bl.y);
  ctx.stroke();

  ctx.save();
  ctx.translate(leftMidX - 4, (tl.y + bl.y) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(centering.tb[0] + ':' + centering.tb[1] + ' (T:B)', 0, 0);
  ctx.restore();
}

function drawNoCardOverlay() {
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(0, 0, overlay.width, overlay.height);

  const gx = overlay.width * 0.15;
  const gy = overlay.height * 0.15;
  const gw = overlay.width * 0.7;
  const gh = overlay.height * 0.7;

  ctx.strokeStyle = 'rgba(124, 77, 255, 0.5)';
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 10]);
  ctx.strokeRect(gx, gy, gw, gh);
  ctx.setLineDash([]);

  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '16px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Position card within frame', overlay.width / 2, overlay.height / 2);
}

// ─── Update UI ──────────────────────────────────────────────────
function updateUI(grade) {
  const c = smooth('centering', grade.centering.score);
  const co = smooth('corners', grade.corners.score);
  const e = smooth('edges', grade.edges.score);
  const s = smooth('surface', grade.surface.score);
  const o = smooth('overall', grade.overall);
  const psa = toPSA(o);

  const lr0 = Math.round(smooth('centerLR', grade.centering.lr[0]));
  const lr1 = 100 - lr0;
  const tb0 = Math.round(smooth('centerTB', grade.centering.tb[0]));
  const tb1 = 100 - tb0;

  // Smooth pixel measurements
  const lPx = Math.round(smooth('centerLPx', grade.centering.leftPx || 0));
  const rPx = Math.round(smooth('centerRPx', grade.centering.rightPx || 0));
  const tPx = Math.round(smooth('centerTPx', grade.centering.topPx || 0));
  const bPx = Math.round(smooth('centerBPx', grade.centering.bottomPx || 0));

  const ci = grade.corners.individual;
  const sTL = smooth('cornerTL', ci.TL).toFixed(1);
  const sTR = smooth('cornerTR', ci.TR).toFixed(1);
  const sBL = smooth('cornerBL', ci.BL).toFixed(1);
  const sBR = smooth('cornerBR', ci.BR).toFixed(1);

  const ei = grade.edges.individual;
  const sET = smooth('edgeT', ei.top).toFixed(1);
  const sEB = smooth('edgeB', ei.bottom).toFixed(1);
  const sEL = smooth('edgeL', ei.left).toFixed(1);
  const sER = smooth('edgeR', ei.right).toFixed(1);

  setGradeRow('centering', c);
  setGradeRow('corners', co);
  setGradeRow('edges', e);
  setGradeRow('surface', s);

  // Centering: ratio + pixel measurements + PSA threshold tag
  const lrDev = Math.abs(lr0 - 50);
  const tbDev = Math.abs(tb0 - 50);
  const maxDev = Math.max(lrDev, tbDev);
  const psaTag = maxDev <= 5 ? ' [PSA10]' : maxDev <= 10 ? ' [PSA9]' : maxDev <= 15 ? ' [PSA8]' : '';

  document.getElementById('centering-detail').textContent =
    `${lr0}:${lr1} (L:R) ${lPx}px/${rPx}px | ${tb0}:${tb1} (T:B) ${tPx}px/${bPx}px${psaTag}`;
  document.getElementById('corners-detail').textContent =
    `TL ${sTL} | TR ${sTR} | BL ${sBL} | BR ${sBR}`;
  document.getElementById('edges-detail').textContent =
    `T ${sET} | B ${sEB} | L ${sEL} | R ${sER}`;

  // Badge
  const badge = document.getElementById('grade-badge');
  badge.classList.remove('hidden', 'grade-psa10', 'grade-psa9', 'grade-psa8', 'grade-psa7', 'grade-low');
  badge.classList.add(gradeClass(psa));
  document.getElementById('badge-grade').textContent = psa;

  // Store for capture
  capturedAnalysis = {
    psaGrade: psa, overall: o,
    centering: { score: c, lr: [lr0, lr1], tb: [tb0, tb1], leftPx: lPx, rightPx: rPx, topPx: tPx, bottomPx: bPx },
    corners: { score: co, individual: { TL: +sTL, TR: +sTR, BL: +sBL, BR: +sBR } },
    edges: { score: e, individual: { top: +sET, bottom: +sEB, left: +sEL, right: +sER } },
    surface: { score: s }
  };

  if (psa >= 10 && navigator.vibrate) {
    navigator.vibrate(50);
  }
}

function setGradeRow(name, score) {
  const psa = toPSA(score);
  document.getElementById(name + '-value').textContent = score.toFixed(1);
  const bar = document.getElementById(name + '-bar');
  bar.style.width = (score * 10) + '%';
  bar.className = 'grade-bar-fill ' + barClass(psa);
}

// ─── Panel Toggle ───────────────────────────────────────────────
function togglePanel() {
  panelCollapsed = !panelCollapsed;
  document.getElementById('bottom-panel').classList.toggle('collapsed', panelCollapsed);
}

// ─── Capture Detail ─────────────────────────────────────────────
function captureDetail() {
  if (!capturedAnalysis) return;

  const modal = document.getElementById('detail-modal');
  modal.classList.remove('hidden');

  const dc = document.getElementById('detail-canvas');
  dc.width = video.videoWidth;
  dc.height = video.videoHeight;
  const dctx = dc.getContext('2d');
  dctx.drawImage(video, 0, 0);

  const db = document.getElementById('detail-grade-badge');
  db.className = gradeClass(capturedAnalysis.psaGrade);
  document.getElementById('detail-badge-grade').textContent = capturedAnalysis.psaGrade;

  const a = capturedAnalysis;
  const bd = document.getElementById('detail-breakdown');
  bd.innerHTML = `
    <div class="breakdown-row">
      <span class="breakdown-label">Centering (35%)</span>
      <span class="breakdown-value">${a.centering.score.toFixed(1)}/10 — ${a.centering.lr[0]}:${a.centering.lr[1]} (L:R) ${a.centering.leftPx}px/${a.centering.rightPx}px | ${a.centering.tb[0]}:${a.centering.tb[1]} (T:B) ${a.centering.topPx}px/${a.centering.bottomPx}px</span>
    </div>
    <div class="breakdown-row">
      <span class="breakdown-label">Corners (30%)</span>
      <span class="breakdown-value">${a.corners.score.toFixed(1)}/10 — TL:${a.corners.individual.TL} TR:${a.corners.individual.TR} BL:${a.corners.individual.BL} BR:${a.corners.individual.BR}</span>
    </div>
    <div class="breakdown-row">
      <span class="breakdown-label">Edges (20%)</span>
      <span class="breakdown-value">${a.edges.score.toFixed(1)}/10 — T:${a.edges.individual.top} B:${a.edges.individual.bottom} L:${a.edges.individual.left} R:${a.edges.individual.right}</span>
    </div>
    <div class="breakdown-row">
      <span class="breakdown-label">Surface (15%)</span>
      <span class="breakdown-value">${a.surface.score.toFixed(1)}/10</span>
    </div>
    <div class="breakdown-row">
      <span class="breakdown-label"><strong>Overall</strong></span>
      <span class="breakdown-value" style="color:${gradeColor(a.psaGrade)}"><strong>PSA ${a.psaGrade} (${a.overall.toFixed(2)})</strong></span>
    </div>
  `;

  const checks = [
    { label: 'Centering within 55/45', pass: Math.max(Math.abs(a.centering.lr[0] - 50), Math.abs(a.centering.tb[0] - 50)) <= 5 },
    { label: 'No corner wear detected', pass: a.corners.score >= 9 },
    { label: 'No edge whitening', pass: a.edges.score >= 9 },
    { label: 'No surface scratches', pass: a.surface.score >= 9 },
    { label: 'Sharp corners', pass: Math.min(a.corners.individual.TL, a.corners.individual.TR, a.corners.individual.BL, a.corners.individual.BR) >= 8 }
  ];

  const cl = document.getElementById('checklist-items');
  cl.innerHTML = checks.map(c =>
    `<li class="${c.pass ? 'check-pass' : 'check-fail'}">${c.pass ? '\u2705' : '\u274C'} ${c.label}</li>`
  ).join('');
}

function closeModal() {
  document.getElementById('detail-modal').classList.add('hidden');
}

// ─── Save Analysis ──────────────────────────────────────────────
function saveAnalysis() {
  const dc = document.getElementById('detail-canvas');
  const link = document.createElement('a');
  link.download = `psa-grade-${capturedAnalysis.psaGrade}-${Date.now()}.png`;
  link.href = dc.toDataURL('image/png');
  link.click();
}

// ─── Utility ────────────────────────────────────────────────────
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
