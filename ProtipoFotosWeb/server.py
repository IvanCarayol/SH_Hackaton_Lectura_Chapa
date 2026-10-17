#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Mock de servidor de postprocesado - Python 3, SOLO biblioteca estándar.

    python server.py            -> http://localhost:3000
    PORT=8080 python server.py

Sirve el frontend (index.html, styles.css, app.js) y expone:

    POST /api/process   recibe la imagen (multipart/form-data, campo "image")
    GET  /api/health    comprobación rápida
    GET  /uploads/<id>  devuelve la imagen "procesada" guardada

El "postprocesado" es simulado: guarda el archivo recibido tal cual y responde
con metadatos. Sustituye process_image() por tu lógica real (Pillow, rembg,
OpenCV, una llamada a otro servicio, ...).
"""

from __future__ import annotations

import json
import os
import sys
import time
import uuid
from email import policy
from email.parser import BytesParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(ROOT, "uploads")
PORT = int(os.environ.get("PORT", "3000"))
HOST = os.environ.get("HOST", "0.0.0.0")
MAX_BYTES = 25 * 1024 * 1024  # 25 MB
DEFAULT_DELAY_MS = 600       # latencia simulada del postprocesado

# Archivos que nunca se sirven aunque estén en la carpeta.
PRIVATE = {"server.py", "server.js", "package.json", "README.md"}


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
# Postprocesado (aquí va tu lógica real)
# --------------------------------------------------------------------------
def process_image(datos: bytes, identificador: str) -> str:
    """
    Recibe la imagen original y devuelve la URL pública del resultado.

    EJEMPLO con Pillow:
        from PIL import Image, ImageEnhance
        import io
        imagen = Image.open(io.BytesIO(datos)).convert("RGB")
        imagen = ImageEnhance.Contrast(imagen).enhance(1.2)
        imagen.save(destino, "JPEG", quality=90)
    """
    destino = os.path.join(UPLOAD_DIR, f"{identificador}.jpg")
    with open(destino, "wb") as f:
        f.write(datos)
    return f"/uploads/{identificador}.jpg"


# --------------------------------------------------------------------------
# Handler HTTP
# --------------------------------------------------------------------------
class Handler(SimpleHTTPRequestHandler):
    server_version = "MockPostprocesado/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # ---------------------------- utilidades ------------------------------
    def _json(self, codigo: int, payload: dict) -> None:
        cuerpo = json.dumps(payload, indent=2, ensure_ascii=False).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(cuerpo)))
        self.send_header("Cache-Control", "no-store")
        # CORS abierto: útil si sirves el frontend desde otro origen en desarrollo.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(cuerpo)

    def end_headers(self) -> None:
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
            self._json(200, {"ok": True, "service": "mock-postprocesado"})
            return

        super().do_GET()

    def do_HEAD(self) -> None:
        if self._es_privado():
            self.send_error(403, "Acceso denegado")
            return
        super().do_HEAD()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
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
        try:
            retardo = int(parametros.get("delay", [DEFAULT_DELAY_MS])[0])
        except ValueError:
            retardo = DEFAULT_DELAY_MS

        inicio = time.time()
        time.sleep(max(0, retardo) / 1000.0)

        try:
            image_url = process_image(datos, identificador)
        except Exception as error:  # noqa: BLE001
            self._json(500, {"ok": False, "error": f"Fallo al procesar: {error}"})
            return

        print(f"[{time.strftime('%H:%M:%S')}] {identificador} · {nombre} · "
              f"{len(datos) / 1024:.0f} KB · {mime}")

        self._json(200, {
            "ok": True,
            "id": identificador,
            "imageUrl": image_url,
            "resultUrl": image_url,
            "message": "Postprocesado simulado: se devuelve la imagen recibida.",
            "meta": {
                "originalName": nombre,
                "contentType": mime,
                "bytes": len(datos),
                "transforms": ["mock:copiar"],  # <- lo que haga tu pipeline real
                "processingMs": int((time.time() - inicio) * 1000),
                "receivedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "client": campos,
            },
        })


def main() -> None:
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    servidor = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"\n  Mock de postprocesado escuchando en http://localhost:{PORT}")
    print(f"  Frontend  -> http://localhost:{PORT}/")
    print(f"  Endpoint  -> POST http://localhost:{PORT}/api/process\n")
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print("\nDetenido.")
    finally:
        servidor.server_close()


if __name__ == "__main__":
    main()
