#!/usr/bin/env node
/* =========================================================================
 * Mock de servidor de postprocesado — Node.js, SIN dependencias.
 * -------------------------------------------------------------------------
 *   node server.js            → http://localhost:3000
 *   PORT=8080 node server.js
 *
 * Sirve el frontend (index.html, styles.css, app.js) y expone:
 *   POST /api/process   → recibe la imagen (multipart/form-data, campo "image")
 *   GET  /api/health    → comprobación rápida
 *   GET  /uploads/<id>  → devuelve la imagen "procesada" guardada
 *
 * El "postprocesado" es simulado: guarda el archivo recibido tal cual y
 * responde con metadatos. Sustituye processImage() por tu lógica real
 * (sharp, Jimp, llamada a un servicio externo, etc.).
 * ========================================================================= */
'use strict';

const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const DEFAULT_DELAY_MS = 600;       // latencia simulada del postprocesado

/* --------------------------- utilidades HTTP ---------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// Archivos que nunca se sirven aunque estén en la carpeta.
const PRIVATE = new Set(['server.js', 'server.py', 'package.json', 'README.md']);

function sendText(res, status, message) {
  const body = Buffer.from(message, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    // CORS abierto: útil si sirves el frontend desde otro origen durante el desarrollo.
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req, limit = MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Cuerpo de la petición demasiado grande'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ----------------------- parser multipart binario ----------------------- */
function parseHeaders(raw) {
  const headers = {};
  for (const line of raw.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return headers;
}

/**
 * Parser mínimo y binario-seguro de multipart/form-data.
 * Devuelve [{ name, filename, contentType, data }].
 */
function parseMultipart(buffer, boundary) {
  const parts = [];
  const delimiter = Buffer.from(`--${boundary}`);
  let cursor = buffer.indexOf(delimiter);
  if (cursor === -1) return parts;
  cursor += delimiter.length;

  while (cursor < buffer.length) {
    // "--" marca el final del multipart
    if (buffer[cursor] === 0x2d && buffer[cursor + 1] === 0x2d) break;
    if (buffer[cursor] === 0x0d && buffer[cursor + 1] === 0x0a) cursor += 2;

    const headerEnd = buffer.indexOf('\r\n\r\n', cursor, 'latin1');
    if (headerEnd === -1) break;

    const headers = parseHeaders(buffer.subarray(cursor, headerEnd).toString('latin1'));
    const bodyStart = headerEnd + 4;
    const next = buffer.indexOf(delimiter, bodyStart);
    if (next === -1) break;

    let bodyEnd = next;
    if (buffer[bodyEnd - 2] === 0x0d && buffer[bodyEnd - 1] === 0x0a) bodyEnd -= 2;

    const disposition = headers['content-disposition'] || '';
    parts.push({
      name: disposition.match(/name="([^"]*)"/i)?.[1] || '',
      filename: disposition.match(/filename="([^"]*)"/i)?.[1] || null,
      contentType: headers['content-type'] || 'application/octet-stream',
      data: buffer.subarray(bodyStart, bodyEnd),
    });

    cursor = next + delimiter.length;
  }

  return parts;
}

/* ------------------- postprocesado (aquí va tu lógica) ------------------ */
/**
 * Recibe la imagen original y devuelve la ruta pública del resultado.
 * EJEMPLO con la librería sharp:
 *     const sharp = require('sharp');
 *     await sharp(inputBuffer).grayscale().normalize().jpeg({ quality: 90 })
 *       .toFile(outputPath);
 *
 * @param {Buffer} input  Bytes de la imagen recibida.
 * @param {string} id     Identificador de la captura.
 * @returns {Promise<string>} URL pública del resultado.
 */
async function processImage(input, id) {
  const outputPath = path.join(UPLOAD_DIR, `${id}.jpg`);
  await fsp.writeFile(outputPath, input);
  return `/uploads/${id}.jpg`;
}

/* ------------------------------ rutas ---------------------------------- */
async function handleProcess(req, res, url) {
  const ctype = req.headers['content-type'] || '';
  if (!ctype.startsWith('multipart/form-data')) {
    return sendJson(res, 415, {
      ok: false,
      error: 'Se esperaba multipart/form-data con el campo "image".',
      recibido: ctype || '(sin Content-Type)',
    });
  }

  const boundary = ctype.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundary) {
    return sendJson(res, 400, { ok: false, error: 'Falta el boundary del multipart.' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    return sendJson(res, error.status || 500, { ok: false, error: error.message });
  }

  const parts = parseMultipart(body, boundary[1] || boundary[2]);
  const filePart = parts.find((p) => p.filename && p.data.length);
  const fields = Object.fromEntries(
    parts.filter((p) => !p.filename).map((p) => [p.name, p.data.toString('utf8')])
  );

  if (!filePart) {
    return sendJson(res, 400, {
      ok: false,
      error: 'No se encontró ningún archivo en el formulario.',
      camposRecibidos: parts.map((p) => p.name),
    });
  }

  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const delay = Number(url.searchParams.get('delay') ?? DEFAULT_DELAY_MS);
  const startedAt = Date.now();

  // Latencia simulada para poder ver el estado "Postprocesando…" del frontend.
  await new Promise((r) => setTimeout(r, Number.isFinite(delay) && delay >= 0 ? delay : DEFAULT_DELAY_MS));

  let imageUrl;
  try {
    imageUrl = await processImage(filePart.data, id);
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: `Fallo al procesar: ${error.message}` });
  }

  console.log(
    `[${new Date().toISOString()}] ${id} · ${filePart.filename} · ` +
    `${(filePart.data.length / 1024).toFixed(0)} KB · ${filePart.contentType}`
  );

  return sendJson(res, 200, {
    ok: true,
    id,
    imageUrl,
    // Los clientes suelen aceptar cualquiera de estas claves:
    resultUrl: imageUrl,
    message: 'Postprocesado simulado: se devuelve la imagen recibida.',
    meta: {
      originalName: filePart.filename,
      contentType: filePart.contentType,
      bytes: filePart.data.length,
      transforms: ['mock:copiar'], // ← aquí lo que haga tu pipeline real
      processingMs: Date.now() - startedAt,
      receivedAt: new Date().toISOString(),
      client: { ...fields },
    },
  });
}

async function handleStatic(req, res, url) {
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const abs = path.resolve(ROOT, `.${decodeURIComponent(rel)}`);

  // Sin salir de la carpeta del proyecto
  if (!abs.startsWith(ROOT + path.sep) || PRIVATE.has(path.basename(abs))) {
    return sendText(res, 403, 'Acceso denegado');
  }

  const ext = path.extname(abs).toLowerCase();
  const type = MIME[ext];
  if (!type) return sendText(res, 404, 'No encontrado');

  try {
    const data = await fsp.readFile(abs);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    sendText(res, 404, 'No encontrado');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/api/process') {
      return await handleProcess(req, res, url);
    }
    if (url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, service: 'mock-postprocesado', uptime: process.uptime() });
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      return await handleStatic(req, res, url);
    }
    sendText(res, 405, 'Método no permitido');
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

fsp.mkdir(UPLOAD_DIR, { recursive: true }).then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`\n  Mock de postprocesado escuchando en http://localhost:${PORT}`);
    console.log(`  Frontend  → http://localhost:${PORT}/`);
    console.log(`  Endpoint  → POST http://localhost:${PORT}/api/process\n`);
  });
});
