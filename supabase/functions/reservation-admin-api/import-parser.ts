import ExcelJS from "npm:exceljs@4.4.0";
import { Buffer } from "node:buffer";

import { extractOpenXmlRows } from "./openxml-parser.ts";

export const MAX_FILE_BYTES = 6_000_000;
export const MAX_IMPORT_ROWS = 1000;
export const MAX_IMPORT_COLUMNS = 40;

export const COLUMN_KEYS = [
  "pickup_date",
  "pickup_time",
  "pickup_terminal",
  "return_date",
  "return_time",
  "return_terminal",
  "price_eur",
  "customer_name",
  "customer_email",
  "customer_phone",
  "vehicle_plate",
  "vehicle_make_model",
  "payment_method",
] as const;

export type ColumnKey = typeof COLUMN_KEYS[number];
export type SourceRow = { source_row: number; cells: Array<string | number> };

export const REQUIRED_KEYS: ColumnKey[] = [
  "pickup_date",
  "pickup_time",
  "pickup_terminal",
  "return_date",
  "return_time",
  "return_terminal",
  "price_eur",
  "customer_name",
  "vehicle_plate",
  "payment_method",
];

export class ImportFileError extends Error {
  code: string;
  detail: string;

  constructor(code: string, detail: unknown = code) {
    super(code);
    this.name = "ImportFileError";
    this.code = code;
    this.detail = sanitizeImportDetail(detail);
  }
}

export function sanitizeImportDetail(value: unknown) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(
      /(authorization|apikey|token|initData)\s*[:=]\s*\S+/gi,
      "$1=[redacted]",
    )
    .slice(0, 400);
}

export function decodeImportBase64(value: unknown) {
  let clean = String(value ?? "").trim();
  const dataUri = clean.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,/i);
  if (dataUri) clean = clean.slice(dataUri[0].length);
  clean = clean.replace(/\s/g, "");
  if (!clean) {
    throw new ImportFileError(
      "invalid_import_file",
      "No se recibió contenido base64.",
    );
  }
  if (clean.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 64) {
    throw new ImportFileError(
      "invalid_import_file_size",
      "El contenido base64 supera el límite permitido.",
    );
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) {
    throw new ImportFileError(
      "invalid_import_base64",
      "El contenido no usa base64 estándar válido.",
    );
  }
  let binary = "";
  try {
    binary = atob(clean);
  } catch (error) {
    throw new ImportFileError(
      "invalid_import_base64",
      (error as Error)?.message || error,
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (bytes.length < 10 || bytes.length > MAX_FILE_BYTES) {
    throw new ImportFileError(
      "invalid_import_file_size",
      `Tamaño decodificado fuera de rango: ${bytes.length}.`,
    );
  }
  return bytes;
}

export function parseDelimited(text: string, delimiter: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        value += '"';
        index++;
      } else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      value = "";
    } else value += char;
  }
  row.push(value.replace(/\r$/, ""));
  if (row.some((cell) => cell !== "")) rows.push(row);
  return rows;
}

export function detectDelimiter(text: string) {
  const sample = text.split(/\r?\n/).slice(0, 12).join("\n");
  let best = ",";
  let bestScore = -1;
  for (const delimiter of [",", ";", "\t"]) {
    const parsed = parseDelimited(sample, delimiter).filter((row) =>
      row.some((cell) => cell.trim() !== "")
    ).slice(0, 8);
    if (!parsed.length) continue;
    const counts = parsed.map((row) => row.length);
    const frequencies = new Map<number, number>();
    for (const count of counts) {
      frequencies.set(count, (frequencies.get(count) || 0) + 1);
    }
    const [mode, consistency] = [...frequencies.entries()].sort((a, b) =>
      b[1] - a[1] || b[0] - a[0]
    )[0];
    const score = mode > 1 ? mode * 10 + consistency : -1;
    if (score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }
  return best;
}

function looksLikeXlsx(bytes: Uint8Array) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06));
}

function decodeCsvText(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le", { fatal: false }).decode(
      bytes.subarray(2),
    );
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = new Uint8Array(bytes.length - 2);
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      swapped[index - 2] = bytes[index + 1];
      swapped[index - 1] = bytes[index];
    }
    return new TextDecoder("utf-16le", { fatal: false }).decode(swapped);
  }
  const zeroOdd =
    bytes.slice(0, Math.min(bytes.length, 256)).filter((_, index) =>
      index % 2 === 1 && bytes[index] === 0
    ).length;
  if (zeroOdd > 20) {
    return new TextDecoder("utf-16le", { fatal: false }).decode(bytes);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(
    /^\uFEFF/,
    "",
  );
}

function safeCellText(cell: ExcelJS.Cell) {
  const value: any = cell.value;
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) {
      return value.richText.map((part: any) => part.text || "").join("");
    }
    if (value.result != null) {
      return value.result instanceof Date
        ? value.result.toISOString()
        : String(value.result);
    }
    if (value.text != null) return String(value.text);
  }
  return typeof value === "number" ? value : String(value).trim();
}

export async function extractImportRows(
  bytes: Uint8Array,
  fileName: string,
  mimeType: string,
) {
  const lowerName = fileName.toLowerCase();
  const lowerMime = mimeType.toLowerCase();
  const xlsxExtension = lowerName.endsWith(".xlsx");
  const delimitedExtension = lowerName.endsWith(".csv") ||
    lowerName.endsWith(".tsv");
  const declaredXlsx = xlsxExtension ||
    (!delimitedExtension && lowerMime.includes("spreadsheetml"));
  const declaredDelimited = delimitedExtension ||
    lowerMime.includes("csv") || lowerMime.includes("tab-separated") ||
    lowerMime.startsWith("text/");
  const zipSignature = looksLikeXlsx(bytes);

  if (zipSignature || declaredXlsx) {
    if (!zipSignature) {
      throw new ImportFileError(
        "xlsx_parse_failed",
        "El archivo .xlsx no contiene una firma ZIP/Open XML.",
      );
    }
    const workbook = new ExcelJS.Workbook();
    try {
      const buffer = Buffer.from(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      await workbook.xlsx.load(buffer as any);
    } catch (excelError) {
      try {
        return extractOpenXmlRows(bytes, MAX_IMPORT_ROWS, MAX_IMPORT_COLUMNS);
      } catch (openXmlError) {
        if (openXmlError instanceof ImportFileError) throw openXmlError;
        throw new ImportFileError(
          "xlsx_parse_failed",
          `ExcelJS: ${(excelError as Error)?.message || excelError}; OOXML: ${
            (openXmlError as Error)?.message || openXmlError
          }`,
        );
      }
    }
    const worksheet = workbook.worksheets.find((sheet) =>
      sheet.actualRowCount > 0
    );
    if (!worksheet) {
      throw new ImportFileError(
        "empty_import_file",
        "El libro no contiene hojas con filas.",
      );
    }
    const rows: SourceRow[] = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rows.length >= MAX_IMPORT_ROWS + 25) return;
      const cells: Array<string | number> = [];
      const lastColumn = Math.min(
        Math.max(row.cellCount, row.actualCellCount),
        MAX_IMPORT_COLUMNS,
      );
      for (let column = 1; column <= lastColumn; column++) {
        cells.push(safeCellText(row.getCell(column)));
      }
      if (cells.some((cell) => String(cell).trim() !== "")) {
        rows.push({ source_row: rowNumber, cells });
      }
    });
    if (!rows.length) {
      throw new ImportFileError(
        "empty_import_file",
        "La primera hoja con datos no contiene filas legibles.",
      );
    }
    return {
      format: "xlsx" as const,
      sheetName: worksheet.name,
      rows,
      delimiter: null,
    };
  }

  if (!declaredDelimited) {
    throw new ImportFileError(
      "unsupported_import_format",
      "La extensión, MIME y firma no corresponden a XLSX, CSV o TSV.",
    );
  }
  const text = decodeCsvText(bytes);
  if (!text.trim()) {
    throw new ImportFileError(
      "empty_import_file",
      "El archivo de texto está vacío.",
    );
  }
  const delimiter =
    lowerName.endsWith(".tsv") || lowerMime.includes("tab-separated")
      ? "\t"
      : detectDelimiter(text);
  const parsed = parseDelimited(text, delimiter).slice(0, MAX_IMPORT_ROWS + 25);
  const rows = parsed
    .map((cells, index) => ({
      source_row: index + 1,
      cells: cells.slice(0, MAX_IMPORT_COLUMNS),
    }))
    .filter((row) => row.cells.some((cell) => cell.trim() !== ""));
  if (!rows.length) {
    throw new ImportFileError(
      "empty_import_file",
      "El CSV no contiene filas legibles.",
    );
  }
  return {
    format: delimiter === "\t" ? "tsv" as const : "csv" as const,
    sheetName: delimiter === "\t" ? "TSV" : "CSV",
    rows,
    delimiter,
  };
}

export function normalizeHeader(value: unknown) {
  return String(value ?? "").replace(/^\uFEFF/, "").trim().toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").replace(
      /\s+/g,
      " ",
    ).trim();
}

const ALIASES: Record<ColumnKey, string[]> = {
  pickup_date: [
    "fecha recogida",
    "fecha de recogida",
    "fecha entrada",
    "entrada fecha",
    "check in date",
  ],
  pickup_time: [
    "hora recogida",
    "hora de recogida",
    "hora entrada",
    "entrada hora",
    "check in time",
  ],
  pickup_terminal: [
    "terminal recogida",
    "terminal de recogida",
    "terminal entrada",
    "entrada terminal",
  ],
  return_date: [
    "fecha regreso",
    "fecha de regreso",
    "fecha devolucion",
    "fecha salida",
    "salida fecha",
    "return date",
  ],
  return_time: [
    "hora regreso",
    "hora de regreso",
    "hora devolucion",
    "hora salida",
    "salida hora",
    "return time",
  ],
  return_terminal: [
    "terminal regreso",
    "terminal de regreso",
    "terminal devolucion",
    "terminal salida",
    "salida terminal",
  ],
  price_eur: [
    "precio iva incluido",
    "precio",
    "importe",
    "total",
    "precio eur",
    "importe total",
  ],
  customer_name: ["usuario", "cliente", "nombre cliente", "nombre", "customer"],
  customer_email: ["e mail", "email", "correo", "correo electronico"],
  customer_phone: ["telefono", "movil", "telefono cliente", "phone"],
  vehicle_plate: [
    "matricula vehiculo",
    "matricula",
    "placa",
    "patente",
    "vehicle plate",
  ],
  vehicle_make_model: [
    "marca y modelo",
    "marca modelo",
    "vehiculo",
    "coche",
    "vehicle",
  ],
  payment_method: [
    "efectivo tarjeta de credito",
    "efectivo o tarjeta de credito",
    "metodo de pago",
    "forma de pago",
    "pago",
    "payment method",
  ],
};

function aliasScore(header: string, key: ColumnKey) {
  const normalized = normalizeHeader(header);
  let best = 0;
  for (const alias of ALIASES[key]) {
    const candidate = normalizeHeader(alias);
    if (normalized === candidate) best = Math.max(best, 100);
    else if (normalized.includes(candidate) || candidate.includes(normalized)) {
      best = Math.max(best, 70);
    }
  }
  return best;
}

export function deterministicHeaderMap(cells: Array<string | number>) {
  const columns = {} as Record<ColumnKey, number>;
  for (const key of COLUMN_KEYS) columns[key] = -1;
  const used = new Set<number>();
  let total = 0;
  for (const key of COLUMN_KEYS) {
    let bestIndex = -1;
    let bestScore = 0;
    let tied = false;
    for (let index = 0; index < cells.length; index++) {
      if (used.has(index)) continue;
      const score = aliasScore(String(cells[index] ?? ""), key);
      if (score > bestScore) {
        bestIndex = index;
        bestScore = score;
        tied = false;
      } else if (score === bestScore && score > 0) tied = true;
    }
    if (bestScore >= 70 && !tied) {
      columns[key] = bestIndex;
      used.add(bestIndex);
      total += bestScore;
    }
  }
  return {
    columns,
    requiredFound: REQUIRED_KEYS.filter((key) => columns[key] >= 0).length,
    total,
  };
}

export function findHeaderCandidate(rows: SourceRow[]) {
  let best:
    | (ReturnType<typeof deterministicHeaderMap> & {
      row: SourceRow;
      score: number;
    })
    | null = null;
  for (const row of rows.slice(0, 30)) {
    const mapped = deterministicHeaderMap(row.cells);
    const score = mapped.requiredFound * 1000 + mapped.total;
    if (!best || score > best.score) best = { row, score, ...mapped };
  }
  if (!best || best.requiredFound < 4) {
    throw new ImportFileError(
      "import_headers_not_found",
      "No se reconocieron al menos cuatro encabezados semánticos en las primeras 30 filas.",
    );
  }
  return best;
}

function two(value: number) {
  return String(value).padStart(2, "0");
}

function toISODate(value: unknown) {
  if (
    typeof value === "number" && Number.isFinite(value) && value > 1 &&
    value < 100000
  ) {
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000)
      .toISOString().slice(0, 10);
  }
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const match = text.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/);
  if (!match) return "";
  let year = Number(match[3]);
  if (year < 100) year += year >= 70 ? 1900 : 2000;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    ? `${year}-${two(month)}-${two(day)}`
    : "";
}

function toTime(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const minutes = Math.round((((value % 1) + 1) % 1) * 1440) % 1440;
    return `${two(Math.floor(minutes / 60))}:${two(minutes % 60)}`;
  }
  const match = String(value ?? "").trim().toLowerCase().match(
    /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/,
  );
  if (!match) return "";
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59) return "";
  if (match[3]) {
    if (hour < 1 || hour > 12) return "";
    if (match[3] === "pm" && hour !== 12) hour += 12;
    if (match[3] === "am" && hour === 12) hour = 0;
  }
  return hour <= 23 ? `${two(hour)}:${two(minute)}` : "";
}

function toPrice(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value * 100) / 100;
  }
  let text = String(value ?? "").replace(/[€\s]/g, "");
  if (text.includes(",") && text.includes(".")) {
    text = text.replace(/\./g, "").replace(",", ".");
  } else text = text.replace(",", ".");
  const number = Number(text);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : NaN;
}

function toPayment(value: unknown) {
  const text = normalizeHeader(value);
  if (/efectivo|cash/.test(text)) return "cash";
  if (/tarjeta|credito|credit|card/.test(text)) return "credit_card";
  return "";
}

export function normalizeImportedRows(
  sourceRows: SourceRow[],
  headerRow: number,
  columns: Record<ColumnKey, number>,
) {
  const validRows: any[] = [];
  const invalidRows: any[] = [];
  for (
    const source of sourceRows.filter((row) => row.source_row > headerRow)
      .slice(0, MAX_IMPORT_ROWS)
  ) {
    const cellAt = (index: number) =>
      index >= 0 && index < source.cells.length ? source.cells[index] : "";
    const raw = Object.fromEntries(
      COLUMN_KEYS.map((key) => [key, cellAt(columns[key])]),
    );
    if (
      Object.values(raw).every((value) => String(value ?? "").trim() === "")
    ) continue;
    const entry = {
      source_row: source.source_row,
      pickup_date: toISODate(raw.pickup_date),
      pickup_time: toTime(raw.pickup_time),
      pickup_terminal: String(raw.pickup_terminal ?? "").trim(),
      return_date: toISODate(raw.return_date),
      return_time: toTime(raw.return_time),
      return_terminal: String(raw.return_terminal ?? "").trim(),
      price_eur: toPrice(raw.price_eur),
      customer_name: String(raw.customer_name ?? "").trim(),
      customer_email: String(raw.customer_email ?? "").trim().toLowerCase(),
      customer_phone: String(raw.customer_phone ?? "").trim(),
      vehicle_plate: String(raw.vehicle_plate ?? "").trim().toUpperCase(),
      vehicle_make_model: String(raw.vehicle_make_model ?? "").trim(),
      payment_method: toPayment(raw.payment_method),
    };
    const issues: string[] = [];
    if (!entry.pickup_date) issues.push("Fecha de recogida no válida");
    if (!entry.pickup_time) issues.push("Hora de recogida no válida");
    if (!entry.pickup_terminal) issues.push("Falta la terminal de recogida");
    if (!entry.return_date) issues.push("Fecha de regreso no válida");
    if (!entry.return_time) issues.push("Hora de regreso no válida");
    if (!entry.return_terminal) issues.push("Falta la terminal de regreso");
    if (!Number.isFinite(entry.price_eur) || entry.price_eur < 0) {
      issues.push("Precio no válido");
    }
    if (!entry.customer_name) issues.push("Falta el usuario");
    if (!entry.vehicle_plate) issues.push("Falta la matrícula");
    if (!entry.payment_method) issues.push("Método de pago no reconocido");
    if (
      entry.customer_email &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.customer_email)
    ) issues.push("E-mail no válido");
    if (
      entry.pickup_date && entry.return_date &&
      entry.return_date < entry.pickup_date
    ) issues.push("El regreso es anterior a la recogida");
    if (issues.length) {
      invalidRows.push({
        ...entry,
        price_eur: Number.isFinite(entry.price_eur) ? entry.price_eur : null,
        issues,
      });
    } else validRows.push(entry);
  }
  return { validRows, invalidRows };
}
