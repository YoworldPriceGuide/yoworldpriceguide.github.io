// Stands in for the extension APIs app.js uses (chrome.storage.local and chrome.runtime.getURL),
// so the same app.js code runs on a normal web page. Data is kept in this browser's localStorage.
(function () {
  const PREFIX = "ytrack:"; // keeps these keys apart from the app's own localStorage keys

  function readItem(key) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? undefined : JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  function writeItem(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch (e) {
      console.warn("[storage] could not save", key, e);
    }
  }

  function allKeys() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith(PREFIX)) keys.push(k.slice(PREFIX.length));
    }
    return keys;
  }

  // Matches chrome.storage: returns a promise and also calls an optional callback
  function done(result, callback) {
    if (callback) callback(result);
    return Promise.resolve(result);
  }

  const local = {
    get(keys, callback) {
      const list = keys == null ? allKeys() : Array.isArray(keys) ? keys : [keys];
      const result = {};
      for (const key of list) {
        const value = readItem(key);
        if (value !== undefined) result[key] = value;
      }
      return done(result, callback);
    },
    set(items, callback) {
      for (const [key, value] of Object.entries(items)) writeItem(key, value);
      return done(undefined, callback);
    },
    remove(keys, callback) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        localStorage.removeItem(PREFIX + key);
      }
      return done(undefined, callback);
    },
  };

  window.chrome = {
    ...window.chrome,
    storage: { local },
    runtime: { getURL: path => path },
  };
})();
