// Aviso do despertador: o servidor manda só o instante (`wakeAt`, em ms); a contagem regressiva é do cliente.

/** Segundos que faltam para `wakeAt`, arredondando para cima (mostra 90s, e só chega a 0s no instante); nunca negativo. */
export function secondsLeft(wakeAt: number, now: number): number {
  return Math.max(0, Math.ceil((wakeAt - now) / 1000));
}

/** "10:32", na hora desta máquina (o texto acrescenta o "h"). */
export function clockHM(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
