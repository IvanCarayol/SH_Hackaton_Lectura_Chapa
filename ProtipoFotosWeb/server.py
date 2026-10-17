#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Servidor de lectura de chapa - Python 3.

    python server.py            -> http://localhost:3000
    PORT=8080 python server.py

Sirve el frontend (index.html, styles.css, app.js) y expone:

    POST /api/process   recibe la imagen (multipart/form-data, campo "image")
    GET  /api/health    comprobación rápida (motores disponibles)
    GET  /uploads/<id>/ guarda los resultados y los pasos del pipeline

Dos motores de postprocesado (`?engine=…`, por defecto `tesseract`):

    tesseract  →  OCR con Tesseract (puerto de `procesamientoTesseract.py`).
                  Necesita el binario de Tesseract instalado en el sistema.
    plantillas →  matching contra plantillas CAD (puerto de `procesadoImagen.py`).

En ambos casos cada etapa del pipeline se guarda como imagen independiente y se
devuelve en la respuesta (`workflow.steps`) para que el frontend pinte el
workflow de procesado paso a paso.
"""

from __future__ import annotations

import glob
import json
import os
import shutil
import sys
import threading
import time
import uuid
from email import policy
from email.parser import BytesParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

# --- Dependencias de imagen (OpenCV + NumPy) -------------------------------
try:
    import cv2
    import numpy as np
except ImportError as _error:  # mensaje de arranque claro, no un traceback en cada petición
    cv2 = None  # type: ignore[assignment]
    np = None  # type: ignore[assignment]
    _ERROR_CV2 = _error

# --- OCR con Tesseract (opcional: solo hace falta para el motor "tesseract") -
try:
    import pytesseract
except ImportError as _error:
    pytesseract = None  # type: ignore[assignment]
    _ERROR_PYTESSERACT = _error

ROOT = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(ROOT, "uploads")
PORT = int(os.environ.get("PORT", "3000"))
HOST = os.environ.get("HOST", "0.0.0.0")
MAX_BYTES = 25 * 1024 * 1024  # 25 MB
DEFAULT_DELAY_MS = 0          # latencia simulada (0: el procesado ya es real)

# Archivos que nunca se sirven aunque estén en la carpeta.
PRIVATE = {"server.py", "server.js", "package.json", "README.md"}

# Motores disponibles y motor por defecto.
ENGINES = ("tesseract", "plantillas")
DEFAULT_ENGINE = "tesseract"


# --------------------------------------------------------------------------
# Configuración de Tesseract (procesamientoTesseract.py)
# --------------------------------------------------------------------------
# Rutas donde se busca tesseract.exe, en orden de prioridad. La variable de
# entorno TESSERACT_CMD permite apuntar a una instalación portable.
RUTAS_TESSERACT = [
    os.environ.get("TESSERACT_CMD"),
    r"C:\Program Files\Tesseract-OCR\tesseract.exe",
    r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "Tesseract-OCR",
                 "tesseract.exe"),
]

# --psm 6 asume un bloque uniforme de texto; la whitelist limita el alfabeto.
TESSERACT_CONFIG = (
    r"--psm 6 -c tessedit_char_whitelist=0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ*"
)

# Recorte lateral derecho por defecto: nos quedamos con el 82 % izquierdo para
# descartar el rectángulo vertical de la derecha (ajustable con ?crop=0.9).
RECORTE_DERECHO = 0.82

# Confianza mínima (%) para dar una palabra por buena.
UMBRAL_CONFIANZA_OCR = 60.0

_tesseract_lock = threading.Lock()
_tesseract_estado: tuple[str | None, str | None] | None = None


def estado_tesseract() -> tuple[str | None, str | None]:
    """Devuelve (ruta, motivo_de_error). Cachea el resultado."""
    global _tesseract_estado
    if _tesseract_estado is not None:
        return _tesseract_estado

    with _tesseract_lock:
        if _tesseract_estado is not None:
            return _tesseract_estado

        if pytesseract is None:
            _tesseract_estado = (None, f"pytesseract no instalado ({_ERROR_PYTESSERACT})")
            return _tesseract_estado

        candidatas = [r for r in RUTAS_TESSERACT if r]
        candidatas.append(shutil.which("tesseract") or "")

        for ruta in candidatas:
            if ruta and os.path.isfile(ruta):
                pytesseract.pytesseract.tesseract_cmd = ruta
                try:
                    version = str(pytesseract.get_tesseract_version())
                except Exception as error:  # noqa: BLE001
                    _tesseract_estado = (None, f"tesseract.exe no ejecutable: {error}")
                    return _tesseract_estado
                _tesseract_estado = (ruta, None)
                print(f"[{time.strftime('%H:%M:%S')}] Tesseract {version} · {ruta}")
                return _tesseract_estado

        _tesseract_estado = (
            None,
            "no se ha encontrado tesseract.exe. Instálalo (UB-Mannheim) o define "
            "la variable TESSERACT_CMD con su ruta.",
        )
        return _tesseract_estado


# --------------------------------------------------------------------------
# Configuración del motor de plantillas (procesadoImagen.py)
# --------------------------------------------------------------------------
CARPETAS_PLANTILLAS = [
    os.path.join(ROOT, "templates", "templates"),  # ubicación real en el repo
    os.path.join(ROOT, "templates"),
]
ANCHO_CARACTER = 64
ALTO_CARACTER = 96
UMBRAL_MATCH = 0.30

# Ancho máximo (px) y calidad JPEG de las imágenes intermedias del workflow.
MAX_ANCHO_WORKFLOW = 1400
CALIDAD_JPEG = 88


# --------------------------------------------------------------------------
# Parser multipart/form-data (binario-seguro, vía módulo email)
# --------------------------------------------------------------------------
def parse_multipart(content_type: str, body: bytes):
    """Devuelve (campos, archivos) a partir del cuerpo multipart."""
    cabecera = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode()
    mensaje = BytesParser(policy=policy.default).parsebytes(cabecera + body)

    campos: dict[str, str] = {}
    archivos: dict[str, tuple[str, bytes, str]] = {}

    for parte in mensaje.iter_parts():
        nombre = parte.get_param("name", header="content-disposition") or ""
        fichero = parte.get_filename()
        datos = parte.get_payload(decode=True) or b""

        if fichero:
            archivos[nombre] = (fichero, datos, parte.get_content_type())
        else:
            charset = parte.get_content_charset() or "utf-8"
            campos[nombre] = datos.decode(charset, "replace")

    return campos, archivos


# --------------------------------------------------------------------------
# Guardado de imágenes del workflow
# --------------------------------------------------------------------------
def _guardar_imagen(imagen, carpeta: str, identificador: str, nombre: str) -> str | None:
    """Guarda (y encoge si hace falta) una imagen intermedia. Devuelve su URL."""
    if imagen is None:
        return None

    alto, ancho = imagen.shape[:2]
    if ancho > MAX_ANCHO_WORKFLOW:
        imagen = cv2.resize(
            imagen,
            (MAX_ANCHO_WORKFLOW, max(1, int(alto * MAX_ANCHO_WORKFLOW / ancho))),
            interpolation=cv2.INTER_AREA,
        )

    ruta = os.path.join(carpeta, nombre)
    if nombre.lower().endswith((".jpg", ".jpeg")):
        cv2.imwrite(ruta, imagen, [cv2.IMWRITE_JPEG_QUALITY, CALIDAD_JPEG])
    else:
        cv2.imwrite(ruta, imagen)

    return f"/uploads/{identificador}/{nombre}"


class _Workflow:
    """Recolector de los pasos del pipeline (id, título, imagen, stats)."""

    def __init__(self, carpeta: str, identificador: str):
        self.carpeta = carpeta
        self.identificador = identificador
        self.steps: list[dict] = []
        self._n = 0

    def paso(self, pid, titulo, descripcion, imagen, stats=None) -> None:
        self._n += 1
        self.steps.append({
            "id": pid,
            "index": self._n,
            "title": titulo,
            "description": descripcion,
            "image": _guardar_imagen(imagen, self.carpeta, self.identificador, f"{pid}.jpg"),
            "stats": stats or [],
        })


# ==========================================================================
# MOTOR 1 · OCR con Tesseract (procesamientoTesseract.py)
# ==========================================================================
def _preprocesar_para_ocr(imagen):
    """Devuelve (gris, binaria, limpia, procesada, invertida) listos para Tesseract."""
    gris = cv2.cvtColor(imagen, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gris, (5, 5), 0)

    # Umbralización global de Otsu
    _, binaria = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # Tesseract prefiere texto NEGRO sobre fondo BLANCO: miramos los bordes y
    # invertimos solo si el fondo ha quedado oscuro.
    bordes = np.concatenate([binaria[0, :], binaria[-1, :], binaria[:, 0], binaria[:, -1]])
    invertida = bool(np.mean(bordes) < 127)
    if invertida:
        binaria = cv2.bitwise_not(binaria)

    # Limpieza de motas pequeñas de ruido
    kernel_ruido = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    limpia = cv2.morphologyEx(binaria, cv2.MORPH_OPEN, kernel_ruido)

    # Cierre moderado para unificar los cortes del stencil sin deformar la letra
    kernel_cierre = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    procesada = cv2.morphologyEx(limpia, cv2.MORPH_CLOSE, kernel_cierre)

    return gris, binaria, limpia, procesada, invertida


def _palabras_ocr(procesada):
    """
    Palabras detectadas con su caja y su confianza, agrupadas por renglón.
    Usa image_to_data (misma configuración que el OCR) para poder pintar el
    detalle de cada palabra en el frontend.
    """
    datos = pytesseract.image_to_data(
        procesada, config=TESSERACT_CONFIG, output_type=pytesseract.Output.DICT
    )

    palabras: list[dict] = []
    # (block, par, line) identifica el renglón para numerarlo.
    indices_linea: dict[tuple, int] = {}

    for i, texto in enumerate(datos.get("text", [])):
        texto = (texto or "").strip()
        try:
            confianza = float(datos["conf"][i])
        except (TypeError, ValueError, KeyError):
            confianza = -1.0
        if not texto or confianza < 0:
            continue

        clave = (datos.get("block_num", [0] * (i + 1))[i],
                 datos.get("par_num", [0] * (i + 1))[i],
                 datos.get("line_num", [0] * (i + 1))[i])
        if clave not in indices_linea:
            indices_linea[clave] = len(indices_linea)

        palabras.append({
            "texto": texto,
            "confianza": confianza,
            "linea": indices_linea[clave],
            "box": {
                "x": int(datos["left"][i]),
                "y": int(datos["top"][i]),
                "w": int(datos["width"][i]),
                "h": int(datos["height"][i]),
            },
        })

    return palabras


def _pipeline_tesseract(placa, datos, identificador, carpeta, crop) -> dict:
    wf = _Workflow(carpeta, identificador)
    alto_img, ancho_img = placa.shape[:2]

    # --- 1. Imagen original ------------------------------------------------
    wf.paso("original", "Imagen capturada",
            "Fotograma recibido del visor, tal cual sale de la cámara.",
            placa,
            [["Resolución", f"{ancho_img} × {alto_img} px"],
             ["Tamaño", f"{len(datos) / 1024:.0f} KB"]])

    # --- 2. Recorte lateral derecho ----------------------------------------
    ancho_recorte = max(1, int(ancho_img * crop))
    recorte = placa[:, :ancho_recorte].copy()
    wf.paso("recorte", "Recorte lateral",
            f"Se descarta el {100 * (1 - crop):.0f} % derecho de la imagen para "
            "quitar el rectángulo vertical que confunde al OCR.",
            recorte,
            [["Recorte", f"{crop * 100:.0f} % izquierdo"],
             ["Resolución", f"{ancho_recorte} × {alto_img} px"]])

    # --- 3. Escala de grises + desenfoque ----------------------------------
    gris, binaria, limpia, procesada, invertida = _preprocesar_para_ocr(recorte)
    wf.paso("grises", "Escala de grises",
            "Conversión a un canal y filtro gaussiano 5×5 para calmar el ruido del metal.",
            gris,
            [["Canal", "Gris (8 bits)"],
             ["Filtro", "GaussianBlur 5×5"]])

    # --- 4. Binarización Otsu ----------------------------------------------
    wf.paso("binaria", "Binarización Otsu",
            "Umbral automático de Otsu; se invierte si el fondo queda oscuro "
            "(Tesseract trabaja mejor con texto negro sobre blanco).",
            binaria,
            [["Umbral", "Otsu (automático)"],
             ["Esquema", "Texto negro / fondo blanco" if invertida else "Sin invertir"]])

    # --- 5. Limpieza de ruido ----------------------------------------------
    wf.paso("limpia", "Limpieza de ruido",
            "Apertura morfológica 3×3: elimina motas sueltas antes del cierre.",
            limpia,
            [["Kernel", "Rectangular 3×3"],
             ["Operación", "Apertura (open)"]])

    # --- 6. Cierre de los cortes del stencil -------------------------------
    wf.paso("procesada", "Cierre del stencil",
            "Cierre morfológico 5×5: une los cortes del troquel sin deformar la letra.",
            procesada,
            [["Kernel", "Rectangular 5×5"],
             ["Operación", "Cierre (close)"]])
    # La imagen que ve Tesseract es la del paso 6 (se usa tal cual abajo).

    # --- 7. OCR ------------------------------------------------------------
    texto_bruto = pytesseract.image_to_string(procesada, config=TESSERACT_CONFIG)
    lineas = [linea.strip() for linea in texto_bruto.split("\n") if linea.strip()]

    palabras = _palabras_ocr(procesada)

    # Cajas verdes de depuración (mismo filtro que el script original)
    ocr_img = recorte.copy()
    contornos, _ = cv2.findContours(
        cv2.bitwise_not(procesada), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )
    cajas = 0
    for contorno in contornos:
        x, y, w, h = cv2.boundingRect(contorno)
        if 15 < h < alto_img * 0.80 and 5 < w < ancho_recorte * 0.25:
            cajas += 1
            cv2.rectangle(ocr_img, (x, y), (x + w, y + h), (0, 255, 0), 2)

    # Encima de cada palabra reconocida, su texto y su confianza
    imagenes_palabras: list[dict] = []
    for i, palabra in enumerate(palabras):
        bx, by, bw, bh = (palabra["box"]["x"], palabra["box"]["y"],
                          palabra["box"]["w"], palabra["box"]["h"])
        aceptada = palabra["confianza"] >= UMBRAL_CONFIANZA_OCR
        color = (0, 200, 90) if aceptada else (0, 140, 255)
        cv2.rectangle(ocr_img, (bx, by), (bx + bw, by + bh), color, 1)
        cv2.putText(ocr_img, f"{palabra['texto']} {palabra['confianza']:.0f}%",
                    (bx, max(14, by - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1)

        # Recorte de la palabra (en color) para los chips del frontend
        x0, y0 = max(0, bx), max(0, by)
        x1, y1 = min(recorte.shape[1], bx + bw), min(recorte.shape[0], by + bh)
        miniatura = recorte[y0:y1, x0:x1] if x1 > x0 and y1 > y0 else None
        imagenes_palabras.append({
            "char": palabra["texto"],
            "score": round(palabra["confianza"] / 100.0, 3),
            "accepted": aceptada,
            "line": palabra["linea"],
            "index": i,
            "box": palabra["box"],
            "image": _guardar_imagen(miniatura, carpeta, identificador, f"word-{i}.png"),
            "kind": "word",
        })

    media = (sum(p["confianza"] for p in palabras) / len(palabras)) if palabras else 0.0
    wf.paso("ocr", "OCR con Tesseract",
            f"Tesseract lee la imagen procesada ({TESSERACT_CONFIG.strip()}). "
            "Se marcan las cajas de cada glifo y la confianza de cada palabra.",
            ocr_img,
            [["Líneas", str(len(lineas))],
             ["Palabras", str(len(palabras))],
             ["Glifos (cajas)", str(cajas)],
             ["Confianza media", f"{media:.0f} %"]])

    texto = "\n".join(lineas)
    url_resultado = wf.steps[-1]["image"] or wf.steps[0]["image"]

    return {
        "engine": "tesseract",
        "imageUrl": url_resultado,
        "resultUrl": url_resultado,
        "text": texto,
        "lines": lineas,
        "workflow": {
            "engine": "tesseract",
            "config": TESSERACT_CONFIG,
            "threshold": UMBRAL_CONFIANZA_OCR / 100.0,
            "crop": crop,
            "steps": wf.steps,
            "chars": imagenes_palabras,
        },
    }


# ==========================================================================
# MOTOR 2 · Matching contra plantillas CAD (procesadoImagen.py)
# ==========================================================================
def _preparar_plantilla_cad(ruta: str):
    """Convierte una plantilla CAD en silueta blanca maciza sobre fondo negro."""
    img_tpl = cv2.imread(ruta, cv2.IMREAD_GRAYSCALE)
    if img_tpl is None:
        return None

    # 1. Binarizamos normal (fondo blanco = 255, trazo negro = 0)
    _, thresh = cv2.threshold(img_tpl, 200, 255, cv2.THRESH_BINARY)
    # 2. Invertimos: el trazo pasa a BLANCO y el fondo a NEGRO
    inv = cv2.bitwise_not(thresh)
    # 3. Rellenamos el interior para dejar la silueta maciza
    contornos, _ = cv2.findContours(inv, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    plantilla_maciza = np.zeros_like(inv)
    cv2.drawContours(plantilla_maciza, contornos, -1, 255, thickness=cv2.FILLED)
    # 4. Recortar al bounding box exacto de la letra
    puntos = cv2.findNonZero(plantilla_maciza)
    if puntos is not None:
        x, y, w, h = cv2.boundingRect(puntos)
        plantilla_maciza = plantilla_maciza[y:y + h, x:x + w]
    # 5. Escalar al tamaño estándar y suavizar
    plantilla_maciza = cv2.resize(
        plantilla_maciza, (ANCHO_CARACTER, ALTO_CARACTER), interpolation=cv2.INTER_AREA
    )
    return cv2.GaussianBlur(plantilla_maciza, (3, 3), 0)


def _nombre_a_caracter(nombre_base: str) -> str:
    """'ASTERISCO' -> '*' · 'GUION' -> '-' · 'PUNTO' -> '.' · resto, tal cual."""
    caracter = nombre_base.split("_")[0].upper()
    especiales = {"ASTERISCO": "*", "GUION": "-", "BARRA": "/", "PUNTO": "."}
    return especiales.get(caracter, caracter)


_plantillas_cache: dict[str, list] | None = None
_plantillas_lock = threading.Lock()


def cargar_plantillas() -> dict[str, list]:
    """Carga (una sola vez) todas las plantillas válidas de las carpetas conocidas."""
    global _plantillas_cache
    if _plantillas_cache is not None:
        return _plantillas_cache

    with _plantillas_lock:
        if _plantillas_cache is not None:
            return _plantillas_cache

        plantillas: dict[str, list] = {}
        buscadas = []

        for carpeta in CARPETAS_PLANTILLAS:
            if not os.path.isdir(carpeta):
                continue
            buscadas.append(carpeta)
            for ruta in sorted(glob.glob(os.path.join(carpeta, "*"))):
                if not os.path.isfile(ruta):
                    continue  # p. ej. la subcarpeta templates/templates
                caracter = _nombre_a_caracter(os.path.splitext(os.path.basename(ruta))[0])
                if len(caracter) != 1:
                    continue
                plantilla = _preparar_plantilla_cad(ruta)
                if plantilla is not None:
                    plantillas.setdefault(caracter, []).append(plantilla)

        if not plantillas:
            raise RuntimeError(
                "No se han podido cargar plantillas válidas. "
                f"Carpetas buscadas: {buscadas or '(ninguna existente)'}"
            )

        print(f"[{time.strftime('%H:%M:%S')}] Plantillas cargadas para: "
              f"{''.join(sorted(plantillas))} ({sum(len(v) for v in plantillas.values())} archivos)")
        _plantillas_cache = plantillas
        return plantillas


def _preprocesar(imagen):
    """Letras blancas sobre fondo negro: máscara limpia + máscara de cajas."""
    gris = cv2.cvtColor(imagen, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gris, (5, 5), 0)

    # Otsu invertido para asegurar letras blancas y fondo negro
    _, binaria = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    total_pixeles = binaria.shape[0] * binaria.shape[1]
    if np.count_nonzero(binaria) > (total_pixeles // 2):
        binaria = cv2.bitwise_not(binaria)

    # Máscara limpia (conserva los cortes del stencil originales)
    kernel_ruido = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    mascara_limpia = cv2.morphologyEx(binaria, cv2.MORPH_OPEN, kernel_ruido)

    # Máscara de cajas (aisla los contornos completos de cada carácter)
    kernel_cajas = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))
    mascara_cajas = cv2.morphologyEx(mascara_limpia, cv2.MORPH_CLOSE, kernel_cajas)

    return gris, mascara_limpia, mascara_cajas


def _extraer_roi(roi_cruda):
    """Normaliza un recorte de carácter a 64×96 centrado (letra blanca sobre negro)."""
    puntos = cv2.findNonZero(roi_cruda)
    if puntos is None:
        return np.zeros((ALTO_CARACTER, ANCHO_CARACTER), dtype=np.uint8)

    x, y, w, h = cv2.boundingRect(puntos)
    recorte = roi_cruda[y:y + h, x:x + w]

    escala = min((ANCHO_CARACTER - 8) / max(1, w), (ALTO_CARACTER - 8) / max(1, h))
    nuevo_ancho = max(1, int(w * escala))
    nuevo_alto = max(1, int(h * escala))

    recorte = cv2.resize(recorte, (nuevo_ancho, nuevo_alto), interpolation=cv2.INTER_AREA)
    resultado = np.zeros((ALTO_CARACTER, ANCHO_CARACTER), dtype=np.uint8)

    x0 = (ANCHO_CARACTER - nuevo_ancho) // 2
    y0 = (ALTO_CARACTER - nuevo_alto) // 2
    resultado[y0:y0 + nuevo_alto, x0:x0 + nuevo_ancho] = recorte
    return resultado


def _agrupar_lineas(candidatos):
    """Agrupa los bboxes por altura (mismo renglón) y los ordena de izquierda a derecha."""
    candidatos = sorted(candidatos, key=lambda c: c[1])
    lineas: list[list[tuple]] = []
    linea_actual: list[tuple] = []

    if candidatos:
        y_ref, h_ref = candidatos[0][1], candidatos[0][3]
        for c in candidatos:
            x, y, w, h = c
            if abs(y - y_ref) < max(h_ref, h) * 0.5:
                linea_actual.append(c)
            else:
                linea_actual.sort(key=lambda item: item[0])
                lineas.append(linea_actual)
                linea_actual = [c]
                y_ref, h_ref = y, h

        if linea_actual:
            linea_actual.sort(key=lambda item: item[0])
            lineas.append(linea_actual)

    return lineas


def _pipeline_plantillas(placa, datos, identificador, carpeta) -> dict:
    plantillas = cargar_plantillas()
    wf = _Workflow(carpeta, identificador)

    # --- 1. Imagen original ------------------------------------------------
    alto_img, ancho_img = placa.shape[:2]
    wf.paso("original", "Imagen capturada",
            "Fotograma recibido del visor, tal cual sale de la cámara.",
            placa,
            [["Resolución", f"{ancho_img} × {alto_img} px"],
             ["Tamaño", f"{len(datos) / 1024:.0f} KB"]])

    # --- 2. Escala de grises + desenfoque ----------------------------------
    gris, mascara_limpia, mascara_cajas = _preprocesar(placa)
    wf.paso("grises", "Escala de grises",
            "Conversión a un canal y filtro gaussiano 5×5 para calmar el ruido del metal.",
            gris,
            [["Canal", "Gris (8 bits)"],
             ["Filtro", "GaussianBlur 5×5"]])

    # --- 3. Binarización Otsu invertida ------------------------------------
    blancos = int(np.count_nonzero(mascara_limpia)) / mascara_limpia.size
    wf.paso("binaria", "Binarización Otsu",
            "Umbral automático de Otsu e invertido: letras blancas, fondo negro.",
            mascara_limpia,
            [["Umbral", "Otsu (automático)"],
             ["Tinta", f"{blancos * 100:.1f} %"]])

    # --- 4. Cierre morfológico (cajas por carácter) ------------------------
    cajas_img = cv2.cvtColor(mascara_cajas, cv2.COLOR_GRAY2BGR)
    cajas_bin, _ = cv2.findContours(mascara_cajas, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for c in cajas_bin:
        x, y, w, h = cv2.boundingRect(c)
        cv2.rectangle(cajas_img, (x, y), (x + w, y + h), (255, 170, 0), 2)
    wf.paso("cajas", "Cierre morfológico",
            "Un kernel 7×7 sella los huecos del stencil para aislar cada carácter.",
            cajas_img,
            [["Kernel", "Rectangular 7×7"],
             ["Cajas", str(len(cajas_bin))]])

    # --- 5. Filtrado de contornos (candidatos a carácter) ------------------
    contornos, _ = cv2.findContours(mascara_cajas, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidatos: list[tuple] = []
    descartados = 0

    for contorno in contornos:
        x, y, w, h = cv2.boundingRect(contorno)
        valido = (
            15 <= h <= alto_img * 0.80 and
            5 <= w <= ancho_img * 0.25 and
            w / float(max(1, h)) <= 2.0
        )
        if valido:
            candidatos.append((x, y, w, h))

    deteccion_img = placa.copy()
    for contorno in contornos:
        x, y, w, h = cv2.boundingRect(contorno)
        if (x, y, w, h) in candidatos:
            continue
        descartados += 1
        cv2.rectangle(deteccion_img, (x, y), (x + w, y + h), (90, 90, 90), 1)

    for x, y, w, h in candidatos:
        cv2.rectangle(deteccion_img, (x, y), (x + w, y + h), (0, 220, 90), 2)

    wf.paso("contornos", "Candidatos a carácter",
            "Se descartan cajas por tamaño o proporción (ruido, brillos, sombras).",
            deteccion_img,
            [["Válidos", str(len(candidatos))],
             ["Descartados", str(descartados)]])

    # --- 6. Agrupación en líneas -------------------------------------------
    lineas = _agrupar_lineas(candidatos)
    paleta = [(0, 200, 255), (255, 120, 80), (120, 160, 255), (200, 120, 255),
              (120, 255, 160), (255, 220, 90)]
    lineas_img = placa.copy()
    for idx, linea in enumerate(lineas):
        color = paleta[idx % len(paleta)]
        for (x, y, w, h) in linea:
            cv2.rectangle(lineas_img, (x, y), (x + w, y + h), color, 2)
        if linea:
            cv2.putText(lineas_img, f"linea {idx + 1}",
                        (linea[0][0], max(18, linea[0][1] - 6)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2)
    wf.paso("lineas", "Agrupación en líneas",
            "Los caracteres se reagrupan por altura en renglones y se ordenan por la X.",
            lineas_img,
            [["Líneas", str(len(lineas))],
             ["Caracteres", str(len(candidatos))]])

    # --- 7. Matching contra las plantillas CAD -----------------------------
    texto_final: list[str] = []
    caracteres: list[dict] = []
    score_suma = 0.0
    resultado_img = placa.copy()
    indice_global = 0

    print(f"\n[{time.strftime('%H:%M:%S')}] {identificador} · iniciando lectura (plantillas)")

    for idx_linea, linea in enumerate(lineas):
        texto_linea: list[str] = []

        for (x, y, w, h) in linea:
            roi = mascara_limpia[y:y + h, x:x + w]
            caracter_img = _extraer_roi(roi)

            mejor_caracter = "?"
            mejor_puntuacion = -1.0
            for caracter, versiones in plantillas.items():
                for plantilla in versiones:
                    puntuacion = float(
                        cv2.matchTemplate(caracter_img, plantilla, cv2.TM_CCOEFF_NORMED)[0, 0]
                    )
                    if puntuacion > mejor_puntuacion:
                        mejor_puntuacion = puntuacion
                        mejor_caracter = caracter

            aceptado = mejor_puntuacion > UMBRAL_MATCH
            if not aceptado:
                mejor_caracter = "?"
            texto_linea.append(mejor_caracter)
            score_suma += mejor_puntuacion

            cv2.rectangle(resultado_img, (x, y), (x + w, y + h), (0, 255, 0), 2)
            cv2.putText(resultado_img, f"{mejor_caracter} ({mejor_puntuacion:.2f})",
                        (x, max(15, y - 5)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 2)

            # Miniatura del recorte normalizado, para el "chip" del frontend
            miniatura = cv2.cvtColor(caracter_img, cv2.COLOR_GRAY2BGR)
            ruta_mini = _guardar_imagen(
                miniatura, carpeta, identificador, f"char-{indice_global}.png"
            )
            caracteres.append({
                "char": mejor_caracter,
                "score": round(mejor_puntuacion, 3),
                "accepted": aceptado,
                "line": idx_linea,
                "index": len(texto_linea) - 1,
                "box": {"x": x, "y": y, "w": w, "h": h},
                "image": ruta_mini,
                "kind": "char",
            })
            indice_global += 1

        texto_final.append("".join(texto_linea))

    total_caracteres = len(caracteres)
    media_score = (score_suma / total_caracteres) if total_caracteres else 0.0

    wf.paso("detecciones", "Reconocimiento (matching)",
            f"Cada recorte normalizado (64×96) se compara con las plantillas "
            f"CAD usando TM_CCOEFF_NORMED (umbral {UMBRAL_MATCH:.2f}).",
            resultado_img,
            [["Caracteres", str(total_caracteres)],
             ["Confianza media", f"{media_score:.2f}"],
             ["Plantillas", str(sum(len(v) for v in plantillas.values()))]])

    texto = "\n".join(texto_final)
    print(f"[{time.strftime('%H:%M:%S')}] {identificador} · líneas: {len(texto_final)} · "
          f"texto: {texto!r}")

    url_resultado = wf.steps[-1]["image"] or wf.steps[0]["image"]

    return {
        "engine": "plantillas",
        "imageUrl": url_resultado,
        "resultUrl": url_resultado,
        "text": texto,
        "lines": texto_final,
        "workflow": {
            "engine": "plantillas",
            "threshold": UMBRAL_MATCH,
            "steps": wf.steps,
            "chars": caracteres,
        },
    }


# --------------------------------------------------------------------------
# Postprocesado: elige motor y prepara la respuesta
# --------------------------------------------------------------------------
def process_image(datos: bytes, identificador: str, engine: str = DEFAULT_ENGINE,
                  crop: float = RECORTE_DERECHO) -> dict:
    """
    Ejecuta el pipeline del motor pedido sobre la imagen recibida.

    Devuelve un dict listo para la respuesta JSON: URL de la imagen anotada,
    texto reconocido, líneas, caracteres/palabras y los pasos del workflow
    (con la imagen intermedia de cada etapa) para pintarlos en la web.
    """
    if cv2 is None:
        raise RuntimeError(
            f"OpenCV no está instalado ({_ERROR_CV2}). "
            "Instala las dependencias con: pip install -r requirements.txt"
        )

    buf = np.frombuffer(datos, np.uint8)
    placa = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if placa is None:
        raise RuntimeError("No se pudo decodificar la imagen recibida.")

    carpeta = os.path.join(UPLOAD_DIR, identificador)
    os.makedirs(carpeta, exist_ok=True)

    if engine == "tesseract":
        ruta, motivo = estado_tesseract()
        if ruta is None:
            raise RuntimeError(f"Tesseract no disponible: {motivo}")
        return _pipeline_tesseract(placa, datos, identificador, carpeta, crop)

    if engine == "plantillas":
        return _pipeline_plantillas(placa, datos, identificador, carpeta)

    raise RuntimeError(f"Motor desconocido: {engine!r}. Opciones: {', '.join(ENGINES)}")


# --------------------------------------------------------------------------
# Handler HTTP
# --------------------------------------------------------------------------
class Handler(SimpleHTTPRequestHandler):
    server_version = "LecturaChapa/2.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # ---------------------------- utilidades ------------------------------
    def _json(self, codigo: int, payload: dict) -> None:
        cuerpo = json.dumps(payload, indent=2, ensure_ascii=False).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(cuerpo)))
        self.end_headers()
        self.wfile.write(cuerpo)

    def end_headers(self) -> None:
        # CORS abierto en TODA la respuesta: la web puede publicarse en otro
        # origen (GitHub Pages, un servidor de ficheros estáticos…) y seguir
        # leyendo las imágenes de /uploads/ y el JSON del API.
        # `Access-Control-Allow-Private-Network` es lo que permite que una
        # página HTTPS llamada desde Internet acceda a este servidor local
        # (Private Network Access de Chrome/Edge, vía preflight OPTIONS).
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        # Evita que el navegador cachee el frontend durante el desarrollo.
        if not self.path.startswith("/uploads/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _es_privado(self) -> bool:
        return os.path.basename(urlparse(self.path).path) in PRIVATE

    # ------------------------------- GET ----------------------------------
    def do_GET(self) -> None:
        if self._es_privado():
            self.send_error(403, "Acceso denegado")
            return

        if urlparse(self.path).path == "/api/health":
            ruta_tess, motivo_tess = estado_tesseract()
            self._json(200, {
                "ok": True,
                "service": "lectura-chapa",
                "opencv": cv2 is not None,
                "defaultEngine": DEFAULT_ENGINE,
                "engines": {
                    "plantillas": {"available": cv2 is not None},
                    "tesseract": {
                        "available": ruta_tess is not None,
                        "cmd": ruta_tess,
                        "error": motivo_tess,
                        "config": TESSERACT_CONFIG,
                    },
                },
            })
            return

        super().do_GET()

    def do_HEAD(self) -> None:
        if self._es_privado():
            self.send_error(403, "Acceso denegado")
            return
        super().do_HEAD()

    def do_OPTIONS(self) -> None:
        # Preflight CORS (lo importante aquí es el bloqueo de red privada).
        # Access-Control-Allow-Origin lo añade end_headers().
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    # ------------------------------- POST ---------------------------------
    def do_POST(self) -> None:
        partes = urlparse(self.path)

        if partes.path != "/api/process":
            self._json(404, {"ok": False, "error": "Ruta no encontrada"})
            return

        content_type = self.headers.get("Content-Type", "")
        if not content_type.startswith("multipart/form-data"):
            self._json(415, {
                "ok": False,
                "error": 'Se esperaba multipart/form-data con el campo "image".',
                "recibido": content_type or "(sin Content-Type)",
            })
            return

        try:
            longitud = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            longitud = 0

        if longitud <= 0:
            self._json(411, {"ok": False, "error": "Falta Content-Length."})
            return
        if longitud > MAX_BYTES:
            self._json(413, {"ok": False, "error": f"Máximo {MAX_BYTES // (1024 * 1024)} MB."})
            return

        cuerpo = self.rfile.read(longitud)
        campos, archivos = parse_multipart(content_type, cuerpo)

        if not archivos:
            self._json(400, {
                "ok": False,
                "error": "No se encontró ningún archivo en el formulario.",
                "camposRecibidos": sorted(campos),
            })
            return

        nombre, datos, mime = next(iter(archivos.values()))
        identificador = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"

        parametros = parse_qs(partes.query)

        def parametro(clave, defecto):
            return parametros.get(clave, [defecto])[0]

        # --- Motor de postprocesado ----------------------------------------
        pedido = parametro("engine", "").strip().lower()
        if pedido and pedido not in ENGINES:
            self._json(400, {
                "ok": False,
                "error": f"Motor desconocido: {pedido!r}. Opciones: {', '.join(ENGINES)}.",
            })
            return

        engine = pedido or DEFAULT_ENGINE
        avisos: list[str] = []
        if not pedido and engine == "tesseract" and estado_tesseract()[0] is None:
            # Sin petición explícita, si Tesseract no está, no rompemos la demo.
            engine = "plantillas"
            avisos.append(f"Tesseract no disponible ({estado_tesseract()[1]}); "
                          "se usa el motor de plantillas.")

        # --- Recorte lateral (?crop=0.9) -----------------------------------
        try:
            crop = float(parametro("crop", str(RECORTE_DERECHO)))
        except ValueError:
            crop = RECORTE_DERECHO
        crop = min(1.0, max(0.1, crop))

        try:
            retardo = int(parametro("delay", str(DEFAULT_DELAY_MS)))
        except ValueError:
            retardo = DEFAULT_DELAY_MS

        inicio = time.time()
        time.sleep(max(0, retardo) / 1000.0)

        try:
            resultado = process_image(datos, identificador, engine=engine, crop=crop)
        except Exception as error:  # noqa: BLE001
            self._json(500, {"ok": False, "error": f"Fallo al procesar: {error}"})
            return

        print(f"[{time.strftime('%H:%M:%S')}] {identificador} · {nombre} · "
              f"{len(datos) / 1024:.0f} KB · {mime} · motor: {resultado['engine']}")

        lineas = resultado.get("lines", [])
        etiqueta = "OCR" if resultado["engine"] == "tesseract" else "Matching"
        self._json(200, {
            "ok": True,
            "id": identificador,
            "engine": resultado["engine"],
            "imageUrl": resultado["imageUrl"],
            "resultUrl": resultado["resultUrl"],
            "text": resultado.get("text", ""),
            "lines": lineas,
            "workflow": resultado.get("workflow"),
            "message": f"{etiqueta} finalizado: {len(lineas)} línea(s) reconocida(s).",
            "meta": {
                "originalName": nombre,
                "contentType": mime,
                "bytes": len(datos),
                "transforms": (
                    ["recorte-lateral", "otsu", "morfologia-stencil", "tesseract-ocr"]
                    if resultado["engine"] == "tesseract"
                    else ["escala-de-grises", "otsu", "morfologia-cajas",
                          "segmentacion-contornos", "matching-plantillas"]
                ),
                "processingMs": int((time.time() - inicio) * 1000),
                "receivedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "client": campos,
                "warnings": avisos,
            },
        })


def main() -> None:
    os.makedirs(UPLOAD_DIR, exist_ok=True)

    if cv2 is None:
        print("\n  ¡Aviso! OpenCV no está instalado: /api/process devolverá error 500.")
        print("  Solución:  pip install -r requirements.txt\n")
    else:
        try:
            cargar_plantillas()  # fallo temprano si faltan las plantillas
        except RuntimeError as error:
            print(f"\n  ¡Aviso! {error}\n")

    ruta_tess, motivo_tess = estado_tesseract()
    if ruta_tess is None:
        print(f"\n  ¡Aviso! Tesseract no disponible: {motivo_tess}")
        print("  El motor 'plantillas' sigue funcionando.\n")

    servidor = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"\n  Servidor de lectura de chapa escuchando en http://localhost:{PORT}")
    print(f"  Frontend  -> http://localhost:{PORT}/")
    print(f"  Endpoint  -> POST http://localhost:{PORT}/api/process?engine={DEFAULT_ENGINE}\n")
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print("\nDetenido.")
    finally:
        servidor.server_close()


if __name__ == "__main__":
    main()
