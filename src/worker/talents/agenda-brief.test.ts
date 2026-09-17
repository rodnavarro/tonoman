import { describe, it, expect } from 'vitest';
import { parseAgendaTimes } from './agenda-brief';
import { agendaSlot } from '../workflows';
import { getTalent } from './registry';

describe('parseAgendaTimes', () => {
  it('defaults to early morning and midday', () => {
    expect(parseAgendaTimes(undefined)).toEqual([{ hour: 7, minute: 0 }, { hour: 12, minute: 0 }]);
    expect(parseAgendaTimes('  ')).toEqual([{ hour: 7, minute: 0 }, { hour: 12, minute: 0 }]);
  });

  it('sorts, dedupes and drops what it cannot read', () => {
    expect(parseAgendaTimes('12:30, 6:45,12:30, 25:00, noon, 9:60')).toEqual([
      { hour: 6, minute: 45 },
      { hour: 12, minute: 30 },
    ]);
  });

  it('a value with nothing readable means no times, not midnight', () => {
    expect(parseAgendaTimes('sometime')).toEqual([]);
  });
});

describe('agendaSlot', () => {
  it('is the scheduled minute in UTC, stable across seconds', () => {
    expect(agendaSlot(Date.parse('2026-09-17T11:00:07.300Z'))).toBe('2026-09-17T11:00');
    expect(agendaSlot(Date.parse('2026-09-17T11:00:59.999Z'))).toBe('2026-09-17T11:00');
  });
});

describe('registry', () => {
  it('ships the agenda brief', () => {
    expect(getTalent('agenda-brief')?.requires).toEqual([{ kind: 'calendar' }]);
  });
});
