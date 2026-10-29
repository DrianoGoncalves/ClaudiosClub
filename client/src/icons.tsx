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

/** Gráfico de barras: o ranking (gastos e modelos). */
export function ChartIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true" {...base}>
      <path d="M3 3v16a2 2 0 0 0 2 2h16" />
      <path d="M8 17v-3" />
      <path d="M13 17V5" />
      <path d="M18 17V9" />
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
