// Imagens enviadas pelo Claudio’s Club são reduzidas no navegador antes de subir: um retrato aparece com
// 40 px no quadro, e o arquivo fica dentro da pasta do projeto. Uma foto de celular (2–5 MB) vira
// algo como 20–60 KB.

import { t } from '../i18n';

export const PORTRAIT_MAX = 320;
export const PROJECT_IMAGE_MAX = 800;
/** Antes de reduzir: só para não travar o navegador com um arquivo absurdo. */
export const MAX_INPUT_BYTES = 20 * 1024 * 1024;

/** Data URL WebP (ou JPEG, se o navegador não gerar WebP) com o lado maior em até `max` px. */
export async function shrinkImage(file: File, max: number): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(t('app.imageFailed'));
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const webp = canvas.toDataURL('image/webp', 0.85);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.85);
}
