export function baytiEngineLabHtml(): string {
  return String.raw`<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Bayti Core — Engine Lab</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #0b0d12; color: #f3f5f7; }
    main { width: min(1180px, 100%); margin: 0 auto; padding: 18px; }
    h1 { font-size: 24px; margin: 0 0 6px; }
    .muted { color: #9ca6b5; font-size: 14px; }
    .panel { background: #141821; border: 1px solid #262d3a; border-radius: 16px; padding: 16px; margin-top: 14px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .grid4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    @media (max-width: 760px) { .grid, .grid4 { grid-template-columns: 1fr; } }
    label { display: block; font-size: 13px; color: #b7c0ce; margin-bottom: 6px; }
    input, select, button { width: 100%; min-height: 44px; border-radius: 10px; border: 1px solid #343d4c; background: #0f131a; color: #fff; padding: 10px 12px; font: inherit; }
    button { cursor: pointer; font-weight: 700; background: #f4f6f8; color: #11151c; }
    button.secondary { background: #202632; color: #fff; }
    button:disabled { opacity: .45; cursor: not-allowed; }
    .warning { background: #2a2213; border: 1px solid #5b4720; color: #f4d796; padding: 11px 12px; border-radius: 10px; margin-top: 12px; font-size: 13px; }
    .status { margin-top: 12px; min-height: 24px; font-weight: 650; }
    .cards { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
    @media (max-width: 840px) { .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    .card { background: #0e1219; border: 1px solid #252c38; border-radius: 12px; padding: 11px; }
    .card b { display: block; font-size: 21px; margin-top: 4px; }
    .pass { color: #7ee2a8; } .review { color: #ffd37a; } .blocked { color: #ff8e8e; }
    .viewer { position: relative; overflow: auto; background: #090b0f; border-radius: 12px; border: 1px solid #252c38; min-height: 240px; display: grid; place-items: center; }
    canvas { max-width: 100%; height: auto; display: block; }
    .toolbar { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; align-items: center; }
    .toolbar label { margin: 0; display: inline-flex; gap: 6px; align-items: center; }
    .toolbar input { width: auto; min-height: auto; }
    details { margin-top: 12px; }
    pre { direction: ltr; text-align: left; white-space: pre-wrap; word-break: break-word; max-height: 440px; overflow: auto; background: #0a0d12; padding: 12px; border-radius: 10px; font-size: 11px; }
    .row { display: flex; gap: 8px; margin-top: 10px; }
    .row > * { flex: 1; }
    .hidden { display: none !important; }
  </style>
</head>
<body>
<main>
  <h1>Bayti Core — Engine Lab</h1>
  <div class="muted">أداة فحص مؤقتة للمحرك فقط. ليست واجهة بيتي النهائية وليست 3D.</div>

  <section class="panel">
    <div class="grid">
      <div>
        <label for="key">رمز دخول المختبر</label>
        <input id="key" type="password" autocomplete="current-password" placeholder="رمز المختبر" />
      </div>
      <div>
        <label for="file">المخطط</label>
        <input id="file" type="file" accept="image/jpeg,image/png,application/pdf" />
      </div>
      <div>
        <label for="verifier">المحقق المستقل</label>
        <select id="verifier">
          <option value="best-effort">Best effort — Tectly أساسي + Replicate عند توفره</option>
          <option value="required">Required — لا يبدأ Tectly إلا بعد نجاح Replicate</option>
        </select>
      </div>
      <div>
        <label for="wallMode">تتبع الجدران</label>
        <select id="wallMode">
          <option value="Polygons">Polygons — الموصى به</option>
          <option value="UniformPolygons">UniformPolygons</option>
          <option value="Rectangles">Rectangles</option>
        </select>
      </div>
    </div>
    <div class="warning">كل ملف جديد وفريد قد يستهلك تحليلًا مدفوعًا من المزوّد. الضغط المتكرر على نفس الملف ونفس الإعدادات يعيد نفس النتيجة خلال مدة الحماية بدل بدء تحليل جديد.</div>
    <div class="row">
      <button id="run">تحليل المخطط</button>
      <button id="clear" class="secondary" type="button">مسح النتيجة</button>
    </div>
    <div id="status" class="status"></div>
  </section>

  <section id="resultPanel" class="panel hidden">
    <div class="grid">
      <div>
        <label for="planSelect">الخطة/الطابق المكتشف</label>
        <select id="planSelect"></select>
      </div>
      <div>
        <label>الإصدار</label>
        <div id="version" class="status"></div>
      </div>
    </div>
    <div id="cards" class="cards"></div>
  </section>

  <section id="viewerPanel" class="panel hidden">
    <div class="toolbar">
      <label><input id="showWalls" type="checkbox" checked /> الجدران</label>
      <label><input id="showRooms" type="checkbox" checked /> الغرف</label>
      <label><input id="showOpenings" type="checkbox" checked /> الفتحات</label>
      <label><input id="showLabels" type="checkbox" checked /> أسماء الغرف</label>
    </div>
    <div class="viewer"><canvas id="canvas"></canvas></div>
    <div class="muted" style="margin-top:8px">الـOverlay مرسوم من Canonical Geometry الناتج من المحرك فوق نفس المخطط.</div>
  </section>

  <section id="detailsPanel" class="panel hidden">
    <div id="qualityText"></div>
    <div class="row">
      <button id="download" class="secondary" type="button">تنزيل JSON</button>
    </div>
    <details>
      <summary>عرض JSON الكامل</summary>
      <pre id="json"></pre>
    </details>
  </section>
</main>
<script type="module">
const $ = (id) => document.getElementById(id);
const keyInput = $("key");
const fileInput = $("file");
const runButton = $("run");
const clearButton = $("clear");
const status = $("status");
const resultPanel = $("resultPanel");
const viewerPanel = $("viewerPanel");
const detailsPanel = $("detailsPanel");
const planSelect = $("planSelect");
const canvas = $("canvas");
const ctx = canvas.getContext("2d");
let currentResult = null;
let backgroundImage = null;
let prepared = null;

keyInput.value = localStorage.getItem("bayti-core-lab-key") || "";
keyInput.addEventListener("change", () => localStorage.setItem("bayti-core-lab-key", keyInput.value.trim()));

function setStatus(text, kind = "") {
  status.textContent = text;
  status.className = "status " + kind;
}

function bytesToBase64(bytes) {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + step, bytes.length)));
  }
  return btoa(binary);
}

function dataUrlBase64(dataUrl) {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("تعذر قراءة صورة المخطط."));
    img.src = url;
  });
}

async function sha256Hex(bytes, suffix) {
  const suffixBytes = new TextEncoder().encode(suffix);
  const merged = new Uint8Array(bytes.byteLength + suffixBytes.byteLength);
  merged.set(bytes, 0);
  merged.set(suffixBytes, bytes.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", merged));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function prepareImage(file, bytes) {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const backgroundDataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(file);
    });
    return {
      fileName: file.name,
      fileBase64: bytesToBase64(bytes),
      fileMimeType: file.type || "image/jpeg",
      sourceImage: { widthPx: img.naturalWidth, heightPx: img.naturalHeight, mimeType: file.type || "image/jpeg" },
      replicateImageBase64: undefined,
      replicateImageMimeType: undefined,
      backgroundDataUrl,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function preparePdf(file, bytes) {
  setStatus("جاري تجهيز صفحة PDF للفحص المستقل…");
  let pdfjs;
  try {
    pdfjs = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";
  } catch {
    throw new Error("تعذر تحميل قارئ PDF للمختبر. حوّل الصفحة إلى JPG/PNG مؤقتًا.");
  }
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  if (doc.numPages !== 1) {
    throw new Error("المختبر الحالي يقبل PDF من صفحة واحدة فقط. افصل الصفحة المطلوبة أو ارفعها JPG/PNG.");
  }
  const page = await doc.getPage(1);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(2.2, Math.max(1.2, 1800 / Math.max(baseViewport.width, 1)));
  const viewport = page.getViewport({ scale });
  const temp = document.createElement("canvas");
  temp.width = Math.max(1, Math.round(viewport.width));
  temp.height = Math.max(1, Math.round(viewport.height));
  const tempCtx = temp.getContext("2d", { alpha: false });
  await page.render({ canvasContext: tempCtx, viewport }).promise;
  const backgroundDataUrl = temp.toDataURL("image/jpeg", 0.92);
  return {
    fileName: file.name,
    fileBase64: bytesToBase64(bytes),
    fileMimeType: "application/pdf",
    sourceImage: { widthPx: temp.width, heightPx: temp.height, mimeType: "image/jpeg" },
    replicateImageBase64: dataUrlBase64(backgroundDataUrl),
    replicateImageMimeType: "image/jpeg",
    backgroundDataUrl,
  };
}

async function prepareSelectedFile() {
  const file = fileInput.files?.[0];
  if (!file) throw new Error("اختر مخططًا أولًا.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("الملف فارغ.");
  const lowerType = (file.type || "").toLowerCase();
  if (lowerType.includes("pdf") || file.name.toLowerCase().endsWith(".pdf")) return preparePdf(file, bytes);
  if (lowerType.includes("jpeg") || lowerType.includes("jpg") || lowerType.includes("png")) return prepareImage(file, bytes);
  throw new Error("ارفع JPG أو PNG أو PDF فقط.");
}

function qualityClass(statusValue) {
  return statusValue === "pass" ? "pass" : statusValue === "blocked" ? "blocked" : "review";
}

function selectedIndex() {
  const parsed = Number.parseInt(planSelect.value || "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function summaryCard(label, value, cls = "") {
  return '<div class="card"><span class="muted">' + label + '</span><b class="' + cls + '">' + value + '</b></div>';
}

function renderSummary() {
  if (!currentResult) return;
  const index = selectedIndex();
  const plan = currentResult.plans[index];
  const contract = currentResult.renderContracts[index];
  if (!plan || !contract) return;
  const quality = contract.quality;
  $("cards").innerHTML = [
    summaryCard("الجدران", plan.walls.length),
    summaryCard("الفتحات", plan.openings.length),
    summaryCard("الغرف", plan.rooms.length),
    summaryCard("فتحات جاهزة للقص", contract.openings.length),
    summaryCard("الجودة", quality.status.toUpperCase(), qualityClass(quality.status)),
  ].join("");
  const metrics = quality.metrics || {};
  const blockers = quality.blockers || [];
  const warnings = quality.warnings || [];
  $("qualityText").innerHTML =
    '<b class="' + qualityClass(quality.status) + '">Quality: ' + quality.status.toUpperCase() + '</b>' +
    '<div class="muted" style="margin-top:8px">Host coverage: ' + Math.round((metrics.openingHostCoverage || 0) * 100) +
    '% · Wall confirmation: ' + Math.round((metrics.wallConfirmationRate || 0) * 100) +
    '% · Opening confirmation: ' + Math.round((metrics.openingConfirmationRate || 0) * 100) + '%</div>' +
    (blockers.length ? '<p><b>Blockers:</b><br>' + blockers.map((x) => '• ' + x).join('<br>') + '</p>' : '') +
    (warnings.length ? '<p><b>Warnings:</b><br>' + warnings.map((x) => '• ' + x).join('<br>') + '</p>' : '');
}

function drawPolygon(points, fill, stroke, width = 2) {
  if (!points?.length) return;
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = p.x * canvas.width;
    const y = p.y * canvas.height;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke(); }
}

function drawOverlay() {
  if (!currentResult || !backgroundImage || !prepared) return;
  const index = selectedIndex();
  const plan = currentResult.plans[index];
  if (!plan) return;
  const maxWidth = 1800;
  const ratio = Math.min(1, maxWidth / prepared.sourceImage.widthPx);
  canvas.width = Math.max(1, Math.round(prepared.sourceImage.widthPx * ratio));
  canvas.height = Math.max(1, Math.round(prepared.sourceImage.heightPx * ratio));
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(backgroundImage, 0, 0, canvas.width, canvas.height);

  if ($("showRooms").checked) {
    for (const room of plan.rooms) drawPolygon(room.polygon, "rgba(75, 180, 255, .08)", "rgba(75, 180, 255, .75)", 2);
  }
  if ($("showWalls").checked) {
    for (const wall of plan.walls) drawPolygon(wall.footprint, "rgba(255, 80, 80, .13)", "rgba(255, 70, 70, .92)", 2.5);
  }
  if ($("showOpenings").checked) {
    for (const opening of plan.openings) {
      ctx.beginPath();
      ctx.moveTo(opening.centerLine.start.x * canvas.width, opening.centerLine.start.y * canvas.height);
      ctx.lineTo(opening.centerLine.end.x * canvas.width, opening.centerLine.end.y * canvas.height);
      ctx.strokeStyle = opening.kind === "window" ? "#5df2ce" : "#ffe169";
      ctx.lineWidth = 4;
      ctx.stroke();
    }
  }
  if ($("showLabels").checked) {
    ctx.font = Math.max(12, Math.round(canvas.width / 95)) + "px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const room of plan.rooms) {
      if (!room.polygon?.length) continue;
      const cx = room.polygon.reduce((sum, p) => sum + p.x, 0) / room.polygon.length;
      const cy = room.polygon.reduce((sum, p) => sum + p.y, 0) / room.polygon.length;
      const text = room.label || room.id;
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(0,0,0,.8)";
      ctx.strokeText(text, cx * canvas.width, cy * canvas.height);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(text, cx * canvas.width, cy * canvas.height);
    }
  }
}

function renderResult() {
  if (!currentResult) return;
  resultPanel.classList.remove("hidden");
  viewerPanel.classList.remove("hidden");
  detailsPanel.classList.remove("hidden");
  $("version").textContent = "Core " + currentResult.engineVersion + " · Tectly project " + currentResult.tectlyProjectId;
  planSelect.innerHTML = currentResult.plans.map((p, i) => '<option value="' + i + '">Plan ' + (i + 1) + ' — ' + p.walls.length + ' جدار · ' + p.openings.length + ' فتحة · ' + p.rooms.length + ' غرفة</option>').join("");
  $("json").textContent = JSON.stringify(currentResult, null, 2);
  renderSummary();
  drawOverlay();
}

async function runAnalysis() {
  const key = keyInput.value.trim();
  if (!key) throw new Error("أدخل رمز دخول المختبر.");
  localStorage.setItem("bayti-core-lab-key", key);
  prepared = await prepareSelectedFile();
  backgroundImage = await loadImage(prepared.backgroundDataUrl);
  const fileBytes = new Uint8Array(await fileInput.files[0].arrayBuffer());
  const verifierMode = $("verifier").value;
  const wallTracingMode = $("wallMode").value;
  const digest = await sha256Hex(fileBytes, "|" + verifierMode + "|" + wallTracingMode);
  const idempotencyKey = "lab-" + digest.slice(0, 48);
  const body = {
    fileName: prepared.fileName,
    fileBase64: prepared.fileBase64,
    fileMimeType: prepared.fileMimeType,
    sourceImage: prepared.sourceImage,
    wallTracingMode,
    verifierMode,
  };
  if (prepared.replicateImageBase64) {
    body.replicateImageBase64 = prepared.replicateImageBase64;
    body.replicateImageMimeType = prepared.replicateImageMimeType;
  }

  setStatus("جاري التحليل… لا تغلق الصفحة أثناء الطلب.");
  runButton.disabled = true;
  try {
    const response = await fetch("/lab/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bayti-lab-key": key,
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.message || json.error || ("HTTP " + response.status));
    currentResult = json;
    setStatus(response.headers.get("x-idempotency-replayed") === "true" ? "تم — أعيدت نتيجة محفوظة بدون تحليل مدفوع جديد." : "تم التحليل بنجاح.", "pass");
    renderResult();
  } finally {
    runButton.disabled = false;
  }
}

runButton.addEventListener("click", () => runAnalysis().catch((error) => setStatus(error?.message || String(error), "blocked")));
clearButton.addEventListener("click", () => {
  currentResult = null; prepared = null; backgroundImage = null;
  resultPanel.classList.add("hidden"); viewerPanel.classList.add("hidden"); detailsPanel.classList.add("hidden");
  setStatus("");
});
planSelect.addEventListener("change", () => { renderSummary(); drawOverlay(); });
for (const id of ["showWalls", "showRooms", "showOpenings", "showLabels"]) $(id).addEventListener("change", drawOverlay);
$("download").addEventListener("click", () => {
  if (!currentResult) return;
  const blob = new Blob([JSON.stringify(currentResult, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "bayti-core-result.json"; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
</script>
</body>
</html>`;
}
