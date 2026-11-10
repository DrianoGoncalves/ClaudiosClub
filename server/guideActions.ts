import { z } from 'zod';
import type { StaffProfile, TaskCodeFile } from '../shared/model';
import { GUIDE_PATH, GUIDE_TEMPLATE, headSha, hasGuide, recordCheck, validCheck } from './projectGuide';
import { changedFiles } from './taskCode';

// Ações do guia (POST /api/projects/:id/guide/run): abrem uma conversa NOVA de um funcionário com o texto da
// ação. Quem faz o trabalho é ele, na conversa; aqui só escolhemos o texto e conferimos o estado do guia.
// O envio é o mesmo da revisão de tarefas (`send` em server/index.ts), sem duplicar a lógica.

export const GUIDE_ACTIONS = ['test', 'drift', 'draft'] as const;
export type GuideAction = (typeof GUIDE_ACTIONS)[number];

export const GuideRunBody = z.object({
  action: z.enum(GUIDE_ACTIONS, { errorMap: () => ({ message: 'ação inválida (test, drift ou draft)' }) }),
  staffId: z
    .string({ required_error: 'escolha quem faz a ação' })
    .trim()
    .min(1, 'escolha quem faz a ação')
    .max(40),
});

/** Pedido que não vale agora (sem SPEC.md, ou rascunho com ele já escrito). A rota responde 400. */
export class GuideActionError extends Error {}

/** Acima disso, a lista de arquivos vira só a contagem (o texto não cabe numa mensagem). */
export const MAX_LISTED_FILES = 80;

/** Mudanças desde a última conferência, para o texto do drift. */
export interface GuideChanges {
  /** Hora da última conferência (ISO). */
  at: string;
  files: TaskCodeFile[];
}

/** Resposta de `drift` sem mudanças desde a base: nada é aberto. */
export interface GuideSkipped {
  skipped: true;
  reason: string;
}

export type GuideRunResult = { sessionId: string; staffId: string } | GuideSkipped;

const dia = (at: string) => new Date(at).toLocaleDateString('pt-BR');

export interface GuideRunDeps {
  /** O funcionário do projeto (null: não existe). */
  readProfile: (staffId: string) => Promise<StaffProfile | null>;
  /** Abre a conversa nova e manda o texto; devolve o id da conversa (ver `send` em server/index.ts). */
  send: (staffId: string, text: string, force: boolean) => Promise<string>;
}

const LABEL: Record<GuideAction, string> = {
  test: 'teste de compreensão',
  drift: 'divergência',
  draft: 'rascunho',
};

/**
 * Texto da ação, em pt-BR. Começa com `[Guia do projeto: <ação>]`, como as outras mensagens automáticas.
 * `changes` (só no drift): há base de conferência; o texto manda conferir só os arquivos mudados desde ela.
 */
export function guideActionText(action: GuideAction, changes?: GuideChanges | null): string {
  const head = `[Guia do projeto: ${LABEL[action]}]`;
  if (action === 'test') {
    return [
      head,
      `Teste se o ${GUIDE_PATH} se sustenta sem contexto. Use a ferramenta Agent para abrir um subagent NOVO, que não herda esta conversa, e passe a ele só isto:\n- o caminho do arquivo: \`${GUIDE_PATH}\` (raiz do projeto);\n- a instrução: "Leia só este arquivo. Não leia código, outros arquivos nem a web. Devolva: (1) O que entendi: o que é o projeto, para quem, o que faz e o que não faz, nas suas palavras. (2) Dúvidas: o que ficou ambíguo, contraditório ou faltando; cada item com 🔴 (impede entender), 🟡 (importante) ou 🟢 (detalhe)."`,
      'Não passe ao subagent a sua opinião, o contexto nem esta conversa.',
      'Se você não tiver a ferramenta Agent, pare e avise o usuário que este teste não vale no mesmo contexto.',
      'Depois:\n1. Mostre a resposta do subagent como veio, sem resumir.\n2. Compare com o que você sabe do projeto. Onde a paráfrase dele errou ou ficou vaga, o guia precisa de ajuste.\n3. Proponha as mudanças no SPEC.md (trecho e motivo). Não edite sem o ok do usuário.',
    ].join('\n\n');
  }
  if (action === 'drift') {
    const report =
      'Reporte SÓ divergências, cada uma com arquivo:linha, o trecho do guia e a severidade (🔴 grave, 🟡 importante, 🟢 detalhe). Categorias:\n- escopo descrito e não implementado;\n- implementado o que está em "Fora do escopo";\n- princípio violado;\n- decisão não seguida;\n- termo do glossário usado com outro sentido;\n- funcionalidade relevante do código que o guia não menciona.';
    if (!changes) {
      return [
        head,
        `Compare o ${GUIDE_PATH} com o código atual. Para buscas longas no código, use um subagent Explore, para não encher esta conversa.`,
        report,
        'Sem divergência, responda: "Nenhuma divergência".',
        'Não edite nada.',
      ].join('\n\n');
    }
    const { at, files } = changes;
    const list =
      files.length > MAX_LISTED_FILES
        ? `${files.length} arquivos mudados desde ${dia(at)}: a lista é longa demais para caber aqui. Confira por pasta de nível alto, com um subagent Explore por pasta, passando só o caminho dela e os itens do guia que tocam nela.`
        : `Arquivos mudados desde ${dia(at)} (${files.length}; status e caminho):\n${files.map((f) => `- ${f.status} ${f.path}`).join('\n')}`;
    return [
      head,
      `Confira o ${GUIDE_PATH} SÓ contra os arquivos mudados listados abaixo. Não varra o repo inteiro. Para cada arquivo, leia o trecho dele e o item do guia que ele afeta.`,
      list,
      report,
      'Sem divergência, responda: "Nenhuma divergência".',
      'Não edite nada.',
    ].join('\n\n');
  }
  return [
    head,
    `Escreva o ${GUIDE_PATH} na raiz do projeto a partir do código, seguindo o modelo abaixo. As linhas \`<!-- -->\` são instruções para você: não as copie.`,
    'Para levantar o projeto, leia o README, os manifestos de pacote, a estrutura de pastas e as rotas ou telas principais. Para varrer o código, use um subagent Explore.',
    'Regras:\n- Só afirme o que está no código ou na documentação existente. O que não der para saber vai em "Dúvidas em aberto", não como chute.\n- Em "Decisões", só o que estiver escrito no código ou nos docs, com data se o git der.\n- Seja curto: um guia longo ninguém atualiza.\n- Não faça commit nem git add.',
    `No fim, peça ao usuário que revise o ${GUIDE_PATH} antes de usá-lo.`,
    `Modelo:\n\n${GUIDE_TEMPLATE}`,
  ].join('\n\n');
}

/**
 * Valida o pedido e abre a conversa. `null`: o funcionário não existe (404). `test` e `drift` exigem o
 * SPEC.md; `draft` não sobrescreve um que já existe. Quem chama confere que o projeto existe.
 * `drift` com base e sem mudanças desde ela: `{ skipped: true }`, sem conversa. Depois de abrir a conversa
 * (draft ou drift, em git), grava o HEAD como nova base; falha de gravação não derruba a ação.
 */
export async function runGuideAction(deps: GuideRunDeps, dir: string, body: unknown): Promise<GuideRunResult | null> {
  const parsed = GuideRunBody.safeParse(body);
  if (!parsed.success) throw new GuideActionError(parsed.error.issues[0]?.message ?? 'pedido inválido');
  const { action, staffId } = parsed.data;
  const profile = await deps.readProfile(staffId);
  if (!profile) return null;
  const exists = await hasGuide(dir);
  if (action === 'draft' && exists) throw new GuideActionError(`já existe ${GUIDE_PATH}: o rascunho não sobrescreve (use o teste ou a divergência)`);
  if (action !== 'draft' && !exists) throw new GuideActionError(`não há ${GUIDE_PATH} neste projeto: crie o guia antes`);

  let changes: GuideChanges | null = null;
  if (action === 'drift') {
    const base = await validCheck(dir);
    if (base) {
      const files = await changedFiles(dir, base.sha);
      if (files.length === 0) return { skipped: true, reason: `sem mudanças desde ${dia(base.at)}` };
      changes = { at: base.at, files };
    }
  }
  const head = action === 'test' ? null : await headSha(dir);
  const sessionId = await deps.send(profile.id, guideActionText(action, changes), false);
  if (head) await recordCheck(dir, head).catch(() => {});
  return { sessionId, staffId: profile.id };
}
