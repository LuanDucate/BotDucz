const { spawn } = require('child_process');

function decodeOutputBuffer(chunks) {
  const full = Buffer.concat(chunks);
  const utf8 = full.toString('utf8');

  if (utf8.includes('\uFFFD')) {
    return full.toString('latin1');
  }

  return utf8;
}

function parseSpotifyCollectionUrl(url) {
  const match = String(url || '').match(
    /spotify\.com\/(?:intl-[^\/]+\/)?(playlist|album)\/([A-Za-z0-9]+)/i
  );
  if (!match) return null;
  return {
    type: match[1].toLowerCase(),
    id: match[2],
  };
}

async function getSpotifyWebAccessToken() {
  try {
    const response = await fetch(
      'https://open.spotify.com/get_access_token?reason=transport&productType=web_player',
      {
        headers: {
          accept: 'application/json',
        },
      }
    );
    if (!response.ok) return null;

    const data = await response.json();
    const token = String(data?.accessToken || '').trim();
    return token || null;
  } catch {
    return null;
  }
}

async function getSpotifyCollectionTrackQueriesApi(url, maxTracks = 50) {
  const parsed = parseSpotifyCollectionUrl(url);
  if (!parsed) return [];

  const token = await getSpotifyWebAccessToken();
  if (!token) return [];

  const limit = Math.max(1, Math.min(1000, Math.floor(maxTracks || 50)));
  const queries = [];
  let offset = 0;

  while (queries.length < limit) {
    const pageSize = Math.min(50, limit - queries.length);
    const endpoint =
      parsed.type === 'playlist'
        ? `https://api.spotify.com/v1/playlists/${parsed.id}/tracks?limit=${pageSize}&offset=${offset}&market=BR`
        : `https://api.spotify.com/v1/albums/${parsed.id}/tracks?limit=${pageSize}&offset=${offset}&market=BR`;

    let response;
    try {
      response = await fetch(endpoint, {
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
    } catch {
      break;
    }

    if (!response.ok) break;

    let data;
    try {
      data = await response.json();
    } catch {
      break;
    }

    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) break;

    for (const item of items) {
      const track = parsed.type === 'playlist' ? item?.track : item;
      if (!track) continue;

      const title = String(track.name || '').trim();
      const artist = Array.isArray(track.artists)
        ? track.artists
            .map((a) => String(a?.name || '').trim())
            .filter(Boolean)
            .join(', ')
        : '';

      if (title && artist) queries.push(`${artist} - ${title}`);
      else if (title) queries.push(title);

      if (queries.length >= limit) break;
    }

    if (!data.next) break;
    offset += items.length;
  }

  return queries;
}

function unescapeJsonString(value) {
  try {
    return JSON.parse(`"${String(value || '').replace(/"/g, '\\"')}"`);
  } catch {
    return String(value || '');
  }
}

async function getSpotifyCollectionTrackQueriesFromEmbed(url, maxTracks = 50) {
  const parsed = parseSpotifyCollectionUrl(url);
  if (!parsed) return [];

  const limit = Math.max(1, Math.min(1000, Math.floor(maxTracks || 50)));
  const embedUrl = `https://open.spotify.com/embed/${parsed.type}/${parsed.id}`;

  let html = '';
  try {
    const response = await fetch(embedUrl, {
      headers: {
        'user-agent': 'Mozilla/5.0',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!response.ok) return [];
    html = await response.text();
  } catch {
    return [];
  }

  const trackRegex = /"title":"((?:\\.|[^"\\])*)","subtitle":"((?:\\.|[^"\\])*)"/g;
  const queries = [];
  const seen = new Set();

  for (const match of html.matchAll(trackRegex)) {
    const rawTitle = match[1];
    const rawSubtitle = match[2];

    const title = unescapeJsonString(rawTitle).trim();
    const artist = unescapeJsonString(rawSubtitle).trim();
    if (!title) continue;
    if (artist.toLowerCase() === 'spotify') continue;

    const query = artist ? `${artist} - ${title}` : title;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(query);

    if (queries.length >= limit) break;
  }

  return queries;
}

async function getSpotifyOEmbedTitle(spotifyUrl) {
  try {
    const endpoint = `https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`;
    const response = await fetch(endpoint);
    if (!response.ok) return null;

    const data = await response.json();
    const rawTitle = String(data?.title || '').trim();
    return rawTitle || null;
  } catch {
    return null;
  }
}

async function getSpotifyTrackSearchQuery(spotifyUrl) {
  const rawTitle = await getSpotifyOEmbedTitle(spotifyUrl);
  if (!rawTitle) return null;

  return rawTitle
    .replace(/\s+on\s+Spotify$/i, '')
    .replace(/\s+\|\s+Spotify$/i, '')
    .trim();
}

async function getSpotifyCollectionTrackQueriesFallback(url, maxTracks = 50) {
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

module.exports = {
  getSpotifyCollectionTrackQueriesApi,
  getSpotifyCollectionTrackQueriesFromEmbed,
  getSpotifyCollectionTrackQueriesFallback,
  getSpotifyOEmbedTitle,
  getSpotifyTrackSearchQuery,
};
