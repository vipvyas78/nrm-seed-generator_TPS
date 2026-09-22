import { describe, expect, it } from 'vitest';
import { renderBlocksToPdf, resolveTokens, tokensIn, type Block } from '../../src/blockPdfRenderer.js';

describe('resolveTokens', () => {
  it('substitutes a known token', () => {
    expect(resolveTokens('Hello {{name}}', { name: 'Jo' })).toBe('Hello Jo');
  });

  it('marks an unresolved token visibly rather than dropping it silently', () => {
    expect(resolveTokens('Hello {{missing}}', {})).toBe('Hello [[missing:missing]]');
  });
});

describe('tokensIn', () => {
  it('finds tokens across every block type', () => {
    const blocks: Block[] = [
      { id: '1', type: 'heading', level: 1, text: 'Hi {{a}}', styles: {} },
      { id: '2', type: 'table', rows: [['{{b}}', 'x']], styles: {} },
      { id: '3', type: 'checklist', items: ['{{c}}'], styles: {} },
      { id: '4', type: 'button', label: '{{d}}', url: 'https://x/{{e}}', styles: {} }
    ];
    expect(tokensIn(blocks).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('finds nothing in a plain text block with no tokens', () => {
    expect(tokensIn([{ id: '1', type: 'text', text: 'Plain text', styles: {} }])).toEqual([]);
  });
});

describe('renderBlocksToPdf', () => {
  it('produces a real PDF for every block type without throwing', async () => {
    const blocks: Block[] = [
      { id: '1', type: 'heading', level: 1, text: 'Title {{name}}', styles: {} },
      { id: '2', type: 'text', text: 'Some text.\n- a bullet', styles: {} },
      { id: '3', type: 'table', rows: [['Label', 'Value']], styles: {} },
      { id: '4', type: 'checklist', items: ['Item one'], styles: {} },
      { id: '5', type: 'divider', styles: {} },
      { id: '6', type: 'image', url: 'https://example.com/x.png', alt: 'A logo', widthPct: 40, styles: {} },
      { id: '7', type: 'button', label: 'Open', url: 'https://example.com', styles: {} }
    ];
    const buffer = await renderBlocksToPdf(blocks, { name: 'Jo' });
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(200);
  });
});
