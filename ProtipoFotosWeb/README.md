# Captura + postprocesado

Frontend mínimo (HTML + CSS + JS, **sin dependencias ni build**) para una página web
de fotografía: el usuario encuadra dentro de un marco guía tipo **lector de QR**, pulsa
el disparador y la imagen se envía al servidor para su postprocesado. El resultado se
muestra en la misma pantalla.

Antes de eso, la app **analiza el encuadre en tiempo real** (sección 4) y mantiene el
disparador bloqueado hasta que la chapa está bien colocada y con nitidez suficiente.

En móvil la captura se hace con el dispositivo **en horizontal**: el marco guía es una
banda panorámica de proporción 4:1 y, si el móvil está vertical, la app pide girarlo y
bloquea el disparador.

```
.
├── index.html      Interfaz (visor, marco, píldora de análisis, controles, resultado)
├── styles.css      Estilos: máscara oscura, esquinas, línea de barrido, modo apaisado
├── app.js          Cámara, análisis del encuadre, recorte del fotograma, envío y pintado
├── server.js       Mock del servidor — Node.js, sin dependencias
├── server.py       Mock del servidor — Python 3, solo biblioteca estándar
└── uploads/        Donde el mock guarda las imágenes "procesadas"
```

---

## 1. Arranque rápido

Cualquiera de los dos mocks sirve el frontend **y** el endpoint, así que no hay
problemas de CORS ni de rutas.

**Python 3** (no necesita instalar nada):

```bash
python server.py
# → http://localhost:3000
```

**Node.js** (tampoco necesita `npm install`):

```bash
node server.js
# → http://localhost:3000
```

Abre <http://localhost:3000> y acepta el permiso de cámara.

> `PORT=8080 python server.py` (o `PORT=8080 node server.js`) para cambiar el puerto.

### Probar desde el móvil

`getUserMedia` solo funciona en **contexto seguro**: `https://` o `localhost`.
Si abres `http://192.168.x.x:3000` desde el móvil la cámara fallará y verás el aviso
correspondiente. Opciones:

- Servir en HTTPS con un certificado (por ejemplo `mkcert` + un proxy inverso).
- Usar un túnel: `ngrok http 3000` y abrir la URL `https://…` que devuelve.
- Abrir la página en el propio móvil con `localhost` vía adb reverse (Android).

---

## 2. Cómo conectar tu backend

En `app.js`, arriba del todo:

```js
const CONFIG = {
  endpoint: '/api/process',   // ← tu URL
  fieldName: 'image',
  captureMode: 'frame',       // 'frame' (recorte al marco) | 'full' (fotograma completo)
  jpegQuality: 0.92,
  idealWidth: 1920,
  idealHeight: 1080,
  timeoutMs: 30000,
  debug: true,
};
```

También puedes cambiarlo sin tocar el código, desde la propia pantalla
(apartado *Servidor de postprocesado*) o con la URL:

```
http://localhost:3000/?endpoint=https://mi-api.com/v1/postprocesar
```

### Contrato de la petición

`POST` con `multipart/form-data`:

| Campo         | Tipo   | Contenido                                  |
| ------------- | ------ | ------------------------------------------ |
| `image`       | file   | JPEG recortado (nombre `captura-<ts>.jpg`)  |
| `capturedAt`  | texto  | ISO-8601 del momento del disparo            |
| `device`      | texto  | `navigator.userAgent`                        |
| `width`       | texto  | Ancho en píxeles                            |
| `height`      | texto  | Alto en píxeles                             |
| `captureMode` | texto  | `frame` o `full`                             |

### Formatos de respuesta aceptados

El frontend admite tres variantes; usa la que te resulte cómoda:

1. **JSON** (recomendado), con la imagen en cualquiera de estas claves:
   `imageUrl`, `resultUrl` o `url`. El resto del objeto se muestra como metadatos.

   ```json
   {
     "ok": true,
     "id": "1730-8f21a2",
     "imageUrl": "/uploads/1730-8f21a2.jpg",
     "meta": {
       "transforms": ["auto-contraste", "denoise"],
       "processingMs": 640
     }
   }
   ```

2. **Imagen binaria**: responde directamente `Content-Type: image/jpeg` (u otro
   `image/*`) con los bytes del resultado.

3. **JSON con base64** en `imageBase64`.

Los errores se muestran en un *toast*: cualquier respuesta con estado ≠ 2xx se
notifica junto al cuerpo (recortado) que devuelva el servidor.

### Sustituir el postprocesado de mentira

El mock solo **copia** el archivo recibido. Cambia estas funciones:

- `server.js` → `processImage(input, id)`
- `server.py` → `process_image(datos, identificador)`

Ambas incluyen un ejemplo comentado (con `sharp` y con Pillow respectivamente).

---

## 3. Ajustar la interfaz

Todo lo visual del marco está en `styles.css`:

```css
:root {
  --frame-width: 78cqw;    /* ancho del marco, en % del ancho del visor */
  --frame-max: 760px;      /* tope de ancho para pantallas grandes */
  --frame-aspect: 4 / 1;   /* banda panorámica (≈ 1/4 de alto que de ancho) */
  --accent: #35e0a1;       /* color de esquinas y línea de barrido */
}
```

- Proporción 4:1 (por defecto) → banda panorámica, pensada para móvil apaisado.
- Marca cuadrada tipo QR → `--frame-aspect: 1 / 1` (y `--frame-width: 60cqmin`).
- Encuadre retrato → `--frame-aspect: 3 / 4`.

El visor usa `aspect-ratio: 16 / 9` en vertical y, en móvil apaisado, ocupa todo el
alto de la pantalla con los mandos flotando encima (`.hud`).

### Obligar a la pantalla horizontal

La app fuerza el modo apaisado con dos mecanismos:

1. **Aviso y bloqueo del disparador.** En `styles.css`, el aviso `#rotate` se muestra
   con `@media (orientation: portrait) and (pointer: coarse)`; en `app.js`,
   `isRotationBlocked()` desactiva el disparador en esa misma situación.
2. **Bloqueo real de la orientación** (opcional). El botón *Bloquear en horizontal*
   del aviso pide pantalla completa y llama a `screen.orientation.lock('landscape')`.
   Solo funciona donde el navegador lo permite (sobre todo Chrome/Android); si falla,
   queda el aviso manual.

La condición `pointer: coarse` limita el aviso a pantallas táctiles, para no molestar
a un navegador de escritorio con la ventana alta. Si quieres exigir el apaisado en
cualquier dispositivo, quita ese término de las dos media queries.

Con `captureMode: 'frame'` solo se envía la zona **dentro** del marco: el recorte
tiene en cuenta el `object-fit: cover` del vídeo, así que lo que ves es exactamente
lo que se sube, a resolución de sensor.

---

## 4. Análisis del encuadre en tiempo real

La app no sube una foto a ciegas: mientras encuadras analiza el vídeo en el propio
dispositivo (un canvas de 320 × 80 a unos 15 fps) y decide si la chapa está bien
puesta. **El disparador queda bloqueado hasta que el veredicto es «LISTA».**

### Los tres estados

| Estado | Marco guía | Aviso en pantalla |
| --- | --- | --- |
| `NO_PLATE` | rojo y discontinuo | «Coloque la chapa dentro del marco» |
| `BLURRY` | ámbar | «Mantenga el dispositivo firme…» |
| `READY_TO_CAPTURE` | verde, con pulso | «¡Posición correcta!» |

### Cómo decide

En cada fotograma, sobre el recorte real del marco:

1. **Color (¿parece metal?)** — `isPlatePixel()`: un píxel cuenta como chapa si su
   luminancia está entre `metallicLuminanceMin` y `metallicLuminanceMax`, su saturación
   no supera `metallicSaturationMax` y su calidez `(R − B) / max` no supera
   `metallicWarmthMax`. Así se descartan madera, piel y óxido (cálidos) y también las
   sombras profundas y los brillos quemados.
2. **Encaje en el marco** — `coverage` (fracción de píxeles de chapa) y `columnRatio`
   (fracción de columnas con al menos `minColumnCoverage` de chapa). Se exigen
   `minCoverageRatio` y `minColumnRatio`: la chapa tiene que **llenar** el marco, no
   basta con que aparezca.
3. **Nitidez** — `sharpness = media|Laplaciano| ÷ media|ΔL horizontal|`: es un índice
   normalizado, así que no depende del contraste ni de la escena. Se completa con
   `detail = media|Laplaciano|`, que descarta superficies planas sin textura.

Los veredictos se **antirrebotan** (`stableFrames`) antes de publicarse, para que un
fotograma suelto (ruido, un parpadeo, medio segundo de movimiento) no encienda ni
apague el disparador.

### Tabla de ajuste (`CONFIG.analysis`, en `app.js`)

| Clave | Valor | Para qué sirve |
| --- | --- | --- |
| `metallicLuminanceMin` / `Max` | 55 / 245 | Brillo del metal: fuera quedan sombras y reflejos |
| `metallicSaturationMax` | 0.5 | Descarta colores vivos (madera, óxido, ropa) |
| `metallicWarmthMax` | 0.35 | Tono cálido: el filtro principal contra madera y piel |
| `minCoverageRatio` | 0.55 | Chapa **llena** el marco (mín. ~86 % del encuadre de referencia) |
| `minColumnCoverage` / `minColumnRatio` | 0.45 / 0.78 | Reparto horizontal (la chapa recorre casi todo el ancho) |
| `sharpnessThreshold` | 1.35 | Nitidez mínima (anti-desenfoque) |
| `minDetail` | 2.5 | Detalle mínimo (anti-superficies lisas) |
| `stableFrames` | 2 | Fotogramas repetidos antes de publicar el veredicto |
| `autoCapture` / `autoCaptureFrames` | `false` / 5 | Disparo automático al mantenerse LISTA |
| `allowOverride` | `false` | Si es `true`, se puede forzar el disparo sin LISTA |
| `fps` | 15 | Frecuencia de análisis |

### Calibración

Los valores están medidos sobre 24 fotos reales de esta chapa (bandas 4:1 equivalentes
al marco), primero en Python y luego verificados en el navegador. Con la configuración
actual:

- **Chapa con luz y bien encuadrada** → LISTA, con cobertura 0.44-0.85, columnas
  0.47-0.99, nitidez 1.8-2.9 y detalle 6-43.
- **Madera de la mesa, teclado, piel y paredes** → cobertura ≤0.36 → `NO_PLATE`.
- **Desenfoque** de 3-6 px → nitidez 0.7-1.0 → `BLURRY`.
- **Chapa a contraluz o muy girada** → se rechaza a propósito: esa foto saldría mal.

Dos límites que conviene conocer:

- El vídeo de la cámara se codifica con croma reducida (4:2:0) y la chapa —que es
  neutra— hereda algo del tono cálido de la sala. Por eso `metallicWarmthMax` no baja
  de 0.30: con 0.25 la chapa plateada se quedaba por debajo de la cobertura mínima.
- Una superficie **gris y lisa** (papel blanco, pared) se parece al metal en color y
  puede colarse como LISTA. Es el precio de no exigir una pieza concreta sin usar
  reconocimiento de imagen.

Si cambias de chapa o de iluminación, ajusta sobre todo `metallicWarmthMax` y
`minCoverageRatio`, y comprueba el resultado con la píldora de métricas en pantalla
(nitidez, detalle, cobertura y columnas frente a sus umbrales).

### Márgenes del encuadre (foto de referencia)

El ajuste de encuadre se hizo con la foto de referencia `Imagen Chapa correcta.jpg`
(1494 × 373, **exactamente 4:1**, con la chapa a 4.19:1 y márgenes de apenas un
4-8 %). Escalando esa foto dentro del marco se midió:

| Encuadre | Cobertura | Columnas | Veredicto |
| --- | --- | --- | --- |
| 1.10 | 0.83 | 0.99 | LISTA |
| **1.00 (la referencia)** | **0.74** | **0.93** | **LISTA** |
| 0.95 | 0.67 | 0.88 | LISTA |
| 0.90 | 0.60 | 0.82 | LISTA |
| 0.85 | 0.54 | 0.77 | NO_PLATE |
| 0.80 | 0.48 | 0.72 | NO_PLATE |
| 0.70 | 0.36 | 0.59 | NO_PLATE |

Con `minCoverageRatio` 0.55 y `minColumnRatio` 0.78 se acepta la chapa cuando llena
al menos ~86 % del encuadre de la referencia y se rechaza por debajo. Si la chapa está
a tamaño completo pero desplazada un 15 % sigue pasando (cobertura 0.64-0.66); si se
desplaza un 25 % en vertical se sale del marco y se rechaza (0.54). Para afinarlo,
sube `minCoverageRatio` (encuadre más exigente) o bájalo (más permisivo).

### Autocaptura

El botón **Auto** del HUD activa el disparo automático: al mantenerse
`autoCaptureFrames` fotogramas seguidos en LISTA se dispara sola. La preferencia se
guarda en `localStorage` (`captura.autocapture`). Si `allowOverride` está activo, el
disparador se puede pulsar aunque el veredicto no sea LISTA (el botón se marca en
ámbar y la foto se envía con un aviso).

---

## 5. API de integración

`app.js` expone un objeto global mínimo:

```js
window.captura.capture();          // dispara una captura por código
window.captura.isReady();          // ¿cámara lista y sin trabajo en curso?
window.captura.canCapture();       // ¿se puede disparar ahora? (incluye el apaisado)
window.captura.stopCamera();       // libera la cámara
window.captura.config;             // el objeto CONFIG, modificable en caliente

window.captura.on((evento, datos) => {
  // 'camera:ready'  → { label, settings }
  // 'camera:error'  → { message, error }
  // 'capture:sent'  → { bytes, elapsed, kind }
  // 'capture:error' → { message, error }
  // 'analysis:frame'        → { hasPlate, isSharp, status, settled, metrics }
  // 'autocapture:triggered' → { status, metrics }
  console.log(evento, datos);
});

// Análisis en tiempo real (leer y controlar desde fuera).
window.captura.analysis.status();       // veredicto publicado, o null si aún no hay
window.captura.analysis.metrics();      // { coverage, columnRatio, sharpness, detail, ... }
window.captura.analysis.blocked();      // ¿el disparador está bloqueado por el análisis?
window.captura.analysis.setEnabled(false);  // apaga el análisis y libera el disparador
```

`analysis:frame` se emite en cada fotograma evaluado (hasta `CONFIG.analysis.fps` por
segundo); `status` es el veredicto crudo de ese fotograma y `settled` el ya
antirrebotado. `autocapture:triggered` avisa de que la autocaptura ha disparado.

---

## 6. Notas para producción

- **HTTPS obligatorio** para la cámara (excepto `localhost`).
- **Orientación**: la captura está pensada para móvil apaisado (banda 4:1). En iOS
  Safari `screen.orientation.lock()` no existe, así que el usuario deberá girar el
  dispositivo a mano; el aviso ya se lo indica.
- **Tamaño**: con 1080p y calidad 0.92 cada JPEG ronda 300–600 KB. Baja
  `jpegQuality` a `0.8` o `idealWidth/Height` si la red es lenta. Recuerda que con
  `captureMode: 'frame'` solo se recorta la banda del marco: la imagen resultante es
  muy apaisada (por ejemplo 1080 × 270 px).
- **Libre de dependencias**: el frontend son 3 archivos; si integras en una página
  existente, copia el bloque `.app` de `index.html` y los estilos que empiezan por
  `.scanner`.
- **PWA**: si vas a publicarlo como app, añade un `manifest.webmanifest` y un
  *service worker*; el resto ya funciona sin conexión al servidor de estáticos.
- **CORS**: los mocks envían `Access-Control-Allow-Origin: *`. Restríngelo en tu
  backend real a tu dominio.
- **Timezone/EXIF**: el JPEG que genera el `canvas` **no** conserva los metadatos
  EXIF de la cámara (orientación, GPS). Si los necesitas, envíalos como campos
  aparte o captura desde el servidor.
