#!/usr/bin/env node
/**
 * extract-sheet-data.js
 * Lee el Google Sheet, filtra promos con incluir_boletin=SI,
 * descarga imágenes de Drive y emite un JSON listo para poblar Canva.
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const SHEET_ID        = '1Hnoh8JfEup2avyFs0jCQZfgOtIH22rebi2w6EDOogQo';
const SHEET_TAB       = 'Promos';
const DRIVE_FOLDER_ID = '1y--6gcZKBgtGurmp1OhziurRYp4hjSTs';
const CREDS_PATH      = path.join(__dirname, 'credentials.json');

// Búsqueda flexible de columna (ignora mayúsculas, acentos, saltos de línea)
function idx(headers, col) {
  const norm = s => s.toLowerCase().replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  const target = norm(col);
  return headers.findIndex(h => norm(h) === target || norm(h).startsWith(target));
}

async function main() {
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
  console.log('📋 Columnas detectadas:', headers.map((h, i) => `${i}:${h.replace(/\n/g,' ')}`).join(' | '));

  const iSKU       = idx(headers, 'SKU');
  const iMarca     = idx(headers, 'Marca');
  const iAnimal    = idx(headers, 'Animal');
  const iDesc      = idx(headers, 'Descripcion');
  const iDescMkt   = idx(headers, 'Descripcion Marketing');
  const iBoletin   = idx(headers, 'incluir_boletin');
  const iPromoTipo = idx(headers, 'COMUNICACIÓN');       // "COMUNICACIÓN\nPC..."
  const iSKURegalo = idx(headers, 'SKU Producto de Regalo');
  const iDescReg   = idx(headers, 'Descripcion');        // descripcion regalo col 18
  const iCantReg   = idx(headers, 'Cantidad de regalo');

  if (iBoletin === -1) {
    console.error('❌ Columna "incluir_boletin" no encontrada.');
    process.exit(1);
  }

  // ── 2. Filtrar y mapear ────────────────────────────────────────────────────
  const promos = rows
    .filter(r => (r[iBoletin] || '').trim().toUpperCase() === 'SI')
    .map(r => {
      const promoTipo  = (r[iPromoTipo]  || '').trim();
      const skuRegalo  = (r[iSKURegalo]  || '').trim();
      const descRegalo = (r[18]          || '').trim(); // col fija índice 18
      const cantRegalo = (r[iCantReg]    || '').trim();
      const descripcion = (r[iDesc]      || '').trim();
      const descMktExist = (r[iDescMkt]  || '').trim();

      return {
        seccion:     (r[iMarca]  || '').trim(),
        animal:      (r[iAnimal] || '').trim(),
        sku:         (r[iSKU]    || '').trim(),
        skuRegalo,
        descripcion,
        promoTipo,
        descRegalo,
        cantRegalo,
        descMkt: descMktExist || generarCopyPuppis(descripcion, promoTipo, descRegalo, cantRegalo),
      };
    })
    .filter(p => p.sku);

  console.log(`\n✅ ${promos.length} promos con incluir_boletin=SI`);

  // ── 3. Agrupar por Marca (Sección) ────────────────────────────────────────
  const secciones = {};
  for (const p of promos) {
    const key = p.seccion || 'Sin sección';
    if (!secciones[key]) secciones[key] = [];
    secciones[key].push(p);
  }

  const marcas = Object.keys(secciones).sort();
  console.log(`📂 ${marcas.length} marcas: ${marcas.join(', ')}`);

  // ── 4. Buscar imágenes en Drive ───────────────────────────────────────────
  const drive = google.drive({ version: 'v3', auth: authClient });

  const filesResp = await drive.files.list({
    q: `'${DRIVE_FOLDER_ID}' in parents and mimeType contains 'image/' and trashed=false`,
    fields: 'files(id, name)',
    pageSize: 500,
  });

  const driveFiles = filesResp.data.files || [];
  console.log(`🖼️  ${driveFiles.length} imágenes en Drive`);

  const fileMap = {};
  for (const f of driveFiles) fileMap[f.name.toLowerCase()] = f.id;

  const skusNecesarios = new Set();
  for (const p of promos) {
    if (p.sku)       skusNecesarios.add(p.sku);
    if (p.skuRegalo) skusNecesarios.add(p.skuRegalo);
  }

  const imagenes = {};
  let encontradas = 0;
  for (const sku of skusNecesarios) {
    const fileId = fileMap[`${sku}.jpg`] || fileMap[`${sku}.jpeg`] || fileMap[`${sku}.png`];
    if (fileId) {
      imagenes[sku] = `https://drive.google.com/uc?export=download&id=${fileId}`;
      encontradas++;
    }
  }
  console.log(`  ✔ ${encontradas}/${skusNecesarios.size} imágenes encontradas`);

  // ── 5. Output ─────────────────────────────────────────────────────────────
  const output = { generatedAt: new Date().toISOString(), mes: obtenerMes(), totalPromos: promos.length, secciones, imagenes };

  const outPath = path.join(__dirname, 'boletin-data.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n📄 Guardado en: ${outPath}`);

  // Resumen por sección
  console.log('\n=== RESUMEN POR MARCA ===');
  for (const [marca, items] of Object.entries(secciones).sort()) {
    console.log(`  ${marca}: ${items.length} promos`);
  }
}

function generarCopyPuppis(desc, tipo, descReg, cant) {
  const D = desc.toUpperCase();
  const t = tipo.toUpperCase();

  if (t === 'REGALO' && descReg) {
    const qty = cant ? `x${cant} ` : '';
    return `COMPRANDO ${D}... ¡TE LLEVÁS ${qty}${descReg.toUpperCase()} DE REGALO!`;
  }
  if (t === '4X3')  return `COMPRANDO ${D}... ¡TE LLEVÁS 4 AL PRECIO DE 3!`;
  if (t === '3X2')  return `COMPRANDO ${D}... ¡TE LLEVÁS 3 AL PRECIO DE 2!`;
  if (t === '6X5')  return `COMPRANDO ${D}... ¡TE LLEVÁS 6 AL PRECIO DE 5!`;
  if (t === '3X2' || t === '3x2') return `COMPRANDO ${D}... ¡TE LLEVÁS 3 AL PRECIO DE 2!`;

  const match2da = t.match(/(\d+)%\s*2DA\s*U/i);
  if (match2da) return `COMPRANDO ${D}... ¡LA SEGUNDA UNIDAD ${match2da[1]}% OFF!`;

  const match35 = t.match(/^(\d+)%/);
  if (match35) return `¡${match35[1]}% DE DESCUENTO EN ${D}!`;

  if (t === 'LIQUIDACIÓN' || t === 'PC') return `¡APROVECHÁ ESTA PROMO ESPECIAL EN ${D}!`;

  return `¡APROVECHÁ ESTA PROMO ESPECIAL EN ${D}!`;
}

function obtenerMes() {
  const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const d = new Date();
  return `${meses[d.getMonth()]} ${d.getFullYear()}`;
}

main().catch(err => {
  console.error('❌ Error:', err.message || err);
  process.exit(1);
});
