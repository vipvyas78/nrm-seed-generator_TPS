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
import { renderBlocksToPdf, resolveTokens, type Block, type RenderContext } from './blockPdfRenderer.js';

export interface IttAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

/** A resolved (org-override-or-global) itt_attachment_templates row — read by
 * tenderPrepDb.ts, handed in here as plain data so this file stays a pure function
 * of its inputs, same as scopeOfWorksPdf/boqPricingWorkbook always have been. */
export interface ResolvedAttachmentTemplate {
  attachmentCode: string;
  filenamePattern: string;
  blocks: Block[];
}

export type AttendanceRow = { groupName: string; description: string; owner: 'SC' | 'H' | 'J' | 'N/A'; notes: string | null };

const OWNER_LABEL: Record<AttendanceRow['owner'], string> = { SC: 'SC', H: 'MC', J: 'J', 'N/A': 'N/A' };

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

/** Renders one 'blocks'-kind attachment (cover letter, Form 1A/1B/1C, …) from its
 * resolved template — the same renderer the Configuration → ITT Templates preview
 * endpoint in the parent repo uses, so a preview can never disagree with a real send. */
async function blocksAttachmentPdf(template: ResolvedAttachmentTemplate, context: RenderContext): Promise<IttAttachment> {
  const content = await renderBlocksToPdf(template.blocks, context);
  return {
    filename: resolveTokens(template.filenamePattern, context),
    contentType: PDF_CONTENT_TYPE,
    content
  };
}

/**
 * The Schedule of Attendances as a PDF: the template row's blocks (title/intro,
 * editable in Configuration) followed by the actual attendance_items table, which is
 * real project data and NOT editable as a template. Owner is mapped H -> "MC" for
 * display — the reference document's own label; the DB code is the client's ('SC',
 * 'H', 'J', 'N/A' — see tps.attendance_items).
 */
export async function scheduleOfAttendancesPdf(
  template: ResolvedAttachmentTemplate | null,
  context: RenderContext,
  attendanceItems: AttendanceRow[]
): Promise<IttAttachment> {
  const doc = new PDFDocument({ size: 'A4', margin: 56, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));

  if (template) {
    // Reuses the shared block renderer for just the title/intro portion by drawing
    // into the same document — renderBlocksToPdf owns its own PDFDocument, so the
    // intro is rendered separately and its bytes are not reused here; instead the
    // title/intro blocks are walked with the same primitives inline, kept simple
    // since they are almost always a couple of text/heading blocks.
    for (const block of template.blocks) {
      if (block.type === 'heading') {
        doc.font('Helvetica-Bold').fontSize(block.level === 1 ? 20 : block.level === 2 ? 16 : 13)
          .text(resolveTokens(block.text, context));
        doc.moveDown(0.4);
      } else if (block.type === 'text') {
        doc.font('Helvetica').fontSize(10).text(resolveTokens(block.text, context));
        doc.moveDown(0.5);
      }
    }
  }
  doc.moveDown(0.3);

  let currentGroup: string | null = null;
  const colWidths = { group: 90, description: 300, owner: 40, notes: 100 };
  for (const item of attendanceItems) {
    if (item.groupName !== currentGroup) {
      currentGroup = item.groupName;
      doc.moveDown(0.4);
      doc.font('Helvetica-Bold').fontSize(10).text(currentGroup);
      doc.moveDown(0.1);
    }
    const top = doc.y;
    const left = doc.page.margins.left;
    doc.font('Helvetica').fontSize(9)
      .text(item.description, left, top, { width: colWidths.description });
    const afterDesc = doc.y;
    doc.font('Helvetica-Bold').text(OWNER_LABEL[item.owner], left + colWidths.description + 8, top, { width: colWidths.owner });
    if (item.notes) doc.font('Helvetica-Oblique').fontSize(8)
      .text(item.notes, left + colWidths.description + colWidths.owner + 16, top, { width: colWidths.notes });
    doc.y = Math.max(doc.y, afterDesc);
    doc.moveDown(0.25);
  }

  doc.end();
  await done;

  return {
    filename: template ? resolveTokens(template.filenamePattern, context) : 'Schedule of Attendances.pdf',
    contentType: PDF_CONTENT_TYPE,
    content: Buffer.concat(chunks)
  };
}

/**
 * All the attachments configured for this pack's trade, in the order
 * `itt_attachment_trades`/`itt_attachment_types.sort_order` resolved them (see
 * `pack.attachmentCodes`, set by `tenderPrepDb.ts`'s `attachmentCodesFor`).
 *
 * `scope_of_works` and `boq_pricing_workbook` keep their existing bespoke,
 * measurement-driven generators regardless of configuration — those render_kind
 * 'code' types are never template-driven. Everything else is looked up in
 * `templates` (pre-resolved: org override if the org has one, else the seeded
 * global default) and rendered through the shared block engine.
 */
export async function ittAttachmentsFor(
  pack: IttEmailPack,
  projectName: string,
  context: RenderContext,
  templates: Map<string, ResolvedAttachmentTemplate>,
  attendanceItems: AttendanceRow[]
): Promise<IttAttachment[]> {
  const built: IttAttachment[] = [];
  for (const code of pack.attachmentCodes) {
    if (code === 'scope_of_works') { built.push(await scopeOfWorksPdf(pack, projectName)); continue; }
    if (code === 'boq_pricing_workbook') { built.push(await boqPricingWorkbook(pack, projectName)); continue; }
    if (code === 'schedule_of_attendances') { built.push(await scheduleOfAttendancesPdf(templates.get(code) ?? null, context, attendanceItems)); continue; }
    const template = templates.get(code);
    if (template) built.push(await blocksAttachmentPdf(template, context));
  }
  return built;
}
