// server/parser.js
import fs from 'fs';
import path from 'path';
export function parsePdfText(text) {
  // El extractor a veces parte una fila en varias líneas (ej: "2 Nuez\nPecan PARTIDA x 1Kg 20,956.00 15.00").
  // Reagrupar líneas hasta obtener una línea "completa" que contenga al menos dos tokens numéricos
  // (precio y stock) en su parte final.
  // El extractor o el endpoint de debug a veces devuelve secuencias con backslashes
  // (p.ej. "\\n" o "\\\\n"). Normalizamos cualquier secuencia '\\+n' a un salto real
  // y también convertimos CRLF a LF.
  const normalized = text.replace(/\\+n/g, '\n').replace(/\r\n/g, '\n');
  let rawLines = normalized.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // Filtrar líneas de encabezado/paginación que aparecen repetidamente en el PDF
  // y que confunden la heurística (ej: "LISTA DE PRECIOS", "PÃ¡gina Nro.: X",
  // "CÃ“DIGO DESCRIPCIÃ“N PRECIO 0 STOCK"). Esto es una mejora segura y no
  // afecta a las líneas de producto reales que comienzan con un código.
  const headerRe = /^\s*(LISTA\s+DE\s+PRECIOS|C\s*\*?DIGO|C[OÓ]DIGO|C\w*DIGO|C\w*IGO|C[OÓ]DIGO DESCRIPC|C\w+IGO DESCRIPC|P[aá]gina\b|C\w*DIGO DESCRIPCI\w*N|LISTA DE PRECIOS C\w*)/i;
  rawLines = rawLines.filter(l => !headerRe.test(l));
  const logicalLines = [];

  const numRe = /-?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?/g;
  let buffer = '';
  for (const l of rawLines) {
    if (!buffer) buffer = l;
    else buffer = (buffer + ' ' + l).trim();

    // comprobar si el buffer tiene al menos dos números (precio y stock) hacia el final
    const matches = buffer.match(numRe) || [];
    if (matches.length >= 2) {
      // heurística: asumir que los dos últimos tokens numéricos son precio y stock
      logicalLines.push(buffer);
      buffer = '';
    } else {
      // esperar la siguiente línea para completar
      continue;
    }
  }
  if (buffer) logicalLines.push(buffer);

  const rows = [];
  const failed = [];
  for (const l of logicalLines) {
    const r = parseLine(l);
    if (r) rows.push(r);
    else failed.push(l);
  }

  // Escribir diagnóstico para debugging
  try {
  const diag = { rawLines: rawLines.length, logicalLines: logicalLines.length, parsed: rows.length, failedSample: failed.slice(0, 200) };
    fs.writeFileSync(path.join(process.cwd(), 'parser_diag.json'), JSON.stringify(diag, null, 2), 'utf8');
  } catch (e) {
    // ignore
  }

  return rows;
}

function parseLine(line) {
  // Limpieza: eliminar caracteres no imprimibles y reemplazar por espacio
  const sanitized = line
    .replace(/\u00A0/g, ' ')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/[^\x20-\x7EÁÉÍÓÚÑáéíóúüñ\d,\.\-\/\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!sanitized) return null;

  // intentar extraer codigo al inicio
  const codeMatch = sanitized.match(/^\s*(\d{1,6})\b/);
  if (!codeMatch) return null;
  const codigo = codeMatch[1];

  // regex para números con miles/decimales
  const numRe = /-?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?/g;
  const numbers = sanitized.match(numRe) || [];
  if (numbers.length < 2) return null;

  // tomar los dos últimos números como [precio, stock]
  const rawPrice = numbers[numbers.length - 2];
  const rawStock = numbers[numbers.length - 1];

  function parseNumberToken(tok) {
    if (!tok) return NaN;
    const s = String(tok).trim();
    if (s.indexOf(',') !== -1 && s.indexOf('.') !== -1) return parseFloat(s.replace(/,/g, ''));
    if (s.indexOf(',') !== -1 && s.indexOf('.') === -1) return parseFloat(s.replace(/,/g, '.'));
    return parseFloat(s.replace(/,/g, ''));
  }

  const precio = parseNumberToken(rawPrice);
  const stock = parseNumberToken(rawStock);
  if (Number.isNaN(precio) || Number.isNaN(stock)) return null;

  // construir descripcion: quitar el codigo inicial y remover la aparicion final de precio y stock
  // para esto buscamos el indice de la primera aparicion del rawPrice desde el final
  let desc = sanitized.replace(/^\s*\d+\s+/, '');
  // eliminar la última ocurrencia de rawPrice and rawStock si existen
  const idxPrice = desc.lastIndexOf(rawPrice);
  if (idxPrice !== -1) desc = desc.substring(0, idxPrice).trim();
  // también eliminar si queda el rawStock al final (por si price aparece antes)
  const idxStock = desc.lastIndexOf(rawStock);
  if (idxStock !== -1 && idxStock > desc.length - rawStock.length - 5) {
    desc = desc.substring(0, idxStock).trim();
  }

  // limpiar posibles separadores sobrantes
  desc = desc.replace(/[\.,]$/, '').trim();

  // ignorar headers cortos
  if (!desc || desc.length < 2) return null;

  return { codigo, descripcion: desc, precio, stock };
}