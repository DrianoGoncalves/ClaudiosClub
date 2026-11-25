// A worktree por card (t-250de1) nasce LIGADA em todo projeto. Os testes dos outros assuntos (mescla da worktree da ficha, vaga de escrita, entrega, commit automático…) começam cards em repositórios git
// e verificam o caminho de sempre: para eles o padrão do projeto sem configuração é desligado (ver `readBoardCardWorktree`). Os testes da própria função (tests/cardTask.test.ts) apagam esta variável
// no começo e provam o padrão ligado.
process.env.MYCO_CARD_WORKTREE_DEFAULT = 'off';
