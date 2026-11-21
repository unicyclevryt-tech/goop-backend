// Goop: Scramjet 2.0.67-alpha.1 controller worker.
importScripts('/controller/controller.sw.js');
self.addEventListener('fetch', event => {
  if ($scramjetController.shouldRoute(event)) event.respondWith($scramjetController.route(event));
});
