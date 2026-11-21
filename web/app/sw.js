// Installability only. No fetch handler and no Cache Storage: summaries, transcripts and the
// login session are never stored offline by this app.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
