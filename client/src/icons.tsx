// Ícones de linha no mesmo traço do ícone de config (24×24, contorno em currentColor): sem emoji.

const base = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

/** Imagem (moldura com montanha e sol): anexar ou indicar prints no chat. */
export function ImageIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}

/** Enviar (avião de papel): o botão de enviar do chat. */
export function SendIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <path d="M14.5 21.7a.5.5 0 0 0 .9 0l6.5-19a.5.5 0 0 0-.6-.6l-19 6.5a.5.5 0 0 0 0 .9l7.9 3.2a2 2 0 0 1 1.1 1.1z" />
      <path d="M21.9 2.1 10.9 13.1" />
    </svg>
  );
}

/** Quadrado: parar o turno em andamento. */
export function StopIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  );
}

/** Seta para baixo: voltar ao fim da conversa. */
export function ArrowDownIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </svg>
  );
}

/** Folha com + e −: os arquivos que o funcionário mudou (diff). */
export function FileDiffIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" />
      <path d="M9 10h6" />
      <path d="M12 7v6" />
      <path d="M9 17h6" />
    </svg>
  );
}

/** Mais: começar algo novo (conversa nova). */
export function PlusIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

/** Logo do Chrome no traço da casa: usa o navegador pela extensão Claude in Chrome. */
export function ChromeIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="4" />
      <path d="M21.17 8H12" />
      <path d="M3.95 6.06 8.54 14" />
      <path d="M10.88 21.94 15.46 14" />
    </svg>
  );
}

/** Duas folhas sobrepostas: duplicar (uma cópia para seguir por outro caminho). */
export function CopyIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <rect x="8" y="8" width="14" height="14" rx="2" />
      <path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2" />
    </svg>
  );
}

/** O logo do MCP (Model Context Protocol), no traço dele: os MCPs ligados na conversa. */
export function McpIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="12 12 172 172" fill="none" stroke="currentColor" strokeWidth={12} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M25 97.85 92.88 29.97a24 24 0 0 1 33.94 0 24 24 0 0 1 0 33.94L75.56 115.18" />
      <path d="M76.27 114.47 126.82 63.91a24 24 0 0 1 33.94 0l.35.35a24 24 0 0 1 0 33.94L99.72 159.6a8 8 0 0 0 0 11.31l12.61 12.61" />
      <path d="M109.85 46.94 59.65 97.15a24 24 0 0 0 0 33.94 24 24 0 0 0 33.94 0l50.2-50.21" />
    </svg>
  );
}

/** Robô (cabeça com antena): os agents que a ficha indica. */
export function AgentIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <path d="M12 8V4H8" />
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M9 13v2" />
      <path d="M15 13v2" />
    </svg>
  );
}

/** Livro: as skills que a ficha indica. */
export function SkillIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

/** Brilhos: modelo secundário configurado. */
export function FallbackModelIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z" />
      <path d="M5 3v4" />
      <path d="M3 5h4" />
      <path d="M19 17v4" />
      <path d="M17 19h4" />
    </svg>
  );
}

/** Servidor (dois gabinetes empilhados): as conexões SSH e FTP que a ficha libera. */
export function ServerIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <rect x="2" y="2" width="20" height="8" rx="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" />
      <path d="M6 6h.01" />
      <path d="M6 18h.01" />
    </svg>
  );
}

/** Pessoa com +: contratar funcionário. */
export function UserPlusIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M19 8v6" />
      <path d="M22 11h-6" />
    </svg>
  );
}

/** Balão de conversa (Lucide message-square): abrir o chat do funcionário. */
export function MessageIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

/** Uma pessoa: o responsável pela tarefa. */
export function UserIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

/** Duas pessoas: o RH (todos os funcionários de todos os projetos). */
export function UsersIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

/** Caixa de arquivo morto: arquivar (tirar do quadro). */
export function ArchiveIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </svg>
  );
}

/** Caixa com seta para cima: desarquivar (voltar ao quadro). */
export function ArchiveRestoreIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h2" />
      <path d="M20 8v11a2 2 0 0 1-2 2h-2" />
      <path d="m9 15 3-3 3 3" />
      <path d="M12 12v9" />
    </svg>
  );
}

/** Botão de ligar (círculo aberto em cima com um traço): fechar a conversa (desliga o processo dela). */
export function PowerIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <path d="M12 2v10" />
      <path d="M18.4 6.6a9 9 0 1 1-12.8 0" />
    </svg>
  );
}

/** Lápis: renomear (o título da conversa). */
export function PencilIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <path d="M17 3a2.85 2.85 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </svg>
  );
}

/** Lupa com gráfico de barras: analisar (revisão de custo do funcionário), não buscar. */
export function AnalyzeIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
      <path d="M7 14v-2M11 14V8M15 14v-4" />
    </svg>
  );
}

/** Tarefas (lista com marcações): o quadro de tarefas do projeto. */
export function TasksIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <path d="M9 6h11" />
      <path d="M9 12h11" />
      <path d="M9 18h11" />
      <path d="M4 6l1 1 2-2" />
      <path d="M4 12l1 1 2-2" />
      <path d="M4 18h2" />
    </svg>
  );
}

/** Pausar (duas barras): pausa o projeto (nada novo começa sozinho). */
export function PauseIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <path d="M8 5v14" />
      <path d="M16 5v14" />
    </svg>
  );
}

/** Retomar (triângulo): tira o projeto da pausa. */
export function PlayIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <path d="M7 4.5v15l12-7.5z" />
    </svg>
  );
}

/** Relógio: os agendamentos (despertadores) do projeto. */
export function ClockIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  );
}

/**
 * Terminal preenchido (janela cheia com o >_ vazado): o login do CLI no topo, na cor do semáforo. O >_
 * é furo (evenodd), então mostra o fundo do topo em qualquer tema.
 */
export function TerminalFilledIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M5 4h14a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zM6.2 8.5L9.9 12l-3.7 3.5 1.4 1.4 5-4.9-5-4.9zM13 15h5v2h-5z"
      />
    </svg>
  );
}

/** Branch do git (dois ramos saindo de um tronco). */
export function BranchIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="7" r="2" />
      <path d="M6 7v10" />
      <path d="M18 9c0 5-6 4-11.5 8" />
    </svg>
  );
}

/** Fantasma: o funcionário fantasma (conversas sem ficha do projeto, num nó só). */
export function GhostIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <path d="M5 21V10a7 7 0 0 1 14 0v11l-2.5-2-2.5 2-2-2-2 2-2.5-2z" />
      <path d="M9.5 10.5h.01" />
      <path d="M14.5 10.5h.01" />
    </svg>
  );
}

/** Revisão automática: um olho (quem revisa a tarefa). */
export function ReviewIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** Pasta: a árvore de arquivos (e o botão "Arquivos" do projeto). */
export function FolderIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

/** Folha com a ponta dobrada: um arquivo na árvore. */
export function FileIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

/** Lixeira: apagar o arquivo ou a pasta selecionada na árvore. */
export function TrashIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

/** Cadeado: arquivo de segredo, listado mas fechado. */
export function LockIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

/** Três réguas com cursor: o nível de uso (quanto detalhe aparece). */
export function SlidersIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3" />
      <path d="M14 2v4M8 10v4M16 18v4" />
    </svg>
  );
}

/** Paleta de tinta: aparência (tema, idioma, movimento). */
export function PaletteIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
      <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
      <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
      <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
    </svg>
  );
}

/** Quatro quadros: o quadro de projetos e as abas dele. */
export function LayoutGridIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

/** Marcador de velocidade: gasto e limites da assinatura. */
export function GaugeIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <path d="m12 14 4-4" />
      <path d="M3.34 19a10 10 0 1 1 17.32 0" />
    </svg>
  );
}

/** Globo: internet e Chrome. */
export function GlobeIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </svg>
  );
}

/** Escudo com visto: liberar o navegador e manter o Club em dia. */
export function ShieldCheckIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

/** Boia: ajuda e sobre. */
export function LifeBuoyIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="4" />
      <path d="m4.93 4.93 4.24 4.24" />
      <path d="m14.83 9.17 4.24-4.24" />
      <path d="m14.83 14.83 4.24 4.24" />
      <path d="m9.17 14.83-4.24 4.24" />
    </svg>
  );
}
