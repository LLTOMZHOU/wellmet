import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CreateEventTypeInput, DuplicateEventTypeInput, EventTypeSettings, UpdateEventTypeInput, applySettingsChanges } from '../src/index.ts';

/**
 * The owner's agent sees these JSON schemas as tool inputs. These tests pin
 * the property that matters: every setting reaches the agent, with defaults
 * and descriptions, generated from the one definition.
 */
describe('owner tool schemas', () => {
  const create = z.toJSONSchema(CreateEventTypeInput, { io: "input" }) as unknown as {
    required?: string[];
    properties: Record<string, { description?: string; default?: unknown }>;
  };

  it('requires only slug and title to create a type', () => {
    expect(create.required?.sort()).toEqual(['slug', 'title']);
  });

  it('exposes every setting, each with a description', () => {
    const settings = Object.keys(EventTypeSettings.shape ?? {});
    const exposed = Object.keys(create.properties);
    for (const key of ['lengths', 'slot_step_min', 'buffer_before_min', 'buffer_after_min', 'min_notice_min', 'window_days',
      'limits', 'schedule', 'confirmation', 'questions', 'location', 'visibility']) {
      expect(exposed).toContain(key);
      expect(create.properties[key]!.description, key).toBeTruthy();
    }
    expect(settings.length === 0 || settings.every((k) => exposed.includes(k))).toBe(true);
  });

  it('lets an update name any single setting and nothing else', () => {
    const update = z.toJSONSchema(UpdateEventTypeInput, { io: "input" }) as unknown as {
      properties: { changes: { required?: string[]; properties: Record<string, unknown> } };
    };
    expect(update.properties.changes.required ?? []).toEqual([]);
    expect(Object.keys(update.properties.changes.properties)).toContain('visibility');
    expect(UpdateEventTypeInput.safeParse({ slug: 'intro', changes: { confirmation: 'instant' } }).success).toBe(true);
  });

  it('offers all three location kinds', () => {
    for (const location of [
      { kind: 'google_meet' },
      { kind: 'phone', number: '+1 415 555 0100' },
      { kind: 'in_person', address: '1 Market St, San Francisco' },
    ]) {
      expect(EventTypeSettings.safeParse({ title: 'x', location }).success, location.kind).toBe(true);
    }
  });

  it('duplicates with optional changes', () => {
    expect(DuplicateEventTypeInput.safeParse({ from: 'intro', slug: 'intro-long', changes: { lengths: [60] } }).success).toBe(true);
  });
});

describe('applying partial changes', () => {
  const current = EventTypeSettings.parse({ title: 'Intro call', limits: { per_week: 5 } });

  it('changes only the named fields', () => {
    const r = applySettingsChanges(current, { confirmation: 'instant' });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ title: 'Intro call', confirmation: 'instant', limits: { per_week: 5 } });
  });

  it('re-checks rules that span fields after merging', () => {
    expect(applySettingsChanges(current, { limits: { per_day: 6, per_week: 5 } }).success).toBe(false);
  });
});
