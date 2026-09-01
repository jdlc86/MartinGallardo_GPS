import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import ExcelJS from "npm:exceljs@4.4.0";
import { Buffer } from "node:buffer";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS_JSON = Deno.env.get("SUPABASE_SECRET_KEYS");
const LEGACY_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") || Deno.env.get("GOOGLE_AI_API_KEY") || Deno.env.get("GOOGLE_API_KEY") || Deno.env.get("GOOGLE_VISION_API_KEY") || null;
const ALLOW_ORIGIN = "https://jdlc86.github.io";
const INIT_DATA_MAX_AGE_SECONDS = 86400;
const MAX_FILE_BYTES = 6_000_000;
const MAX_IMPORT_ROWS = 1000;
const MAX_IMPORT_COLUMNS = 40;
const AI_MODEL = "gemini-2.5-flash-lite";

class AppError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function serverKey() {
  if (SECRET_KEYS_JSON) {
    try {
      const parsed = JSON.parse(SECRET_KEYS_JSON);
      if (typeof parsed?.default === "string") return parsed.default;
      const value = Object.values(parsed ?? {})[0];
      if (typeof value === "string") return value;
    } catch {
      // Fall through to the legacy secret.
    }
  }
  if (LEGACY_SERVICE_ROLE_KEY) return LEGACY_SERVICE_ROLE_KEY;
  throw new AppError("no_server_key", 500);
}

function serviceHeaders(extra: Record<string, string> = {}) {
  const key = serverKey();
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    Vary: "Origin",
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function equalBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}

function hexToBytes(value: string) {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  const output = new Uint8Array(32);
  for (let index = 0; index < 32; index++) output[index] = parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return output;
}

async function hmac(key: Uint8Array | string, message: string) {
  const keyBytes = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const rawKey = keyBytes.buffer.slice(
    keyBytes.byteOffset,
    keyBytes.byteOffset + keyBytes.byteLength,
  ) as ArrayBuffer;
  const imported = await crypto.subtle.importKey("raw", rawKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(message)));
}

async function validateInitData(initData: string) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash") ?? "";
  params.delete("hash");
  const checkString = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = await hmac("WebAppData", BOT_TOKEN);
  const calculated = await hmac(secret, checkString);
  const supplied = hexToBytes(hash);
  if (!supplied || !equalBytes(calculated, supplied)) throw new AppError("invalid_init_data", 403);
  const authDate = Number(params.get("auth_date") ?? 0);
  if (!Number.isFinite(authDate) || Math.abs(Date.now() / 1000 - authDate) > INIT_DATA_MAX_AGE_SECONDS) throw new AppError("expired_init_data", 403);
  let telegramUser: any = null;
  try {
    telegramUser = JSON.parse(params.get("user") ?? "null");
  } catch {
    // Handled below.
  }
  const telegramUserId = Number(telegramUser?.id);
  if (!Number.isFinite(telegramUserId)) throw new AppError("missing_user", 403);
  return { telegramUserId, telegramUser };
}

async function requestTable(table: string, params: Record<string, string>) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: serviceHeaders({ Accept: "application/json" }) });
  if (!response.ok) throw await responseError(response);
  return response.json();
}

async function one(table: string, params: Record<string, string>) {
  return (await requestTable(table, { ...params, limit: "1" }))[0] ?? null;
}

async function insert(table: string, body: unknown) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: serviceHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }),
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await responseError(response);
  return (await response.json())[0] ?? null;
}

async function rpc(name: string, body: Record<string, unknown>) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: serviceHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }),
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await responseError(response);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function responseError(response: Response) {
  const text = await response.text();
  let message = text || `upstream_${response.status}`;
  try {
    const parsed = JSON.parse(text);
    message = String(parsed?.message || parsed?.error || message);
  } catch {
    // Keep the raw server message for logs; the client maps known codes.
  }
  return new AppError(message, response.status === 401 || response.status === 403 ? 403 : 400);
}

async function requireAdmin(telegramUserId: number) {
  const user = await one("telegram_users", {
    telegram_user_id: `eq.${telegramUserId}`,
    active: "eq.true",
    select: "telegram_user_id,username,first_name,last_name,role,active",
  });
  if (!user || (user.role !== "owner" && user.role !== "admin")) throw new AppError("not_admin", 403);
  return user;
}

function decodeBase64(value: string) {
  const clean = value.replace(/^data:[^;]+;base64,/, "");
  if (!clean || clean.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 16) throw new AppError("invalid_import_file");
  let binary = "";
  try {
    binary = atob(clean);
  } catch {
    throw new AppError("invalid_import_file");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  if (bytes.length < 10 || bytes.length > MAX_FILE_BYTES) throw new AppError("invalid_import_file_size");
  return bytes;
}

async function sha256Hex(bytes: Uint8Array) {
  const rawBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", rawBytes));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function parseDelimited(text: string, delimiter: string) {
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

function safeCellText(cell: ExcelJS.Cell) {
  const value: any = cell.value;
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) return value.richText.map((part: any) => part.text || "").join("");
    if (value.result != null) return value.result instanceof Date ? value.result.toISOString().slice(0, 10) : String(value.result);
    if (value.text != null) return String(value.text);
  }
  return typeof value === "number" ? value : String(value).trim();
}

async function extractRows(bytes: Uint8Array, fileName: string, mimeType: string) {
  const lowerName = fileName.toLowerCase();
  if (lowerName.endsWith(".csv") || lowerName.endsWith(".tsv") || mimeType.includes("csv") || mimeType.includes("tab-separated")) {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^\uFEFF/, "");
    const delimiter = lowerName.endsWith(".tsv") || mimeType.includes("tab-separated") ? "\t" : ",";
    const parsed = parseDelimited(text, delimiter).slice(0, MAX_IMPORT_ROWS + 25);
    return {
      sheetName: lowerName.endsWith(".tsv") ? "TSV" : "CSV",
      rows: parsed.map((cells, index) => ({ source_row: index + 1, cells: cells.slice(0, MAX_IMPORT_COLUMNS) })),
    };
  }
  if (!lowerName.endsWith(".xlsx") && !mimeType.includes("spreadsheetml")) throw new AppError("unsupported_import_format");
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Buffer.from(bytes) as any);
  } catch (error) {
    console.error("xlsx_load", error);
    throw new AppError("invalid_import_file");
  }
  const worksheet = workbook.worksheets.find((sheet) => sheet.actualRowCount > 0);
  if (!worksheet) throw new AppError("empty_import_file");
  const rows: Array<{ source_row: number; cells: Array<string | number> }> = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rows.length >= MAX_IMPORT_ROWS + 25) return;
    const cells: Array<string | number> = [];
    const lastColumn = Math.min(Math.max(row.cellCount, row.actualCellCount), MAX_IMPORT_COLUMNS);
    for (let column = 1; column <= lastColumn; column++) cells.push(safeCellText(row.getCell(column)));
    if (cells.some((cell) => String(cell).trim() !== "")) rows.push({ source_row: rowNumber, cells });
  });
  if (!rows.length) throw new AppError("empty_import_file");
  return { sheetName: worksheet.name, rows };
}

const COLUMN_KEYS = [
  "pickup_date", "pickup_time", "pickup_terminal", "return_date", "return_time", "return_terminal",
  "price_eur", "customer_name", "customer_email", "customer_phone", "vehicle_plate",
  "vehicle_make_model", "payment_method",
] as const;

type ColumnKey = typeof COLUMN_KEYS[number];

const HEADER_HINTS = [
  "fecha", "recogida", "hora", "terminal", "regreso", "precio", "iva", "usuario",
  "email", "e-mail", "correo", "telefono", "teléfono", "matricula", "matrícula",
  "marca", "modelo", "efectivo", "tarjeta", "pago",
];

function normalizedHeaderText(value: unknown) {
  return String(value ?? "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function headerHintScore(cells: Array<string | number>) {
  const matched = new Set<string>();
  for (const cell of cells) {
    const normalized = normalizedHeaderText(cell);
    for (const hint of HEADER_HINTS) if (normalized.includes(normalizedHeaderText(hint))) matched.add(normalizedHeaderText(hint));
  }
  return matched.size;
}

function findHeaderCandidate(rows: Array<{ source_row: number; cells: Array<string | number> }>) {
  const candidates = rows.slice(0, 30).map((row) => ({ row, score: headerHintScore(row.cells) })).sort((a, b) => b.score - a.score);
  if (!candidates.length || candidates[0].score < 4) throw new AppError("ai_import_headers_not_found");
  return candidates[0].row;
}

function safeHeaderLabel(value: unknown) {
  const text = String(value ?? "").trim().slice(0, 120);
  const normalized = normalizedHeaderText(text);
  const isRecognizedLabel = HEADER_HINTS.some((hint) => normalized.includes(normalizedHeaderText(hint)));
  return isRecognizedLabel ? text : "[COLUMNA]";
}

async function analyzeHeadersWithAI(rows: Array<{ source_row: number; cells: Array<string | number> }>) {
  if (!GEMINI_KEY) throw new AppError("ai_import_not_configured", 503);
  const header = findHeaderCandidate(rows);
  const safeHeaders = header.cells.map(safeHeaderLabel);
  const prompt = [
    "Interpreta exclusivamente estos encabezados de una hoja de reservas de parking y asigna sus columnas.",
    "No se incluye ninguna fila de clientes. Los índices de columna son cero-based dentro del array header_cells.",
    "Devuelve -1 para una columna que realmente no exista. No inventes columnas.",
    "Campos: pickup_date=Fecha recogida, pickup_time=Hora recogida, pickup_terminal=Terminal de recogida, return_date=Fecha de regreso, return_time=Hora regreso, return_terminal=Terminal de regreso, price_eur=Precio IVA incluido, customer_name=Usuario, customer_email=E-mail, customer_phone=Teléfono, vehicle_plate=Matrícula, vehicle_make_model=Marca y Modelo, payment_method=Efectivo o Tarjeta de crédito.",
    JSON.stringify({ header_cells: safeHeaders }),
  ].join("\n\n");
  const properties: Record<string, unknown> = {};
  for (const key of COLUMN_KEYS) properties[key] = { type: "INTEGER" };
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${AI_MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            columns: { type: "OBJECT", properties, required: [...COLUMN_KEYS] },
            warnings: { type: "ARRAY", items: { type: "STRING" } },
          },
          required: ["columns", "warnings"],
        },
      },
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    console.error("gemini_import", response.status, detail.slice(0, 1000));
    throw new AppError("ai_import_failed", 502);
  }
  const payload = await response.json();
  const text = String(payload?.candidates?.[0]?.content?.parts?.[0]?.text || "");
  let result: any = null;
  try {
    result = JSON.parse(text);
  } catch {
    throw new AppError("ai_import_invalid_response", 502);
  }
  const columns: Record<ColumnKey, number> = {} as Record<ColumnKey, number>;
  for (const key of COLUMN_KEYS) {
    const index = Number(result?.columns?.[key]);
    columns[key] = Number.isInteger(index) && index >= -1 && index < MAX_IMPORT_COLUMNS ? index : -1;
  }
  return {
    headerRow: header.source_row,
    columns,
    warnings: Array.isArray(result?.warnings) ? result.warnings.map((value: unknown) => String(value).slice(0, 300)).slice(0, 10) : [],
  };
}

function twoDigits(value: number) {
  return String(value).padStart(2, "0");
}

function toISODate(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && value > 1 && value < 100000) {
    const utc = Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000;
    return new Date(utc).toISOString().slice(0, 10);
  }
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  let match = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})$/);
  if (match) {
    let year = Number(match[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    const month = Number(match[1]);
    const day = Number(match[2]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) return `${year}-${twoDigits(month)}-${twoDigits(day)}`;
  }
  match = text.match(/^(\d{1,2})[.](\d{1,2})[.](\d{2}|\d{4})$/);
  if (match) {
    let year = Number(match[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    const day = Number(match[1]);
    const month = Number(match[2]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) return `${year}-${twoDigits(month)}-${twoDigits(day)}`;
  }
  return "";
}

function toTime(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const fraction = ((value % 1) + 1) % 1;
    const totalMinutes = Math.round(fraction * 24 * 60) % (24 * 60);
    return `${twoDigits(Math.floor(totalMinutes / 60))}:${twoDigits(totalMinutes % 60)}`;
  }
  const text = String(value ?? "").trim().toLowerCase();
  const match = text.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/);
  if (!match) return "";
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59) return "";
  if (match[3]) {
    if (hour < 1 || hour > 12) return "";
    if (match[3] === "pm" && hour !== 12) hour += 12;
    if (match[3] === "am" && hour === 12) hour = 0;
  }
  if (hour > 23) return "";
  return `${twoDigits(hour)}:${twoDigits(minute)}`;
}

function toPrice(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value * 100) / 100;
  let text = String(value ?? "").replace(/[€\s]/g, "");
  if (text.includes(",") && text.includes(".")) text = text.replace(/\./g, "").replace(",", ".");
  else text = text.replace(",", ".");
  const number = Number(text);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : NaN;
}

function toPayment(value: unknown) {
  const text = String(value ?? "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/efectivo|cash/.test(text)) return "cash";
  if (/tarjeta|credito|credit|card/.test(text)) return "credit_card";
  return "";
}

function cellAt(cells: Array<string | number>, index: number) {
  return index >= 0 && index < cells.length ? cells[index] : "";
}

function normalizeImportedRows(
  sourceRows: Array<{ source_row: number; cells: Array<string | number> }>,
  headerRow: number,
  columns: Record<ColumnKey, number>,
) {
  const validRows: any[] = [];
  const invalidRows: any[] = [];
  for (const source of sourceRows.filter((row) => row.source_row > headerRow).slice(0, MAX_IMPORT_ROWS)) {
    const raw = Object.fromEntries(COLUMN_KEYS.map((key) => [key, cellAt(source.cells, columns[key])]));
    if (Object.values(raw).every((value) => String(value ?? "").trim() === "")) continue;
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
    if (!Number.isFinite(entry.price_eur) || entry.price_eur < 0) issues.push("Precio no válido");
    if (!entry.customer_name) issues.push("Falta el usuario");
    if (!entry.vehicle_plate) issues.push("Falta la matrícula");
    if (!entry.payment_method) issues.push("Método de pago no reconocido");
    if (entry.customer_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.customer_email)) issues.push("E-mail no válido");
    if (entry.pickup_date && entry.return_date && entry.return_date < entry.pickup_date) issues.push("El regreso es anterior a la recogida");
    if (issues.length) invalidRows.push({ ...entry, price_eur: Number.isFinite(entry.price_eur) ? entry.price_eur : null, issues });
    else validRows.push(entry);
  }
  return { validRows, invalidRows };
}

async function analyzeImport(telegramUserId: number, body: any) {
  const writerEpoch = Number(body.writer_epoch);
  if (!Number.isSafeInteger(writerEpoch) || writerEpoch < 1) throw new AppError("write_permission_changed", 409);
  await rpc("parking_booking_require_writer", {
    p_actor_telegram_user_id: telegramUserId,
    p_writer_epoch: writerEpoch,
  });
  const fileName = String(body.file_name || "").replace(/[\\/]/g, "").slice(0, 240);
  const mimeType = String(body.mime_type || "application/octet-stream").slice(0, 120);
  if (!fileName) throw new AppError("invalid_import_file");
  const bytes = decodeBase64(String(body.file_base64 || ""));
  const fileSha256 = await sha256Hex(bytes);
  const extracted = await extractRows(bytes, fileName, mimeType);
  const ai = await analyzeHeadersWithAI(extracted.rows);
  const normalized = normalizeImportedRows(extracted.rows, ai.headerRow, ai.columns);
  if (!normalized.validRows.length && !normalized.invalidRows.length) throw new AppError("empty_import_file");
  const missingColumns = COLUMN_KEYS.filter((key) => ai.columns[key] < 0);
  const warnings = [...ai.warnings];
  if (missingColumns.length) warnings.push(`Columnas no detectadas: ${missingColumns.join(", ")}`);
  if (extracted.rows.length > MAX_IMPORT_ROWS) warnings.push(`Se analizaron como máximo ${MAX_IMPORT_ROWS} filas.`);
  const analysis = await insert("parking_booking_import_analyses", {
    created_by_telegram_user_id: telegramUserId,
    file_name: fileName,
    file_sha256: fileSha256,
    ai_provider: "google_gemini",
    ai_model: AI_MODEL,
    valid_rows: normalized.validRows,
    invalid_rows: normalized.invalidRows,
    warnings,
  });
  return {
    analysis_id: analysis.id,
    file_name: fileName,
    file_sha256: fileSha256,
    ai_model: AI_MODEL,
    header_row: ai.headerRow,
    columns: ai.columns,
    warnings,
    valid_rows: normalized.validRows,
    invalid_rows: normalized.invalidRows,
    expires_at: analysis.expires_at,
  };
}

function requireUuid(value: unknown, code: string) {
  const text = String(value ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) throw new AppError(code);
  return text;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  try {
    const origin = request.headers.get("Origin");
    if (origin && origin !== ALLOW_ORIGIN) throw new AppError("origin_not_allowed", 403);
    const body = await request.json();
    const auth = await validateInitData(String(body.initData || ""));
    await requireAdmin(auth.telegramUserId);
    await rpc("parking_booking_expire_permission_requests", {});
    const action = String(body.action || "");
    let data: any = null;

    if (action === "dashboard") {
      data = await rpc("parking_booking_dashboard", {
        p_actor_telegram_user_id: auth.telegramUserId,
        p_query: String(body.query || "").slice(0, 120),
        p_limit: Math.min(Math.max(Number(body.limit) || 50, 1), 200),
        p_offset: Math.max(Number(body.offset) || 0, 0),
      });
      data.ai_import_available = Boolean(GEMINI_KEY);
    } else if (action === "create") {
      data = await rpc("parking_booking_create", {
        p_actor_telegram_user_id: auth.telegramUserId,
        p_writer_epoch: Number(body.writer_epoch),
        p_idempotency_key: requireUuid(body.idempotency_key, "invalid_idempotency_key"),
        p_entry: body.entry,
      });
    } else if (action === "update") {
      data = await rpc("parking_booking_update", {
        p_actor_telegram_user_id: auth.telegramUserId,
        p_writer_epoch: Number(body.writer_epoch),
        p_idempotency_key: requireUuid(body.idempotency_key, "invalid_idempotency_key"),
        p_booking_id: requireUuid(body.booking_id, "invalid_booking_id"),
        p_expected_version: Number(body.expected_version),
        p_entry: body.entry,
      });
    } else if (action === "delete_many") {
      data = await rpc("parking_booking_delete_many", {
        p_actor_telegram_user_id: auth.telegramUserId,
        p_writer_epoch: Number(body.writer_epoch),
        p_idempotency_key: requireUuid(body.idempotency_key, "invalid_idempotency_key"),
        p_items: body.items,
      });
    } else if (action === "analyze_import") {
      data = await analyzeImport(auth.telegramUserId, body);
    } else if (action === "commit_import") {
      data = await rpc("parking_booking_import_commit", {
        p_actor_telegram_user_id: auth.telegramUserId,
        p_writer_epoch: Number(body.writer_epoch),
        p_idempotency_key: requireUuid(body.idempotency_key, "invalid_idempotency_key"),
        p_analysis_id: requireUuid(body.analysis_id, "invalid_analysis_id"),
        p_selected_source_rows: Array.isArray(body.selected_source_rows) ? body.selected_source_rows : [],
      });
    } else if (action === "request_write") {
      data = await rpc("parking_booking_request_write", {
        p_actor_telegram_user_id: auth.telegramUserId,
        p_idempotency_key: requireUuid(body.idempotency_key, "invalid_idempotency_key"),
      });
    } else if (action === "offer_transfer") {
      data = await rpc("parking_booking_offer_transfer", {
        p_actor_telegram_user_id: auth.telegramUserId,
        p_writer_epoch: Number(body.writer_epoch),
        p_target_telegram_user_id: Number(body.target_telegram_user_id),
        p_idempotency_key: requireUuid(body.idempotency_key, "invalid_idempotency_key"),
      });
    } else if (action === "respond_permission") {
      data = await rpc("parking_booking_respond_permission", {
        p_actor_telegram_user_id: auth.telegramUserId,
        p_request_id: requireUuid(body.request_id, "invalid_permission_request"),
        p_decision: String(body.decision || ""),
        p_idempotency_key: requireUuid(body.idempotency_key, "invalid_idempotency_key"),
      });
    } else if (action === "mark_notifications_read") {
      data = { count: await rpc("parking_booking_mark_notifications_read", {
        p_actor_telegram_user_id: auth.telegramUserId,
        p_notification_ids: Array.isArray(body.notification_ids) ? body.notification_ids : [],
      }) };
    } else {
      throw new AppError("invalid_action");
    }

    return json({ ok: true, ...data });
  } catch (error) {
    console.error(error);
    const message = String((error as Error)?.message || error);
    const status = error instanceof AppError ? error.status : (message === "not_admin" ? 403 : 400);
    return json({ ok: false, error: message }, status);
  }
});
