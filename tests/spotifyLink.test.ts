import { describe, expect, it } from 'vitest';
import { parseSpotifyLink, spotifyEmbedSrc, spotifyLink, spotifyUri } from '../client/src/toolbar/spotifyLink';

// Link do Spotify → src do Embed: só tipo da lista e id base62 de 22 caracteres chegam ao iframe.

const ID = '37i9dQZF1DXcBWIGoYBM5M';

describe('parseSpotifyLink', () => {
  it.each(['track', 'album', 'playlist', 'artist', 'episode', 'show'])('aceita %s em link e em URI', (type) => {
    expect(parseSpotifyLink(`https://open.spotify.com/${type}/${ID}`)).toEqual({ type, id: ID });
    expect(parseSpotifyLink(`spotify:${type}:${ID}`)).toEqual({ type, id: ID });
  });

  it('aceita ?si=, #, barra final, /intl-xx/, /embed/ e espaços em volta', () => {
    const want = { type: 'playlist', id: ID };
    expect(parseSpotifyLink(`https://open.spotify.com/playlist/${ID}?si=abc123&utm_source=copy-link`)).toEqual(want);
    expect(parseSpotifyLink(`https://open.spotify.com/playlist/${ID}#x`)).toEqual(want);
    expect(parseSpotifyLink(`https://open.spotify.com/playlist/${ID}/`)).toEqual(want);
    expect(parseSpotifyLink(`https://open.spotify.com/intl-pt/playlist/${ID}`)).toEqual(want);
    expect(parseSpotifyLink(`https://open.spotify.com/intl-pt-br/playlist/${ID}`)).toEqual(want);
    expect(parseSpotifyLink(`https://open.spotify.com/embed/playlist/${ID}`)).toEqual(want);
    expect(parseSpotifyLink(`  \nhttps://open.spotify.com/playlist/${ID}\t `)).toEqual(want);
  });

  it('rejeita tipo fora da lista', () => {
    for (const type of ['user', 'genre', 'collection', 'Track', 'track/x', '']) {
      expect(parseSpotifyLink(`https://open.spotify.com/${type}/${ID}`)).toBeNull();
      expect(parseSpotifyLink(`spotify:${type}:${ID}`)).toBeNull();
    }
  });

  it('rejeita id que não é base62 de 22 caracteres', () => {
    for (const id of [ID.slice(1), `${ID}A`, ID.replace('Z', '-'), ID.replace('Z', '_'), ID.replace('Z', '%'), `${ID.slice(1)} `, '']) {
      expect(parseSpotifyLink(`https://open.spotify.com/track/${id}`)).toBeNull();
      expect(parseSpotifyLink(`spotify:track:${id}`)).toBeNull();
    }
  });

  it('rejeita host, protocolo e caminho que não são os do site', () => {
    const bad = [
      `http://open.spotify.com/track/${ID}`,
      `ftp://open.spotify.com/track/${ID}`,
      `javascript:alert(1)//open.spotify.com/track/${ID}`,
      `data:text/html,open.spotify.com/track/${ID}`,
      `https://open.spotify.com.evil.com/track/${ID}`,
      `https://evil.com/open.spotify.com/track/${ID}`,
      `https://evil.com/track/${ID}?u=https://open.spotify.com/track/${ID}`,
      `https://evilopen.spotify.com/track/${ID}`,
      `https://spotify.com/track/${ID}`,
      `https://spotify.link/${ID}`,
      `https://open.spotify.com/track/${ID}/extra`,
      `https://open.spotify.com/user/someone/playlist/${ID}`,
      `open.spotify.com/track/${ID}`,
      `spotify:track:${ID}:extra`,
      `spotify:user:x:playlist:${ID}`,
      `//open.spotify.com/track/${ID}`,
    ];
    for (const input of bad) expect(parseSpotifyLink(input), input).toBeNull();
  });

  it('o navegador resolve ".." antes; o src sai do tipo e do id que sobraram', () => {
    expect(parseSpotifyLink(`https://open.spotify.com/track/${ID}/../${ID}`)).toEqual({ type: 'track', id: ID });
    expect(parseSpotifyLink(`https://open.spotify.com/album/${ID}/../../track/${ID}`)).toEqual({ type: 'track', id: ID });
  });

  it('rejeita vazio, lixo e entrada gigante', () => {
    for (const input of ['', '   ', 'spotify', 'spotify:', 'spotify::', 'texto qualquer', ID, '<iframe src="https://open.spotify.com/embed/track/' + ID + '">']) {
      expect(parseSpotifyLink(input), input).toBeNull();
    }
    expect(parseSpotifyLink(`https://open.spotify.com/track/${ID}?${'a'.repeat(400)}`)).toBeNull();
  });
});

describe('src montado', () => {
  it('é só o embed com tipo e id, nunca a entrada', () => {
    const ref = parseSpotifyLink(`https://open.spotify.com/intl-pt/track/${ID}?si=segredo#x`)!;
    expect(spotifyEmbedSrc(ref)).toBe(`https://open.spotify.com/embed/track/${ID}`);
    expect(spotifyLink(ref)).toBe(`https://open.spotify.com/track/${ID}`);
    expect(spotifyUri(ref)).toBe(`spotify:track:${ID}`);
    // O que se guarda volta pelo mesmo parser.
    expect(parseSpotifyLink(spotifyUri(ref))).toEqual(ref);
    expect(parseSpotifyLink(spotifyLink(ref))).toEqual(ref);
  });
});
