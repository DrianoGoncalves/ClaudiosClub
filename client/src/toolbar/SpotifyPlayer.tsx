import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { t } from '../i18n';
import { parseSpotifyLink, spotifyEmbedSrc, spotifyLink, spotifyUri, type SpotifyRef } from './spotifyLink';

// Player do Spotify ao lado do monitor (config → Geral cola o link; vazio = desligado). É o Embed oficial num iframe:
// sem login, API nem SDK. O link fica só neste navegador (localStorage) e nada do Spotify vai ao servidor.

const KEY = 'myco.spotify';
const listeners = new Set<() => void>();

function read(): SpotifyRef | null {
  try {
    const saved = localStorage.getItem(KEY);
    // Relê pelo parser: o que está no armazenamento também não vai cru para o iframe.
    return saved ? parseSpotifyLink(saved) : null;
  } catch {
    return null;
  }
}

let value = read();

function set(v: SpotifyRef | null) {
  value = v;
  try {
    if (v) localStorage.setItem(KEY, spotifyUri(v));
    else localStorage.removeItem(KEY);
  } catch {
    // sem armazenamento: vale só nesta aba
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useSpotifyLink(): [SpotifyRef | null, (v: SpotifyRef | null) => void] {
  return [useSyncExternalStore(subscribe, () => value), set];
}

/** Mesmo corte do CSS do monitor: em tela estreita o player nem é montado (o iframe tocaria escondido). */
const NARROW = '(max-width: 640px)';
const narrow = () => window.matchMedia(NARROW).matches;
function onNarrow(l: () => void) {
  const m = window.matchMedia(NARROW);
  m.addEventListener('change', l);
  return () => m.removeEventListener('change', l);
}

/** O mínimo que o embed pede: scripts e a própria origem (para o login do Spotify valer), e popups (o "abrir no Spotify"). */
const SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox';

export function SpotifyPlayer() {
  const [ref] = useSpotifyLink();
  const small = useSyncExternalStore(onNarrow, narrow);
  if (!ref || small) return null;
  return (
    <div className="spotify">
      <iframe
        src={spotifyEmbedSrc(ref)}
        title={t('toolbar.spotifyFrame')}
        allow="autoplay; encrypted-media; clipboard-write"
        loading="lazy"
        sandbox={SANDBOX}
        referrerPolicy="no-referrer"
      />
    </div>
  );
}

/** Campo das configurações: link válido liga, campo vazio desliga. */
export function SpotifySetting() {
  const [saved, save] = useSpotifyLink();
  const [text, setText] = useState(saved ? spotifyLink(saved) : '');
  const [bad, setBad] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) {
      setBad(false);
      return save(null);
    }
    const ref = parseSpotifyLink(text);
    setBad(!ref);
    if (!ref) return;
    save(ref);
    setText(spotifyLink(ref));
  };

  return (
    <form className="setting-spotify" onSubmit={submit}>
      <input
        type="text"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        maxLength={300}
        value={text}
        placeholder={t('toolbar.spotifyPlaceholder')}
        aria-label={t('toolbar.spotifyLabel')}
        aria-invalid={bad}
        onChange={(e) => {
          setText(e.target.value);
          setBad(false);
        }}
      />
      <button type="submit" className="btn-secondary">
        {t('toolbar.spotifySave')}
      </button>
      {saved && (
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            save(null);
            setText('');
            setBad(false);
          }}
        >
          {t('toolbar.spotifyOff')}
        </button>
      )}
      {bad && (
        <p className="error small setting-spotify-error" role="alert">
          {t('toolbar.spotifyInvalid')}
        </p>
      )}
    </form>
  );
}
