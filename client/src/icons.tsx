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
