import { useEffect, useRef, useState } from 'react';

// Copiar para a área de transferência, fora de chat/markdown.tsx: a caixa "precisa de mim" (inbox/SandboxFix.tsx) usa o botão de copiar
// e, importando do markdown, puxava o react-markdown e o remark-gfm para o pedaço inicial do quadro. O markdown reexporta os dois.

/** Põe o texto na área de transferência; false quando o navegador recusa ou não a oferece (página sem HTTPS, sem permissão). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Copia para a área de transferência; `copied` fica true por 1,5s para o botão confirmar. `failed` (3º item, opcional) fica true por 4s quando a cópia não deu. */
export function useCopy(): [boolean, (text: string) => void, boolean] {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (text: string) => {
    void copyText(text).then((ok) => {
      setCopied(ok);
      setFailed(!ok);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => (ok ? setCopied(false) : setFailed(false)), ok ? 1500 : 4000);
    });
  };
  return [copied, copy, failed];
}
