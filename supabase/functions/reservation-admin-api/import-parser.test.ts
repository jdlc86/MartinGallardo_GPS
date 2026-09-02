import ExcelJS from "npm:exceljs@4.4.0";
import { zipSync } from "npm:fflate@0.8.2";
import {
  decodeImportBase64,
  extractImportRows,
  findHeaderCandidate,
  normalizeImportedRows,
  REQUIRED_KEYS,
} from "./import-parser.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

const headers = [
  "Matrícula vehículo",
  "Usuario",
  "Fecha de regreso (Mes-Día-Año)",
  "Hora regreso",
  "Terminal de regreso",
  "Fecha recogida (Mes-Día-Año)",
  "Hora recogida",
  "Terminal de recogida",
  "Precio € (IVA incl.)",
  "E-mail",
  "Teléfono",
  "Marca y Modelo",
  "Efectivo | Tarjeta de crédito",
];

const reservation = [
  "1234ABC",
  "Ana García",
  "03/09/2026",
  "18:45",
  "Terminal 2",
  "02/09/2026",
  "08:30",
  "Terminal 1",
  "25,50",
  "ana@example.com",
  "600000000",
  "Seat Ibiza",
  "Tarjeta de crédito",
];

function xmlEscape(value: unknown) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function strictOpenXmlFixture() {
  const encoder = new TextEncoder();
  const row = (number: number, values: string[]) =>
    `<row r="${number}">${
      values.map((value, index) => {
        let column = "";
        for (
          let current = index + 1;
          current;
          current = Math.floor((current - 1) / 26)
        ) {
          column = String.fromCharCode(65 + (current - 1) % 26) + column;
        }
        return `<c r="${column}${number}" t="inlineStr"><is><t>${
          xmlEscape(value)
        }</t></is></c>`;
      }).join("")
    }</row>`;
  const strictSpreadsheet = "http://purl.oclc.org/ooxml/spreadsheetml/main";
  const strictOfficeRelationships =
    "http://purl.oclc.org/ooxml/officeDocument/relationships";
  const strictPackageRelationships =
    "http://purl.oclc.org/ooxml/package/relationships";
  const parts: Record<string, Uint8Array> = {
    "[Content_Types].xml": encoder.encode(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    ),
    "_rels/.rels": encoder.encode(
      `<?xml version="1.0"?><Relationships xmlns="${strictPackageRelationships}"><Relationship Id="rId1" Type="${strictOfficeRelationships}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": encoder.encode(
      `<?xml version="1.0"?><workbook xmlns="${strictSpreadsheet}" xmlns:r="${strictOfficeRelationships}"><sheets><sheet name="Reservas Strict" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": encoder.encode(
      `<?xml version="1.0"?><Relationships xmlns="${strictPackageRelationships}"><Relationship Id="rId1" Type="${strictOfficeRelationships}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    "xl/worksheets/sheet1.xml": encoder.encode(
      `<?xml version="1.0"?><worksheet xmlns="${strictSpreadsheet}"><sheetData>${
        row(1, ["Listado de reservas"])
      }${row(2, headers)}${row(3, reservation)}</sheetData></worksheet>`,
    ),
  };
  return zipSync(parts, { level: 6 });
}

function verifyExtracted(
  rows: Array<{ source_row: number; cells: Array<string | number> }>,
) {
  const header = findHeaderCandidate(rows);
  assert(
    REQUIRED_KEYS.every((key) => header.columns[key] >= 0),
    "deben reconocerse todos los encabezados obligatorios por significado",
  );
  const normalized = normalizeImportedRows(
    rows,
    header.row.source_row,
    header.columns,
  );
  assertEquals(
    normalized.invalidRows.length,
    0,
    "la reserva válida no debe quedar rechazada",
  );
  assertEquals(normalized.validRows.length, 1, "debe normalizarse una reserva");
  assertEquals(
    normalized.validRows[0].vehicle_plate,
    "1234ABC",
    "la matrícula debe proceder de su encabezado, no de su posición",
  );
  assertEquals(
    normalized.validRows[0].pickup_date,
    "2026-09-02",
    "la fecha española debe normalizarse",
  );
  assertEquals(
    normalized.validRows[0].payment_method,
    "credit_card",
    "el método de pago debe reconocerse semánticamente",
  );
}

Deno.test("base64 conserva todos los bytes con y sin data URI", () => {
  const original = new Uint8Array([
    0x50,
    0x4b,
    0x03,
    0x04,
    0,
    1,
    2,
    3,
    127,
    128,
    254,
    255,
  ]);
  let binary = "";
  for (const byte of original) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);
  assertEquals([...decodeImportBase64(base64)], [...original], "base64 crudo");
  assertEquals(
    [...decodeImportBase64(
      `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${base64}`,
    )],
    [...original],
    "data URI",
  );
});

Deno.test("CSV UTF-8 con punto y coma se importa por encabezados semánticos", async () => {
  const csv = `${headers.map((value) => `"${value}"`).join(";")}\r\n${
    reservation.map((value) => `"${value}"`).join(";")
  }\r\n`;
  const extracted = await extractImportRows(
    new TextEncoder().encode(csv),
    "reservas.csv",
    "application/octet-stream",
  );
  assertEquals(
    extracted.delimiter,
    ";",
    "debe detectar el delimitador español",
  );
  verifyExtracted(extracted.rows);
});

Deno.test("CSV UTF-16LE exportado por Excel se importa", async () => {
  const csv = `${headers.join("\t")}\r\n${reservation.join("\t")}\r\n`;
  const bytes = new Uint8Array(2 + csv.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let index = 0; index < csv.length; index++) {
    const code = csv.charCodeAt(index);
    bytes[2 + index * 2] = code & 0xff;
    bytes[3 + index * 2] = code >> 8;
  }
  const extracted = await extractImportRows(bytes, "reservas.csv", "text/csv");
  assertEquals(
    extracted.delimiter,
    "\t",
    "debe detectar tabuladores aunque la extensión sea CSV",
  );
  verifyExtracted(extracted.rows);
});

Deno.test("XLSX Office Open XML válido se importa desde bytes completos", async () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Reservas");
  worksheet.addRow(["Listado de reservas"]);
  worksheet.addRow(headers);
  worksheet.addRow(reservation);
  const buffer = await workbook.xlsx.writeBuffer();
  const bytes = new Uint8Array(buffer);
  assertEquals(
    [...bytes.slice(0, 4)],
    [0x50, 0x4b, 0x03, 0x04],
    "el fixture debe ser un ZIP Open XML real",
  );
  const extracted = await extractImportRows(
    bytes,
    "reservas.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  assertEquals(extracted.format, "xlsx", "debe detectar XLSX por firma");
  verifyExtracted(extracted.rows);
});

Deno.test("XLSX Strict generado fuera de ExcelJS se importa por OOXML", async () => {
  const bytes = strictOpenXmlFixture();
  const extracted = await extractImportRows(
    bytes,
    "reservas-strict.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  assertEquals(extracted.format, "xlsx", "debe admitir OOXML Strict válido");
  assertEquals(
    extracted.sheetName,
    "Reservas Strict",
    "debe conservar el nombre de hoja",
  );
  verifyExtracted(extracted.rows);
});
