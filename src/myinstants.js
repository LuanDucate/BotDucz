const { fetchUrl } = require('./utils');

/**
 * Extrai a URL direta do MP3 a partir de uma página do MyInstants.
 */
async function extractMp3Url(pageUrl) {
  const html = await fetchUrl(pageUrl);

  const downloadMatch = html.match(/href=["'](\/media\/sounds\/[^"']+\.mp3)["']/i);
  if (downloadMatch) return `https://www.myinstants.com${downloadMatch[1]}`;

  const onclickMatch = html.match(/play\(['"]?(\/media\/sounds\/[^'")\s]+\.mp3)['"]?\)/i);
  if (onclickMatch) return `https://www.myinstants.com${onclickMatch[1]}`;

  const genericMatch = html.match(/(\/media\/sounds\/[^\s"'<>]+\.mp3)/i);
  if (genericMatch) return `https://www.myinstants.com${genericMatch[1]}`;

  throw new Error('Não foi possível encontrar o arquivo MP3 nesta página.');
}

/**
 * Busca um som no MyInstants por texto.
 * Retorna { title, pageUrl } ou { title, mp3Url } do primeiro resultado, ou null.
 */
async function searchMyInstants(query) {
  const searchUrl = `https://www.myinstants.com/pt/search/?name=${encodeURIComponent(query)}`;
  console.log(`🔍 Buscando no MyInstants: ${searchUrl}`);
  const html = await fetchUrl(searchUrl);

  const resultPattern = /href=["'](\/pt\/instant\/[\w\-]+\/)["'][^>]*>([^<]*)/gi;
  const results = [];
  let match;

  while ((match = resultPattern.exec(html)) !== null) {
    const instantPath = match[1];
    const title = match[2].trim();
    if (!results.find((r) => r.pageUrl === `https://www.myinstants.com${instantPath}`)) {
      results.push({
        title: title || instantPath.split('/').filter(Boolean).pop().replace(/-/g, ' '),
        pageUrl: `https://www.myinstants.com${instantPath}`,
      });
    }
  }

  if (results.length === 0) {
    const onclickPattern =
      /onclick=["']play\(['"]?(\/media\/sounds\/[^'")\s]+\.mp3)['"]?\)["']/gi;
    let onclickMatch;
    while ((onclickMatch = onclickPattern.exec(html)) !== null) {
      const mp3Path = onclickMatch[1];
      const soundName = mp3Path
        .split('/')
        .pop()
        .replace('.mp3', '')
        .replace(/-/g, ' ')
        .replace(/_/g, ' ');
      results.push({
        title: soundName,
        mp3Url: `https://www.myinstants.com${mp3Path}`,
      });
    }
  }

  if (results.length === 0) return null;

  console.log(`✅ Encontrados ${results.length} resultado(s). Primeiro: "${results[0].title}"`);
  return results[0];
}

module.exports = { extractMp3Url, searchMyInstants };
