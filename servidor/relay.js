// Servidor de relevo de "Los Hornos Rebeldes".
//
// Para qué sirve: los dos celulares no pueden conectarse directamente por
// internet (routers, datos móviles...). Así que ambos se conectan A ESTE
// servidor, y él les pasa los mensajes. No entiende el juego: solo junta a
// dos jugadores en una "sala" con un código de 4 letras y reenvía lo que
// manda uno al otro.
//
// No tiene dependencias: solo usa módulos que ya trae Node (versión 18 o
// más nueva). Uso:   node relay.js        (o:  npm start)
// Puerto: variable de entorno PORT (por defecto 8080).

const http = require('http');
const crypto = require('crypto');

const PUERTO = parseInt(process.env.PORT || '8080', 10);
const MAX_SALAS = 500;                 // para que no se llene la memoria
const MINUTOS_SIN_PAREJA = 10;         // una sala sin segundo jugador se borra
const MAX_BYTES_MENSAJE = 256 * 1024;  // los mensajes del juego pesan ~1 KB
const MAX_BYTES_PENDIENTES = 256 * 1024; // si un jugador no recibe, se descartan datos viejos
const LETRAS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin O/0, I/1/L para no confundir
const GUID_WEBSOCKET = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const salas = new Map(); // codigo -> { host, cliente, creada }

function nuevoCodigo() {
  for (let intento = 0; intento < 50; intento++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += LETRAS[crypto.randomInt(LETRAS.length)];
    if (!salas.has(c)) return c;
  }
  return null;
}

// ---------- Una conexión WebSocket (protocolo RFC 6455, lo mínimo necesario) ----------

class Conexion {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.fragmentos = [];
    this.tipoFragmentado = 1;
    this.abierta = true;
    this.cerrada = false;
    this.vivo = true;
    this.sala = null;   // código de la sala en la que está
    this.rol = null;    // 'host' o 'cliente'

    socket.setNoDelay(true);
    socket.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.procesar();
    });
    socket.on('close', () => this.alCerrarSocket());
    socket.on('error', () => {});
  }

  // Saca del buffer todos los "frames" completos que haya llegado
  procesar() {
    while (this.abierta) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const conMascara = (b1 & 0x80) !== 0;
      let largo = b1 & 0x7f;
      let pos = 2;
      if (largo === 126) {
        if (this.buf.length < 4) return;
        largo = this.buf.readUInt16BE(2);
        pos = 4;
      } else if (largo === 127) {
        if (this.buf.length < 10) return;
        if (this.buf.readUInt32BE(2) !== 0) { this.cerrar(1009); return; }
        largo = this.buf.readUInt32BE(6);
        pos = 10;
      }
      if (!conMascara) { this.cerrar(1002); return; }   // los clientes siempre enmascaran
      if (largo > MAX_BYTES_MENSAJE) { this.cerrar(1009); return; }
      if (this.buf.length < pos + 4 + largo) return;     // falta que llegue el resto

      const mascara = this.buf.subarray(pos, pos + 4);
      const datos = Buffer.from(this.buf.subarray(pos + 4, pos + 4 + largo));
      for (let i = 0; i < largo; i++) datos[i] ^= mascara[i & 3];
      this.buf = this.buf.subarray(pos + 4 + largo);
      this.alFrame(fin, op, datos);
    }
  }

  alFrame(fin, op, datos) {
    if (op === 8) { this.cerrar(1000); return; }                       // cerrar
    if (op === 9) { this.enviarFrame(10, datos); return; }             // ping -> pong
    if (op === 10) { this.vivo = true; return; }                       // pong
    if (op > 2) return;                                                // desconocido
    if (op !== 0) { this.tipoFragmentado = op; this.fragmentos = []; } // texto o binario
    this.fragmentos.push(datos);
    if (fin) {
      const completo = Buffer.concat(this.fragmentos);
      this.fragmentos = [];
      alMensaje(this, completo, this.tipoFragmentado === 2);
    }
  }

  enviarFrame(op, datos) {
    if (!this.abierta) return;
    const largo = datos.length;
    let cabecera;
    if (largo < 126) {
      cabecera = Buffer.from([0x80 | op, largo]);
    } else if (largo < 65536) {
      cabecera = Buffer.alloc(4);
      cabecera[0] = 0x80 | op; cabecera[1] = 126; cabecera.writeUInt16BE(largo, 2);
    } else {
      cabecera = Buffer.alloc(10);
      cabecera[0] = 0x80 | op; cabecera[1] = 127; cabecera.writeUInt32BE(0, 2); cabecera.writeUInt32BE(largo, 6);
    }
    this.socket.write(Buffer.concat([cabecera, datos]));
  }

  enviarJson(obj) { this.enviarFrame(1, Buffer.from(JSON.stringify(obj))); }

  enviarBinario(datos) {
    // Si este jugador no está recibiendo (conexión lenta), mejor descartar
    // que acumular datos viejos en memoria.
    if (this.socket.writableLength > MAX_BYTES_PENDIENTES) return;
    this.enviarFrame(2, datos);
  }

  ping() { this.enviarFrame(9, Buffer.alloc(0)); }

  cerrar(codigo) {
    if (!this.abierta) return;
    this.enviarFrame(8, Buffer.from([(codigo >> 8) & 255, codigo & 255]));
    this.abierta = false;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }

  alCerrarSocket() {
    if (this.cerrada) return;
    this.cerrada = true;
    this.abierta = false;
    alDesconectar(this);
  }
}

// ---------- Lógica de las salas ----------

function alMensaje(ws, datos, esBinario) {
  // Datos del juego: se reenvían tal cual al otro jugador de la sala.
  if (esBinario) {
    const sala = salas.get(ws.sala);
    if (!sala) return;
    const otro = ws.rol === 'host' ? sala.cliente : sala.host;
    if (otro) otro.enviarBinario(datos);
    return;
  }

  // Mensajes de control (texto JSON)
  let msg;
  try { msg = JSON.parse(datos.toString()); } catch (e) { return; }
  if (ws.sala || typeof msg !== 'object' || msg === null) return; // ya está en una sala

  if (msg.t === 'crear') {
    if (salas.size >= MAX_SALAS) {
      ws.enviarJson({ t: 'error', m: 'El servidor está lleno. Intenta en un rato.' });
      return;
    }
    const codigo = nuevoCodigo();
    if (!codigo) {
      ws.enviarJson({ t: 'error', m: 'No se pudo crear la sala.' });
      return;
    }
    salas.set(codigo, { host: ws, cliente: null, creada: Date.now() });
    ws.sala = codigo;
    ws.rol = 'host';
    ws.enviarJson({ t: 'creada', codigo });
    console.log(`[sala ${codigo}] creada (${salas.size} salas)`);
  } else if (msg.t === 'unir') {
    const codigo = String(msg.codigo || '').toUpperCase().trim();
    const sala = salas.get(codigo);
    if (!sala) {
      ws.enviarJson({ t: 'error', m: 'No existe una partida con ese código.' });
      return;
    }
    if (sala.cliente) {
      ws.enviarJson({ t: 'error', m: 'Esa partida ya tiene dos jugadores.' });
      return;
    }
    sala.cliente = ws;
    ws.sala = codigo;
    ws.rol = 'cliente';
    ws.enviarJson({ t: 'unido' });
    sala.host.enviarJson({ t: 'par_unido' });
    console.log(`[sala ${codigo}] se unió el segundo jugador`);
  }
}

function alDesconectar(ws) {
  const sala = salas.get(ws.sala);
  if (!sala) return;
  if (ws.rol === 'host') {
    // Si se va el anfitrión, la partida se acaba
    if (sala.cliente) {
      sala.cliente.enviarJson({ t: 'par_salio' });
      sala.cliente.cerrar(1000);
    }
    salas.delete(ws.sala);
    console.log(`[sala ${ws.sala}] cerrada (se fue el anfitrión)`);
  } else if (sala.cliente === ws) {
    // Si se va el cliente, el anfitrión puede esperar a otro
    sala.cliente = null;
    sala.sinParejaDesde = Date.now();
    sala.host.enviarJson({ t: 'par_salio' });
    console.log(`[sala ${ws.sala}] el segundo jugador se fue`);
  }
}

// ---------- Servidor HTTP (con "upgrade" a WebSocket) ----------

// ---------- Marcadores ----------
// tabla "infinito": gana la ronda más alta. Las demás ("rush", "diario-NNNNN"):
// gana el tiempo más bajo (segundos). Se guarda en memoria y en puntajes.json
// (en el plan gratis de Render el disco se borra al redesplegar o reiniciar).
const fs = require('fs');
const ARCHIVO_PUNTAJES = process.env.PUNTAJES_ARCHIVO || 'puntajes.json';
const MAX_TABLAS = 80;
const TOP = 20;
const tablas = new Map(); // tabla -> Map(nombre -> valor)

try {
  const crudo = JSON.parse(fs.readFileSync(ARCHIVO_PUNTAJES, 'utf8'));
  for (const [t, filas] of Object.entries(crudo)) tablas.set(t, new Map(Object.entries(filas)));
} catch (e) { /* primera vez */ }

let guardando = null;
function guardarPuntajes() {
  if (guardando) return;
  guardando = setTimeout(() => {
    guardando = null;
    const o = {};
    for (const [t, m] of tablas) o[t] = Object.fromEntries(m);
    fs.writeFile(ARCHIVO_PUNTAJES, JSON.stringify(o), () => {});
  }, 5000);
  guardando.unref();
}

const mejorEsMayor = (tabla) => tabla === 'infinito';
const tablaValida = (t) => /^[a-z0-9-]{1,20}$/.test(t);

function ordenado(tabla) {
  const m = tablas.get(tabla) || new Map();
  const filas = [...m.entries()].map(([nombre, valor]) => ({ nombre, valor }));
  filas.sort((a, b) => (mejorEsMayor(tabla) ? b.valor - a.valor : a.valor - b.valor));
  return filas.slice(0, TOP);
}

function limpiarNombre(n) {
  return String(n || '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 12);
}

const visitas = new Map(); // ip -> [contador, ventana]
function demasiadas(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const ahora = Math.floor(Date.now() / 60000);
  const v = visitas.get(ip);
  if (!v || v[1] !== ahora) { visitas.set(ip, [1, ahora]); return false; }
  v[0]++;
  return v[0] > 60;
}

function responder(res, codigo, obj) {
  res.writeHead(codigo, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(obj));
}

function recibirPuntaje(req, res) {
  let cuerpo = '';
  req.on('data', (d) => { cuerpo += d; if (cuerpo.length > 2000) req.destroy(); });
  req.on('end', () => {
    let m;
    try { m = JSON.parse(cuerpo); } catch (e) { return responder(res, 400, { ok: false }); }
    const tabla = String(m.tabla || '');
    const nombre = limpiarNombre(m.nombre);
    const valor = Number(m.valor);
    if (!tablaValida(tabla) || !nombre || !Number.isFinite(valor)) return responder(res, 400, { ok: false });
    if (tabla === 'infinito' ? (valor < 1 || valor > 999) : (valor < 5 || valor > 36000)) return responder(res, 400, { ok: false });
    if (!tablas.has(tabla)) {
      if (tablas.size >= MAX_TABLAS) return responder(res, 400, { ok: false });
      tablas.set(tabla, new Map());
    }
    const filas = tablas.get(tabla);
    const antes = filas.get(nombre);
    const valorFinal = mejorEsMayor(tabla) ? Math.round(valor) : Math.round(valor * 10) / 10;
    if (antes === undefined || (mejorEsMayor(tabla) ? valorFinal > antes : valorFinal < antes)) {
      filas.set(nombre, valorFinal);
      guardarPuntajes();
    }
    responder(res, 200, { ok: true, top: ordenado(tabla) });
  });
}

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return responder(res, 204, {});
  if (url.pathname === '/top' && req.method === 'GET') {
    if (demasiadas(req)) return responder(res, 429, { ok: false });
    const tabla = url.searchParams.get('tabla') || '';
    if (!tablaValida(tabla)) return responder(res, 400, { ok: false });
    return responder(res, 200, { ok: true, top: ordenado(tabla) });
  }
  if (url.pathname === '/puntaje' && req.method === 'POST') {
    if (demasiadas(req)) return responder(res, 429, { ok: false });
    return recibirPuntaje(req, res);
  }
  // Respuesta simple para comprobar desde el navegador que está funcionando
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(`Servidor de relevo de Los Hornos Rebeldes: activo (${salas.size} salas)\n`);
});

const conexiones = new Set();

servidor.on('upgrade', (req, socket) => {
  const clave = req.headers['sec-websocket-key'];
  const quiereWs = String(req.headers['upgrade'] || '').toLowerCase() === 'websocket';
  if (!clave || !quiereWs) { socket.destroy(); return; }
  const aceptar = crypto.createHash('sha1').update(clave + GUID_WEBSOCKET).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${aceptar}\r\n\r\n`
  );
  const ws = new Conexion(socket);
  conexiones.add(ws);
  socket.on('close', () => conexiones.delete(ws));
});

// Cada 25 segundos: se revisa que sigan conectados (y se mantiene viva la
// conexión, porque muchos servicios gratis cortan las que están quietas).
setInterval(() => {
  for (const ws of conexiones) {
    if (!ws.vivo) { ws.socket.destroy(); continue; }
    ws.vivo = false;
    ws.ping();
  }
  // Salas a las que nadie se unió en un buen rato
  const limite = Date.now() - MINUTOS_SIN_PAREJA * 60 * 1000;
  for (const [codigo, sala] of salas) {
    if (!sala.cliente && (sala.sinParejaDesde || sala.creada) < limite) {
      sala.host.cerrar(1000);
      salas.delete(codigo);
    }
  }
}, 25000).unref();

servidor.listen(PUERTO, () => {
  console.log(`Servidor de relevo escuchando en el puerto ${PUERTO}`);
});
