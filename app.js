// No external dependencies. Pure canvas pixel math.

const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const captureCanvas = document.getElementById("capture");
const overlayCtx = overlay.getContext("2d");
const captureCtx = captureCanvas.getContext("2d", { willReadFrequently: true });

let running = false;
let lastGrade = null;
let frameCount = 0, fpsTime = performance.now(), fps = 0;
const SMOOTH = 8;
const history = { overall:[], centering:[], corners:[], edges:[], surface:[], lr:[], tb:[] };

// ── Start ────────────────────────────────────────────────────────
async function start() {
  document.getElementById("load-msg").textContent = "Requesting camera...";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    video.srcObject = stream;
    await new Promise(r => video.addEventListener("loadedmetadata", r, { once: true }));
    await video.play();

    overlay.width = captureCanvas.width = video.videoWidth;
    overlay.height = captureCanvas.height = video.videoHeight;

    document.getElementById("loading").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");

    running = true;
    loop();
  } catch(e) {
    document.getElementById("load-msg").textContent = "Camera error: " + e.message + ". Please allow camera access and reload.";
  }
}

// ── Main loop ────────────────────────────────────────────────────
function loop() {
  if (!running) return;
  requestAnimationFrame(loop);

  frameCount++;
  const now = performance.now();
  if (now - fpsTime >= 1000) {
    fps = frameCount; frameCount = 0; fpsTime = now;
    document.getElementById("fps").textContent = fps + " fps";
  }

  captureCtx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

  const bounds = detectCardBounds();
  const imageData = captureCtx.getImageData(bounds.x, bounds.y, bounds.w, bounds.h);
  const pixels = imageData.data;

  const variance = getBrightnessVariance(pixels, bounds.w, bounds.h);
  if (variance < 20) {
    document.getElementById("status").textContent = "Point camera at card";
    document.getElementById("panel").classList.add("no-grade");
    return;
  }
  document.getElementById("panel").classList.remove("no-grade");

  const grade = analyzeCard(pixels, bounds.w, bounds.h);
  const smoothed = addSmooth(grade);
  lastGrade = smoothed;

  drawCardOverlay(bounds, smoothed);
  updateUI(smoothed);
}

// ── Card Detection ──────────────────────────────────────────────
function detectCardBounds() {
  const W = captureCanvas.width, H = captureCanvas.height;
  const fullData = captureCtx.getImageData(0, 0, W, H);
  const pixels = fullData.data;

  let topEdge = Math.round(H * 0.05);
  let botEdge = Math.round(H * 0.95);
  let leftEdge = Math.round(W * 0.05);
  let rightEdge = Math.round(W * 0.95);

  const midX = Math.round(W / 2);

  // Scan down from top to find where brightness jumps (top of card)
  let prevBright = getGrayFull(pixels, W, midX, 0);
  for (let y = 5; y < H * 0.5; y += 3) {
    const bright = getGrayFull(pixels, W, midX, y);
    if (Math.abs(bright - prevBright) > 30 || bright > 160) {
      topEdge = y;
      break;
    }
    prevBright = bright;
  }

  // Scan up from bottom
  prevBright = getGrayFull(pixels, W, midX, H - 1);
  for (let y = H - 5; y > H * 0.5; y -= 3) {
    const bright = getGrayFull(pixels, W, midX, y);
    if (Math.abs(bright - prevBright) > 30 || bright > 160) {
      botEdge = y;
      break;
    }
    prevBright = bright;
  }

  const midY = Math.round((topEdge + botEdge) / 2);

  // Scan right from left
  prevBright = getGrayFull(pixels, W, 0, midY);
  for (let x = 5; x < W * 0.5; x += 3) {
    const bright = getGrayFull(pixels, W, x, midY);
    if (Math.abs(bright - prevBright) > 30 || bright > 160) {
      leftEdge = x;
      break;
    }
    prevBright = bright;
  }

  // Scan left from right
  prevBright = getGrayFull(pixels, W, W - 1, midY);
  for (let x = W - 5; x > W * 0.5; x -= 3) {
    const bright = getGrayFull(pixels, W, x, midY);
    if (Math.abs(bright - prevBright) > 30 || bright > 160) {
      rightEdge = x;
      break;
    }
    prevBright = bright;
  }

  const cardW = rightEdge - leftEdge;
  const cardH = botEdge - topEdge;
  const aspect = cardH / cardW;

  // Validate: card should have roughly 1.4 aspect ratio and be a reasonable size
  const minSize = Math.min(W, H) * 0.20;
  if (cardW < minSize || cardH < minSize || aspect < 0.8 || aspect > 2.5) {
    // Fallback: use center 70% of frame
    const fw = Math.round(W * 0.70);
    const fh = Math.round(fw * 1.4);
    return {
      x: Math.round((W - fw) / 2),
      y: Math.round((H - fh) / 2),
      w: fw, h: fh,
      detected: false
    };
  }

  return { x: leftEdge, y: topEdge, w: cardW, h: cardH, detected: true };
}

function getGrayFull(pixels, W, x, y) {
  const i = (y * W + x) * 4;
  return 0.299 * pixels[i] + 0.587 * pixels[i+1] + 0.114 * pixels[i+2];
}

// ── Pixel helpers ────────────────────────────────────────────────
function getGray(pixels, w, x, y) {
  const i = (y * w + x) * 4;
  return 0.299 * pixels[i] + 0.587 * pixels[i+1] + 0.114 * pixels[i+2];
}

function getBrightnessVariance(pixels, w, h) {
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 0; y < h; y += 8) {
    for (let x = 0; x < w; x += 8) {
      const g = getGray(pixels, w, x, y);
      sum += g; sumSq += g * g; n++;
    }
  }
  const mean = sum / n;
  return (sumSq / n) - (mean * mean);
}

// ── Sobel edge magnitude at a pixel ─────────────────────────────
function sobelAt(pixels, w, h, x, y) {
  if (x < 1 || y < 1 || x >= w-1 || y >= h-1) return 0;
  const tl = getGray(pixels, w, x-1, y-1), tm = getGray(pixels, w, x, y-1), tr = getGray(pixels, w, x+1, y-1);
  const ml = getGray(pixels, w, x-1, y),                                      mr = getGray(pixels, w, x+1, y);
  const bl = getGray(pixels, w, x-1, y+1), bm = getGray(pixels, w, x, y+1), br = getGray(pixels, w, x+1, y+1);
  const gx = -tl - 2*ml - bl + tr + 2*mr + br;
  const gy = -tl - 2*tm - tr + bl + 2*bm + br;
  return Math.sqrt(gx*gx + gy*gy);
}

// ── Main Analysis ────────────────────────────────────────────────
function analyzeCard(pixels, w, h) {
  const centering = analyzeCentering(pixels, w, h);
  const corners = analyzeCorners(pixels, w, h);
  const edges = analyzeEdges(pixels, w, h);
  const surface = analyzeSurface(pixels, w, h);

  const overall = centering.score * 0.35 + corners.score * 0.30 + edges.score * 0.20 + surface.score * 0.15;

  return { centering, corners, edges, surface, overall, psaGrade: toPSA(overall) };
}

// ── Centering ────────────────────────────────────────────────────
function analyzeCentering(pixels, w, h) {
  function findBorderWidth(scanFn, start, end) {
    const edgeBrightness = scanFn(start + 2);
    const isLightBorder = edgeBrightness > 160;

    let borderEnd = Math.round((end - start) * 0.12);

    if (isLightBorder) {
      for (let pos = start + 2; pos < start + (end - start) * 0.40; pos += 1) {
        const brightness = scanFn(pos);
        if (brightness < edgeBrightness - 40) {
          borderEnd = pos - start;
          break;
        }
      }
    } else {
      borderEnd = Math.round((end - start) * 0.08);
    }

    return Math.max(3, borderEnd);
  }

  function rowBrightness(y) {
    if (y < 0 || y >= h) return 128;
    let sum = 0;
    const step = Math.max(1, Math.round(w / 20));
    let n = 0;
    for (let x = Math.round(w*0.1); x < Math.round(w*0.9); x += step) {
      sum += getGray(pixels, w, x, y);
      n++;
    }
    return n > 0 ? sum / n : 128;
  }

  function colBrightness(x) {
    if (x < 0 || x >= w) return 128;
    let sum = 0;
    const step = Math.max(1, Math.round(h / 20));
    let n = 0;
    for (let y = Math.round(h*0.1); y < Math.round(h*0.9); y += step) {
      sum += getGray(pixels, w, x, y);
      n++;
    }
    return n > 0 ? sum / n : 128;
  }

  const leftPx = findBorderWidth(colBrightness, 0, w);

  function findRightBorder() {
    const edgeBrightness = colBrightness(w - 3);
    const isLight = edgeBrightness > 160;
    if (!isLight) return Math.round(w * 0.08);
    for (let x = w - 3; x > w * 0.60; x--) {
      const b = colBrightness(x);
      if (b < edgeBrightness - 40) return w - x;
    }
    return Math.round(w * 0.12);
  }
  function findTopBorder() {
    const edgeBrightness = rowBrightness(2);
    const isLight = edgeBrightness > 160;
    if (!isLight) return Math.round(h * 0.08);
    for (let y = 2; y < h * 0.35; y++) {
      const b = rowBrightness(y);
      if (b < edgeBrightness - 40) return y;
    }
    return Math.round(h * 0.12);
  }
  function findBottomBorder() {
    const edgeBrightness = rowBrightness(h - 3);
    const isLight = edgeBrightness > 160;
    if (!isLight) return Math.round(h * 0.08);
    for (let y = h - 3; y > h * 0.65; y--) {
      const b = rowBrightness(y);
      if (b < edgeBrightness - 40) return h - y;
    }
    return Math.round(h * 0.12);
  }

  const rightPx = findRightBorder();
  const topPx = findTopBorder();
  const botPx = findBottomBorder();

  const lrTotal = leftPx + rightPx;
  const tbTotal = topPx + botPx;

  const lrRatio = lrTotal > 0 ? Math.max(leftPx, rightPx) / lrTotal * 100 : 50;
  const tbRatio = tbTotal > 0 ? Math.max(topPx, botPx) / tbTotal * 100 : 50;

  function ratioToScore(r) {
    if (r <= 52) return 10;
    if (r <= 55) return 9;
    if (r <= 60) return 8;
    if (r <= 65) return 7;
    if (r <= 70) return 6;
    return Math.max(1, 5 - (r - 70) / 5);
  }

  const score = (ratioToScore(lrRatio) + ratioToScore(tbRatio)) / 2;
  const lrPct = Math.round(lrRatio);
  const tbPct = Math.round(tbRatio);

  return {
    score: Math.max(1, Math.min(10, score)),
    lrRatio, tbRatio,
    leftPx, rightPx, topPx, botPx,
    label: lrPct + "/" + (100-lrPct) + " L/R | " + tbPct + "/" + (100-tbPct) + " T/B"
  };
}

// ── Corners ──────────────────────────────────────────────────────
function analyzeCorners(pixels, w, h) {
  const cw = Math.round(w * 0.07);
  const ch = Math.round(h * 0.05);

  function singleCorner(startX, startY) {
    let whiteCount = 0, totalPixels = 0;

    for (let dy = 0; dy < ch; dy++) {
      for (let dx = 0; dx < cw; dx++) {
        const x = startX + dx;
        const y = startY + dy;
        if (x < 0 || x >= w || y < 0 || y >= h) continue;
        const i = (y * w + x) * 4;
        const r = pixels[i], g = pixels[i+1], b = pixels[i+2];
        const isWhite = r > 200 && g > 200 && b > 200 && Math.max(r,g,b) - Math.min(r,g,b) < 40;
        if (isWhite) whiteCount++;
        totalPixels++;
      }
    }

    if (totalPixels === 0) return 9;
    const whitePct = whiteCount / totalPixels;
    const score = Math.max(1, 10 - whitePct * 25);
    return Math.round(score * 10) / 10;
  }

  const tl = singleCorner(0, 0);
  const tr = singleCorner(w - cw, 0);
  const bl = singleCorner(0, h - ch);
  const br = singleCorner(w - cw, h - ch);

  const all = [tl, tr, bl, br];
  const minScore = Math.min(...all);
  const avgScore = all.reduce((a,b)=>a+b,0) / 4;
  const score = minScore * 0.5 + avgScore * 0.5;

  return { score: Math.max(1, Math.min(10, score)), tl, tr, bl, br };
}

// ── Edges ────────────────────────────────────────────────────────
function analyzeEdges(pixels, w, h) {
  const edgeDepth = Math.round(Math.min(w, h) * 0.025);

  function edgeScore(horizontal, start, end, fixedCoord) {
    let brightCount = 0, sobelSum = 0, n = 0;
    for (let i = start; i < end; i++) {
      for (let d = 0; d < edgeDepth; d++) {
        const x = horizontal ? i : (fixedCoord === "left" ? d : w - 1 - d);
        const y = horizontal ? (fixedCoord === "top" ? d : h - 1 - d) : i;
        if (x < 0 || x >= w || y < 0 || y >= h) continue;
        const pi = (y * w + x) * 4;
        if (pixels[pi] > 215 && pixels[pi+1] > 215 && pixels[pi+2] > 215) brightCount++;
        sobelSum += sobelAt(pixels, w, h, x, y);
        n++;
      }
    }
    if (n === 0) return 10;
    const whitePct = brightCount / n;
    const avgSobel = sobelSum / n;
    const ws = Math.max(0, 10 - whitePct * 100);
    const ss = Math.max(0, 10 - avgSobel / 12);
    return Math.round((ws * 0.65 + ss * 0.35) * 10) / 10;
  }

  const margin = Math.round(w * 0.12);
  const top = edgeScore(true, margin, w - margin, "top");
  const bot = edgeScore(true, margin, w - margin, "bottom");
  const left = edgeScore(false, margin, h - margin, "left");
  const right = edgeScore(false, margin, h - margin, "right");
  const score = (top + bot + left + right) / 4;

  return { score: Math.max(1, Math.min(10, score)), top, bot, left, right };
}

// ── Surface ──────────────────────────────────────────────────────
function analyzeSurface(pixels, w, h) {
  const mx = Math.round(w * 0.12), my = Math.round(h * 0.12);
  let anomalyCount = 0, totalSamples = 0;
  const ANOMALY_THRESHOLD = 35;

  for (let y = my + 2; y < h - my - 2; y += 6) {
    for (let x = mx + 2; x < w - mx - 2; x += 6) {
      let localSum = 0, localCount = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          localSum += getGray(pixels, w, x + dx, y + dy);
          localCount++;
        }
      }
      const localMean = localSum / localCount;
      const centerGray = getGray(pixels, w, x, y);
      const deviation = Math.abs(centerGray - localMean);

      if (deviation > ANOMALY_THRESHOLD) anomalyCount++;
      totalSamples++;
    }
  }

  const anomalyRate = anomalyCount / totalSamples;
  const score = Math.max(1, Math.min(10, 10 - anomalyRate * 150));

  let label = "No issues";
  if (score < 4) label = "Severe";
  else if (score < 6) label = "Moderate";
  else if (score < 8) label = "Minor";

  return { score: Math.round(score * 10) / 10, label };
}

// ── PSA Grade ────────────────────────────────────────────────────
function toPSA(score) {
  if (score >= 9.5) return { grade: 10, label: "Gem Mint" };
  if (score >= 8.5) return { grade: 9, label: "Mint" };
  if (score >= 7.5) return { grade: 8, label: "Near Mint-Mint" };
  if (score >= 6.5) return { grade: 7, label: "Near Mint" };
  if (score >= 5.5) return { grade: 6, label: "Excellent-Mint" };
  if (score >= 4.5) return { grade: 5, label: "Excellent" };
  return { grade: Math.max(1, Math.round(score)), label: "Fair/Poor" };
}

// ── Smoothing ────────────────────────────────────────────────────
function addSmooth(grade) {
  function push(arr, val) {
    arr.push(val);
    if (arr.length > SMOOTH) arr.shift();
    return arr.reduce((a,b)=>a+b,0) / arr.length;
  }
  const overall = push(history.overall, grade.overall);
  const centering = push(history.centering, grade.centering.score);
  const corners = push(history.corners, grade.corners.score);
  const edges = push(history.edges, grade.edges.score);
  const surface = push(history.surface, grade.surface.score);
  const lr = push(history.lr, grade.centering.lrRatio);
  const tb = push(history.tb, grade.centering.tbRatio);

  const lrPct = Math.round(lr);
  const tbPct = Math.round(tb);

  return {
    overall,
    psaGrade: toPSA(overall),
    centering: { ...grade.centering, score: centering, lrRatio: lr, tbRatio: tb,
      label: lrPct + "/" + (100-lrPct) + " L/R | " + tbPct + "/" + (100-tbPct) + " T/B" },
    corners: { ...grade.corners, score: corners },
    edges: { ...grade.edges, score: edges },
    surface: { ...grade.surface, score: surface }
  };
}

// ── Draw Card Overlay ────────────────────────────────────────────
function drawCardOverlay(bounds, grade) {
  const ctx = overlayCtx;
  const { x, y, w, h, detected } = bounds;

  if (!grade) return;

  const g = grade.psaGrade.grade;
  const color = g >= 9 ? "#00e676" : g >= 7 ? "#FFD700" : "#FF5252";

  // If auto-detected, draw a subtle thin dashed border
  if (detected) {
    ctx.strokeStyle = color + "88";
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }

  // Corner score dots at each corner
  const corners = [
    [x + 14, y + 14, grade.corners.tl],
    [x + w - 14, y + 14, grade.corners.tr],
    [x + 14, y + h - 14, grade.corners.bl],
    [x + w - 14, y + h - 14, grade.corners.br]
  ];
  corners.forEach(([cx, cy, score]) => {
    const col = score >= 9 ? "#00e676" : score >= 7 ? "#FFD700" : "#FF5252";
    ctx.fillStyle = col + "cc";
    ctx.beginPath(); ctx.arc(cx, cy, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#000";
    ctx.font = "bold 9px sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(score.toFixed(0), cx, cy);
  });

  // Centering measurement arrows inside card
  drawCenteringOverlay(ctx, bounds, grade.centering);
}

// ── Centering Overlay ────────────────────────────────────────────
function drawCenteringOverlay(ctx, bounds, centering) {
  const { x, y, w, h } = bounds;
  const { leftPx, rightPx, topPx, botPx } = centering;

  // Scale pixel measurements from analysis space to display space
  const scaleX = w / 350;
  const scaleY = h / 490;

  const lPx = Math.round(leftPx * scaleX);
  const rPx = Math.round(rightPx * scaleX);
  const tPx = Math.round(topPx * scaleY);
  const bPx = Math.round(botPx * scaleY);

  // Left border arrow
  const midY = y + h * 0.35;
  drawMeasArrow(ctx, x + 2, midY, x + lPx, midY, "#00e5ff", lPx + "px");

  // Right border arrow
  drawMeasArrow(ctx, x + w - 2, midY, x + w - rPx, midY, "#00e5ff", rPx + "px");

  // Top border arrow
  const midX = x + w * 0.65;
  drawMeasArrow(ctx, midX, y + 2, midX, y + tPx, "#00e5ff", tPx + "px");

  // Bottom border arrow
  drawMeasArrow(ctx, midX, y + h - 2, midX, y + h - bPx, "#00e5ff", bPx + "px");

  // Thin lines marking where the image border is
  ctx.strokeStyle = "rgba(0, 229, 255, 0.4)";
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(x + lPx, y + h*0.1); ctx.lineTo(x + lPx, y + h*0.6); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + w - rPx, y + h*0.1); ctx.lineTo(x + w - rPx, y + h*0.6); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + w*0.1, y + tPx); ctx.lineTo(x + w*0.9, y + tPx); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + w*0.1, y + h - bPx); ctx.lineTo(x + w*0.9, y + h - bPx); ctx.stroke();
  ctx.setLineDash([]);

  // L/R and T/B ratio labels inside the card
  ctx.font = "bold 13px monospace";
  ctx.textAlign = "center";

  const lrPct = Math.round(centering.lrRatio);
  const lrColor = centering.score >= 9 ? "#00e676" : centering.score >= 8 ? "#FFD700" : "#FF5252";
  ctx.fillStyle = lrColor;
  ctx.fillText("\u2190 " + lrPct + " : " + (100-lrPct) + " \u2192", x + w/2, y + h * 0.08);

  const tbPct = Math.round(centering.tbRatio);
  const tbColor = centering.score >= 9 ? "#00e676" : centering.score >= 8 ? "#FFD700" : "#FF5252";
  ctx.save();
  ctx.translate(x + w - 18, y + h/2);
  ctx.rotate(-Math.PI/2);
  ctx.fillStyle = tbColor;
  ctx.fillText("\u2191" + tbPct + ":" + (100-tbPct) + "\u2193", 0, 0);
  ctx.restore();
}

function drawMeasArrow(ctx, x1, y1, x2, y2, color, label) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.sqrt(dx*dx + dy*dy);
  if (len < 4) return;

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash([]);

  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();

  // Arrowhead at endpoint
  const angle = Math.atan2(dy, dx);
  const al = 7;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - al * Math.cos(angle - 0.4), y2 - al * Math.sin(angle - 0.4));
  ctx.lineTo(x2 - al * Math.cos(angle + 0.4), y2 - al * Math.sin(angle + 0.4));
  ctx.closePath();
  ctx.fill();

  // Label at midpoint
  if (len > 20) {
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const perpX = -dy / len * 13, perpY = dx / len * 13;
    ctx.font = "11px monospace";
    ctx.textAlign = "center";
    ctx.fillText(label, mx + perpX, my + perpY);
  }
}

// ── Update UI ────────────────────────────────────────────────────
function updateUI(grade) {
  const { psaGrade, centering, corners, edges, surface } = grade;

  const g = psaGrade.grade;
  document.getElementById("grade-number").textContent = g;
  document.getElementById("grade-label").textContent = psaGrade.label;

  const panel = document.getElementById("panel");
  panel.className = panel.classList.contains("collapsed") ? "collapsed" : "";
  if (g >= 10) panel.classList.add("grade-10");
  else if (g >= 9) panel.classList.add("grade-9");
  else if (g >= 8) panel.classList.add("grade-8");
  else if (g >= 7) panel.classList.add("grade-7");
  else panel.classList.add("grade-low");

  document.getElementById("sc-centering").textContent = centering.score.toFixed(1) + "/10 \u00b7 " + centering.label;
  document.getElementById("sc-corners").textContent = corners.score.toFixed(1) + "/10 (TL:" + corners.tl.toFixed(0) + " TR:" + corners.tr.toFixed(0) + " BL:" + corners.bl.toFixed(0) + " BR:" + corners.br.toFixed(0) + ")";
  document.getElementById("sc-edges").textContent = edges.score.toFixed(1) + "/10 (T:" + edges.top.toFixed(0) + " B:" + edges.bot.toFixed(0) + " L:" + edges.left.toFixed(0) + " R:" + edges.right.toFixed(0) + ")";
  document.getElementById("sc-surface").textContent = surface.score.toFixed(1) + "/10 \u00b7 " + surface.label;

  // PSA 10 checklist
  const lrPct = Math.round(Math.max(centering.lrRatio, 100 - centering.lrRatio));
  const tbPct = Math.round(Math.max(centering.tbRatio, 100 - centering.tbRatio));
  setCheck("chk-centering", lrPct <= 55 && tbPct <= 55, "Centering \u2264 55/45 (" + lrPct + "/" + (100-lrPct) + " | " + tbPct + "/" + (100-tbPct) + ")");
  setCheck("chk-corners", corners.score >= 9, "Corners 9+ (" + corners.score.toFixed(1) + ")");
  setCheck("chk-edges", edges.score >= 9, "Edges 9+ (" + edges.score.toFixed(1) + ")");
  setCheck("chk-surface", surface.score >= 9, "Surface 9+ (" + surface.score.toFixed(1) + ")");

  document.getElementById("status").textContent = g >= 10 ? "\uD83C\uDFC6 PSA 10 Candidate!" : g >= 9 ? "\u2705 Strong card" : "Hold steady";

  // Haptic on PSA 10
  if (g >= 10 && navigator.vibrate) navigator.vibrate([100, 50, 100]);
}

function setCheck(id, pass, text) {
  const el = document.getElementById(id);
  el.textContent = (pass ? "\u2705 " : "\u274C ") + text;
  el.className = "check-item " + (pass ? "pass" : "fail");
}

// ── Panel Toggle ────────────────────────────────────────────────
document.getElementById("panel-toggle").addEventListener("click", () => {
  document.getElementById("panel").classList.toggle("collapsed");
});

// ── Boot ─────────────────────────────────────────────────────────
start();
