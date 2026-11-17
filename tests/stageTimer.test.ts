import { describe, expect, it } from 'vitest';
import { StageTimer } from '../server/stageTimer';

describe('StageTimer', () => {
  it('abaixo do limite não escreve nada', () => {
    let t = 0;
    const lines: string[] = [];
    const timer = new StageTimer('pedido', (l) => lines.push(l), 2_000, () => t);
    timer.stage('a');
    t = 1_999;
    timer.finish();
    expect(lines).toEqual([]);
  });

  it('no limite escreve o total e cada etapa em ordem, somando a que repete', () => {
    let t = 0;
    const lines: string[] = [];
    const timer = new StageTimer('pedido', (l) => lines.push(l), 2_000, () => t);
    timer.stage('projectPath');
    t = 100;
    timer.stage('lock');
    t = 2_900;
    timer.stage('projectPath');
    t = 3_000;
    timer.stage('conversa');
    t = 3_500;
    timer.finish();
    timer.finish(); // só vale a primeira
    expect(lines).toEqual(['[tarefas] pedido: 3500 ms (projectPath 200 ms, lock 2800 ms, conversa 500 ms)']);
  });

  it('diz onde está parado e, respondido antes do fim, que o resto seguiu em segundo plano', () => {
    let t = 0;
    const lines: string[] = [];
    const timer = new StageTimer('pedido', (l) => lines.push(l), 0, () => t);
    timer.stage('lock');
    t = 700;
    expect(timer.where()).toEqual({ name: 'lock', ms: 700 });
    expect(timer.elapsed()).toBe(700);
    timer.answeredEarly = true;
    t = 900;
    timer.finish();
    expect(timer.where()).toBeNull();
    expect(lines).toEqual(['[tarefas] pedido: 900 ms (lock 900 ms); respondeu na fila, o resto seguiu em segundo plano']);
  });
});
