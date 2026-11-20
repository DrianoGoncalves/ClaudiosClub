import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MYCO_HOME } from './config';

// O projeto demo (a pizzaria, e a cafeteria antes dela) saiu do produto: nada mais o cria. Quem já o tem em ~/.myco/demo continua com ele
// fixado no quadro, para não sumir de uma hora para outra; a pasta e o que há nela são do usuário, e nada aqui apaga, migra ou altera.
const DEMO_DIRS = [path.join(MYCO_HOME, 'demo', 'my-co'), path.join(MYCO_HOME, 'demo', 'cafe-demo')];

/** As pastas do demo antigo que ainda existem nesta máquina. */
export async function legacyDemoPaths(): Promise<string[]> {
  const isDir = await Promise.all(DEMO_DIRS.map((d) => fs.stat(d).then((s) => s.isDirectory(), () => false)));
  return DEMO_DIRS.filter((_, i) => isDir[i]);
}
