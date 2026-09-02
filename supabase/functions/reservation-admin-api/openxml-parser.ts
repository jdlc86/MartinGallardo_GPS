import { unzipSync } from "npm:fflate@0.8.2";
import { DOMParser } from "npm:@xmldom/xmldom@0.8.11";

const MAX_ZIP_ENTRIES = 3000;
const MAX_UNCOMPRESSED_BYTES = 40_000_000;
const MAX_ENTRY_BYTES = 20_000_000;

function uint16(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function uint32(bytes: Uint8Array, offset: number) {
  return (bytes[offset] | (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function validateZipBounds(bytes: Uint8Array) {
  const lowerBound = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= lowerBound; offset--) {
    if (uint32(bytes, offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("No se encontró el directorio ZIP central.");
  const entries = uint16(bytes, eocd + 10);
  const centralSize = uint32(bytes, eocd + 12);
  const centralOffset = uint32(bytes, eocd + 16);
  if (!entries || entries > MAX_ZIP_ENTRIES) {
    throw new Error(`Número de entradas ZIP fuera de rango: ${entries}.`);
  }
  if (centralOffset + centralSize > bytes.length) {
    throw new Error("El directorio ZIP está truncado.");
  }
  let offset = centralOffset;
  let total = 0;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > bytes.length || uint32(bytes, offset) !== 0x02014b50) {
      throw new Error("Entrada ZIP central no válida.");
    }
    const flags = uint16(bytes, offset + 8);
    if (flags & 1) throw new Error("Los XLSX cifrados no son compatibles.");
    const size = uint32(bytes, offset + 24);
    if (size > MAX_ENTRY_BYTES) {
      throw new Error("Una parte del XLSX supera el límite permitido.");
    }
    total += size;
    if (total > MAX_UNCOMPRESSED_BYTES) {
      throw new Error("El XLSX descomprimido supera el límite permitido.");
    }
    offset += 46 + uint16(bytes, offset + 28) + uint16(bytes, offset + 30) +
      uint16(bytes, offset + 32);
  }
}

function normalizePath(base: string, target: string) {
  const source = target.startsWith("/")
    ? target.slice(1)
    : `${base.slice(0, base.lastIndexOf("/") + 1)}${target}`;
  const parts: string[] = [];
  for (const part of source.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function localName(node: { localName?: string | null; nodeName?: string }) {
  return node.localName || String(node.nodeName || "").split(":").pop() || "";
}

function descendants(root: Document | Element, name: string) {
  return Array.from(root.getElementsByTagName("*")).filter((node) =>
    localName(node) === name
  );
}

function parseXml(entries: Record<string, Uint8Array>, path: string) {
  const bytes = entries[path];
  if (!bytes) throw new Error(`Falta la parte OOXML ${path}.`);
  const document = new DOMParser().parseFromString(
    new TextDecoder().decode(bytes),
    "application/xml",
  );
  if (!document || descendants(document, "parsererror").length) {
    throw new Error(`XML no válido en ${path}.`);
  }
  return document;
}

function relationshipId(element: Element) {
  return element.getAttribute("r:id") || element.getAttribute("id") ||
    Array.from(element.attributes).find((attribute) =>
      localName(attribute) === "id"
    )?.value || "";
}

function columnIndex(reference: string) {
  const letters = reference.match(/^[A-Za-z]+/)?.[0]?.toUpperCase() || "";
  let result = 0;
  for (const letter of letters) {
    result = result * 26 + letter.charCodeAt(0) - 64;
  }
  return result;
}

function textNodes(element: Element) {
  return descendants(element, "t").map((node) => node.textContent || "").join(
    "",
  );
}

function cellValue(cell: Element, sharedStrings: string[]) {
  const type = cell.getAttribute("t") || "";
  if (type === "inlineStr") return textNodes(cell);
  const raw = descendants(cell, "v")[0]?.textContent ?? "";
  if (type === "s") return sharedStrings[Number(raw)] ?? "";
  if (type === "str" || type === "d" || type === "e") return raw;
  if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
  const number = Number(raw);
  return raw !== "" && Number.isFinite(number) ? number : raw;
}

export function extractOpenXmlRows(
  bytes: Uint8Array,
  maxRows: number,
  maxColumns: number,
) {
  validateZipBounds(bytes);
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (error) {
    throw new Error(
      `No se pudo descomprimir el paquete OOXML: ${
        (error as Error)?.message || error
      }`,
    );
  }

  const workbookPath = entries["xl/workbook.xml"]
    ? "xl/workbook.xml"
    : Object.keys(entries).find((path) => path.endsWith("/workbook.xml"));
  if (!workbookPath) throw new Error("No se encontró xl/workbook.xml.");
  const workbook = parseXml(entries, workbookPath);
  const relationshipsPath = normalizePath(
    workbookPath,
    "_rels/workbook.xml.rels",
  );
  const relationships = parseXml(entries, relationshipsPath);
  const targets = new Map(
    descendants(relationships, "Relationship").map((relationship) => [
      relationship.getAttribute("Id") || relationship.getAttribute("id") || "",
      relationship.getAttribute("Target") ||
      relationship.getAttribute("target") || "",
    ]),
  );
  const sharedPath = Object.keys(entries).find((path) =>
    path.endsWith("/sharedStrings.xml")
  );
  const sharedStrings = sharedPath
    ? descendants(parseXml(entries, sharedPath), "si").map(textNodes)
    : [];

  const sheets = descendants(workbook, "sheet");
  for (let sheetIndex = 0; sheetIndex < sheets.length; sheetIndex++) {
    const sheet = sheets[sheetIndex];
    const target = targets.get(relationshipId(sheet));
    const fallback = Object.keys(entries).filter((path) =>
      /\/worksheets\/sheet\d+\.xml$/i.test(path)
    ).sort()[sheetIndex];
    const sheetPath = target ? normalizePath(workbookPath, target) : fallback;
    if (!sheetPath || !entries[sheetPath]) {
      continue;
    }
    const document = parseXml(entries, sheetPath);
    const rows: Array<{ source_row: number; cells: Array<string | number> }> =
      [];
    for (const [position, row] of descendants(document, "row").entries()) {
      if (rows.length >= maxRows + 25) {
        break;
      }
      const cells: Array<string | number> = [];
      let sequentialColumn = 1;
      for (const cell of descendants(row, "c")) {
        const column = columnIndex(cell.getAttribute("r") || "") ||
          sequentialColumn;
        sequentialColumn = column + 1;
        if (column < 1 || column > maxColumns) {
          continue;
        }
        cells[column - 1] = cellValue(cell, sharedStrings);
      }
      for (let index = 0; index < cells.length; index++) {
        if (cells[index] == null) {
          cells[index] = "";
        }
      }
      if (
        cells.some((value) =>
          String(value).trim() !== ""
        )
      ) {
        rows.push({
          source_row: Number(row.getAttribute("r")) || position + 1,
          cells,
        });
      }
    }
    if (rows.length) {
      return {
        format: "xlsx" as const,
        sheetName: sheet.getAttribute("name") || `Hoja ${sheetIndex + 1}`,
        rows,
        delimiter: null,
      };
    }
  }
  throw new Error("El libro no contiene hojas con filas legibles.");
}
