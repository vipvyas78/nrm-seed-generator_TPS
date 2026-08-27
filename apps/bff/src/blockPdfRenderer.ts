/**
 * Renders an `itt_attachment_templates.blocks` array to a PDF with pdfkit.
 *
 * Byte-for-byte copy of nrm-seed-generator's apps/bff/src/blockPdfRenderer.ts —
 * the parent repo's Configuration → ITT Templates editor uses its copy for live
 * preview, this repo's ittAttachments.ts uses this one for the real ITT send. Two
 * repos, two deployments, so a runtime cross-repo call for something this cheap
 * would add a new failure mode for no real benefit; keep both copies identical by
 * hand instead (they have no other dependencies, so drift is easy to spot in review).
 */
import PDFDocument from 'pdfkit';

export type BlockStyles = {
  align?: 'left' | 'center' | 'right';
  color?: string;
  background?: string;
  fontSize?: number;
  padding?: number;
  bold?: boolean;
};

export type Block =
  | { id: string; type: 'heading'; level: 1 | 2 | 3; text: string; styles: BlockStyles }
  | { id: string; type: 'text'; text: string; styles: BlockStyles }
  | { id: string; type: 'table'; rows: string[][]; styles: BlockStyles }
  | { id: string; type: 'checklist'; items: string[]; styles: BlockStyles }
  | { id: string; type: 'divider'; styles: BlockStyles }
  | { id: string; type: 'image'; url: string; alt: string; widthPct: number; styles: BlockStyles }
  | { id: string; type: 'button'; label: string; url: string; styles: BlockStyles };

export type RenderContext = Record<string, string>;

const TOKEN_RE = /\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g;

/**
 * Substitutes every {{token}} in `text` from `context`. An unresolved token is left
 * visibly marked rather than silently dropped — the editor validates every token
 * against the known set before save (see ittTemplateFields.ts), so this only fires
 * if something slipped through, and a visible gap in a sent PDF is safer than a
 * silently blank one.
 */
export function resolveTokens(text: string, context: RenderContext): string {
  return text.replace(TOKEN_RE, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(context, key) ? context[key] : `[[missing:${key}]]`);
}

/** Every {{token}} referenced anywhere in a block array — used by the editor's live validator. */
export function tokensIn(blocks: Block[]): string[] {
  const found = new Set<string>();
  const scan = (s: string | undefined) => {
    if (!s) return;
    for (const m of s.matchAll(TOKEN_RE)) found.add(m[1]);
  };
  for (const b of blocks) {
    if (b.type === 'heading' || b.type === 'text') scan(b.text);
    if (b.type === 'table') b.rows.forEach((row) => row.forEach(scan));
    if (b.type === 'checklist') b.items.forEach(scan);
    if (b.type === 'button') { scan(b.label); scan(b.url); }
    if (b.type === 'image') scan(b.url);
  }
  return [...found];
}

const headingSize = (level: 1 | 2 | 3): number => (level === 1 ? 20 : level === 2 ? 16 : 13);

function renderBlock(doc: PDFKit.PDFDocument, block: Block, context: RenderContext, contentWidth: number): void {
  const align = block.styles.align ?? 'left';
  const color = block.styles.color ?? '#000000';
  if (block.styles.padding) doc.moveDown(block.styles.padding / 10);

  switch (block.type) {
    case 'heading':
      doc.font('Helvetica-Bold').fontSize(block.styles.fontSize ?? headingSize(block.level)).fillColor(color)
        .text(resolveTokens(block.text, context), { align });
      doc.fillColor('#000').moveDown(0.4);
      break;

    case 'text': {
      const resolved = resolveTokens(block.text, context);
      doc.font(block.styles.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(block.styles.fontSize ?? 10).fillColor(color);
      for (const line of resolved.split('\n')) {
        if (line.startsWith('- ')) doc.text(`•  ${line.slice(2)}`, { align, indent: 12 });
        else doc.text(line, { align });
      }
      doc.fillColor('#000').moveDown(0.5);
      break;
    }

    case 'table': {
      doc.font('Helvetica').fontSize(block.styles.fontSize ?? 10);
      const colWidth = contentWidth / 2;
      for (const row of block.rows) {
        const top = doc.y;
        doc.font('Helvetica-Bold').text(resolveTokens(row[0] ?? '', context), doc.page.margins.left, top, { width: colWidth - 10 });
        const afterLeft = doc.y;
        doc.font('Helvetica').text(resolveTokens(row[1] ?? '', context), doc.page.margins.left + colWidth, top, { width: colWidth });
        doc.y = Math.max(doc.y, afterLeft);
        doc.moveDown(0.3);
      }
      doc.moveDown(0.4);
      break;
    }

    case 'checklist':
      doc.font('Helvetica').fontSize(block.styles.fontSize ?? 10);
      for (const item of block.items) {
        const top = doc.y;
        doc.rect(doc.page.margins.left, top + 1, 9, 9).stroke();
        doc.text(resolveTokens(item, context), doc.page.margins.left + 16, top, { width: contentWidth - 16 });
        doc.moveDown(0.35);
      }
      doc.moveDown(0.4);
      break;

    case 'divider': {
      doc.moveDown(0.3);
      const y = doc.y;
      doc.strokeColor(block.styles.color ?? '#cccccc')
        .moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y).stroke();
      doc.strokeColor('#000').moveDown(0.5);
      break;
    }

    // A labelled placeholder box, not a fetched remote image — a template author's
    // image host being briefly unreachable must never break an ITT send.
    case 'image': {
      const w = contentWidth * (block.widthPct / 100);
      const top = doc.y;
      doc.rect(doc.page.margins.left, top, w, 60).stroke();
      doc.fontSize(8).fillColor('#888').text(block.alt || '[image]', doc.page.margins.left + 4, top + 26, { width: w - 8 });
      doc.fillColor('#000').y = top + 68;
      break;
    }

    case 'button': {
      const label = resolveTokens(block.label, context);
      const url = resolveTokens(block.url, context);
      const top = doc.y;
      const width = Math.min(contentWidth, doc.widthOfString(label) + 32);
      doc.rect(doc.page.margins.left, top, width, 24).stroke();
      doc.fontSize(10).fillColor('#0645AD').text(label, doc.page.margins.left + 16, top + 6, { link: url, underline: true });
      doc.fillColor('#000').moveDown(1.2);
      break;
    }
  }
}

export async function renderBlocksToPdf(blocks: Block[], context: RenderContext): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 56, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));

  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  for (const block of blocks) renderBlock(doc, block, context, contentWidth);

  doc.end();
  await done;
  return Buffer.concat(chunks);
}
