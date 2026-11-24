import path from 'node:path';
import { ClaudeAdapter } from '../server/adapters/claude';
import { defaultLocations } from '../server/adapters/claude/paths';
import { MYCO_HOME, readExtraProjects } from '../server/config';
import { legacyDemoPaths } from '../server/legacyDemo';
import { MCP_MIGRATION_FILE } from '../server/staff/mcp';
import { rollbackMcpMigration } from '../server/staff/mcpMigration';
import { MCP_TOOLS_FILE } from '../server/staff/mcpTools';
import { listProjectStaff, saveProfile } from '../server/staff/store';

// Desfaz a migração dos MCPs para o modelo Global/Projeto (`npm run mcp:rollback`), a partir do relatório ~/.myco/mcps-migracao.json.
// Use com o Claudio’s Club FECHADO e só para voltar a uma versão anterior ao modelo: a versão nova migra de novo no próximo boot.
//   - ~/.claude.json: remove só as entradas que a migração gravou e que continuam iguais (o que você mexeu depois fica);
//   - fichas: devolve o `mcps` de antes (por nome, sem `global:`/`project:`);
//   - mcp-tools.json: devolve as chaves antigas das ferramentas testadas (relatórios de antes desta versão não têm o mapa: teste de novo).
// Antes de gravar, copia o ~/.claude.json e o mcp-tools.json para ~/.myco/backups. O registro (~/.myco/mcps.json) e o cofre não são mexidos.
// Ficha que não for achada (projeto fora do quadro ou ficha apagada) mantém o relatório: o script sai com erro e pode rodar de novo.
// Caminhos: os padrão do Club (MYCO_HOME, MYCO_CLAUDE_CONFIG). Nada de segredo é lido nem impresso.

try {
  // Só os projetos das fichas do relatório importam; o adapter acha a pasta deles.
  const adapter = new ClaudeAdapter({ extraPaths: async () => [...(await legacyDemoPaths()), ...(await readExtraProjects())] });
  const projects: Array<{ id: string; path: string }> = [];
  for (const id of await adapter.boardProjectIds()) {
    const dir = await adapter.projectPath(id);
    if (dir) projects.push({ id, path: dir });
  }

  const r = await rollbackMcpMigration({
    recordFile: MCP_MIGRATION_FILE,
    claudeConfigFile: defaultLocations().configFile,
    backupDir: path.join(MYCO_HOME, 'backups'),
    toolsFile: MCP_TOOLS_FILE,
    projects,
    list: listProjectStaff,
    save: saveProfile,
  });

  if (!r) {
    console.log(`Nada a desfazer: não há relatório da migração (${MCP_MIGRATION_FILE}).`);
  } else {
    console.log(`~/.claude.json: ${r.removed.length} entrada(s) removida(s)${r.removed.length ? ` (${r.removed.join(', ')})` : ''}${r.backups.claudeConfig ? `; backup em ${r.backups.claudeConfig}` : ''}`);
    if (r.kept.length) console.log(`  ficaram, porque mudaram depois da migração: ${r.kept.join(', ')}`);
    console.log(`Fichas com o \`mcps\` de antes de volta: ${r.fichas}`);
    console.log(`Chaves das ferramentas testadas devolvidas: ${r.toolsKeys}${r.backups.tools ? `; backup em ${r.backups.tools}` : ''}`);
    if (r.fichasPuladas.length) {
      console.error(`Não achei estas fichas (projeto/ficha); o relatório foi mantido, rode de novo depois de conferir: ${r.fichasPuladas.join(', ')}`);
      process.exitCode = 1;
    } else console.log('Relatório apagado. Feche este terminal e volte à versão anterior do Club.');
  }
} catch (err) {
  console.error(`Não consegui desfazer: ${err instanceof Error ? err.message : 'erro'}`);
  process.exitCode = 1;
}
