<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>answer-site</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; background:#0b0f14; color:#e8eef6; }
    .wrap { max-width: 960px; margin: 0 auto; padding: 16px 14px 40px; }
    .card { background:#0f1622; border:1px solid rgba(255,255,255,.08); border-radius: 16px; padding: 14px; box-shadow: 0 10px 30px rgba(0,0,0,.25); }
    .row { display:flex; gap:10px; flex-wrap: wrap; align-items: center; }
    .btn {
      border: 0; border-radius: 999px; padding: 12px 16px; font-weight: 700;
      background:#2b79ff; color:white; cursor:pointer;
    }
    .btn.secondary { background:#22314a; }
    .btn:disabled { opacity:.55; cursor:not-allowed; }
    label { opacity:.85; font-size: 14px; }
    input[type="number"]{
      width: 84px; padding: 10px 12px; border-radius: 12px;
      border:1px solid rgba(255,255,255,.12); background:#0b0f14; color:#e8eef6;
      font-size: 16px;
    }
    .hint { opacity:.75; font-size: 13px; line-height: 1.4; }
    .title { font-size: 18px; font-weight: 800; margin: 0 0 8px; }

    /* ✅ 프리뷰 박스 크게 */
    .previewBox{
      margin-top: 12px;
      border-radius: 18px;
      overflow: hidden;
      border:1px solid rgba(255,255,255,.10);
      background:#000;
      height: 70vh; /* 핵심 */
      min-height: 420px;
      display:flex; align-items:center; justify-content:center;
      position: relative;
    }
    video { width:100%; height:100%; object-fit: contain; background:#000; }
    canvas { display:none; }
    .overlayInfo{
      position:absolute; left:10px; bottom:10px;
      background: rgba(0,0,0,.55); padding: 8px 10px; border-radius: 12px;
      font-size: 12px; line-height: 1.35;
      border:1px solid rgba(255,255,255,.12);
      max-width: calc(100% - 20px);
      white-space: pre-wrap;
    }

    .log { margin-top: 14px; padding: 12px; background:#0b0f14; border:1px solid rgba(255,255,255,.10); border-radius: 14px; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; }
    textarea{
      width: 100%;
      min-height: 180px;
      resize: vertical;
      padding: 12px;
      border-radius: 14px;
      border:1px solid rgba(255,255,255,.12);
      background:#0b0f14;
      color:#e8eef6;
      font-size: 13px;
      line-height: 1.45;
      box-sizing: border-box;
    }
    .sectionTitle { margin: 16px 0 8px; font-size: 16px; font-weight: 800; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1 class="title">카메라</h1>

      <div class="row">
        <button id="startBtn" class="btn">카메라 시작</button>
        <button id="shotBtn" class="btn secondary" disabled>현재 페이지 촬영</button>

        <label style="margin-left:6px;">현재 페이지</label>
        <input id="pageInput" type="number" min="1" value="1" />
      </div>

      <div class="previewBox" id="previewBox">
        <video id="video" playsinline muted></video>
        <div class="overlayInfo" id="overlayInfo">해상도: -</div>
      </div>

      <div class="hint" style="margin-top:10px;">
        ① 시험지를 화면에 꽉 채우고<br/>
        ② 글자/문항번호/보기까지 선명하게 보이게 맞춘 뒤<br/>
        ③ “현재 페이지 촬영” → OCR → 정답 생성 순서로 진행.
      </div>

      <div class="sectionTitle">로그</div>
      <div class="log"><pre id="log"></pre></div>

      <div class="sectionTitle">OCR 원문 확인</div>
      <div class="hint">여기에서 OCR이 얼마나 제대로 뽑혔는지 즉시 확인해. (정답률 90%의 핵심)</div>
      <textarea id="ocrTextArea" placeholder="촬영하면 OCR 결과가 여기에 표시돼."></textarea>
    </div>
  </div>

  <script>
    const video = document.getElementById('video');
    const startBtn = document.getElementById('startBtn');
    const shotBtn = document.getElementById('shotBtn');
    const pageInput = document.getElementById('pageInput');
    const logEl = document.getElementById('log');
    const ocrTextArea = document.getElementById('ocrTextArea');
    const overlayInfo = document.getElementById('overlayInfo');

    let stream = null;

    function now() {
      const d = new Date();
      const hh = String(d.getHours()).padStart(2,'0');
      const mm = String(d.getMinutes()).padStart(2,'0');
      const ss = String(d.getSeconds()).padStart(2,'0');
      return `${hh}:${mm}:${ss}`;
    }
    function log(msg) {
      logEl.textContent += `[${now()}] ${msg}\n`;
      logEl.scrollTop = logEl.scrollHeight;
    }

    async function startCamera() {
      log('STATUS: 카메라를 켜고, 페이지 1부터 한 페이지씩 촬영해.');

      // ✅ iPhone에서 고해상도 먼저 시도 → 실패하면 fallback
      const tries = [
        {
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width:  { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30 }
          }
        },
        {
          audio: false,
          video: {
            facingMode: { ideal: 'environment' }
          }
        }
      ];

      let lastErr = null;

      for (const constraints of tries) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
          break;
        } catch (e) {
          lastErr = e;
          stream = null;
        }
      }

      if (!stream) {
        log('STATUS: 카메라 시작 실패');
        alert('카메라 권한/설정을 확인해줘. 에러: ' + (lastErr && lastErr.message ? lastErr.message : String(lastErr)));
        return;
      }

      video.srcObject = stream;
      await video.play();

      // ✅ 스트림 시작 후 한 번 더 고해상도 적용 시도
      try {
        const track = stream.getVideoTracks()[0];
        if (track && track.applyConstraints) {
          await track.applyConstraints({ width: { ideal: 1920 }, height: { ideal: 1080 } });
        }
      } catch (_) {}

      shotBtn.disabled = false;
      log('STATUS: 카메라가 켜졌어. 시험지를 화면에 꽉 차게 맞춰줘.');

      updateOverlay();
      video.addEventListener('loadedmetadata', updateOverlay);
      setInterval(updateOverlay, 1000);
    }

    function updateOverlay(){
      const w = video.videoWidth || 0;
      const h = video.videoHeight || 0;
      overlayInfo.textContent =
        `해상도: ${w} x ${h}\n` +
        `팁: 해상도가 1280x720 이상이면 OCR 정확도 확 올라감`;
    }

    function captureDataURL() {
      const vw = video.videoWidth;
      const vh = video.videoHeight;

      if (!vw || !vh) {
        throw new Error('Video metadata not ready');
      }

      // ✅ “원본 해상도”로 캡처
      const canvas = document.createElement('canvas');
      canvas.width = vw;
      canvas.height = vh;
      const ctx = canvas.getContext('2d', { willReadFrequently: false });
      ctx.drawImage(video, 0, 0, vw, vh);

      // jpeg 0.92 (너무 낮추면 OCR 망함)
      const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      return { dataUrl, width: vw, height: vh, length: dataUrl.length };
    }

    async function callOCR(page, dataUrl) {
      const res = await fetch('/.netlify/functions/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // ✅ ocr.js가 기대하는 형태 그대로
        body: JSON.stringify({ page, image: dataUrl })
      });
      return res.json();
    }

    async function callSolve(page, ocrText) {
      const res = await fetch('/.netlify/functions/solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page, ocrText })
      });
      return res.json();
    }

    async function shootOnce(){
      const page = Number(pageInput.value || 1);

      try {
        log(`STATUS: 페이지 ${page} 촬영 중... 시험지를 흔들리지 않게 잡고 있어줘.`);
        const cap = captureDataURL();
        log(`capture size ${JSON.stringify({ width: cap.width, height: cap.height, length: cap.length })}`);

        log('STATUS: OCR 처리 중...');
        const ocr = await callOCR(page, cap.dataUrl);
        log(`OCR response ${JSON.stringify(ocr).slice(0, 1800)}`);

        if (!ocr.ok) {
          log(`STATUS: OCR 실패: ${ocr.error || 'Unknown'}${ocr.detail ? ' / ' + ocr.detail : ''}`);
          return;
        }

        // OCR 원문 표시
        ocrTextArea.value = ocr.text || '';

        log(`STATUS: OCR 완료 (번호 패턴 수: ${ocr.hits || 0}). 이제 정답을 생성할게.`);
        const solved = await callSolve(page, ocr.text || '');
        log(`solve response ${JSON.stringify(solved).slice(0, 1800)}`);

        if (!solved.ok) {
          log(`STATUS: solve 실패: ${solved.error || 'Unknown'}`);
          return;
        }

        log(`STATUS: 페이지 ${page} 정답을 생성했어. XURTH가 들리면 이 페이지는 끝이야.`);
      } catch (e) {
        log(`STATUS: 예외 발생: ${e && e.message ? e.message : String(e)}`);
      }
    }

    startBtn.addEventListener('click', startCamera);
    shotBtn.addEventListener('click', shootOnce);
  </script>
</body>
</html>
