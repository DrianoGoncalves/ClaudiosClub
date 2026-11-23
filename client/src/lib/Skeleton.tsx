// Esqueleto de carregamento: blocos no formato do que vai chegar (as colunas do quadro, linhas de texto) enquanto a primeira leitura não volta.
// O texto ("Carregando…") fica para o leitor de tela (`role="status"`); os blocos são só visuais. Com "reduzir movimento", sem brilho (styles.css).

export function Skeleton({ label, variant = 'lines', lines = 3 }: { label: string; variant?: 'lines' | 'columns'; lines?: number }) {
  return (
    <div className={`skel skel-${variant}`} role="status">
      <span className="sr-only">{label}</span>
      {variant === 'columns'
        ? Array.from({ length: 4 }, (_, c) => (
            <div key={c} className="skel-col" aria-hidden="true">
              <div className="skel-bar skel-head" />
              {Array.from({ length: 3 - (c % 2) }, (_, i) => (
                <div key={i} className="skel-card" />
              ))}
            </div>
          ))
        : Array.from({ length: lines }, (_, i) => <div key={i} className="skel-bar" aria-hidden="true" style={{ width: `${92 - i * 14}%` }} />)}
    </div>
  );
}
