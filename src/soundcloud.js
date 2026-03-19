// Facade de SoundCloud para manter o index.js intuitivo:
// toda chamada relacionada a SoundCloud entra por este módulo.
// As implementações usam utilitários compartilhados de yt-dlp em youtube.js.
const {
  getSoundCloudPlaylistTracks,
  getSoundCloudPlaylistTracksStream,
  resolveSoundCloudTrackDetails,
} = require('./youtube');

module.exports = {
  getSoundCloudPlaylistTracks,
  getSoundCloudPlaylistTracksStream,
  resolveSoundCloudTrackDetails,
};
