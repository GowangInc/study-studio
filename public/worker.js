self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate' || new URL(event.request.url).pathname !== '/') return
  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Study Studio</title><main><h1>Study Studio is offline</h1><p>Reconnect to the school network and reopen the app. You can still open a study app you downloaded earlier.</p></main></html>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )))
})
