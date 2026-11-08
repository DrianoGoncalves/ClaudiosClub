import { defaultRunner, type CodexRunner, type CodexStatus } from './adapters/codex';

// Catálogo de modelos do Codex para a tela escolher (GET /api/codex/models): vem de `codex debug models`, que imprime um JSON
// `{ models: [{ slug, display_name, visibility, supported_reasoning_levels: [{ effort }], default_reasoning_level, … }] }`.
// Só os de `visibility: "list"` (os outros são internos ou escondidos). Sem o CLI ou sem login, devolve lista vazia com o motivo,
// em vez de erro. Só vale com o Codex ligado nas configurações (`codexReview`). Testado com o Codex CLI 0.156.1 e 0.167.0.

export interface CodexModelInfo {
  slug: string;
  displayName: string;
  /** Esforços aceitos pelo modelo, do menor ao maior (`ultra` só em alguns). */
  efforts: string[];
  defaultEffort: string | null;
}

export interface CodexModelsResult {
  models: CodexModelInfo[];
  /** Por que a lista veio vazia (sem o CLI, sem login, catálogo ilegível); null quando há modelos. */
  reason: string | null;
}

/** Por que a lista vem vazia com o Codex desligado nas configurações (a opção "Segunda opinião do Codex" é o "usar o Codex"). */
export const CODEX_OFF_REASON = 'o Codex está desligado nas configurações: ligue "Segunda opinião do Codex" para usar o Codex';

/** Quanto tempo o catálogo fica guardado: ele muda de vez em quando (o Codex atualiza), não a cada abertura da tela. */
export const MODELS_TTL = 5 * 60_000;
const RUN_TIMEOUT = 30_000;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** A saída do `codex debug models` → os modelos listados (null: não é o JSON esperado). Item torto é ignorado. */
export function parseCodexModels(stdout: string): CodexModelInfo[] | null {
  const json = stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1);
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const models = (data as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return null;
  const out: CodexModelInfo[] = [];
  for (const m of models as Array<Record<string, unknown>>) {
    const slug = str(m?.slug);
    if (!slug || m.visibility !== 'list') continue;
    const levels = Array.isArray(m.supported_reasoning_levels) ? (m.supported_reasoning_levels as Array<Record<string, unknown>>) : [];
    out.push({
      slug,
      displayName: str(m.display_name) ?? slug,
      efforts: levels.map((l) => str(l?.effort)).filter((e): e is string => !!e),
      defaultEffort: str(m.default_reasoning_level),
    });
  }
  return out;
}

/** A "família" do modelo é o último pedaço do slug: `gpt-6-sol` e `gpt-5.6-sol` são `sol`. */
export const codexFamily = (slug: string): string => slug.split('-').at(-1) ?? slug;

/** A versão do slug (`gpt-6.1-sol` → [6, 1]); sem número, vazia. */
function versionOf(slug: string): number[] {
  const m = /^gpt-(\d+(?:\.\d+)*)-/i.exec(slug);
  return m ? m[1]!.split('.').map(Number) : [];
}

/** Maior versão primeiro (6 vem antes de 5.6; 6.1 antes de 6). */
function newer(a: string, b: string): number {
  const va = versionOf(a);
  const vb = versionOf(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] ?? 0) - (va[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * O substituto de um modelo que a conta recusou (`model_not_found`): o mais parecido do catálogo, da mesma família (o último pedaço
 * do slug: sol, luna, astra, terra), preferindo a versão mais nova. O próprio modelo recusado não vale. Sem parecido, null: roda sem
 * `-m` (o padrão do Codex). Serve ao motor dos funcionários e à ferramenta "perguntar ao GPT".
 */
export function pickCodexSubstitute(wanted: string, models: ReadonlyArray<Pick<CodexModelInfo, 'slug'>>): string | null {
  const family = codexFamily(wanted);
  const same = models.map((m) => m.slug).filter((slug) => slug !== wanted && codexFamily(slug) === family);
  return same.sort(newer)[0] ?? null;
}

export class CodexModels {
  private cache: { at: number; value: CodexModelsResult } | null = null;

  constructor(
    /** Instalado e com login (o `check` do CodexAdapter, que tem o cache dele). */
    private readonly check: (fresh?: boolean) => Promise<CodexStatus>,
    private readonly run: CodexRunner = defaultRunner(),
    private readonly now: () => number = Date.now,
    /** O Codex está ligado nas configurações (`codexReview`)? Desligado: lista vazia com o motivo, e nenhum processo é aberto. */
    private readonly enabled: () => Promise<boolean> = async () => true,
  ) {}

  /** `fresh`: ignora o que está guardado (e confere de novo o login). Nunca lança: o motivo vai em `reason`. */
  async list(fresh = false): Promise<CodexModelsResult> {
    if (!(await this.enabled().catch(() => false))) return { models: [], reason: CODEX_OFF_REASON };
    if (!fresh && this.cache && this.now() - this.cache.at < MODELS_TTL) return this.cache.value;
    let status: CodexStatus;
    try {
      status = await this.check(fresh);
    } catch (err) {
      return { models: [], reason: `não consegui verificar o Codex: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!status.available) return { models: [], reason: status.reason ?? 'o Codex não está disponível' };
    const r = await this.run(['debug', 'models'], '', RUN_TIMEOUT);
    if (r.spawnError) return { models: [], reason: 'o Codex CLI não está instalado (npm i -g @openai/codex)' };
    if (r.timedOut) return { models: [], reason: 'o Codex demorou demais para listar os modelos' };
    if (r.code !== 0) return { models: [], reason: `o codex debug models falhou${r.stderr.trim() ? `: ${r.stderr.trim().split('\n')[0]!.slice(0, 200)}` : ''}` };
    const models = parseCodexModels(r.stdout);
    if (!models) return { models: [], reason: 'o Codex devolveu o catálogo de modelos num formato que não reconheço' };
    const value: CodexModelsResult = { models, reason: models.length ? null : 'o Codex não listou nenhum modelo' };
    // Só guarda o que deu certo: falha passageira não fica na lista por 5 minutos.
    if (models.length) this.cache = { at: this.now(), value };
    return value;
  }
}
