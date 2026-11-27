import { describe, expect, it } from 'vitest';
import { route } from '../scripts/preview/mockApi';

describe('API simulada da prévia (npm run preview:ui)', () => {
  it('serve cargos e quadro fictícios', () => {
    const roles = route('GET', '/api/roles');
    expect(roles.status).toBe(200);
    expect((roles.body as unknown[]).length).toBeGreaterThan(5);
    expect(route('GET', '/api/board').status).toBe(200);
  });
  it('recusa qualquer escrita e rota sem dado', () => {
    expect(route('POST', '/api/roles').status).toBe(403);
    expect(route('GET', '/api/nao-existe').status).toBe(404);
  });
});
