# Norsk playlist library/example

Build:
```
npm install && npm run build
```

Run:

```
npm run playlist [file.json]
```

## Overview

This package is in two parts, a library at `playlist.ts` which orchestrates a "playlist" of file and live sources in a Norsk instance, and a simplistic example "app" using this library.

### Playlist library

The library is created by passing in a playlist to the `create` function:

```
const norsk = await Norsk.connect();
const player = await Playlist.create(norsk, playlist);
```

where the playlist comprises an array of items that specify their respective media source, in a form that is derived from the Norsk Media Node config. For example

```js
const playlist = [
  { source:
    { type: "localMp4File"
    , config: { fileName: "/file/source.mp4" }
    }
  , duration: 10000
  },
  { source: 
    { type: "srt 
    , config: { ip: "127.0.0.1", port: 5000, mode: "listener" }
    }
  }
]
```

The returned `Playlist` (`player` above) can be started via `player.start()`, manually advanced (`player.switch()`), and the audio and video output available by subscribing to `player.audio` and `player.video`.

### Playlist example

The `index.ts` contains an example applciation using the playlist library. The playlist is read in from a JSON file and transformed into the config for the playlist library, to demonstrate the translation from an arbitrary specification format to the internal format.  Example source:

```json
[
  {
    "source": "/some/file.ts",
    "duration": 10000
  },
  "/some/file.mp4",
  "srt://127.0.0.1:5002?mode=caller",
  "rtmp://0.0.0.0:5003"
]
```

Outputs to a hosted WebRTC player, HLS and a local file are set up.

## Notes

When the playlist is initialised, any listener nodes required for inbound connections (RTMP, SRT in listen mode, etc) are created and start listening immediately to allow the player to connect.

Any files in the playlist are simply played as the current item advances to them. Live sources are pre-connected at the point the prior playlist item starts playing, to allow for an immediate switch if requested - it may take some time to connect to a live source initially, and on starting to decode the source depending on key-frame timing.

