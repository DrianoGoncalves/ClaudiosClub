// Cabeçalho das seções recolhidas do detalhe da tarefa: o rótulo e, logo abaixo, o resumo numa linha só.
// É um <summary> nativo (Enter/Espaço abrem, o leitor de tela anuncia aberto/fechado); o `title` traz o texto inteiro quando a linha corta.

export function SectionSummary({ label, sum }: { label: string; sum: string }) {
  return (
    <summary className="has-sum">
      {label}
      <span className="collapse-sum muted small" title={sum}>
        {sum}
      </span>
    </summary>
  );
}
