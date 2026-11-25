import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyFlowInput, FlowPolicies, FlowPolicyInput, legacyPolicy, publishOf } from '../server/flowPolicy';
import { secretDenyRules } from '../server/staff/ficha';
import type { StaffProfile } from '../shared/model';
import { tempDirs } from './support/tmp';

// O portão `publish` da política de fluxo (quem publica a versão: ver server/release.ts). Mora na mesma política, em ~/.myco, fora do alcance do agente.

const tmp = tempDirs();

describe('portão publish da política de fluxo', () => {
  it('os presets gravam o portão: Automático publica tudo, Supervisionado abre o PR e a tag espera o dono, Manual só o dono', () => {
    const base = legacyPolicy(false);
    expect(applyFlowInput(base, { mode: 'auto' }).publish).toBe('staff-all');
    expect(applyFlowInput(base, { mode: 'supervised' }).publish).toBe('staff-pr');
    expect(applyFlowInput(base, { mode: 'manual' }).publish).toBe('manual');
  });

  it('sem política, ou política gravada antes do portão, é só o dono (ninguém consentiu com publicação por funcionário)', async () => {
    expect(publishOf(null)).toBe('manual');
    expect(publishOf(legacyPolicy(true))).toBe('manual');
    const file = path.join(await tmp('myco-flowpub-'), 'flow-policies.json');
    const { promises: fs } = await import('node:fs');
    await fs.writeFile(file, JSON.stringify({ version: 1, projects: { p: { mode: 'auto', plan: 'ai', completion: 'ai', commit: true, completionChosen: true, at: new Date().toISOString() } } }));
    const stored = await new FlowPolicies(file, () => {}).get('p');
    expect(stored?.mode).toBe('auto');
    expect(publishOf(stored)).toBe('manual');
  });

  it('mexer só no portão grava custom (mesmo partindo de um preset), e o portão persiste', async () => {
    const policies = new FlowPolicies(path.join(await tmp('myco-flowpub2-'), 'flow-policies.json'), () => {});
    const auto = await policies.set('p', applyFlowInput(legacyPolicy(false), { mode: 'auto' }));
    expect(auto).toMatchObject({ mode: 'auto', publish: 'staff-all' });
    const changed = await policies.set('p', applyFlowInput(auto, FlowPolicyInput.parse({ publish: 'staff-pr' })));
    expect(changed).toMatchObject({ mode: 'custom', publish: 'staff-pr', plan: 'ai', completion: 'ai', commit: true });
    // Mexer em outro portão não apaga o publish.
    expect(applyFlowInput(changed, { commit: false }).publish).toBe('staff-pr');
    expect(() => FlowPolicyInput.parse({ publish: 'tudo' })).toThrow();
    expect(() => FlowPolicyInput.parse({ mode: 'auto', publish: 'manual' })).toThrow();
  });

  it('a ficha nega ao agente a escrita no estado das versões (~/.myco/releases)', () => {
    const rules = secretDenyRules({ id: 'ana-1', projectId: 'p', servers: [] } as unknown as StaffProfile);
    expect(rules.some((r) => /^Write\(.*releases\/\*\*\)$/.test(r))).toBe(true);
    expect(rules.some((r) => /^Edit\(.*releases\/\*\*\)$/.test(r))).toBe(true);
  });
});
