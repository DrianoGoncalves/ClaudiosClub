import { useEffect, useRef, useState } from 'react';
import { pollVisibleLoop } from './usePoll';

/**
 * Lê uma rota que pode estar "lendo os transcripts" (`scanning`): rebusca a cada 5 s enquanto lê; depois a cada `idleMs`
 * (null = não rebusca). Trocar `key` (outro período, outra tarefa) zera o que está na tela e carrega de novo; trocar
 * `refresh` só busca outra vez, sem piscar. O refresh de fundo não mostra erro: só a primeira carga mostra o carregando e o erro.
 */
export function useScanPoll<T extends { scanning: boolean }>(
  load: () => Promise<T>,
  key: string,
  idleMs: number | null = 30_000,
  refresh = '',
): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastKey = useRef(key);
  useEffect(() => {
    let alive = true;
    let loaded = false;
    if (lastKey.current !== key) {
      lastKey.current = key;
      setData(null);
    }
    setError(null);
    // Aba escondida: não rebusca; ao voltar, busca na hora (ver usePoll).
    const stop = pollVisibleLoop(() =>
      load().then(
        (r): number | null => {
          if (!alive) return null;
          loaded = true;
          setError(null);
          setData((prev) => (prev && JSON.stringify(prev) === JSON.stringify(r) ? prev : r));
          return r.scanning ? 5_000 : idleMs;
        },
        (e: Error): number | null => {
          if (!alive) return null;
          if (!loaded) setError(e.message);
          return idleMs;
        },
      ),
    );
    return () => {
      alive = false;
      stop();
    };
    // `load` muda a cada render: quem chama diz em `key` e `refresh` o que importa.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refresh]);
  return { data, error };
}
