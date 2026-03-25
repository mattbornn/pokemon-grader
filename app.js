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

  // Capture frame to hidden canvas
  captureCtx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);

  // Get guide rect
  const guide = getGuideRect();

  // Get pixel data from guide region
  const imageData = captureCtx.getImageData(guide.x, guide.y, guide.w, guide.h);
  const pixels = imageData.data; // RGBA flat array

  // Check if card is present (brightness variance check)
  const variance = getBrightnessVariance(pixels, guide.w, guide.h);

  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

  if (variance < 30) {
    // Nothing in frame
    drawGuide(guide, null);
    document.getElementById("status").textContent = "Align card to frame";
    document.getElementById("grade-badge").classList.add("hidden");
    return;
  }

  // Run analysis
  const grade = analyzeCard(pixels, guide.w, guide.h);

  // Smooth grades
  const smooth = addSmooth(grade);
  lastGrade = smooth;

  // Draw overlay
  drawGuide(guide, smooth);
  updateUI(smooth);
}

// ── Guide Rect ───────────────────────────────────────────────────
function getGuideRect() {
  const W = overlay.width, H = overlay.height;
  const h = Math.round(H * 0.78);
  const w = Math.round(h * (2.5 / 3.5));
  const x = Math.round((W - w) / 2);
  const y = Math.round((H - h) / 2);
  return { x, y, w, h };
}

// ── Pixel helpers ────────────────────────────────────────────────
function getGray(pixels, w, x, y) {
  const i = (y * w + x) * 4;
  return 0.299 * pixels[i] + 0.587 * pixels[i+1] + 0.114 * pixels[i+2];
}

function getBrightnessVariance(pixels, w, h) {
  let sum = 0, sumSq = 0, n = 0;
  // Sample every 8th pixel for speed
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
  function findInnerLeft(sampleY) {
    const startX = Math.round(w * 0.04);
    const endX = Math.round(w * 0.40);
    let maxSobel = 0, maxX = startX;
    for (let x = startX; x < endX; x++) {
      const s = sobelAt(pixels, w, h, x, sampleY);
      if (s > maxSobel) { maxSobel = s; maxX = x; }
    }
    return maxSobel > 8 ? maxX : null;
  }
  function findInnerRight(sampleY) {
    const startX = Math.round(w * 0.60);
    const endX = Math.round(w * 0.96);
    let maxSobel = 0, maxX = startX;
    for (let x = startX; x < endX; x++) {
      const s = sobelAt(pixels, w, h, x, sampleY);
      if (s > maxSobel) { maxSobel = s; maxX = x; }
    }
    return maxSobel > 8 ? w - maxX : null;
  }
  function findInnerTop(sampleX) {
    const startY = Math.round(h * 0.04);
    const endY = Math.round(h * 0.30);
    let maxSobel = 0, maxY = startY;
    for (let y = startY; y < endY; y++) {
      const s = sobelAt(pixels, w, h, sampleX, y);
      if (s > maxSobel) { maxSobel = s; maxY = y; }
    }
    return maxSobel > 8 ? maxY : null;
  }
  function findInnerBottom(sampleX) {
    const startY = Math.round(h * 0.70);
    const endY = Math.round(h * 0.96);
    let maxSobel = 0, maxY = startY;
    for (let y = startY; y < endY; y++) {
      const s = sobelAt(pixels, w, h, sampleX, y);
      if (s > maxSobel) { maxSobel = s; maxY = y; }
    }
    return maxSobel > 8 ? h - maxY : null;
  }

  const y1 = Math.round(h * 0.25), y2 = Math.round(h * 0.50), y3 = Math.round(h * 0.75);
  const x1 = Math.round(w * 0.25), x2 = Math.round(w * 0.50), x3 = Math.round(w * 0.75);

  const lefts = [findInnerLeft(y1), findInnerLeft(y2), findInnerLeft(y3)].filter(v => v !== null);
  const rights = [findInnerRight(y1), findInnerRight(y2), findInnerRight(y3)].filter(v => v !== null);
  const tops = [findInnerTop(x1), findInnerTop(x2), findInnerTop(x3)].filter(v => v !== null);
  const bots = [findInnerBottom(x1), findInnerBottom(x2), findInnerBottom(x3)].filter(v => v !== null);

  const leftPx = lefts.length ? lefts.reduce((a,b)=>a+b,0)/lefts.length : w * 0.08;
  const rightPx = rights.length ? rights.reduce((a,b)=>a+b,0)/rights.length : w * 0.08;
  const topPx = tops.length ? tops.reduce((a,b)=>a+b,0)/tops.length : h * 0.08;
  const botPx = bots.length ? bots.reduce((a,b)=>a+b,0)/bots.length : h * 0.08;

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

  const lrScore = ratioToScore(lrRatio);
  const tbScore = ratioToScore(tbRatio);
  const score = (lrScore + tbScore) / 2;

  const lrPct = Math.round(lrRatio);
  const lrOther = 100 - lrPct;
  const tbPct = Math.round(tbRatio);
  const tbOther = 100 - tbPct;

  return {
    score,
    lrRatio, tbRatio,
    leftPx: Math.round(leftPx), rightPx: Math.round(rightPx),
    topPx: Math.round(topPx), botPx: Math.round(botPx),
    label: lrPct + "/" + lrOther + " L/R | " + tbPct + "/" + tbOther + " T/B"
  };
}

// ── Corners ──────────────────────────────────────────────────────
function analyzeCorners(pixels, w, h) {
  const cw = Math.round(w * 0.12), ch = Math.round(h * 0.09);

  function cornerScore(px, py, flipX, flipY) {
    let edgeSum = 0, brightCount = 0, n = 0;
    const startX = flipX ? w - cw : 0;
    const startY = flipY ? h - ch : 0;

    for (let dy = 0; dy < ch; dy++) {
      for (let dx = 0; dx < cw; dx++) {
        const x = startX + dx, y = startY + dy;
        const s = sobelAt(pixels, w, h, x, y);
        edgeSum += s;
        const i = (y * w + x) * 4;
        if (pixels[i] > 220 && pixels[i+1] > 220 && pixels[i+2] > 220) brightCount++;
        n++;
      }
    }

    const avgEdge = edgeSum / n;
    const whitePct = brightCount / n;

    const whiteScore = Math.max(0, 10 - whitePct * 60);
    const edgeScore = Math.max(0, 10 - avgEdge / 3);

    return Math.round((whiteScore * 0.6 + edgeScore * 0.4) * 10) / 10;
  }

  const tl = cornerScore(0, 0, false, false);
  const tr = cornerScore(w - cw, 0, true, false);
  const bl = cornerScore(0, h - ch, false, true);
  const br = cornerScore(w - cw, h - ch, true, true);
  const score = Math.min(tl, tr, bl, br);

  return { score: Math.max(1, Math.min(10, score)), tl, tr, bl, br };
}

// ── Edges ────────────────────────────────────────────────────────
function analyzeEdges(pixels, w, h) {
  const edgeDepth = Math.round(Math.min(w, h) * 0.04);

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
    const ws = Math.max(0, 10 - whitePct * 50);
    const ss = Math.max(0, 10 - avgSobel / 4);
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
  const mx = Math.round(w * 0.15), my = Math.round(h * 0.15);
  let highFreqCount = 0, totalSamples = 0;
  const SCRATCH_THRESHOLD = 45;

  for (let y = my; y < h - my; y += 4) {
    for (let x = mx; x < w - mx; x += 4) {
      const s = sobelAt(pixels, w, h, x, y);
      if (s > SCRATCH_THRESHOLD) highFreqCount++;
      totalSamples++;
    }
  }

  const defectRate = highFreqCount / totalSamples;
  const score = Math.max(1, 10 - defectRate * 60);

  let label = "No issues";
  if (score < 5) label = "Severe";
  else if (score < 7) label = "Moderate";
  else if (score < 9) label = "Minor";

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

// ── Draw Guide ───────────────────────────────────────────────────
function drawGuide(guide, grade) {
  const ctx = overlayCtx;
  const { x, y, w, h } = guide;

  // Dim outside guide
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(0, 0, overlay.width, y);
  ctx.fillRect(0, y + h, overlay.width, overlay.height - y - h);
  ctx.fillRect(0, y, x, h);
  ctx.fillRect(x + w, y, overlay.width - x - w, h);

  if (!grade) {
    // Dashed guide frame
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.lineWidth = 3;
    ctx.setLineDash([15, 10]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);

    // Corner brackets
    const bs = 30;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 4;
    [[x,y],[x+w,y],[x,y+h],[x+w,y+h]].forEach(([cx,cy]) => {
      const sx = cx === x ? 1 : -1;
      const sy = cy === y ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(cx + sx*bs, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + sy*bs);
      ctx.stroke();
    });
    return;
  }

  // Grade-based color
  const g = grade.psaGrade.grade;
  const color = g >= 9 ? "#00e676" : g >= 7 ? "#FFD700" : "#FF5252";

  // Solid guide border
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.setLineDash([]);
  ctx.strokeRect(x, y, w, h);

  // Centering rulers
  const lr = grade.centering.lrRatio / 100;
  const tb = grade.centering.tbRatio / 100;
  const cColor = grade.centering.score >= 9 ? "#00e676" : grade.centering.score >= 8 ? "#FFD700" : "#FF5252";

  // Horizontal center line (top/bottom balance indicator)
  ctx.strokeStyle = cColor;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 5]);
  ctx.beginPath(); ctx.moveTo(x + 10, y + h * tb); ctx.lineTo(x + w - 10, y + h * tb); ctx.stroke();
  ctx.setLineDash([]);

  // Vertical center line (left/right balance indicator)
  ctx.beginPath(); ctx.moveTo(x + w * lr, y + 10); ctx.lineTo(x + w * lr, y + h - 10); ctx.stroke();
  ctx.setLineDash([]);

  // Corner dots
  const corners = [
    [x + 12, y + 12, grade.corners.tl],
    [x + w - 12, y + 12, grade.corners.tr],
    [x + 12, y + h - 12, grade.corners.bl],
    [x + w - 12, y + h - 12, grade.corners.br]
  ];
  corners.forEach(([cx, cy, score]) => {
    const col = score >= 9 ? "#00e676" : score >= 7 ? "#FFD700" : "#FF5252";
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(cx, cy, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#000";
    ctx.font = "bold 8px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(score.toFixed(0), cx, cy);
  });
}

// ── Update UI ────────────────────────────────────────────────────
function updateUI(grade) {
  const { psaGrade, centering, corners, edges, surface, overall } = grade;

  const badge = document.getElementById("grade-badge");
  badge.classList.remove("hidden");

  const g = psaGrade.grade;
  document.getElementById("grade-number").textContent = g;
  document.getElementById("grade-label").textContent = psaGrade.label;

  badge.className = "";
  if (g >= 10) badge.classList.add("grade-10");
  else if (g >= 9) badge.classList.add("grade-9");
  else if (g >= 8) badge.classList.add("grade-8");
  else if (g >= 7) badge.classList.add("grade-7");
  else badge.classList.add("grade-low");

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

// ── Capture ──────────────────────────────────────────────────────
document.getElementById("capture-btn").addEventListener("click", () => {
  if (!lastGrade) return;
  const guide = getGuideRect();
  const mc = document.getElementById("modal-canvas");
  mc.width = guide.w;
  mc.height = guide.h;
  const mCtx = mc.getContext("2d");
  mCtx.drawImage(captureCanvas, guide.x, guide.y, guide.w, guide.h, 0, 0, guide.w, guide.h);

  const g = lastGrade;
  document.getElementById("modal-detail").innerHTML =
    '<div class="modal-grade">PSA ~' + g.psaGrade.grade + ' \u00b7 ' + g.psaGrade.label + '</div>' +
    '<div class="modal-scores">' +
      '<div>\uD83C\uDFAF Centering: ' + g.centering.score.toFixed(1) + '/10 \u00b7 ' + g.centering.label + '</div>' +
      '<div>\uD83D\uDCD0 Corners: ' + g.corners.score.toFixed(1) + '/10</div>' +
      '<div>\uD83D\uDCCF Edges: ' + g.edges.score.toFixed(1) + '/10</div>' +
      '<div>\u2728 Surface: ' + g.surface.score.toFixed(1) + '/10</div>' +
    '</div>' +
    '<div class="checklist">' +
      '<div class="' + (g.centering.score >= 9 ? "pass" : "fail") + '">' +
        (g.centering.score >= 9 ? "\u2705" : "\u274C") + ' Centering</div>' +
      '<div class="' + (g.corners.score >= 9 ? "pass" : "fail") + '">' +
        (g.corners.score >= 9 ? "\u2705" : "\u274C") + ' Corners</div>' +
      '<div class="' + (g.edges.score >= 9 ? "pass" : "fail") + '">' +
        (g.edges.score >= 9 ? "\u2705" : "\u274C") + ' Edges</div>' +
      '<div class="' + (g.surface.score >= 9 ? "pass" : "fail") + '">' +
        (g.surface.score >= 9 ? "\u2705" : "\u274C") + ' Surface</div>' +
    '</div>';
  document.getElementById("modal").classList.remove("hidden");
});

document.getElementById("modal-close").addEventListener("click", () => {
  document.getElementById("modal").classList.add("hidden");
});

document.getElementById("save-btn").addEventListener("click", () => {
  const mc = document.getElementById("modal-canvas");
  const a = document.createElement("a");
  a.href = mc.toDataURL("image/png");
  a.download = "psa-grade-" + Date.now() + ".png";
  a.click();
});

// ── Boot ─────────────────────────────────────────────────────────
start();
