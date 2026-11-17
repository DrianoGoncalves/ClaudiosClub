import { createHash } from 'node:crypto';
import path from 'node:path';
import { ROOT } from '../root';

// Identidade da extensão do Chrome do Claudio’s Club. A chave pública é fixa no manifest: o Chrome calcula o ID dela a partir dela (sha256 do
// DER, 32 primeiros hex, cada dígito virado em a..p). Sem .crx nem loja, a chave privada não existe: o ID só serve para reconhecer o Origin
// `chrome-extension://…` que chega ao servidor (ver gate.ts).

export const EXTENSION_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAylSuekTefvOuWeO5umuG2r2OPO9IXQ0+Edcl5d+MkVRVFWisQ14VlbyJEKZsvxHSJX/e4jpXIDsCY7OAJPKoHWbtqO4goTUFkcgQvsCg78QCRzbGhfBDNrH+OfVrS0ysTKTqZhVtGFI6M5Bs1FziGKiunErlJAeZuLNb78EXIjBarh+afkWVwfYMNtWfH9PuYlk4CYKLKJOKPPUEsJ8+2qqDnDe4eINqvGZhRpUl+1lSA42c66NQ7yMXg+3k0hKt5ly0De/vEbvVtBJxZlWETGSGPYbJSP0J3tPTWfrqI+jK3nHdPJsz64XbNUUEHQx29JKFUVgvzAiWDBvyz67n5wIDAQAB';

/** O ID que o Chrome dá à extensão com esta chave (32 letras de a a p). */
export function extensionIdOf(keyB64: string): string {
  const hex = createHash('sha256').update(Buffer.from(keyB64, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((h) => String.fromCharCode('a'.charCodeAt(0) + parseInt(h, 16))).join('');
}

export const EXTENSION_ID = extensionIdOf(EXTENSION_KEY);
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
/** A pasta da extensão no repositório (o que vira o .zip do config). */
export const EXTENSION_DIR = path.join(ROOT, 'extension');
