// Parser CSV mínimo y robusto (sin dependencias). Soporta comillas dobles,
// comas y saltos de línea dentro de campos entrecomillados, y separador ; o ,.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const s = String(text || '').replace(/\r\n?/g, '\n');
  // Detecta separador por la primera línea (soporta Excel es-CO que usa ';').
  const firstLine = s.split('\n')[0] || '';
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

// Convierte CSV con encabezados en un arreglo de objetos { header: value }.
export function csvToObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim().toLowerCase());
  return rows.slice(1).map(cols => {
    const o = {};
    headers.forEach((h, i) => { o[h] = (cols[i] ?? '').trim(); });
    return o;
  });
}
