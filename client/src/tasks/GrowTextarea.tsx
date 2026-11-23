import { useEffect, useRef, type TextareaHTMLAttributes } from 'react';

/** Área de texto que cresce com o conteúdo (até o teto do CSS, que então rola): o dono lê o que escreveu sem rolar dentro do campo. */
export function GrowTextarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [props.value]);
  return <textarea {...props} ref={ref} className={`grow-textarea${className ? ` ${className}` : ''}`} />;
}
