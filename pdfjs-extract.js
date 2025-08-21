// server/pdfjs-extract.js
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

export async function extractTextFromPDF(buffer) {
  // Convertir Buffer \u2192 Uint8Array
  const uint8Array = new Uint8Array(buffer);

  // Determinar una URL para los standard fonts que pdfjs necesita en Node.
  // Primero intentamos la copia local instalada en node_modules; si no existe,
  // hacemos fallback a un CDN público (requiere acceso a Internet).
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const localFontsPath = path.join(__dirname, "node_modules", "pdfjs-dist", "standard_fonts");
  let standardFontDataUrl;

  if (fs.existsSync(localFontsPath)) {
    // Preferir servir las fuentes por HTTP desde el server local para evitar problemas
    // con fetch(file://...) en algunos entornos Node/V8. Asumimos que el server
    // corre en localhost:3001 (puede cambiarse si es necesario).
    standardFontDataUrl = "http://localhost:3001/pdfjs_fonts/";
    console.log("Usando standardFontDataUrl HTTP local:", standardFontDataUrl);
  } else {
    // Fallback CDN (requiere acceso a Internet)
    standardFontDataUrl = "https://unpkg.com/pdfjs-dist@latest/standard_fonts/";
    console.log("Usando standardFontDataUrl CDN:", standardFontDataUrl);
  }

  const loadingTask = pdfjsLib.getDocument({
    data: uint8Array,
    standardFontDataUrl,
  });

  const pdf = await loadingTask.promise;
  let text = "";

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    // Agrupar los items por coordenada Y (aproximada) para reconstruir filas
    const items = content.items || [];
    const groups = new Map();

    items.forEach(i => {
      // transform: [a, b, c, d, x, y]
      const ty = (i.transform && i.transform[5]) ?? i.y ?? 0;
      const tx = (i.transform && i.transform[4]) ?? i.x ?? 0;
      const yKey = Math.round(ty);
      if (!groups.has(yKey)) groups.set(yKey, []);
      groups.get(yKey).push({ x: tx, str: i.str });
    });

    // Ordenar por Y (de mayor a menor para mantener orden visual) y luego por X
    const ys = Array.from(groups.keys()).sort((a, b) => b - a);
    for (const y of ys) {
      const row = groups.get(y)
        .sort((a, b) => a.x - b.x)
        .map(it => it.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (row) text += row + "\n";
    }
  }

  // Algunos pipelines (o transformaciones posteriores) pueden introducir
  // secuencias literales "\\n" dentro del texto. Normalizarlas a saltos
  // reales antes de devolver para evitar dobles escapes cuando el texto se
  // serializa como JSON o se inspecciona en endpoints de depuración.
  try {
    // Convertir secuencias de backslashes seguidas de 'n' (p.ej. "\\n", "\\\\n")
    // a saltos de línea reales; además normalizar CRLF.
    text = text.replace(/\\+n/g, "\n");
    text = text.replace(/\r\n/g, "\n");
  } catch (e) {
    // no crítico, seguir devolviendo lo que tengamos
  }

  return text;
}
