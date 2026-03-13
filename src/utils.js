const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Faz uma requisição HTTP/HTTPS e retorna o corpo como string.
 * Segue redirecionamentos automaticamente.
 */
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Erro HTTP ${res.statusCode} ao acessar ${url}`));
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Baixa um MP3 para um arquivo temporário.
 * Retorna o caminho do arquivo.
 */
function downloadMp3(mp3Url) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `botducz_${Date.now()}.mp3`);

    function doDownload(downloadUrl) {
      const dl = downloadUrl.startsWith('https') ? https : http;
      dl.get(downloadUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doDownload(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Erro HTTP ${res.statusCode} ao baixar o áudio`));
        }
        const fileStream = fs.createWriteStream(tmpFile);
        res.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          resolve(tmpFile);
        });
        fileStream.on('error', (err) => {
          fs.unlink(tmpFile, () => {});
          reject(err);
        });
      }).on('error', reject);
    }

    doDownload(mp3Url);
  });
}

module.exports = { fetchUrl, downloadMp3 };
