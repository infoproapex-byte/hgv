```javascript
"use strict";

var CACHE_NAME = "roadtalk-v4";

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

/* =========================
   INSTALL
========================= */

self.addEventListener("install", function (event) {

  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(APP_SHELL);
    })
  );

  self.skipWaiting();

});


/* =========================
   ACTIVATE
========================= */

self.addEventListener("activate", function (event) {

  event.waitUntil(

    caches.keys().then(function (keys) {

      return Promise.all(

        keys
          .filter(function (key) {
            return key !== CACHE_NAME;
          })
          .map(function (key) {
            return caches.delete(key);
          })

      );

    })

  );

  self.clients.claim();

});


/* =========================
   FETCH
========================= */

self.addEventListener("fetch", function (event) {

  var req = event.request;

  if (req.method !== "GET") {
    return;
  }

  var url = new URL(req.url);

  if (url.origin !== self.location.origin) {
    return;
  }

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


/* =========================
   NOTIFICATION CLICK
========================= */

self.addEventListener("notificationclick", function (event) {

  event.notification.close();

  event.waitUntil(

    self.clients.matchAll({
      type: "window",
      includeUncontrolled: true
    })

    .then(function (clientList) {

      for (var i = 0; i < clientList.length; i++) {

        var client = clientList[i];

        if ("focus" in client) {
          return client.focus();
        }

      }

      if (self.clients.openWindow) {

        return self.clients.openWindow(
          "https://hgvtalk.live/wtd.html"
        );

      }

    })

  );

});


/* =========================
   PUSH NOTIFICATION
========================= */

self.addEventListener("push", function (event) {

  var data = {};

  try {

    if (event.data) {
      data = event.data.json();
    }

  } catch (error) {

    data = {
      title: "WTD Tracker",
      body: event.data
        ? event.data.text()
        : "WTD reminder"
    };

  }

  var title =
    data.title ||
    "WTD Tracker";

  var options = {

    body:
      data.body ||
      "WTD reminder",

    icon:
      "/icons/icon-192.png",

    badge:
      "/icons/icon-192.png",

    tag:
      data.tag ||
      "wtd-reminder",

    data: {

      url:
        data.url ||
        "/wtd.html"

    },

    vibrate: [
      200,
      100,
      200
    ]

  };

  event.waitUntil(

    self.registration.showNotification(
      title,
      options
    )

  );

});
```
