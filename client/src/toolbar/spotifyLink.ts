// Link do Spotify → src do Embed. A entrada crua nunca vai para o iframe: só o tipo (lista fechada) e o id (base62 de
// 22 caracteres) entram na URL montada aqui.

export const SPOTIFY_TYPES = ['track', 'album', 'playlist', 'artist', 'episode', 'show'] as const;
export type SpotifyType = (typeof SPOTIFY_TYPES)[number];
export interface SpotifyRef {
  type: SpotifyType;
  id: string;
}

const ID = /^[0-9A-Za-z]{22}$/;
/** Prefixo de idioma que o site põe no caminho (open.spotify.com/intl-pt/track/…). */
const INTL = /^intl-[a-z]{2}(-[a-z]{2})?$/i;
const MAX_LEN = 300;

function ref(type: string | undefined, id: string | undefined): SpotifyRef | null {
  if (!type || !id || !ID.test(id)) return null;
  const known = SPOTIFY_TYPES.find((x) => x === type);
  return known ? { type: known, id } : null;
}

/** Aceita https://open.spotify.com/<tipo>/<id> (com ?si=, /intl-xx/ ou /embed/) e spotify:<tipo>:<id>; o resto vira null. */
export function parseSpotifyLink(raw: string): SpotifyRef | null {
  const input = raw.trim();
  if (!input || input.length > MAX_LEN) return null;
  if (input.startsWith('spotify:')) {
    const [, type, id, ...rest] = input.split(':');
    return rest.length ? null : ref(type, id);
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com') return null;
  const path = url.pathname.split('/').filter(Boolean);
  if (path[0] && INTL.test(path[0])) path.shift();
  if (path[0] === 'embed') path.shift();
  return path.length === 2 ? ref(path[0], path[1]) : null;
}

export const spotifyEmbedSrc = ({ type, id }: SpotifyRef) => `https://open.spotify.com/embed/${type}/${id}`;
/** Forma canônica do link (a que o campo mostra depois de salvar). */
export const spotifyLink = ({ type, id }: SpotifyRef) => `https://open.spotify.com/${type}/${id}`;
export const spotifyUri = ({ type, id }: SpotifyRef) => `spotify:${type}:${id}`;
