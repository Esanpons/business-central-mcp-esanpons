import { describe, it, expect } from 'vitest';
import { extractValidationMessage } from '../../src/protocol/mutation-result.js';
import type { BCEvent } from '../../src/protocol/types.js';

/**
 * BC refuses a value by echoing ValidationResults on the control — the interaction
 * still completes normally. Discarding that array turned "item 0000001 is not a
 * sales item" into an unexplained no-op, which is what made a working line-write
 * path look broken. Shape captured live on devel1 (Sales Order line, `No.`).
 */
function pc(controlPath: string, changes: Record<string, unknown>): BCEvent {
  return { type: 'PropertyChanged', formId: 'F1', controlPath, changes } as BCEvent;
}

describe('extractValidationMessage', () => {
  const live = pc('server:c[1]/cr/c[1]', {
    ValidationResults: [{ Id: 18, Description: "Sale debe ser igual a 'Sí' en Item: No.=0000001. El valor actual es 'No'." }],
  });

  it('returns the description BC sent for the targeted control', () => {
    expect(extractValidationMessage([live], 'server:c[1]/cr/c[1]'))
      .toBe("Sale debe ser igual a 'Sí' en Item: No.=0000001. El valor actual es 'No'.");
  });

  it('ignores validation results belonging to another control', () => {
    // The same batch carries validation state for unrelated cells; attributing one
    // cell's rejection to another would blame the wrong field.
    expect(extractValidationMessage([live], 'server:c[1]/cr/c[9]')).toBeUndefined();
  });

  it('collects across the batch when no control is named, without duplicates', () => {
    const other = pc('server:c[1]/cr/c[2]', { ValidationResults: [{ Description: 'Second problem' }] });
    const dup = pc('server:c[1]/cr/c[3]', { ValidationResults: [{ Description: 'Second problem' }] });
    expect(extractValidationMessage([live, other, dup])).toBe(
      "Sale debe ser igual a 'Sí' en Item: No.=0000001. El valor actual es 'No'. Second problem",
    );
  });

  it('returns undefined when nothing was rejected', () => {
    expect(extractValidationMessage([pc('server:c[0]', { StringValue: 'ok' })])).toBeUndefined();
    expect(extractValidationMessage([])).toBeUndefined();
  });

  it('tolerates malformed payloads instead of throwing', () => {
    const junk: BCEvent[] = [
      pc('server:c[0]', { ValidationResults: 'not-an-array' }),
      pc('server:c[0]', { ValidationResults: [null, 42, { Description: '' }, { Description: '   ' }] }),
      { type: 'InvokeCompleted', formId: 'F1' } as BCEvent,
    ];
    expect(extractValidationMessage(junk)).toBeUndefined();
  });
});
