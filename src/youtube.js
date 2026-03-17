const { spawn } = require('child_process');

/**
 * Obtém o título de um vídeo do YouTube via yt-dlp.
 */
function getYouTubeTitle(url) {
  return new Promise((resolve) => {
    try {
      const proc = spawn('yt-dlp', ['--get-title', '--no-warnings', '--no-playlist', url]);
      let title = '';
      proc.stdout.on('data', (data) => (title += data.toString()));
      proc.on('close', (code) => {
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
    ]);
    
    let output = '';
    proc.stdout.on('data', (data) => (output += data.toString()));
    proc.stderr.on('data', (data) =>
      console.error('yt-dlp playlist stderr:', data.toString().trim())
    );
    proc.on('close', () => {
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
 * Verifica se a URL do YouTube contém uma playlist.
 */
function isPlaylistUrl(url) {
  return /[?&]list=/.test(url);
}

module.exports = { getYouTubeTitle, getPlaylistVideos, isPlaylistUrl };
