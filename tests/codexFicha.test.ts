import { describe, expect, it } from 'vitest';
import {
  chatEffortFor,
  codexAutonomyHelp,
  codexBlockedByServers,
  defaultEffortOf,
  effortsOfModel,
  engineToSend,
  isClaudeModel,
  pickCodexModel,
  showEngineField,
  switchEngine,
  type CodexCatalog,
} from '../client/src/staff/codexEngine';
import { t } from '../client/src/i18n';

// Escolha do motor (Claude ou Codex/GPT) na ficha e no chat: a lógica pura que decide o que aparece e o que vale em cada motor.

const catalog: CodexCatalog = [
  { slug: 'gpt-6-sol', displayName: 'GPT-6 Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'high' },
  { slug: 'gpt-6-luna', displayName: 'GPT-6 Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
  // O catálogo pode trazer níveis que a ficha não guarda (o servidor só aceita low a ultra) e fora de ordem.
  { slug: 'gpt-5-terra', displayName: 'GPT-5 Terra', efforts: ['high', 'minimal', 'low'], defaultEffort: 'minimal' },
];

describe('campo "Motor" na ficha', () => {
  it('com o Codex desligado nas configurações, só aparece para quem já é do Codex', () => {
    expect(showEngineField(false, 'claude')).toBe(false);
    expect(showEngineField(null, 'claude')).toBe(false);
    expect(showEngineField(undefined, 'claude')).toBe(false);
    expect(showEngineField(false, 'codex')).toBe(true); // para dar para voltar ao Claude
  });

  it('com o Codex ligado, aparece para todos', () => {
    expect(showEngineField(true, 'claude')).toBe(true);
    expect(showEngineField(true, 'codex')).toBe(true);
  });

  it('quem tem servidores na ficha não pode escolher o Codex', () => {
    expect(codexBlockedByServers([])).toBe(false);
    expect(codexBlockedByServers(['prod'])).toBe(true);
    expect(t('staff.engineCodexServers', { tools: t('staff.tools') })).toMatch(/^Quem tem servidores na ficha não pode rodar no Codex/);
  });

  it('o Claude fica sem `engine` na ficha (como sempre foi); o Codex vai explícito, e a volta dele também', () => {
    expect(engineToSend('claude', undefined)).toBeUndefined();
    expect(engineToSend('claude', 'claude')).toBeUndefined();
    expect(engineToSend('codex', undefined)).toBe('codex');
    expect(engineToSend('codex', 'codex')).toBe('codex');
    expect(engineToSend('claude', 'codex')).toBe('claude');
  });
});

describe('esforço por modelo', () => {
  it('só os níveis do modelo escolhido, do menor ao maior, com `ultra` quando ele aceita', () => {
    expect(effortsOfModel(catalog, 'gpt-6-sol')).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(effortsOfModel(catalog, 'gpt-6-luna')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('ignora nível que a ficha não guarda e reordena', () => {
    expect(effortsOfModel(catalog, 'gpt-5-terra')).toEqual(['low', 'high']);
  });

  it('sem modelo (o padrão do Codex) ou modelo fora da lista, nenhum', () => {
    expect(effortsOfModel(catalog, '')).toEqual([]);
    expect(effortsOfModel(catalog, 'gpt-9-x')).toEqual([]);
    expect(effortsOfModel([], 'gpt-6-sol')).toEqual([]);
  });

  it('o "Padrão" mostra o nível que o modelo usa, se a ficha o guarda', () => {
    expect(defaultEffortOf(catalog, 'gpt-6-sol')).toBe('high');
    expect(defaultEffortOf(catalog, 'gpt-5-terra')).toBeNull();
    expect(defaultEffortOf(catalog, '')).toBeNull();
  });

  it('trocar de modelo mantém o esforço que o novo aceita e limpa o que não aceita', () => {
    expect(pickCodexModel(catalog, 'gpt-6-luna', 'high')).toEqual({ model: 'gpt-6-luna', effort: 'high' });
    expect(pickCodexModel(catalog, 'gpt-6-luna', 'ultra')).toEqual({ model: 'gpt-6-luna', effort: '' });
    expect(pickCodexModel(catalog, 'gpt-6-sol', 'ultra')).toEqual({ model: 'gpt-6-sol', effort: 'ultra' });
    expect(pickCodexModel(catalog, '', 'high')).toEqual({ model: '', effort: '' });
  });

  it('no chat, trocar o modelo manda um esforço novo só quando o atual não vale', () => {
    expect(chatEffortFor(catalog, 'gpt-6-luna', 'high')).toBeUndefined();
    expect(chatEffortFor(catalog, 'gpt-6-luna', 'ultra')).toBe('medium'); // o padrão do modelo
    expect(chatEffortFor(catalog, 'gpt-5-terra', 'ultra')).toBe('low'); // sem padrão que a ficha guarde: o menor
    expect(chatEffortFor(catalog, 'gpt-6-sol', null)).toBe('high');
    expect(chatEffortFor(catalog, 'gpt-9-x', 'high')).toBeUndefined(); // modelo desconhecido: não mexe
  });
});

describe('trocar de motor', () => {
  it('do Claude para o Codex limpa o modelo e o esforço (o modelo é um alias, o esforço depende do modelo)', () => {
    expect(switchEngine('codex', { model: 'opus', effort: 'high' })).toEqual({ model: '', effort: '' });
    expect(switchEngine('codex', { model: '', effort: '' })).toEqual({ model: '', effort: '' });
  });

  it('do Codex para o Claude limpa o modelo e o `ultra`, mas deixa o esforço que vale nos dois', () => {
    expect(switchEngine('claude', { model: 'gpt-6-sol', effort: 'ultra' })).toEqual({ model: '', effort: '' });
    expect(switchEngine('claude', { model: 'gpt-6-sol', effort: 'xhigh' })).toEqual({ model: '', effort: 'xhigh' });
    expect(switchEngine('claude', { model: 'gpt-6-sol', effort: '' })).toEqual({ model: '', effort: '' });
  });

  it('alias e id do Claude não valem como modelo do Codex', () => {
    for (const m of ['opus', 'sonnet', 'haiku', 'fable', 'claude-sonnet-5-5', 'default']) expect(isClaudeModel(m)).toBe(true);
    for (const m of ['gpt-6-sol', 'gpt-5.6-luna', '', null, undefined]) expect(isClaudeModel(m)).toBe(false);
  });
});

describe('o que cada autonomia vira no Codex', () => {
  it('plan e manual só leem o projeto; as outras podem editá-lo', () => {
    expect(codexAutonomyHelp('plan')).toMatch(/Só lê/);
    expect(codexAutonomyHelp('manual')).toMatch(/Só lê/);
    for (const a of ['acceptEdits', 'auto', 'bypassPermissions'] as const) expect(codexAutonomyHelp(a)).toMatch(/editar o projeto/);
  });

  it('a explicação geral diz que não há internet', () => {
    expect(t('staff.codexSandboxNote')).toMatch(/sem internet/);
  });
});
