/* =========================================================================
 * Captura + postprocesado
 * -------------------------------------------------------------------------
 * Frontend sin dependencias. Flujo:
 *   1. Abre la cámara trasera (getUserMedia) y muestra el vídeo a pantalla
 *      completa con un marco guía tipo lector de QR.
 *   2. Al pulsar el disparador recorta el fotograma (según CONFIG.captureMode)
 *      y lo convierte a JPEG con un <canvas>.
 *   3. Envía el JPEG por POST multipart/form-data al endpoint configurado.
 *   4. Pinta la imagen devuelta por el servidor junto a sus metadatos.
 * ========================================================================= */
(() => {
  'use strict';

  /* -----------------------------------------------------------------------
   * CONFIGURACIÓN — ajusta aquí lo básico de tu integración
   * --------------------------------------------------------------------- */
  const CONFIG = {
    /** Endpoint que recibe la imagen. Se puede sobrescribir con ?endpoint=… */
    endpoint: '/api/process',

    /** Nombre del campo del archivo en el formulario multipart. */
    fieldName: 'image',

    /**
     * Qué se envía al servidor:
     *   'frame' → solo el área del marco guía (lo que ve el usuario)
     *   'full'  → el fotograma completo de la cámara
     */
    captureMode: 'frame',

    /** Calidad del JPEG resultante (0–1). */
    jpegQuality: 0.92,

    /** Resolución que se pide a la cámara (orientativa, el navegador decide). */
    idealWidth: 1920,
    idealHeight: 1080,

    /** Tiempo máximo de espera del postprocesado, en ms. */
    timeoutMs: 30000,

    /** Mostrar en pantalla la respuesta completa del servidor (JSON). */
    debug: true,

    /* ---------------------------------------------------------------------
     * Análisis del encuadre en tiempo real (nítidez + chapa metálica).
     * Todo se calcula en el cliente sobre un canvas diminuto: no hay
     * dependencias externas ni envío de datos al servidor.
     *
     * Umbrales calibrados con 24 fotos reales de la chapa (las del banco de
     * pruebas), midiendo bandas 4:1 equivalentes al marco, primero en Python y
     * luego verificados en el navegador con la cámara sintética.
     *
     * Colores medidos (0–255 / 0–1):
     *
     *   superficie de la chapa : brillo 60-200 · saturación 0.05-0.35
     *                            calidez (R−B)/max ≈ −0.05…0.35 (neutra/fría)
     *   madera de la mesa      : calidez 0.50-0.85 · saturación 0.55-0.90
     *   piel de la mano        : calidez 0.30-0.50 · brillo ≈100
     *   teclado / camiseta     : brillo 35-50 → fuera por luminancia
     *   papel blanco / pared   : sin textura → fuera por `minDetail`
     *
     * Ojo: el vídeo de la cámara se codifica con croma reducida (4:2:0), así
     * que la chapa —que es neutra— hereda algo del tono cálido de la sala.
     * Por eso `metallicWarmthMax` está en 0.35 y no más bajo: con 0.25 la
     * chapa plateada del banco se colaba por debajo de la cobertura mínima.
     *
     * --- Encuadre: "márgenes ajustados" ---------------------------------
     * Además del color, el detector exige que la chapa **llene** el marco
     * como en la foto de referencia `Imagen Chapa correcta.jpg` (1494×373,
     * exactamente 4:1, con la chapa a 4.19:1 y márgenes de apenas 4-8 %).
     *
     * Medido en el navegador escalando esa foto dentro del marco (1.00 = tal
     * cual, como la referencia):
     *
     *   encuadre  cobertura  columnas   veredicto
     *   1.10        0.83       0.99      LISTA
     *   1.00        0.74       0.93      LISTA   ← la referencia
     *   0.95        0.67       0.88      LISTA
     *   0.90        0.60       0.82      LISTA
     *   0.85        0.54       0.77      NO_PLATE
     *   0.80        0.48       0.72      NO_PLATE
     *   0.70        0.36       0.59      NO_PLATE
     *
     * Con `minCoverageRatio` 0.57 y `minColumnRatio` 0.78 se acepta la chapa
     * si llena al menos el ~86 % del encuadre de referencia, y se rechaza por
     * debajo. Desplazada un 15 % (sigue siendo la misma chapa a tamaño
     * completo) da cobertura 0.64-0.66 y pasa; desplazada un 25 % en vertical
     * se sale del marco y da 0.54 → NO_PLATE.
     *
     * --- Rendimiento con el banco --------------------------------------
     * (13 fotos con la chapa bien encuadradas y 13 fondos):
     *   chapa con luz y encuadrada  : 13/13 → LISTA
     *     cobertura 0.44-0.85 · columnas 0.47-0.99 · nitidez 1.8-2.9
     *   madera, teclado, piel, pared: cobertura ≤0.36 → NO_PLATE
     *   chapa a contraluz o girada  : cobertura ≤0.38 → NO_PLATE (a propósito)
     *   papel blanco y superficies grises lisas: siguen colándose (sin color
     *     no hay más información): es el precio de no exigir la pieza exacta.
     *
     * Si cambias de pieza o de iluminación, ajusta sobre todo
     * `metallicWarmthMax`, `minCoverageRatio` y `minColumnRatio`.
     * ------------------------------------------------------------------- */
    analysis: {
      /** Interruptor general del análisis y del bloqueo del disparador. */
      enabled: true,

      /**
       * Ancho en píxeles del canvas de análisis. La altura se deduce de la
       * proporción real del recorte, así que con el marco 4:1 sale 320 × 80.
       * Más resolución distingue mejor el desenfoque; a cambio, algo más de CPU.
       */
      sampleWidth: 320,

      /** Frecuencia del analizador. Por encima de ~15 fps no aporta nada. */
      fps: 15,

      /* --- Perfil de color de la chapa metálica ------------------------- */

      /** Saturación máxima (0–1) para considerar un píxel "metálico". */
      metallicSaturationMax: 0.5,

      /** Rango de luminancia (0–255) del metal. El máximo descarta brillos. */
      metallicLuminanceMin: 55,
      metallicLuminanceMax: 245,

      /**
       * Calidez máxima admitida: (R − B) / max(R, G, B).
       * El metal de esta chapa es frío/neutro; la madera (0.5-0.85), la piel
       * y el óxido (>0.30) quedan descartados. No bajar de 0.30: el vídeo
       * tiñe de cálido la chapa al reducir el croma.
       */
      metallicWarmthMax: 0.35,

      /* --- Posicionamiento de la chapa dentro del marco ----------------- */

      /**
       * Cobertura mínima de píxeles metálicos dentro del marco (0–1).
       * Exige la chapa "llena" como en la foto de referencia: con 0.55 se
       * acepta si llena ~86 % del encuadre de referencia (0.74 de cobertura)
       * y se rechaza por debajo.
       */
      minCoverageRatio: 0.7,

      /** Cobertura mínima exigida en cada columna del marco (0–1). */
      minColumnCoverage: 0.55,

      /**
       * Fracción mínima de columnas que deben superar la anterior (0–1).
       * Con 0.78 la chapa debe recorrer casi todo el ancho del marco.
       */
      minColumnRatio: 0.78,

      /* --- Nitidez (anti-borrosidad) ------------------------------------ */

      /**
       * Nitidez mínima: media del laplaciano (curvatura) ÷ media de las
       * diferencias horizontales. Al normalizar, el índice no depende del
       * contraste ni de la escena. Medido en el navegador con las fotos
       * reales: chapa enfocada 1.8-2.9 · desenfoque leve <1.7.
       */
      sharpnessThreshold: 1.35,

      /**
       * Detalle mínimo (media absoluta del laplaciano). Descarta escenas
       * planas o sin textura (papel, pared): la chapa con letras troqueladas
       * da 6-43; el papel blanco liso, 1-3.
       */
      minDetail: 2.5,

      /* --- Comportamiento ----------------------------------------------- */

      /** Fotogramas seguidos con el mismo veredicto antes de publicarlo. */
      stableFrames: 2,

      /** Disparo automático al mantenerse listo N fotogramas seguidos. */
      autoCapture: false,

      /** Fotogramas consecutivos válidos para la autocaptura (~1/3 s a 15 fps). */
      autoCaptureFrames: 5,

      /**
       * Permite disparar a mano aunque el análisis no esté conforme.
       * Con `false` el disparador queda realmente bloqueado.
       */
      allowOverride: false,
    },
  };

  const STORAGE_KEY = 'captura.endpoint';
  const AUTO_KEY = 'captura.autocapture';

  /** La captura solo se permite con el dispositivo apaisado (móvil/tableta). */
  const portraitQuery = window.matchMedia('(orientation: portrait) and (pointer: coarse)');
  const isRotationBlocked = () => portraitQuery.matches;

  /* -----------------------------------------------------------------------
   * Utilidades
   * --------------------------------------------------------------------- */
  const $ = (id) => document.getElementById(id);
  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

  /** 512 → "512 B" · 219 → "219 B" · 48230 → "47 KB" */
  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /** Dimensiones de un archivo de imagen, sin subirlo al servidor. */
  async function measureImage(file) {
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(file);
        const size = { width: bitmap.width, height: bitmap.height };
        bitmap.close?.();
        return size;
      } catch { /* probamos con <img> */ }
    }
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
        URL.revokeObjectURL(url);
      };
      img.onerror = () => { resolve({ width: 0, height: 0 }); URL.revokeObjectURL(url); };
      img.src = url;
    });
  }

  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* modo privado */ } },
  };

  /** Error de cámara con mensaje ya listo para mostrar al usuario. */
  class CameraError extends Error {
    constructor(message, cause) {
      super(message);
      this.name = 'CameraError';
      this.cause = cause;
    }
  }

  /** Canal de eventos hacia la página anfitriona → window.captura.on(fn) */
  const bus = {
    listeners: [],
    on(fn) { this.listeners.push(fn); },
    emit(name, detail) {
      for (const fn of this.listeners) {
        try { fn(name, detail); } catch { /* no romper el flujo por un listener */ }
      }
    },
  };

  /* -----------------------------------------------------------------------
   * Referencias del DOM
   * --------------------------------------------------------------------- */
  const els = {
    app: $('app'),
    viewport: $('viewport'),
    video: $('video'),
    frame: $('frame'),
    status: $('status'),
    analysis: $('analysis'),
    analysisText: $('analysisText'),
    analysisMetrics: $('analysisMetrics'),
    notice: $('notice'),
    noticeSpinner: $('noticeSpinner'),
    noticeText: $('noticeText'),
    btnRetry: $('btnRetry'),
    btnFile: $('btnFile'),
    processing: $('processing'),
    processingHint: $('processingHint'),
    btnCapture: $('btnCapture'),
    btnSwitch: $('btnSwitch'),
    btnAuto: $('btnAuto'),
    btnTorch: $('btnTorch'),
    btnFullscreen: $('btnFullscreen'),
    fileInput: $('fileInput'),
    result: $('result'),
    resultImage: $('resultImage'),
    resultMeta: $('resultMeta'),
    btnNew: $('btnNew'),
    btnDownload: $('btnDownload'),
    endpointInput: $('endpointInput'),
    btnSaveEndpoint: $('btnSaveEndpoint'),
    toast: $('toast'),
  };

  /* -----------------------------------------------------------------------
   * Estado del módulo
   * --------------------------------------------------------------------- */
  let stream = null;
  let track = null;
  let cameras = [];
  let cameraIndex = 0;
  let facingMode = 'environment';
  let torchOn = false;
  let busy = false;
  let resultObjectUrl = null;
  let toastTimer = null;

  /* -----------------------------------------------------------------------
   * Endpoint configurable (?endpoint=… > localStorage > por defecto)
   * --------------------------------------------------------------------- */
  (function resolveEndpoint() {
    const fromUrl = new URLSearchParams(location.search).get('endpoint');
    const saved = storage.get(STORAGE_KEY);
    if (fromUrl) {
      CONFIG.endpoint = fromUrl;
      storage.set(STORAGE_KEY, fromUrl);
    } else if (saved) {
      CONFIG.endpoint = saved;
    }
    els.endpointInput.value = CONFIG.endpoint;
  })();

  /* La última elección de autocaptura del usuario manda sobre el valor por defecto. */
  (function resolveAutocapture() {
    const saved = storage.get(AUTO_KEY);
    if (saved !== null) CONFIG.analysis.autoCapture = saved === 'true';
  })();

  /* -----------------------------------------------------------------------
   * Interfaz: estados, avisos y toasts
   * --------------------------------------------------------------------- */
  function setState(state) {
    els.app.dataset.state = state;
    // El analizador solo tiene sentido mientras se puede disparar: fuera de
    // 'ready' se detiene y se limpia el feedback para no dejar el marco en
    // verde con información vieja.
    if (state === 'ready') analyzer.start();
    else analyzer.reset();
  }

  function setStatus(text) { els.status.textContent = text; }

  function showNotice(text, { spinner = false, retry = false, file = false } = {}) {
    els.noticeText.textContent = text;
    els.noticeSpinner.hidden = !spinner;
    els.btnRetry.hidden = !retry;
    els.btnFile.hidden = !file;
    els.notice.hidden = false;
  }

  function hideNotice() { els.notice.hidden = true; }

  /**
   * El disparador solo está activo con cámara lista, sin trabajo en curso, en
   * horizontal y —si el análisis está activo— con el encuadre validado.
   * Si `analysis.allowOverride` está activado, se deja pulsar para forzar.
   */
  function syncShutter() {
    const unavailable = Boolean(busy || !stream || isRotationBlocked());
    const { blocked } = analysisGate();
    const canForce = blocked && !unavailable && CONFIG.analysis.allowOverride;

    els.btnCapture.disabled = unavailable || (blocked && !CONFIG.analysis.allowOverride);
    els.btnCapture.classList.toggle('is-gated', canForce);
  }

  /** Estado del bloqueo por análisis, listo para decidir y para avisar. */
  function analysisGate() {
    const blocked = analyzer.blocked();
    return { blocked, hint: blocked ? analyzer.hint() : '' };
  }

  function showToast(message, kind = 'info', ms = 5000) {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.className = `toast is-${kind}`;
    els.toast.hidden = false;
    requestAnimationFrame(() => els.toast.classList.add('is-visible'));
    if (ms > 0) {
      toastTimer = setTimeout(hideToast, ms);
    }
  }

  function hideToast() {
    els.toast.classList.remove('is-visible');
    setTimeout(() => { els.toast.hidden = true; }, 220);
  }

  /* -----------------------------------------------------------------------
   * Cámara
   * --------------------------------------------------------------------- */
  async function listCameras() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  }

  function stopStream() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
      track = null;
    }
  }

  async function startCamera({ deviceId } = {}) {
    if (busy) return;
    stopStream();
    torchOn = false;
    els.btnTorch.classList.remove('is-on');

    const secure = window.isSecureContext;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraError(
        secure
          ? 'Este navegador no permite usar la cámara desde la página.'
          : 'La cámara necesita HTTPS (o localhost). Abre la página por https:// e inténtalo de nuevo.'
      );
    }

    setState('starting');
    els.btnCapture.disabled = true;
    showNotice('Iniciando cámara…', { spinner: true });

    const video = {
      width: { ideal: CONFIG.idealWidth },
      height: { ideal: CONFIG.idealHeight },
    };
    if (deviceId) {
      video.deviceId = { exact: deviceId };
    } else {
      video.facingMode = { ideal: facingMode };
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
    } catch (error) {
      throw new CameraError(describeCameraError(error), error);
    }

    els.video.srcObject = stream;
    try {
      await els.video.play();
    } catch (error) {
      if (error?.name !== 'AbortError') {
        throw new CameraError('No se pudo iniciar la previsualización de la cámara.', error);
      }
    }

    track = stream.getVideoTracks()[0] || null;

    // Preparar vigilancia de fin de pista (cámara tomada por otra app, etc.)
    if (track) {
      track.addEventListener('ended', () => {
        setState('error');
        els.btnCapture.disabled = true;
        showNotice('Se perdió la señal de la cámara.', { retry: true, file: true });
      });
    }

    // Refrescar la lista de cámaras (los deviceId ya son estables tras el permiso)
    cameras = await listCameras();
    if (deviceId) {
      const found = cameras.findIndex((c) => c.deviceId === deviceId);
      if (found >= 0) cameraIndex = found;
    }
    els.btnSwitch.hidden = cameras.length < 2;

    // Linterna, si el dispositivo la expone
    const caps = track?.getCapabilities?.() || {};
    els.btnTorch.hidden = !caps.torch;

    setState('ready');
    syncShutter();
    hideNotice();

    const label = track?.label ? ` · ${track.label}` : '';
    setStatus(`Cámara lista${label}`);
    bus.emit('camera:ready', { label: track?.label, settings: track?.getSettings?.() });
  }

  function describeCameraError(error) {
    switch (error?.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Permiso de cámara denegado. Actívalo en el navegador y reintenta.';
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'No se ha encontrado ninguna cámara disponible en este dispositivo.';
      case 'NotReadableError':
        return 'La cámara está siendo usada por otra aplicación.';
      default:
        return `No se pudo abrir la cámara${error?.message ? `: ${error.message}` : '.'}`;
    }
  }

  async function handleCameraFailure(error) {
    setState('error');
    els.btnCapture.disabled = true;
    const message = error instanceof CameraError
      ? error.message
      : `Error inesperado al iniciar la cámara${error?.message ? `: ${error.message}` : '.'}`;
    showNotice(message, { retry: true, file: true });
    setStatus('Cámara no disponible');
    showToast(message, 'error', 8000);
    bus.emit('camera:error', { message, error });
  }

  async function cycleCamera() {
    if (cameras.length < 2) return;
    cameraIndex = (cameraIndex + 1) % cameras.length;
    try {
      await startCamera({ deviceId: cameras[cameraIndex].deviceId });
    } catch (error) {
      await handleCameraFailure(error);
    }
  }

  async function toggleTorch() {
    if (!track?.getCapabilities?.().torch) return;
    try {
      torchOn = !torchOn;
      await track.applyConstraints({ advanced: [{ torch: torchOn }] });
      els.btnTorch.classList.toggle('is-on', torchOn);
    } catch (error) {
      torchOn = false;
      els.btnTorch.classList.remove('is-on');
      showToast('Este dispositivo no permite controlar la linterna.', 'error');
    }
  }

  /* -----------------------------------------------------------------------
   * Captura: recorte del fotograma y conversión a JPEG
   * --------------------------------------------------------------------- */
  /**
   * Traduce el rectángulo del marco guía (en píxeles CSS) a coordenadas del
   * fotograma real del vídeo, teniendo en cuenta el `object-fit: cover`.
   */
  function computeCropRect() {
    const vw = els.video.videoWidth;
    const vh = els.video.videoHeight;
    if (!vw || !vh) return null;

    if (CONFIG.captureMode === 'full') {
      return { sx: 0, sy: 0, sw: vw, sh: vh };
    }

    const box = els.viewport.getBoundingClientRect();
    const guide = els.frame.getBoundingClientRect();
    if (!box.width || !box.height) return { sx: 0, sy: 0, sw: vw, sh: vh };

    // Escala y desplazamiento que aplica object-fit: cover
    const scale = Math.max(box.width / vw, box.height / vh);
    const offsetX = (vw * scale - box.width) / 2;
    const offsetY = (vh * scale - box.height) / 2;

    let sx = (guide.left - box.left + offsetX) / scale;
    let sy = (guide.top - box.top + offsetY) / scale;
    let sw = guide.width / scale;
    let sh = guide.height / scale;

    sx = clamp(sx, 0, vw);
    sy = clamp(sy, 0, vh);
    sw = clamp(sw, 16, vw - sx);
    sh = clamp(sh, 16, vh - sy);

    return { sx, sy, sw, sh };
  }

  const canvas = document.createElement('canvas');

  /** Devuelve un Blob JPEG con el fotograma capturado. */
  function grabFrame() {
    const rect = computeCropRect();
    if (!rect) throw new Error('La cámara todavía no está lista.');

    const width = Math.round(rect.sw);
    const height = Math.round(rect.sh);
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(els.video, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, width, height);

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve({ blob, width, height }) : reject(new Error('No se pudo generar el JPEG.'))),
        'image/jpeg',
        CONFIG.jpegQuality
      );
    });
  }

  /* =======================================================================
   * ANÁLISIS DEL ENCUADRE EN TIEMPO REAL
   * -----------------------------------------------------------------------
   * Bucle de requestAnimationFrame a baja frecuencia (CONFIG.analysis.fps)
   * sobre un canvas diminuto (320 × 80 con el marco 4:1), así que el coste
   * por fotograma es despreciable y todo el procesado queda en el cliente.
   *
   * Cada fotograma se resume en cuatro métricas:
   *
   *   · cobertura → fracción de píxeles que parecen chapa metálica.
   *   · columnas  → fracción de columnas del marco con chapa suficiente;
   *                 evita dar por buena una mancha metálica mal encuadrada.
   *   · detalle   → media del laplaciano (energía de bordes).
   *   · nitidez   → detalle ÷ media de las diferencias horizontales. Al
   *                 normalizar, el índice vale ≈2 con la imagen enfocada y
   *                 cae por debajo de 1.4 al desenfocar, sea cual sea la
   *                 escena o el contraste.
   *
   * ¿Qué cuenta como "chapa"? Un píxel frío/neutro y de brillo medio: el
   * metal oxidado de esta pieza es verde-azulado y poco saturado, mientras
   * que la madera, la piel y el óxido del entorno son cálidos y saturados.
   *
   * Estados posibles:
   *   NO_PLATE          falta chapa o está mal encuadrada
   *   BLURRY            hay chapa, pero sin nitidez (movimiento o desenfoque)
   *   READY_TO_CAPTURE  chapa bien posicionada y nítida
   *
   * Nota: una superficie metálica totalmente lisa y uniforme, sin textura ni
   * iluminación que genere gradientes, se lee como BLURRY. Si tu pieza es
   * así, baja `minDetail` y `sharpnessThreshold`.
   * ===================================================================== */
  const STATUS = {
    NO_PLATE: 'NO_PLATE',
    BLURRY: 'BLURRY',
    READY: 'READY_TO_CAPTURE',
  };

  const STATUS_HINTS = {
    NO_PLATE: 'Coloque la chapa dentro del marco',
    BLURRY: 'Mantenga el dispositivo firme…',
    READY_TO_CAPTURE: '¡Posición correcta!',
  };

  /** ¿Este píxel parece chapa metálica? (frío/neutro, sin brillos ni sombras) */
  function isPlatePixel(r, g, b, luma, cfg) {
    const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
    if (max === 0) return false;                        // negro puro
    if (luma < cfg.metallicLuminanceMin) return false;  // sombra / camiseta oscura
    if (luma > cfg.metallicLuminanceMax) return false;  // reflejo deslumbrante
    const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
    if ((max - min) / max > cfg.metallicSaturationMax) return false;  // color vivo
    return (r - b) / max <= cfg.metallicWarmthMax;      // cálido = madera, piel, óxido
  }

  /**
   * Recorre los píxeles del canvas de análisis y devuelve las métricas.
   * Es una función pura (no toca el DOM) para que sea fácil de leer y ajustar.
   *
   * @param {Uint8ClampedArray} data  RGBA del canvas de análisis.
   * @returns {{coverage:number, columnRatio:number, sharpness:number,
   *            detail:number, plateColumns:number, meanLuma:number, pixels:number}}
   */
  function analyzePixels(data, width, height) {
    const cfg = CONFIG.analysis;
    const total = width * height;

    const luma = new Float32Array(total);   // luminancia de cada píxel
    const columns = new Float32Array(width); // píxeles de chapa por columna

    let plate = 0;      // píxeles que parecen chapa
    let lumaSum = 0;    // suma de luminancias

    // --- Pasada 1: luminancia y máscara de chapa -------------------------
    for (let p = 0; p < total; p++) {
      const i = p * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      // Luminancia perceptual (Rec. 709), 0–255
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      luma[p] = l;
      lumaSum += l;

      if (isPlatePixel(r, g, b, l, cfg)) {
        plate++;
        columns[p % width]++;
      }
    }

    // --- Pasada 2: energía de bordes (detalle y nitidez) -----------------
    let edgeSum = 0;   // suma de |ΔL| horizontales
    let edgeCount = 0;
    let lapSum = 0;    // suma del laplaciano de 5 puntos
    let lapCount = 0;

    for (let y = 0; y < height; y++) {
      const row = y * width;

      for (let x = 0; x < width; x++) {
        const i = row + x;

        if (x + 1 < width) {
          edgeSum += Math.abs(luma[i + 1] - luma[i]);
          edgeCount++;
        }

        // Laplaciano: 4·L(x,y) − vecinos. Mide curvatura, no desplazamiento,
        // así que el desenfoque lo reduce mucho más que a las diferencias.
        if (x > 0 && x + 1 < width && y > 0 && y + 1 < height) {
          lapSum += Math.abs(4 * luma[i] - luma[i - 1] - luma[i + 1]
                             - luma[i - width] - luma[i + width]);
          lapCount++;
        }
      }
    }

    const detail = lapCount ? lapSum / lapCount : 0;
    const edge = edgeCount ? edgeSum / edgeCount : 0;

    // --- Cobertura: total y reparto por columnas -------------------------
    let plateColumns = 0;
    for (let x = 0; x < width; x++) {
      if (columns[x] / height >= cfg.minColumnCoverage) plateColumns++;
    }

    return {
      coverage: total ? plate / total : 0,
      columnRatio: width ? plateColumns / width : 0,
      plateColumns,
      // Índice normalizado: independiente del contraste y de la escena
      sharpness: edge > 1e-6 ? detail / edge : (detail > 0 ? 999 : 0),
      detail,
      meanLuma: total ? lumaSum / total : 0,
      pixels: total,
    };
  }

  /** Traduce las métricas a uno de los tres estados del análisis. */
  function classifyFrame(metrics) {
    const cfg = CONFIG.analysis;
    const hasPlate = metrics.coverage >= cfg.minCoverageRatio &&
                     metrics.columnRatio >= cfg.minColumnRatio;
    const isSharp = metrics.sharpness >= cfg.sharpnessThreshold &&
                    metrics.detail >= cfg.minDetail;
    const status = !hasPlate ? STATUS.NO_PLATE : (isSharp ? STATUS.READY : STATUS.BLURRY);
    return { hasPlate, isSharp, status };
  }

  /* ---------------------------------------------------------------------
   * Analizador: bucle, caché de geometría y pintado del feedback
   * ------------------------------------------------------------------- */
  const analyzer = {
    canvas: null,
    ctx: null,
    running: false,
    rafId: 0,
    lastTick: 0,
    lastFrameAt: 0,   // para el "fail-open" si el bucle dejara de dar señales
    frames: 0,
    errorCount: 0,
    failed: false,
    status: null,
    metrics: null,
    streak: 0,        // fotogramas consecutivos en READY_TO_CAPTURE
    pendingStatus: null, // veredicto candidato (antirrebote)
    pending: 0,          // fotogramas seguidos con ese candidato
    epoch: 0,         // se incrementa al cambiar la geometría (resize, giro)
    cache: null,

    /** ¿Debe analizarse? (config activada y sin fallos previos) */
    get enabled() { return CONFIG.analysis.enabled && !this.failed; },

    /**
     * ¿El análisis impide disparar ahora mismo? Si el bucle se ha quedado
     * atascado más de 2 s dejamos pasar, para no dejar la cámara inservible.
     */
    blocked() {
      if (!this.enabled) return false;
      if (this.status === STATUS.READY) return false;
      if (this.lastFrameAt && performance.now() - this.lastFrameAt > 2000) return false;
      return true;
    },

    /** Mensaje que corresponde al estado actual. */
    hint() {
      return STATUS_HINTS[this.status] || STATUS_HINTS.NO_PLATE;
    },

    init() {
      const w = Math.max(16, Math.round(CONFIG.analysis.sampleWidth));
      this.canvas = document.createElement('canvas');
      this.canvas.width = w;
      this.canvas.height = Math.max(8, Math.round(w / 4));
      // `willReadFrequently` mantiene el canvas en memoria para getImageData()
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    },

    start() {
      if (!this.enabled || this.running || !stream) return;
      if (!this.canvas) this.init();
      this.running = true;
      this.streak = 0;
      this.pendingStatus = null;
      this.pending = 0;
      this.lastTick = 0;
      this.lastFrameAt = 0;
      this.rafId = requestAnimationFrame((t) => this.tick(t));
    },

    stop() {
      if (!this.running) return;
      this.running = false;
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    },

    /** Detiene el bucle y limpia el feedback visual. */
    reset() {
      this.stop();
      this.status = null;
      this.metrics = null;
      this.streak = 0;
      this.pendingStatus = null;
      this.pending = 0;
      this.paint();
    },

    tick(ts) {
      if (!this.running) return;
      this.rafId = requestAnimationFrame((t) => this.tick(t));

      // Limitamos la frecuencia: analizar en cada frame no aporta nada nuevo.
      if (ts - this.lastTick < 1000 / CONFIG.analysis.fps) return;
      this.lastTick = ts;

      try {
        const metrics = this.sample();
        if (metrics) this.publish(metrics);
        this.errorCount = 0;
      } catch (error) {
        // Un error puntual se ignora; tres seguidos desactivan el análisis.
        if (++this.errorCount >= 3) this.fail(error);
      }
    },

    /**
     * Recorte del marco en coordenadas del vídeo, con caché para no medir el
     * DOM en cada fotograma (getBoundingClientRect fuerza recálculo de layout).
     */
    cropRect() {
      const vw = els.video.videoWidth;
      const vh = els.video.videoHeight;
      if (!vw || !vh) return null;

      const cached = this.cache;
      if (cached && cached.vw === vw && cached.vh === vh && cached.epoch === this.epoch) {
        return cached.rect;
      }

      const rect = computeCropRect();
      if (!rect) return null;

      // El canvas de análisis sigue la proporción real del recorte
      const w = Math.max(16, Math.round(CONFIG.analysis.sampleWidth));
      const h = Math.max(8, Math.round(w * (rect.sh / rect.sw)));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }

      this.cache = { vw, vh, epoch: this.epoch, rect };
      return rect;
    },

    /** Toma un fotograma del marco y devuelve sus métricas (o null). */
    sample() {
      const rect = this.cropRect();
      if (!rect) return null;

      const { canvas, ctx } = this;
      ctx.drawImage(
        els.video,
        rect.sx, rect.sy, rect.sw, rect.sh,
        0, 0, canvas.width, canvas.height
      );

      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return analyzePixels(image.data, canvas.width, canvas.height);
    },

    /** Evalúa las métricas, emite eventos, pinta el estado y gestiona la autocaptura. */
    publish(metrics) {
      const cfg = CONFIG.analysis;
      const { hasPlate, isSharp, status } = classifyFrame(metrics);
      const previous = this.status;
      const raw = status;

      this.metrics = metrics;
      this.lastFrameAt = performance.now();
      this.frames++;
      this.streak = raw === STATUS.READY ? this.streak + 1 : 0;

      /* Antirrebote: un veredicto nuevo no se publica hasta repetirse
         `stableFrames` veces seguidas. Así un fotograma suelto (ruido, un
         parpadeo, medio segundo de movimiento) no enciende ni apaga el
         disparador ni hace parpadear el marco. */
      if (raw === this.status) {
        this.pending = 0;
      } else if (raw === this.pendingStatus) {
        this.pending++;
      } else {
        this.pendingStatus = raw;
        this.pending = 1;
      }

      if (this.status === null || this.pending >= cfg.stableFrames) {
        this.status = this.pendingStatus;
        this.pending = 0;
      }

      // Evento público en cada fotograma evaluado (hasta CONFIG.analysis.fps/s)
      bus.emit('analysis:frame', {
        hasPlate,
        isSharp,
        status: raw,            // veredicto crudo de este fotograma
        settled: this.status,   // estado publicado tras el antirrebote
        metrics,
      });

      this.paint();
      if (this.status !== previous) syncShutter();

      if (this.status === STATUS.READY &&
          CONFIG.analysis.autoCapture &&
          this.streak >= cfg.autoCaptureFrames &&
          !busy) {
        this.fire();
      }
    },

    /** Disparo automático: avisa, emite el evento y lanza la captura. */
    fire() {
      this.streak = 0;
      bus.emit('autocapture:triggered', { status: this.status, metrics: this.metrics });
      showToast('Autocaptura: encuadre correcto.', 'ok', 2500);
      this.stop();                        // se reanuda al volver a 'ready'
      capture({ automatic: true });
    },

    /** Error repetido: desactiva el análisis y libera el disparador. */
    fail(error) {
      this.failed = true;
      this.errorCount = 0;
      this.reset();
      console.warn('[captura] Análisis desactivado por errores repetidos:', error);
      showToast('No se pudo analizar el encuadre: el disparador queda libre.', 'error', 6000);
      syncShutter();
    },

    /** Pinta el color del marco, el aviso flotante y las métricas de depuración. */
    paint() {
      const status = this.status;
      const cfg = CONFIG.analysis;

      // Color del marco guía (el CSS se encarga del resto)
      const frameState = status || 'off';
      if (els.frame.dataset.status !== frameState) els.frame.dataset.status = frameState;

      if (!status) {
        els.analysis.hidden = true;
        return;
      }

      const text = status === STATUS.READY && cfg.autoCapture
        ? '¡Posición correcta! Capturando…'
        : STATUS_HINTS[status];

      els.analysis.hidden = false;
      if (els.analysis.dataset.status !== status) els.analysis.dataset.status = status;
      if (els.analysisText.textContent !== text) els.analysisText.textContent = text;

      this.paintMetrics();
    },

    /** Línea de métricas en vivo (solo con CONFIG.debug), útil para ajustar umbrales. */
    paintMetrics() {
      const m = this.metrics;
      const cfg = CONFIG.analysis;
      const pct = (v) => Math.round(v * 100);
      const text = CONFIG.debug && m
        ? `nitidez ${m.sharpness.toFixed(2)}/${cfg.sharpnessThreshold} · ` +
          `detalle ${m.detail.toFixed(1)}/${cfg.minDetail} · ` +
          `chapa ${pct(m.coverage)}%/${pct(cfg.minCoverageRatio)}% · ` +
          `columnas ${pct(m.columnRatio)}%/${pct(cfg.minColumnRatio)}%`
        : '';

      if (els.analysisMetrics.textContent !== text) els.analysisMetrics.textContent = text;
      els.analysisMetrics.hidden = !text;
    },
  };

  /* La geometría del marco solo cambia al redimensionar o girar la pantalla:
     invalidamos la caché del analizador en esos casos. */
  function invalidateLayout() { analyzer.epoch++; }

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(invalidateLayout).observe(els.viewport);
  }
  window.addEventListener('orientationchange', invalidateLayout);

  /* -----------------------------------------------------------------------
   * Envío al servidor
   * --------------------------------------------------------------------- */
  async function uploadImage(blob, meta) {
    const form = new FormData();
    form.append(CONFIG.fieldName, blob, `captura-${Date.now()}.jpg`);
    form.append('capturedAt', new Date().toISOString());
    form.append('device', navigator.userAgent);
    form.append('width', String(meta.width));
    form.append('height', String(meta.height));
    form.append('captureMode', CONFIG.captureMode);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);

    let response;
    try {
      response = await fetch(CONFIG.endpoint, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`El servidor tardó más de ${Math.round(CONFIG.timeoutMs / 1000)} s en responder.`);
      }
      throw new Error(`No se pudo contactar con el servidor (${CONFIG.endpoint}). ¿Está en marcha?`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `El servidor respondió ${response.status} ${response.statusText}` +
        (detail ? ` — ${detail.slice(0, 200)}` : '')
      );
    }

    const type = (response.headers.get('content-type') || '').toLowerCase();

    if (type.includes('application/json')) {
      const data = await response.json();
      const url = data.imageUrl || data.resultUrl || data.url || null;
      return { data, url, kind: 'json' };
    }

    if (type.startsWith('image/')) {
      const resultBlob = await response.blob();
      return { data: null, blob: resultBlob, kind: 'binary' };
    }

    const text = await response.text().catch(() => '');
    return { data: { raw: text.slice(0, 500) }, url: null, kind: 'text' };
  }

  /* -----------------------------------------------------------------------
   * Flujo de captura completo
   * --------------------------------------------------------------------- */
  async function capture({ automatic = false } = {}) {
    if (busy || !stream) return false;

    if (isRotationBlocked()) {
      if (!automatic) showToast('Gira el dispositivo en horizontal para capturar.', 'error', 4000);
      return false;
    }

    // Puerta del análisis: sin chapa nítida y bien posicionada no se dispara.
    const gate = analysisGate();
    if (gate.blocked) {
      if (automatic) return false;                       // la autocaptura nunca fuerza
      if (!CONFIG.analysis.allowOverride) {
        showToast(gate.hint, 'error', 4000);
        return false;
      }
      showToast(`${gate.hint} — se captura de todos modos (forzado).`, 'info', 3500);
    }

    busy = true;
    els.btnCapture.disabled = true;
    els.result.hidden = true;

    try {
      // 1. Flash visual + congelado del fotograma
      els.viewport.classList.add('is-flash');
      setTimeout(() => els.viewport.classList.remove('is-flash'), 90);

      const shot = await grabFrame();

      setState('uploading');
      els.processingHint.textContent = `Enviando ${formatBytes(shot.blob.size)} a ${CONFIG.endpoint}`;
      els.processing.hidden = false;
      setStatus('Enviando la imagen al servidor…');

      const startedAt = performance.now();

      // 2. Envío
      const result = await uploadImage(shot.blob, shot);

      const elapsed = Math.round(performance.now() - startedAt);
      bus.emit('capture:sent', { bytes: shot.blob.size, elapsed, kind: result.kind });

      // 3. Resultado
      await showResult(result, {
        bytes: shot.blob.size,
        width: shot.width,
        height: shot.height,
        elapsed,
      });

      setState('result');
      setStatus('Resultado recibido.');
      showToast('Imagen postprocesada correctamente.', 'ok', 3500);
    } catch (error) {
      setState('ready');
      setStatus('Error al procesar la imagen.');
      showToast(error?.message || 'Error inesperado durante la captura.', 'error', 9000);
      bus.emit('capture:error', { message: error?.message, error });
    } finally {
      els.processing.hidden = true;
      busy = false;
      syncShutter();
    }
  }

  /** Captura cuando el origen es el selector de archivos (fallback). */
  async function captureFromFile(file) {
    if (!file) return;
    els.btnCapture.disabled = true;
    els.result.hidden = true;
    busy = true;

    try {
      setState('uploading');
      els.processingHint.textContent = `Enviando ${file.name} (${formatBytes(file.size)})`;
      els.processing.hidden = false;
      setStatus('Enviando la imagen al servidor…');

      const startedAt = performance.now();
      const size = await measureImage(file);
      const result = await uploadImage(file, size);
      const elapsed = Math.round(performance.now() - startedAt);

      await showResult(result, { bytes: file.size, width: size.width, height: size.height, elapsed });
      setState('result');
      setStatus('Resultado recibido.');
      showToast('Imagen postprocesada correctamente.', 'ok', 3500);
    } catch (error) {
      setState(stream ? 'ready' : 'error');
      showToast(error?.message || 'Error inesperado durante el envío.', 'error', 9000);
    } finally {
      els.processing.hidden = true;
      busy = false;
      syncShutter();
      els.fileInput.value = '';
    }
  }

  /* -----------------------------------------------------------------------
   * Pintado del resultado
   * --------------------------------------------------------------------- */
  function renderMeta(rows) {
    els.resultMeta.replaceChildren();
    for (const [key, value] of rows) {
      if (value === undefined || value === null || value === '') continue;
      const dt = document.createElement('dt');
      dt.textContent = key;
      const dd = document.createElement('dd');
      dd.textContent = String(value);
      els.resultMeta.append(dt, dd);
    }
  }

  async function showResult(result, local) {
    if (resultObjectUrl) {
      URL.revokeObjectURL(resultObjectUrl);
      resultObjectUrl = null;
    }

    let src = result.url;

    if (!src && result.blob) {
      resultObjectUrl = URL.createObjectURL(result.blob);
      src = resultObjectUrl;
    }

    if (!src && result.data?.imageBase64) {
      src = `data:image/jpeg;base64,${result.data.imageBase64}`;
    }

    if (src) {
      els.resultImage.src = src;
      els.resultImage.hidden = false;
      els.btnDownload.href = src;
      els.btnDownload.hidden = false;
      els.btnDownload.setAttribute('download', `postprocesado-${Date.now()}.jpg`);
    } else {
      els.resultImage.hidden = true;
      els.btnDownload.hidden = true;
    }

    const serverMeta = result.data?.meta || {};
    const rows = [
      ['Tamaño enviado', formatBytes(local.bytes)],
      ['Resolución enviada', local.width ? `${local.width} × ${local.height} px` : '—'],
      ['Tiempo de ida y vuelta', `${local.elapsed} ms`],
      ['Respuesta', result.kind],
      ['ID en el servidor', result.data?.id],
      ['Imagen procesada', result.data?.imageUrl || result.data?.resultUrl || null],
      ['Transformaciones', Array.isArray(serverMeta.transforms) ? serverMeta.transforms.join(', ') : undefined],
      ['Mensaje', result.data?.message || serverMeta.message],
      ['Debug', CONFIG.debug && result.data ? JSON.stringify(result.data).slice(0, 220) : undefined],
    ];

    renderMeta(rows);
    els.result.hidden = false;
    els.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* -----------------------------------------------------------------------
   * Eventos
   * --------------------------------------------------------------------- */
  els.btnCapture.addEventListener('click', () => capture());
  els.btnRetry.addEventListener('click', () => { startCamera().catch(handleCameraFailure); });
  els.btnSwitch.addEventListener('click', cycleCamera);
  els.btnTorch.addEventListener('click', toggleTorch);

  /* Autocaptura: interruptor manual sincronizado con CONFIG.analysis. */
  function syncAutoButton() {
    const on = CONFIG.analysis.autoCapture;
    els.btnAuto.hidden = !CONFIG.analysis.enabled;
    els.btnAuto.classList.toggle('is-on', on);
    els.btnAuto.setAttribute('aria-pressed', String(on));
    els.btnAuto.title = on ? 'Autocaptura activada' : 'Autocaptura desactivada';
  }

  els.btnAuto.addEventListener('click', () => {
    CONFIG.analysis.autoCapture = !CONFIG.analysis.autoCapture;
    storage.set(AUTO_KEY, String(CONFIG.analysis.autoCapture));
    analyzer.streak = 0;
    analyzer.paint();          // el texto de "posición correcta" cambia
    syncAutoButton();
    showToast(
      CONFIG.analysis.autoCapture
        ? 'Autocaptura activada: se disparará sola al enfocar.'
        : 'Autocaptura desactivada.',
      'info',
      3000
    );
  });

  els.btnFile.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', (e) => captureFromFile(e.target.files?.[0]));

  els.btnNew.addEventListener('click', () => {
    els.result.hidden = true;
    setState(stream ? 'ready' : 'error');
    syncShutter();
    els.btnCapture.focus();
  });

  // Al girar el dispositivo, el disparador se habilita o bloquea solo.
  portraitQuery.addEventListener('change', syncShutter);

  // Bloqueo real de la orientación, donde el navegador lo permita
  // (requiere pantalla completa; funciona sobre todo en Chrome/Android).
  const canLockOrientation =
    Boolean(window.screen?.orientation) && typeof window.screen.orientation.lock === 'function';

  els.btnFullscreen.hidden = !canLockOrientation;

  els.btnFullscreen.addEventListener('click', async () => {
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      }
      await window.screen.orientation.lock('landscape');
      showToast('Pantalla bloqueada en horizontal.', 'ok');
    } catch {
      showToast('No se pudo bloquear la orientación: gira el dispositivo a mano.', 'error', 6000);
    }
  });

  syncShutter();
  syncAutoButton();

  els.btnSaveEndpoint.addEventListener('click', () => {
    const value = els.endpointInput.value.trim();
    if (!value) {
      showToast('Escribe una URL de endpoint válida.', 'error');
      return;
    }
    CONFIG.endpoint = value;
    storage.set(STORAGE_KEY, value);
    els.endpointInput.value = value;
    showToast(`Endpoint guardado: ${value}`, 'ok');
  });

  // API pública mínima para integrar con el resto de la página.
  window.captura = {
    config: CONFIG,
    on: (fn) => bus.on(fn),
    capture,
    startCamera,
    stopCamera: stopStream,
    isReady: () => Boolean(stream) && !busy,
    canCapture: () => Boolean(stream) && !busy && !isRotationBlocked() &&
      (!analyzer.blocked() || CONFIG.analysis.allowOverride),

    /** Lectura y control del análisis en tiempo real (para integraciones). */
    analysis: {
      status: () => analyzer.status,
      metrics: () => analyzer.metrics,
      blocked: () => analyzer.blocked(),
      isEnabled: () => analyzer.enabled,
      start: () => analyzer.start(),
      stop: () => analyzer.stop(),

      /** Activa o desactiva el análisis en caliente (marco y disparador incluidos). */
      setEnabled(value) {
        CONFIG.analysis.enabled = Boolean(value);
        syncAutoButton();
        if (CONFIG.analysis.enabled && els.app.dataset.state === 'ready') analyzer.start();
        else analyzer.reset();
        syncShutter();
      },
    },
  };

  /* -----------------------------------------------------------------------
   * Arranque
   * --------------------------------------------------------------------- */
  startCamera().catch(handleCameraFailure);
})();
