#!/usr/bin/env node
/**
 * download-fotos.js
 * Descarga imágenes de productos desde el Sheet "Fotos Vtex ARG"
 * y las sube a la carpeta de Drive Fotos_SKU_Puppis.
 *
 * USO:
 *   node download-fotos.js           → descarga solo SKUs del boletín activo
 *   node download-fotos.js --todos   → descarga todos los SKUs del sheet de fotos
 *   node download-fotos.js --dry-run → muestra qué descargaría sin hacerlo
 */

const { google } = require('googleapis');
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// ── Configuración ─────────────────────────────────────────────────────────────
const FOTOS_SHEET_ID  = '1e-roi2WbOFnV4dap96PZbUbOJoaoRpdzWH3XNRNjcWw';
const FOTOS_TAB       = 'Fotoss';   // ← nombre exacto de la pestaña
const COL_SKU         = 1;          // columna B (0-indexed)
const COL_URL         = -1;         // -1 = autodetectar columna con URLs http

const PROMOS_SHEET_ID = '1Hnoh8JfEup2avyFs0jCQZfgOtIH22rebi2w6EDOogQo';
const PROMOS_TAB      = 'Promos';

const DRIVE_FOLDER_ID = '12MphbEbTzKruIjamqpBj_gY8CeeVycZ5';
const CREDS_PATH      = path.join(__dirname, 'credentials.json');

const CONCURRENCIA    = 5;   // descargas simultáneas
const PAUSA_MS        = 300; // ms entre lotes

// ── Args ──────────────────────────────────────────────────────────────────────
const MODO_TODOS  = process.argv.includes('--todos');
const DRY_RUN     = process.argv.includes('--dry-run');
const DEBUG       = process.argv.includes('--debug');

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchBuffer(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects === 0) return reject(new Error('Demasiadas redirecciones'));
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { timeout: 15000 }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        return resolve(fetchBuffer(res.headers.location, redirects - 1));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] || 'image/jpeg' }));
      res.on('error', reject);
    }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
  });
}

function ext(contentType) {
  if (contentType.includes('png'))  return '.png';
  if (contentType.includes('webp')) return '.jpg'; // Canva acepta jpg aunque sea webp internamente
  if (contentType.includes('gif'))  return '.gif';
  return '.jpg';
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 download-fotos.js iniciado');
  console.log(`   Modo: ${MODO_TODOS ? 'TODOS los SKUs' : 'Solo SKUs del boletín'}${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

  // Auth con scope de escritura en Drive
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDS_PATH,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets.readonly',
      'https://www.googleapis.com/auth/drive',
    ],
  });
  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: authClient });
  const drive  = google.drive({ version: 'v3', auth: authClient });

  // ── 1. Leer mapa SKU → URL desde Fotos Vtex ARG ───────────────────────────
  console.log(`📋 Leyendo sheet de fotos (${FOTOS_TAB})...`);
  const fotosResp = await sheets.spreadsheets.values.get({
    spreadsheetId: FOTOS_SHEET_ID,
    range: `'${FOTOS_TAB}'`,
  });

  const fotasRows = fotosResp.data.values || [];
  const headers   = fotasRows[0] || [];

  // Autodetectar columna de URL si no está configurada
  let colUrl = COL_URL;
  if (colUrl === -1) {
    // Buscar columna que contenga URLs en las primeras 10 filas de datos
    for (let c = 0; c < headers.length; c++) {
      const sample = fotasRows.slice(1, 11).map(r => String(r[c] || ''));
      const httpCount = sample.filter(v => v.includes('http') || v.startsWith('//')).length;
      if (httpCount >= 3) { colUrl = c; break; }
    }
    console.log(`   Columna URL autodetectada: ${colUrl} (${headers[colUrl] || '?'}) — letra ${String.fromCharCode(65 + colUrl)}`);
  }

  if (DEBUG) {
    console.log('\n🔍 DEBUG — primeras 5 filas:');
    console.log('   Headers:', headers.map((h, i) => `[${i}]${h}`).join(' | '));
    for (let i = 1; i <= 5 && i < fotasRows.length; i++) {
      const r = fotasRows[i];
      console.log(`   Fila ${i}: SKU=${r[COL_SKU]} | URL_col${colUrl}=${String(r[colUrl]||'').slice(0,60)}`);
    }
    console.log('');
  }

  const mapaUrls  = {};
  for (let i = 1; i < fotasRows.length; i++) {
    const row = fotasRows[i];
    const sku = String(row[COL_SKU] || '').trim();
    let   url = String(row[colUrl]  || '').trim();
    if (!sku || !url) continue;
    if (url.startsWith('//'))    url = 'https:' + url;
    if (!url.startsWith('http')) url = 'https://' + url;
    mapaUrls[sku] = url;
  }
  console.log(`   ${Object.keys(mapaUrls).length} SKUs con URL en el sheet\n`);

  // ── 2. Determinar qué SKUs descargar ──────────────────────────────────────
  let skusObjetivo;

  if (MODO_TODOS) {
    skusObjetivo = new Set(Object.keys(mapaUrls));
    console.log(`🎯 Modo --todos: ${skusObjetivo.size} SKUs objetivo`);
  } else {
    // Solo los SKUs del boletín activo
    console.log(`📋 Leyendo promos del boletín (${PROMOS_TAB})...`);
    const promosResp = await sheets.spreadsheets.values.get({
      spreadsheetId: PROMOS_SHEET_ID,
      range: `'${PROMOS_TAB}'`,
    });
    const [headers, ...rows] = promosResp.data.values || [[]];
    const norm = s => s.toLowerCase().replace(/\n/g,' ').replace(/\s+/g,' ').trim();
    const iSKU      = headers.findIndex(h => norm(h) === 'sku');
    const iBoletin  = headers.findIndex(h => norm(h) === 'incluir_boletin');
    const iSKUReg   = headers.findIndex(h => norm(h).startsWith('sku producto de regalo'));

    skusObjetivo = new Set();
    for (const r of rows) {
      if ((r[iBoletin] || '').trim().toUpperCase() !== 'SI') continue;
      if (r[iSKU])    skusObjetivo.add(String(r[iSKU]).trim());
      if (r[iSKUReg]) skusObjetivo.add(String(r[iSKUReg]).trim());
    }
    console.log(`   ${skusObjetivo.size} SKUs únicos en el boletín activo`);
  }

  // ── 3. Ver qué ya existe en Drive ─────────────────────────────────────────
  console.log(`\n🗂️  Revisando archivos existentes en Drive...`);
  const existentes = new Set();
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${DRIVE_FOLDER_ID}' in parents and mimeType contains 'image/' and trashed=false`,
      fields: 'nextPageToken, files(name)',
      pageSize: 1000,
      pageToken,
    });
    for (const f of res.data.files || []) existentes.add(f.name.toLowerCase());
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  console.log(`   ${existentes.size} imágenes ya en Drive`);

  // ── 4. Calcular pendientes ─────────────────────────────────────────────────
  const pendientes = [];
  let sinUrl = 0;

  for (const sku of skusObjetivo) {
    const yaExiste = existentes.has(`${sku}.jpg`) || existentes.has(`${sku}.jpeg`) || existentes.has(`${sku}.png`);
    if (yaExiste) continue;
    if (!mapaUrls[sku]) { sinUrl++; continue; }
    pendientes.push({ sku, url: mapaUrls[sku] });
  }

  console.log(`\n📊 Resumen:`);
  console.log(`   Ya en Drive:       ${[...skusObjetivo].filter(s => existentes.has(`${s}.jpg`) || existentes.has(`${s}.jpeg`) || existentes.has(`${s}.png`)).length}`);
  console.log(`   Sin URL en sheet:  ${sinUrl}`);
  console.log(`   A descargar:       ${pendientes.length}`);

  if (pendientes.length === 0) {
    console.log('\n✅ Todo al día, nada que descargar.');
    return;
  }

  if (DRY_RUN) {
    console.log('\n🔍 DRY RUN — SKUs que se descargarían:');
    pendientes.slice(0, 20).forEach(p => console.log(`   ${p.sku} → ${p.url.slice(0, 80)}...`));
    if (pendientes.length > 20) console.log(`   ... y ${pendientes.length - 20} más`);
    return;
  }

  // ── 5. Descargar y subir a Drive en lotes ─────────────────────────────────
  console.log(`\n⬇️  Descargando ${pendientes.length} imágenes (${CONCURRENCIA} simultáneas)...\n`);

  let ok = 0, err = 0;
  const errores = [];

  for (let i = 0; i < pendientes.length; i += CONCURRENCIA) {
    const lote = pendientes.slice(i, i + CONCURRENCIA);

    await Promise.all(lote.map(async ({ sku, url }) => {
      try {
        const { buffer, contentType } = await fetchBuffer(url);
        const extension   = ext(contentType);
        const nombre      = `${sku}${extension}`;
        const { Readable } = require('stream');

        // Subir a Drive
        await drive.files.create({
          requestBody: {
            name:    nombre,
            parents: [DRIVE_FOLDER_ID],
          },
          media: {
            mimeType: contentType.split(';')[0].trim(),
            body:     Readable.from(buffer),
          },
          fields: 'id',
        });

        ok++;
        process.stdout.write(`\r   ✔ ${ok + err}/${pendientes.length}  (${ok} ok, ${err} err)   `);
      } catch (e) {
        err++;
        errores.push(`SKU ${sku}: ${e.message}`);
        process.stdout.write(`\r   ✔ ${ok + err}/${pendientes.length}  (${ok} ok, ${err} err)   `);
      }
    }));

    if (i + CONCURRENCIA < pendientes.length) await sleep(PAUSA_MS);
  }

  // ── 6. Resultado final ─────────────────────────────────────────────────────
  console.log(`\n\n✅ Completado`);
  console.log(`   Descargadas: ${ok}`);
  console.log(`   Con error:   ${err}`);
  if (errores.length > 0) {
    console.log('\n⚠️  Primeros errores:');
    errores.slice(0, 10).forEach(e => console.log(`   ${e}`));
  }
  console.log('\n▶  Ahora corré: node extract-sheet-data.js');
}

main().catch(err => {
  console.error('\n❌ Error fatal:', err.message || err);
  process.exit(1);
});
