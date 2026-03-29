#!/usr/bin/env node
/**
 * extract-sheet-data.js
 * Lee el Google Sheet, filtra promos con incluir_boletin=SI,
 * descarga imágenes de Drive y emite un JSON listo para poblar Canva.
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const SHEET_ID    = '1Hnoh8JfEup2avyFs0jCQZfgOtIH22rebi2w6EDOogQo';
const SHEET_TAB   = 'promos';
const DRIVE_FOLDER_ID = '12MphbEbTzKruIjamqpBj_gY8CeeVycZ5';
const CREDS_PATH  = path.join(__dirname, 'credentials.json');
const IMG_DIR     = path.join(__dirname, 'tmp_images');

async function main() {
  // Auth
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDS_PATH,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  });
  const authClient = await auth.getClient();

  // ── 1. Leer el Sheet ──────────────────────────────────────────────────────
  const sheets = google.sheets({ version: 'v4', auth: authClient });
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_TAB}'`,
  });

  const [headers, ...rows] = resp.data.values;
  const idx = (col) => headers.findIndex(h => h.trim().toLowerCase() === col.toLowerCase());

  const idxBoletin   = idx('incluir_boletin');
  const idxSeccion   = idx('Sección');
  const idxSKU       = idx('SKU');
  const idxSKURegalo = idx('SKU regalo');
  const idxDesc      = idx('Descripcion');
  const idxDescMkt   = idx('Descripcion Marketing');

  if (idxBoletin === -1) {
    console.error('Columna "incluir_boletin" no encontrada. Columnas disponibles:', headers);
    process.exit(1);
  }

  // Filtrar filas activas
  const promos = rows
    .filter(r => (r[idxBoletin] || '').trim().toUpperCase() === 'SI')
    .map(r => ({
      seccion:     (r[idxSeccion]   || '').trim(),
      sku:         (r[idxSKU]       || '').trim(),
      skuRegalo:   (r[idxSKURegalo] || '').trim(),
      descripcion: (r[idxDesc]      || '').trim(),
      descMkt:     (r[idxDescMkt]   || '').trim(),
      rowData:     r,
    }))
    .filter(p => p.sku);

  console.log(`✅ ${promos.length} promos encontradas con incluir_boletin=SI`);

  // ── 2. Agrupar por sección ────────────────────────────────────────────────
  const secciones = {};
  for (const p of promos) {
    if (!secciones[p.seccion]) secciones[p.seccion] = [];
    secciones[p.seccion].push(p);
  }

  console.log('📂 Secciones:', Object.keys(secciones).join(', '));

  // ── 3. Mejorar copy con tono Puppis ──────────────────────────────────────
  // Genera copy estilo "COMPRANDO X... TE LLEVÁS Y"
  for (const p of promos) {
    if (!p.descMkt) {
      p.descMkt = generarCopyPuppis(p);
    }
  }

  // ── 4. Descargar imágenes de Drive ───────────────────────────────────────
  const drive = google.drive({ version: 'v3', auth: authClient });

  if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR);

  // Listar todos los JPG de la carpeta
  const filesResp = await drive.files.list({
    q: `'${DRIVE_FOLDER_ID}' in parents and mimeType contains 'image/' and trashed=false`,
    fields: 'files(id, name)',
    pageSize: 200,
  });

  const driveFiles = filesResp.data.files || [];
  console.log(`🖼️  ${driveFiles.length} imágenes en Drive`);

  // Mapear nombre → id
  const fileMap = {};
  for (const f of driveFiles) fileMap[f.name.toLowerCase()] = f.id;

  // Descargar imágenes relevantes y generar URLs de descarga públicas
  const skusNecesarios = new Set();
  for (const p of promos) {
    if (p.sku)       skusNecesarios.add(p.sku);
    if (p.skuRegalo) skusNecesarios.add(p.skuRegalo);
  }

  const imagenes = {};
  for (const sku of skusNecesarios) {
    const filename = `${sku}.jpg`.toLowerCase();
    const fileId = fileMap[filename];
    if (!fileId) {
      console.warn(`⚠️  No se encontró imagen para SKU: ${sku}`);
      continue;
    }
    // URL de descarga directa (válida para service account con acceso)
    imagenes[sku] = `https://drive.google.com/uc?export=download&id=${fileId}`;
    console.log(`  ✔ ${sku} → ${fileId}`);
  }

  // ── 5. Output final ───────────────────────────────────────────────────────
  const output = {
    generatedAt: new Date().toISOString(),
    mes: obtenerMesActual(),
    totalPromos: promos.length,
    secciones,
    imagenes,
    headers,
  };

  const outPath = path.join(__dirname, 'boletin-data.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n📄 Datos guardados en: ${outPath}`);
  console.log(JSON.stringify(output, null, 2));
}

function generarCopyPuppis(promo) {
  const desc = promo.descripcion || promo.sku;
  if (promo.skuRegalo) {
    return `COMPRANDO ${desc.toUpperCase()}... ¡TE LLEVÁS ${promo.skuRegalo} DE REGALO!`;
  }
  return `¡APROVECHÁ ESTA PROMO ESPECIAL EN ${desc.toUpperCase()}!`;
}

function obtenerMesActual() {
  const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                 'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const d = new Date();
  return `${meses[d.getMonth()]} ${d.getFullYear()}`;
}

main().catch(err => {
  console.error('❌ Error:', err.message || err);
  process.exit(1);
});
