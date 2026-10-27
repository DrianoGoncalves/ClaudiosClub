import type { ReactNode } from 'react';

// Markdown mínimo das respostas (blocos de código, `código`, **negrito**, listas e parágrafos),
// montado como elementos React: nada vira HTML cru.

export function Markdown({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf('\n');
      const code = nl === -1 ? part : part.slice(nl + 1);
      out.push(
        <pre key={i} className="md-code">
          <code>{code.replace(/\n$/, '')}</code>
        </pre>,
      );
    } else {
      out.push(...blocks(part, i));
    }
  });
  return <div className="md">{out}</div>;
}

function blocks(text: string, key: number): ReactNode[] {
  return text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b, j) => {
      const lines = b.split('\n');
      if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) {
        const ordered = /^\s*\d+\./.test(lines[0]!);
        const items = lines.map((l, k) => <li key={k}>{inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>);
        return ordered ? <ol key={`${key}-${j}`}>{items}</ol> : <ul key={`${key}-${j}`}>{items}</ul>;
      }
      const heading = /^(#{1,4})\s+(.*)$/.exec(b);
      if (heading && lines.length === 1) return <p key={`${key}-${j}`} className="md-h">{inline(heading[2]!)}</p>;
      return (
        <p key={`${key}-${j}`}>
          {lines.map((l, k) => (
            <span key={k}>
              {k > 0 && <br />}
              {inline(l)}
            </span>
          ))}
        </p>
      );
    });
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    out.push(tok.startsWith('`') ? <code key={m.index}>{tok.slice(1, -1)}</code> : <b key={m.index}>{tok.slice(2, -2)}</b>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
