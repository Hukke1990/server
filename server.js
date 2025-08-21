// server/server.js
import express from "express";
import path from "path";
import fs from "fs";
import cors from "cors";
import multer from "multer";
import * as XLSX from "xlsx";
import { parsePdfText } from "./parser.js";
import { extractTextFromPDF } from "./pdfjs-extract.js";


const app = express();
app.use(cors());
const PORT = process.env.PORT || 3001;

// Servir las fuentes estándar de pdfjs para que pdfjs pueda cargarlas vía HTTP.
// Esto evita problemas con fetch(file://...) en entornos Node.
app.use(
	"/pdfjs_fonts",
	express.static(path.join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts"))
);


const upload = multer({
storage: multer.memoryStorage(),
limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
});


app.post("/convert", upload.single("pdf"), async (req, res) => {
try {
if (!req.file) return res.status(400).json({ error: "No se subió ningún PDF" });


// 🔹 Ahora usamos pdfjs-dist
const text = await extractTextFromPDF(req.file.buffer);
// Guardar texto extraido para debugging
try {
	fs.writeFileSync(path.join(process.cwd(), 'last_pdf_text.txt'), text, 'utf8');
} catch (e) {
	console.warn('No se pudo escribir last_pdf_text.txt', e.message);
}
console.log("Texto extraído (primeros 500 chars):", text.substring(0, 500));


const rows = parsePdfText(text);
// Guardar filas parseadas para debugging
try {
	fs.writeFileSync(path.join(process.cwd(), 'last_rows.json'), JSON.stringify(rows, null, 2), 'utf8');
} catch (e) {
	console.warn('No se pudo escribir last_rows.json', e.message);
}


if (!rows.length) {
	// Intentar fallback por línea; normalizar caracteres raros y aplicar regex simple
	const fallback = [];
	const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
	const lineRegex = /^(\d{1,6})\s+(.+?)\s+(-?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)\s+(-?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)/;
	for (let rawLine of lines) {
		// sanitize similar to parser
		const sanitized = rawLine
			.replace(/\u00A0/g, ' ')
			.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
			.replace(/[^\x20-\x7EÁÉÍÓÚÑáéíóúüñ\d,\.\-\/\s]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
		const m = sanitized.match(lineRegex);
		if (m) {
			const precio = parseFloat(m[3].replace(/,/g, ''));
			const stock = parseFloat(m[4].replace(/,/g, ''));
			if (!Number.isNaN(precio) && !Number.isNaN(stock)) {
				fallback.push({ codigo: m[1], descripcion: m[2].trim(), precio, stock });
			}
		}
	}
	if (fallback.length) {
		try {
			fs.writeFileSync(path.join(process.cwd(), 'last_rows.json'), JSON.stringify(fallback, null, 2), 'utf8');
		} catch (e) {
			console.warn('No se pudo escribir last_rows.json (fallback)', e.message);
		}
		// usar fallback
		for (const r of fallback) rows.push(r);
	}

	if (!rows.length) {
		return res.status(422).json({
			error: "No se detectaron filas. Ajustá la heurística de parser.",
			hint: "Verifica que el PDF no sea un escaneo. Para escaneos se necesita OCR.",
		});
	}
}


// Armar workbook
const wb = XLSX.utils.book_new();
const ws = XLSX.utils.json_to_sheet(rows, {
header: ["codigo", "descripcion", "precio", "stock"],
});


ws['!cols'] = [
{ wch: 12 },
{ wch: 60 },
{ wch: 12 },
{ wch: 10 },
];


XLSX.utils.book_append_sheet(wb, ws, "Precios");


const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
res.setHeader("Content-Disposition", 'attachment; filename="lista_precios.xlsx"');
res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
res.send(buffer);
} catch (err) {
console.error("PDFJS ERROR:", err);
res.status(500).json({ error: "Error al procesar el PDF", detail: err.message });
}
});

app.get("/health", (req, res) => res.json({ ok: true }));

// Endpoint de depuración: devuelve el texto extraído (útil para ajustar el parser)
app.post("/debug", upload.single("pdf"), async (req, res) => {
	try {
		if (!req.file) return res.status(400).json({ error: "No se subió ningún PDF" });
		const text = await extractTextFromPDF(req.file.buffer);
		// Devolver texto plano para inspección: así vemos saltos reales y
		// evitamos que JSON escape las secuencias de nueva línea.
		res.setHeader('Content-Type', 'text/plain; charset=utf-8');
		return res.send(text.substring(0, 20000));
	} catch (err) {
		console.error("DEBUG PDFJS ERROR:", err);
		return res.status(500).json({ error: "Error al extraer texto", detail: err.message });
	}
});
app.listen(PORT, () => console.log(`Server escuchando en http://localhost:${PORT}`));