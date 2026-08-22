import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { boqPricingWorkbook, scopeOfWorksPdf } from './ittAttachments.js';
import { groupScopeSections, type IttEmailPack } from './ittEmail.js';

const pack: IttEmailPack = {
  packageName: 'Secondary Structural Steel',
  displayRef: '12',
  routeOfProcurement: 'Subcontract — Design & Build',
  returnForms: [],
  boqSummary: { total: 2, priceable: 1, authored: 1 },
  specDocuments: [],
  boqLines: [
    { geCode: '5.10', elementCode: '5.10.10', description: 'Structural steel frame', quantity: 12.5, unit: 't', isPriceable: true },
    { geCode: '5.10', elementCode: '5.10.20', description: 'Fire protection board', quantity: null, unit: 'm2', isPriceable: false }
  ],
  billLines: [
    { ref: 'B1', section: 'Preliminaries', description: 'Site survey', quantity: 1, unit: 'item', requiredFor: 'Steel frame erection' }
  ],
  scopeItems: [
    { section: 'General & Contractual', description: 'Steel frame erection', procurementStage: 'Contract' },
    { section: 'General & Contractual', description: 'Performance bonds', procurementStage: null },
    { section: 'The Works', description: 'Fire protection to steelwork', procurementStage: 'Profit Plan' }
  ],
  specClauses: [],
  bundle: null,
  attendanceSummary: { subcontractor: 5, mainContractor: 3, joint: 1 },
  valueEngineeringRequired: true
};

const readBack = async (buffer: Buffer): Promise<ExcelJS.Workbook> => {
  const workbook = new ExcelJS.Workbook();
  // Cast: exceljs types the reader as taking a stream, but accepts a Buffer at runtime and
  // this is the documented way to round-trip one in a test.
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook;
};

describe('scopeOfWorksPdf', () => {
  it('produces a real PDF', async () => {
    const file = await scopeOfWorksPdf(pack, 'Riverside House');
    expect(file.filename).toBe('Scope of Works - Secondary Structural Steel.pdf');
    expect(file.contentType).toBe('application/pdf');
    expect(file.content.subarray(0, 5).toString()).toBe('%PDF-');
    expect(file.content.length).toBeGreaterThan(500);
  });

  it('strips path characters a client typed into a package name out of the filename', async () => {
    const file = await scopeOfWorksPdf({ ...pack, packageName: 'M&E / HVAC: phase 1' }, 'Riverside House');
    expect(file.filename).toBe('Scope of Works - M&E HVAC phase 1.pdf');
  });

  it('renders without throwing when a package has no scope configured', async () => {
    const file = await scopeOfWorksPdf({ ...pack, scopeItems: [] }, 'Riverside House');
    expect(file.content.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('numbers clauses from the same helper the email body uses', () => {
    // The PDF and the email must agree on what "item 3" means. Pinning the shared helper is
    // what actually protects that — two separate numbering passes would drift silently.
    const sections = groupScopeSections(pack.scopeItems);
    expect(sections.map((s) => s.section)).toEqual(['General & Contractual', 'The Works']);
    expect(sections[0].lines.map((l) => l.number)).toEqual([1, 2]);
    expect(sections[1].lines[0].number).toBe(3);
    expect(sections[1].lines[0].text).toContain('Profit Plan — not priced');
  });
});

describe('boqPricingWorkbook', () => {
  it('is a pricing form: Rate and Total columns exist but every value cell is blank', async () => {
    const file = await boqPricingWorkbook(pack, 'Riverside House');
    expect(file.filename).toBe('Bill of Quantities - Secondary Structural Steel.xlsx');
    expect(file.contentType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    const sheet = (await readBack(file.content)).getWorksheet('Bill of Quantities')!;
    const headers = sheet.getRow(1).values as unknown[];
    expect(headers).toContain('Rate');
    expect(headers).toContain('Total');

    // Rate is what the tenderer types. It must arrive empty, or we have quoted them a price.
    expect(sheet.getCell('F2').value).toBeNull();
    expect(sheet.getCell('F3').value).toBeNull();
  });

  it('totals each line by formula over the tenderer own rate', async () => {
    const file = await boqPricingWorkbook(pack, 'Riverside House');
    const sheet = (await readBack(file.content)).getWorksheet('Bill of Quantities')!;
    expect((sheet.getCell('G2').value as { formula: string }).formula).toBe('D2*F2');
    expect((sheet.getCell('G3').value as { formula: string }).formula).toBe('D3*F3');
  });

  it('writes quantities as numbers so the formula multiplies rather than erroring', async () => {
    const file = await boqPricingWorkbook(pack, 'Riverside House');
    const sheet = (await readBack(file.content)).getWorksheet('Bill of Quantities')!;
    expect(sheet.getCell('D2').value).toBe(12.5);
    // A line the take-off could not measure carries no quantity, and must stay empty rather
    // than becoming a zero the tenderer would price against.
    expect(sheet.getCell('D3').value).toBeNull();
  });

  it('coerces a NUMERIC returned as a string into a real number', async () => {
    // node-postgres hands NUMERIC back as a string ("86.000") despite the `number | null`
    // type, and a text quantity silently breaks the tenderer's Total formula and their SUM.
    const fromDb = {
      ...pack,
      boqLines: [{ ...pack.boqLines[0], quantity: '86.000' as unknown as number }]
    };
    const sheet = (await readBack((await boqPricingWorkbook(fromDb, 'Riverside House')).content))
      .getWorksheet('Bill of Quantities')!;
    expect(sheet.getCell('D2').value).toBe(86);
    expect(typeof sheet.getCell('D2').value).toBe('number');
  });

  it('carries every measured line', async () => {
    const file = await boqPricingWorkbook(pack, 'Riverside House');
    const sheet = (await readBack(file.content)).getWorksheet('Bill of Quantities')!;
    expect(sheet.getCell('C2').value).toBe('Structural steel frame');
    expect(sheet.getCell('C3').value).toBe('Fire protection board');
  });

  it('gives authored bill lines their own sheet, and omits it when there are none', async () => {
    const withBill = await readBack((await boqPricingWorkbook(pack, 'Riverside House')).content);
    expect(withBill.getWorksheet('Authored Items')).toBeDefined();
    expect(withBill.getWorksheet('Authored Items')!.getCell('C2').value).toBe('Site survey');

    const withoutBill = await readBack((await boqPricingWorkbook({ ...pack, billLines: [] }, 'Riverside House')).content);
    expect(withoutBill.getWorksheet('Authored Items')).toBeUndefined();
  });

  it('states the pricing rules the ITT requires on a notes sheet', async () => {
    const file = await boqPricingWorkbook(pack, 'Riverside House');
    const notes = (await readBack(file.content)).getWorksheet('Notes')!;
    const text = (notes.getColumn(1).values as unknown[]).filter(Boolean).join(' | ');
    expect(text).toContain('Riverside House');
    expect(text).toContain('expressly excluded');
  });

  it('never leaks a rate or cost figure into the workbook', async () => {
    const file = await boqPricingWorkbook(pack, 'Riverside House');
    const workbook = await readBack(file.content);
    const values: string[] = [];
    workbook.eachSheet((sheet) => {
      sheet.eachRow((row) => {
        (row.values as unknown[]).forEach((v) => {
          if (v !== null && v !== undefined) values.push(typeof v === 'object' ? JSON.stringify(v) : String(v));
        });
      });
    });
    expect(values.join(' ').toLowerCase()).not.toMatch(/unit_rate|total_cost|£\d/);
  });
});
