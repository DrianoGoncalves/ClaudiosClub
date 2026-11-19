import type { Engine } from '../../../shared/model';
import { t, type MsgKey } from '../i18n';
import { BROWSER_IDLE_MIN, CLOSE_IDLE_MIN, rangeParams, WEIGHT_MB } from './mcpWeight';

// Selos de peso da ficha: o que pesa mais e em quê. São dois pesos separados: "Usa memória" (processo no computador, com número só onde foi
// medido, em `mcpWeight.ts`) e "Gasta limite" (consumo da assinatura, só comparação, nunca número). Opção sem base no código fica sem selo.
// A dica abre ao tocar (<details> nativo, sem estado; no celular não há passar o mouse).

export type WeightKind = 'memory' | 'limit';

/** Cada recurso que a ficha avisa. */
export type WeightId = 'claude' | 'codexRun' | 'gpt' | 'browser' | 'mcps' | 'model' | 'effort';

export interface WeightCtx {
  engine: Engine;
  /** "Usar o Codex (GPT)" ligado nas Configurações: só então o recurso de perguntar ao GPT entra nas conversas do Claude. */
  gpt: boolean;
  /** "Usar o navegador" marcado na ficha. */
  browser: boolean;
  /** Quantos MCPs estão marcados. */
  mcps: number;
  model: string;
  effort: string;
}

export interface WeightFlagSpec {
  id: WeightId;
  /** Vazio = só informa (peso leve ou sem medida): sem selo. */
  kinds: WeightKind[];
  label: string;
  tip: string;
}

/** Opus e Fable custam mais por token que Sonnet e Haiku na tabela de preços do Club (`server/adapters/claude/pricing.ts`). */
const HEAVY_MODEL = /opus|fable|mythos/i;
/** Do esforço alto para cima: o `low` já diz "gasta menos" (`staff.agentEffortLow`), e o máximo só é usado de propósito ao otimizar a assinatura. */
const HEAVY_EFFORT = new Set(['high', 'xhigh', 'max']);

const KIND_LABEL = { memory: 'staff.w.memory', limit: 'staff.w.limit' } as const satisfies Record<WeightKind, MsgKey>;

/** Os avisos de `ids` que valem para esta ficha, na ordem pedida. Só o motor Claude tem peso medido; o do GPT só diz o que sabe. */
export function weightFlags(ctx: WeightCtx, ids: readonly WeightId[]): WeightFlagSpec[] {
  const claude = ctx.engine !== 'codex';
  const idle = { idle: CLOSE_IDLE_MIN };
  const specs: Record<WeightId, (() => Omit<WeightFlagSpec, 'id' | 'label' | 'tip'> & { vars: Record<string, string | number> }) | null> = {
    claude: claude ? () => ({ kinds: ['memory'], vars: { ...rangeParams(WEIGHT_MB.claude), ...idle } }) : null,
    codexRun: !claude ? () => ({ kinds: [], vars: {} }) : null,
    gpt: claude && ctx.gpt ? () => ({ kinds: ['memory', 'limit'], vars: { ...rangeParams(WEIGHT_MB.gpt), setting: t('toolbar.codexTitle') } }) : null,
    browser:
      claude && ctx.browser
        ? () => ({
            kinds: ['memory'],
            vars: { ...rangeParams(WEIGHT_MB.browser), proxy: WEIGHT_MB.browserProxy[1], idle: BROWSER_IDLE_MIN },
          })
        : null,
    mcps: claude && ctx.mcps > 0 ? () => ({ kinds: [], vars: {} }) : null,
    model: claude && HEAVY_MODEL.test(ctx.model) ? () => ({ kinds: ['limit'], vars: {} }) : null,
    effort: claude && HEAVY_EFFORT.has(ctx.effort) ? () => ({ kinds: ['limit'], vars: {} }) : null,
  };
  const out: WeightFlagSpec[] = [];
  for (const id of ids) {
    const make = specs[id];
    if (!make) continue;
    const { kinds, vars } = make();
    out.push({ id, kinds, label: t(`staff.w.${id}` as MsgKey, vars), tip: t(`staff.w.${id}Tip` as MsgKey, vars) });
  }
  return out;
}

/** Um aviso: os selos e a frase curta numa linha, a dica abaixo ao tocar. */
export function WeightFlagView({ flag }: { flag: WeightFlagSpec }) {
  return (
    <details className="weight-flag" data-weight={flag.id}>
      <summary title={t('staff.w.hint')}>
        {flag.kinds.map((k) => (
          <span key={k} className={`weight-badge is-${k}`}>
            {t(KIND_LABEL[k])}
          </span>
        ))}
        <span className="weight-label">{flag.label}</span>
      </summary>
      <p className="muted small weight-tip" role="note">
        {flag.tip}
      </p>
    </details>
  );
}

/** Os avisos de peso de `ids` que valem agora; nenhum, nada na tela. */
export function WeightFlags({ ctx, ids }: { ctx: WeightCtx; ids: readonly WeightId[] }) {
  const flags = weightFlags(ctx, ids);
  if (!flags.length) return null;
  return (
    <div className="weight-flags">
      {flags.map((f) => (
        <WeightFlagView key={f.id} flag={f} />
      ))}
    </div>
  );
}
