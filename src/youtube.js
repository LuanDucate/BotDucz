const { spawn } = require('child_process');
const readline = require('readline');

function decodeOutputBuffer(chunks) {
  const full = Buffer.concat(chunks);
  const utf8 = full.toString('utf8');

  // Alguns ambientes Windows ignoram UTF-8 no yt-dlp e retornam CP1252/Latin-1.
  // Se houver caractere de substituição, tentamos fallback em latin1.
  if (utf8.includes('\uFFFD')) {
    return full.toString('latin1');
  }

  return utf8;
}

function titleFromSlug(slug) {
  const cleanSlug = String(slug || '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
  if (!cleanSlug) return '';
  if (/^\d+$/.test(cleanSlug)) return '';

  try {
    return decodeURIComponent(cleanSlug)
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return cleanSlug
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

function normalizeSoundCloudTrack(entry) {
  if (!entry) return null;

  const domainCandidate = String(entry.webpage_url_domain || '').trim().toLowerCase();
  const rawUrl = String(
    entry.webpage_url || entry.original_url || entry.url || ''
  ).trim();
  const directUrl = rawUrl.startsWith('http')
    ? rawUrl
    : rawUrl.startsWith('/')
      ? `https://soundcloud.com${rawUrl}`
      : null;
  if (!directUrl) return null;

  const titleCandidate = String(entry.title || '').trim();
  const idCandidate = String(entry.id || '').trim();
  const basenameCandidate = String(entry.webpage_url_basename || '').trim();
  const uploaderCandidate = String(entry.uploader || entry.channel || '').trim();
  const idFromUrl = (() => {
    const m = rawUrl.match(/(?:\/tracks\/|\btracks%2F)(\d{4,})/i);
    return m ? String(m[1]) : '';
  })();

  let title = titleCandidate;
  const titleLooksNumeric = /^\d+$/.test(titleCandidate);
  const titleMatchesId = titleCandidate && idCandidate && titleCandidate === idCandidate;

  if (!title || titleLooksNumeric || titleMatchesId) {
    title = titleFromSlug(basenameCandidate);
  }

  if (!title) {
    try {
      title = titleFromSlug(new URL(directUrl).pathname.split('/').filter(Boolean).pop() || '');
    } catch {
      title = '';
    }
  }

  const fallbackId = idCandidate || idFromUrl;
  const fallbackTitle = fallbackId
    ? `${uploaderCandidate || 'SoundCloud'} - faixa ${fallbackId}`
    : (uploaderCandidate ? `${uploaderCandidate} - faixa do SoundCloud` : 'faixa do SoundCloud');

  return {
    url: directUrl,
    title: title || fallbackTitle,
    needsResolve: domainCandidate === 'api-v2.soundcloud.com' || !title || /^\d+$/.test(title),
  };
}

function resolveSoundCloudTrackDetails(url) {
  return new Promise((resolve) => {
    try {
      const proc = spawn(
        'yt-dlp',
        ['--dump-single-json', '--no-warnings', '--no-playlist', url],
        {
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        }
      );

      const stdoutChunks = [];
      proc.stdout.on('data', (data) => stdoutChunks.push(data));

      proc.on('close', () => {
        try {
          const output = decodeOutputBuffer(stdoutChunks).trim();
          if (!output) return resolve(null);
          const obj = JSON.parse(output);
          const normalized = normalizeSoundCloudTrack(obj);
          if (!normalized) return resolve(null);
          normalized.needsResolve = false;
          resolve(normalized);
        } catch {
          resolve(null);
        }
      });

      proc.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

/**
 * Obtém o título de um vídeo do YouTube via yt-dlp.
 */
function getYouTubeTitle(url) {
  return new Promise((resolve) => {
    try {
      const proc = spawn('yt-dlp', ['--get-title', '--no-warnings', '--no-playlist', url], {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      });
      const stdoutChunks = [];
      proc.stdout.on('data', (data) => stdoutChunks.push(data));
      proc.on('close', (code) => {
        const title = decodeOutputBuffer(stdoutChunks);
        resolve(code === 0 && title.trim() ? title.trim() : 'vídeo do YouTube');
      });
      proc.on('error', () => resolve('vídeo do YouTube'));
    } catch {
      resolve('vídeo do YouTube');
    }
  });
}

/**
 * Extrai os vídeos de uma playlist do YouTube via yt-dlp.
 * Retorna um array de { url, title }.
 */
function getPlaylistVideos(url, maxVideos = 50) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', [
      '--flat-playlist',
      '-f', 'bestaudio/best',
      '-j',
      '--no-warnings',
      '--playlist-end',
      String(maxVideos),
      '--extractor-args',
      'youtube:player_client=android',
      url,
    ], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });

    const stdoutChunks = [];
    proc.stdout.on('data', (data) => stdoutChunks.push(data));
    proc.stderr.on('data', (data) =>
      console.error('yt-dlp playlist stderr:', data.toString().trim())
    );
    proc.on('close', () => {
      const output = decodeOutputBuffer(stdoutChunks);
      const videos = output
        .trim()
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          try {
            const obj = JSON.parse(line);
            return {
              url:
                obj.url && obj.url.startsWith('http')
                  ? obj.url
                  : `https://www.youtube.com/watch?v=${obj.id}`,
              title: obj.title || 'Vídeo desconhecido',
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      resolve(videos);
    });
    proc.on('error', () => reject(new Error('yt-dlp não encontrado')));
  });
}

/**
 * Resolve uma busca (texto) para um vídeo único do YouTube.
 * Retorna { url, title } ou null.
 */
function resolveYouTubeSearch(query) {
  return new Promise((resolve) => {
    try {
      const proc = spawn(
        'yt-dlp',
        ['--dump-single-json', '--no-warnings', '--no-playlist', `ytsearch1:${query}`],
        {
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        }
      );

      const stdoutChunks = [];
      proc.stdout.on('data', (data) => stdoutChunks.push(data));

      proc.on('close', (code) => {
        if (code !== 0) return resolve(null);

        try {
          const output = decodeOutputBuffer(stdoutChunks).trim();
          if (!output) return resolve(null);

          const obj = JSON.parse(output);
          const entry = Array.isArray(obj.entries) ? obj.entries[0] : obj;
          if (!entry) return resolve(null);

          const id = entry.id;
          const directUrl =
            (typeof entry.webpage_url === 'string' && entry.webpage_url.startsWith('http'))
              ? entry.webpage_url
              : (typeof entry.url === 'string' && entry.url.startsWith('http'))
                ? entry.url
                : id
                  ? `https://www.youtube.com/watch?v=${id}`
                  : null;

          if (!directUrl) return resolve(null);

          resolve({
            url: directUrl,
            title: entry.title || 'vídeo do YouTube',
          });
        } catch {
          resolve(null);
        }
      });

      proc.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

/**
 * Resolve múltiplos resultados de uma busca do YouTube.
 * Retorna array de { url, title }.
 */
function resolveYouTubeSearchMany(query, maxResults = 10) {
  return new Promise((resolve) => {
    try {
      const limit = Math.max(1, Math.min(50, Math.floor(maxResults || 10)));
      const proc = spawn(
        'yt-dlp',
        ['--dump-single-json', '--no-warnings', '--no-playlist', `ytsearch${limit}:${query}`],
        {
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        }
      );

      const stdoutChunks = [];
      proc.stdout.on('data', (data) => stdoutChunks.push(data));

      proc.on('close', (code) => {
        if (code !== 0) return resolve([]);

        try {
          const output = decodeOutputBuffer(stdoutChunks).trim();
          if (!output) return resolve([]);

          const obj = JSON.parse(output);
          const entries = Array.isArray(obj.entries) ? obj.entries : [obj];

          const videos = entries
            .map((entry) => {
              if (!entry) return null;

              const id = entry.id;
              const directUrl =
                (typeof entry.webpage_url === 'string' && entry.webpage_url.startsWith('http'))
                  ? entry.webpage_url
                  : (typeof entry.url === 'string' && entry.url.startsWith('http'))
                    ? entry.url
                    : id
                      ? `https://www.youtube.com/watch?v=${id}`
                      : null;

              if (!directUrl) return null;

              return {
                url: directUrl,
                title: entry.title || 'vídeo do YouTube',
              };
            })
            .filter(Boolean);

          resolve(videos);
        } catch {
          resolve([]);
        }
      });

      proc.on('error', () => resolve([]));
    } catch {
      resolve([]);
    }
  });
}

/**
 * Extrai faixas de uma playlist/album do Spotify para consultas de busca no YouTube.
 * Retorna array de strings (queries).
 */
function getSpotifyCollectionTrackQueries(url, maxTracks = 50) {
  return new Promise((resolve) => {
    try {
      const proc = spawn(
        'yt-dlp',
        [
          '--flat-playlist',
          '-j',
          '--no-warnings',
          '--playlist-end',
          String(maxTracks),
          url,
        ],
        {
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        }
      );

      const stdoutChunks = [];
      proc.stdout.on('data', (data) => stdoutChunks.push(data));

      proc.on('close', () => {
        const output = decodeOutputBuffer(stdoutChunks);
        const queries = output
          .trim()
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => {
            try {
              const obj = JSON.parse(line);
              const title = String(obj.title || '').trim();
              const artist = String(
                obj.artist || obj.uploader || obj.channel || obj.creator || ''
              ).trim();

              if (title && artist) return `${artist} - ${title}`;
              if (title) return title;
              return null;
            } catch {
              return null;
            }
          })
          .filter(Boolean);

        resolve(queries);
      });

      proc.on('error', () => resolve([]));
    } catch {
      resolve([]);
    }
  });
}

/**
 * Extrai faixas de playlist/sets do SoundCloud.
 * Usa --flat-playlist -j para descoberta rápida (uma linha por faixa).
 * Retorna array de { url, title }.
 */
function getSoundCloudPlaylistTracks(url, maxTracks = 0) {
  return new Promise((resolve) => {
    try {
      const args = [
        '-j',
        '--no-warnings',
      ];
      if (maxTracks > 0) {
        args.push('--playlist-end', String(maxTracks));
      }
      args.push(url);

      const proc = spawn(
        'yt-dlp',
        args,
        {
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        }
      );

      const stdoutChunks = [];
      proc.stdout.on('data', (data) => stdoutChunks.push(data));
      proc.stderr.on('data', (data) =>
        console.error('yt-dlp SoundCloud stderr:', data.toString().trim())
      );

      proc.on('close', () => {
        try {
          const output = decodeOutputBuffer(stdoutChunks);
          const tracks = output
            .trim()
            .split('\n')
            .filter((line) => line.trim())
            .map((line) => {
              try {
                const obj = JSON.parse(line);
                return normalizeSoundCloudTrack(obj);
              } catch {
                return null;
              }
            })
            .filter(Boolean);

          resolve(tracks);
        } catch {
          resolve([]);
        }
      });

      proc.on('error', () => resolve([]));
    } catch {
      resolve([]);
    }
  });
}

/**
 * Streaming version: yields { url, title } one track at a time as yt-dlp discovers them.
 * Uses --flat-playlist for speed (no full metadata fetch per track).
 * Titles that come back as pure numeric IDs are replaced with the URL slug.
 * Use with `for await`.
 */
async function* getSoundCloudPlaylistTracksStream(url, maxTracks = 0) {
  const args = ['--flat-playlist', '-j', '--no-warnings'];
  if (maxTracks > 0) args.push('--playlist-end', String(maxTracks));
  args.push(url);

  const proc = spawn('yt-dlp', args, {
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  proc.stderr.on('data', (d) => console.error('yt-dlp SC stream stderr:', d.toString().trim()));

  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        const track = normalizeSoundCloudTrack(obj);
        if (!track) continue;
        yield track;
      } catch { /* skip malformed line */ }
    }
  } finally {
    rl.close();
    try { proc.kill(); } catch { /* ignore */ }
  }
}

/**
 * Verifica se a URL do YouTube contém uma playlist.
 */
function isPlaylistUrl(url) {
  return /[?&]list=/.test(url);
}

module.exports = {
  getYouTubeTitle,
  getPlaylistVideos,
  isPlaylistUrl,
  resolveYouTubeSearch,
  resolveYouTubeSearchMany,
  getSpotifyCollectionTrackQueries,
  getSoundCloudPlaylistTracks,
  getSoundCloudPlaylistTracksStream,
  resolveSoundCloudTrackDetails,
};
