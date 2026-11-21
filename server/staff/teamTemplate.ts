import { z } from 'zod';
import { teamTemplateById, type TeamTemplate } from '../../shared/teamTemplates';
import { StaffError } from './store';

// Modelo de equipe (shared/teamTemplates.ts): o corpo da rota e a conferência do id. A montagem das fichas é de StaffService.applyTeamTemplate.

const TemplateBody = z.object({ templateId: z.string().regex(/^[a-z0-9-]{1,40}$/, 'modelo de equipe inválido') });

/** O modelo pelo id; id fora da lista é erro do pedido (400). */
export function templateOf(id: string): TeamTemplate {
  const template = teamTemplateById(id);
  if (!template) throw new StaffError(`modelo de equipe desconhecido: ${id.slice(0, 40)}`);
  return template;
}

/** O corpo `{ templateId }` da rota, já resolvido no modelo. */
export function parseTemplateBody(body: unknown): TeamTemplate {
  const r = TemplateBody.safeParse(body);
  if (!r.success) throw new StaffError(r.error.issues[0]?.message ?? 'informe o modelo de equipe (templateId)');
  return templateOf(r.data.templateId);
}
