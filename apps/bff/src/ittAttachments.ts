/**
 * The two files an ITT carries: the scope of works, and the pricing schedule.
 *
 * Pure functions over `IttEmailPack` — no DB, no network, no filesystem — so they unit-test
 * without Postgres, exactly as `ittEmail.ts` does. The pack they read is the same one the
 * email body renders from, which is the point: an attachment that disagreed with the email
 * it arrived with would be worse than no attachment at all.
 *
 * NO RATES. `boqReadDb.ts` and `tenderPrepDb.ts` both state the invariant that an ITT never
 * discloses a rate or a cost, and it holds here too. The pricing workbook has Rate and Total
 * COLUMNS, but every value cell is empty — they exist for the tenderer to fill in, and the
 * Total column is a formula over their own input. Nothing derived from `unit_rate` or
 * `total_cost` may ever be written into these files.
 */
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import {
  BILL_HEADERS,
  BOQ_HEADERS,
  billRowsFor,
  boqRowsFor,
  groupScopeSections,
  type IttEmailPack
} from './ittEmail.js';

export interface IttAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PDF_CONTENT_TYPE = 'application/pdf';

/**
 * Windows, macOS and most mail clients all reject some punctuation in a filename, and a
 * package name is free text a client typed. Collapse anything risky rather than trusting it.
 */
const safeName = (s: string): string =>
  s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Package';

/**
 * Coerce a quantity to a real number for the spreadsheet.
 *
 * `IttEmailBoqLine.quantity` is typed `number | null`, but node-postgres hands NUMERIC back
 * as a STRING ("86.000") to avoid the precision loss of a float. That is invisible in the
 * email, where every cell is stringified anyway — but a spreadsheet stores it as text, and a
 * text quantity silently breaks the tenderer's own SUM and the Total formula beside it.
 */
const numeric = (value: number | null): number | null => {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * The scope of works as a PDF, numbered identically to the email body.
 *
 * Both call `groupScopeSections`, so the numbering cannot drift — a bill that refers to
 * "item 29" means the same clause in the email and in the attachment.
 */
export async function scopeOfWorksPdf(pack: IttEmailPack, projectName: string): Promise<IttAttachment> {
  const sections = groupScopeSections(pack.scopeItems);
  const doc = new PDFDocument({ size: 'A4', margin: 56, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));

  doc.font('Helvetica-Bold').fontSize(18).text('Scope of Works');
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(11).fillColor('#444')
    .text(`${pack.packageName} (ref ${pack.displayRef})`)
    .text(projectName);
  if (pack.routeOfProcurement) doc.text(`Route: ${pack.routeOfProcurement}`);
  doc.fillColor('#000').moveDown(1);

  if (sections.length === 0) {
    doc.font('Helvetica-Oblique').fontSize(11)
      .text('No scope of works is configured for this package.');
  }

  for (const section of sections) {
    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(12).text(section.section);
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10);
    for (const line of section.lines) {
      // Hanging indent: the number sits in its own gutter so wrapped clause text lines up.
      const top = doc.y;
      doc.fillColor('#888').text(`${line.number}`, doc.page.margins.left, top, { width: 26 });
      doc.fillColor('#000').text(line.text, doc.page.margins.left + 30, top, {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 30
      });
      doc.moveDown(0.35);
    }
  }

  doc.end();
  await done;

  return {
    filename: `Scope of Works - ${safeName(pack.packageName)}.pdf`,
    contentType: PDF_CONTENT_TYPE,
    content: Buffer.concat(chunks)
  };
}

/** Header styling shared by both sheets, so the workbook reads as one document. */
const styleHeader = (sheet: ExcelJS.Worksheet, columnCount: number): void => {
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.border = { bottom: { style: 'thin' } };
  header.commit();
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columnCount }
  };
};

/**
 * The bill of quantities as a blank pricing schedule.
 *
 * Rate and Total are EMPTY, by design: the ITT asks for every line to be priced or expressly
 * excluded with a reason, and this is the document that is returned. Total carries a formula
 * over the tenderer's own Rate, so a filled-in sheet totals itself.
 */
export async function boqPricingWorkbook(pack: IttEmailPack, projectName: string): Promise<IttAttachment> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Novamerx Tender Prep';
  workbook.created = new Date();

  const boq = workbook.addWorksheet('Bill of Quantities');
  boq.columns = [
    { header: BOQ_HEADERS[0], key: 'ge', width: 10 },
    { header: BOQ_HEADERS[1], key: 'element', width: 12 },
    { header: BOQ_HEADERS[2], key: 'description', width: 72 },
    { header: BOQ_HEADERS[3], key: 'quantity', width: 12 },
    { header: BOQ_HEADERS[4], key: 'unit', width: 8 },
    { header: 'Rate', key: 'rate', width: 14 },
    { header: 'Total', key: 'total', width: 16 }
  ];

  boqRowsFor(pack).forEach((row, index) => {
    const rowNumber = index + 2;
    const line = boq.addRow({
      ge: row[0], element: row[1], description: row[2],
      // The quantity is text in the email tables ("—" for null); the workbook wants a real
      // number so the tenderer's Total formula multiplies rather than erroring.
      quantity: numeric(pack.boqLines[index].quantity), unit: row[4],
      rate: null, total: { formula: `D${rowNumber}*F${rowNumber}` }
    });
    line.getCell('description').alignment = { wrapText: true, vertical: 'top' };
    line.getCell('quantity').numFmt = '#,##0.000';
    line.getCell('rate').numFmt = '#,##0.00';
    line.getCell('total').numFmt = '#,##0.00';
  });

  styleHeader(boq, 7);

  if (pack.billLines.length > 0) {
    const bill = workbook.addWorksheet('Authored Items');
    bill.columns = [
      { header: BILL_HEADERS[0], key: 'ref', width: 10 },
      { header: BILL_HEADERS[1], key: 'section', width: 22 },
      { header: BILL_HEADERS[2], key: 'description', width: 64 },
      { header: BILL_HEADERS[3], key: 'quantity', width: 12 },
      { header: BILL_HEADERS[4], key: 'unit', width: 8 },
      { header: BILL_HEADERS[5], key: 'requiredFor', width: 20 },
      { header: 'Rate', key: 'rate', width: 14 },
      { header: 'Total', key: 'total', width: 16 }
    ];
    billRowsFor(pack).forEach((row, index) => {
      const rowNumber = index + 2;
      const line = bill.addRow({
        ref: row[0], section: row[1], description: row[2],
        quantity: numeric(pack.billLines[index].quantity), unit: row[4], requiredFor: row[5],
        rate: null, total: { formula: `D${rowNumber}*G${rowNumber}` }
      });
      line.getCell('description').alignment = { wrapText: true, vertical: 'top' };
      line.getCell('rate').numFmt = '#,##0.00';
      line.getCell('total').numFmt = '#,##0.00';
    });
    styleHeader(bill, 8);
  }

  const notes = workbook.addWorksheet('Notes');
  notes.columns = [{ header: 'Pricing this schedule', key: 'note', width: 100 }];
  [
    `Project: ${projectName}`,
    `Package: ${pack.packageName} (ref ${pack.displayRef})`,
    '',
    'Enter a rate against every line. The Total column calculates itself.',
    'Any line you do not price must be expressly excluded, with the reason stated.',
    'Quantities are issued for pricing only and do not limit the scope of works.',
    'Read this schedule with the attached scope of works, which takes precedence.'
  ].forEach((note) => notes.addRow({ note }));
  styleHeader(notes, 1);

  const content = Buffer.from(await workbook.xlsx.writeBuffer());

  return {
    filename: `Bill of Quantities - ${safeName(pack.packageName)}.xlsx`,
    contentType: XLSX_CONTENT_TYPE,
    content
  };
}

/** Both attachments for one package, in the order they should appear on the message. */
export async function ittAttachmentsFor(pack: IttEmailPack, projectName: string): Promise<IttAttachment[]> {
  return [
    await scopeOfWorksPdf(pack, projectName),
    await boqPricingWorkbook(pack, projectName)
  ];
}
