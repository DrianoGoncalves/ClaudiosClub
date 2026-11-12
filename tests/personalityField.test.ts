import { describe, expect, it } from 'vitest';
import { PERSONALITIES } from '../shared/personality';
import { PERSON_FIELDS } from '../shared/person';
import { PERSON_FIELD_LABEL } from '../client/src/staff/directory';
import { PERSONALITY_TEXT, personalityToSend } from '../client/src/staff/personalityField';
import { t } from '../client/src/i18n';

describe('estilo de comunicação na ficha', () => {
  it('não manda o campo sem mudança e manda quando muda (null limpa)', () => {
    expect(personalityToSend('', undefined)).toEqual({});
    expect(personalityToSend('', null)).toEqual({});
    expect(personalityToSend('nerd', 'nerd')).toEqual({});
    expect(personalityToSend('caveman', undefined)).toEqual({ personality: 'caveman' });
    expect(personalityToSend('caveman', 'nerd')).toEqual({ personality: 'caveman' });
    expect(personalityToSend('', 'nerd')).toEqual({ personality: null });
  });

  it('todo estilo e todo campo da pessoa têm texto', () => {
    for (const p of PERSONALITIES) {
      expect(t(PERSONALITY_TEXT[p].name)).not.toBe(PERSONALITY_TEXT[p].name);
      expect(t(PERSONALITY_TEXT[p].hint)).not.toBe(PERSONALITY_TEXT[p].hint);
    }
    for (const f of PERSON_FIELDS) expect(t(PERSON_FIELD_LABEL[f])).not.toBe(PERSON_FIELD_LABEL[f]);
  });
});
