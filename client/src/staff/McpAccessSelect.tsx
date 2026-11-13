import type { McpAccess } from '../../../shared/model';
import { t } from '../i18n';
import { MCP_ACCESS_LABEL, MCP_ACCESS_LEVELS, type AccessHint } from './mcpAccessField';

/** O seletor de acesso de um MCP (ou do navegador): compacto, para caber na linha do nome. */
export function McpAccessSelect({ label, value, onChange }: { label: string; value: McpAccess; onChange: (level: McpAccess) => void }) {
  return (
    <select className="mcp-access" aria-label={label} value={value} onChange={(e) => onChange(e.target.value as McpAccess)}>
      {MCP_ACCESS_LEVELS.map((l) => (
        <option key={l} value={l}>
          {t(MCP_ACCESS_LABEL[l])}
        </option>
      ))}
    </select>
  );
}

/** A dica embaixo da linha, só quando o acesso limita a escrita; as frases vêm juntas num parágrafo. */
export function McpAccessHint({ hints }: { hints: AccessHint[] }) {
  if (!hints.length) return null;
  const vars = { ask: t(MCP_ACCESS_LABEL.ask), readonly: t(MCP_ACCESS_LABEL.readonly), bypass: t('staff.autonomyBypassLabel') };
  return <p className="muted small mcp-hint">{hints.map((h) => t(h.key, { ...vars, ...h.params })).join(' ')}</p>;
}
