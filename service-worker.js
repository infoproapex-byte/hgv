"use strict";

// Bump this whenever any cached file changes, so Android picks up the update.
var CACHE_NAME = "roadtalk-v2";

var APP_SHELL = [
  "/index.html",
  "/wtd.html",
  "/style.css",
  "/script.js",
  "/wtd.js",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-512-maskable.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(APP_SHELL);
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (key) { return key !== CACHE_NAME; })
          .map(function (key) { return caches.delete(key); })
      );
    })
  );
  self.clients.claim();
});

// Network-first for the app shell: always try to fetch the latest HTML/CSS/JS
// from the server first, and only fall back to the cached copy if the phone
// is offline. This means a new deploy reaches the phone on the very next
// load, instead of the old cached version sticking around silently.
// Everything outside this origin (e.g. the WebSocket to your signaling
// server) is never touched by this worker.
self.addEventListener("fetch", function (event) {
  var req = event.request;

  if (req.method !== "GET") return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(req, copy);
          });
        }
        return res;
      })
      .catch(function () {
        return caches.match(req);
      })
  );
});
