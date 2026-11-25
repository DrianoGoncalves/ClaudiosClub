// Deploy como código (contrato em docs/deploy.md): o Club dispara o `.github/workflows/deploy.yml` do projeto e acompanha a execução (ver server/deploy.ts).

export type DeployEnv = 'staging' | 'producao';
export const DEPLOY_ENVS: DeployEnv[] = ['staging', 'producao'];

/** `queued` disparado, a execução ainda não apareceu; `running` rodando; `success` no ar (o smoke passou); `failure` falhou; `unknown` o Club parou de acompanhar (ver o GitHub). */
export type DeployState = 'queued' | 'running' | 'success' | 'failure' | 'unknown';

export interface DeployRecord {
  id: string;
  /** O que foi ao ar: o commit (SHA) ou a tag. */
  ref: string;
  environment: DeployEnv;
  /** O cartão de onde saiu (deploy de tarefa) ou null (deploy de versão). */
  taskId: string | null;
  /** Voltou para a versão anterior (rollback): a tag de onde voltou. */
  rollbackFrom: string | null;
  at: string;
  state: DeployState;
  runId: number | null;
  /** O link do log da execução no GitHub (só https://github.com/…). */
  runUrl: string | null;
  finishedAt: string | null;
  /** Por que está como está (execução que não apareceu, GitHub fora), em pt-BR. */
  reason?: string;
}

/** `GET /api/projects/:id/deploys`: se dá para disparar (workflow no projeto e origin no GitHub), os deploys (mais novo primeiro) e as tags para a versão e o rollback. */
export interface DeployInfo {
  available: boolean;
  reason?: string;
  records: DeployRecord[];
  latestTag: string | null;
  previousTag: string | null;
}

export const isRunning = (r: Pick<DeployRecord, 'state'>): boolean => r.state === 'queued' || r.state === 'running';
