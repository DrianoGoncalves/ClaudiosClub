// O que a extensão guarda neste Chrome (chrome.storage.local, só desta extensão):
//   token, pairingId  o pareamento (o token só existe aqui; no Club fica só o hash)
//   seen, seeded      ids dos avisos já vistos e se a primeira leitura (que não avisa) já passou
//   targets           para onde cada notificação leva ao clicar
//   status            'ok' | 'offline' | 'revoked' | 'unpaired' (o que o selo e o popup mostram)
//   choice            o último projeto e responsável da tarefa rápida

const PAIRING_KEYS = ['token', 'pairingId', 'seen', 'seeded', 'targets', 'choice'];

/** @param {string | string[]} keys */
export const getState = (keys) => chrome.storage.local.get(keys);

/** @param {Record<string, unknown>} values */
export const setState = (values) => chrome.storage.local.set(values);

/** Esquece o pareamento deste Chrome (o token no Club segue valendo até ser revogado lá). */
export const clearPairing = () => chrome.storage.local.remove(PAIRING_KEYS);
