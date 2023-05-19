import { Norsk, audioStreamKeys, selectAudio, selectVideo, videoStreamKeys } from "@norskvideo/norsk-sdk"
import { Playlist, PlaylistItem } from "./playlist";
import { readFileSync, existsSync } from 'fs';
import { URL } from 'node:url';
import express from "express";



function main() {
  let args = process.argv.slice(2);
  let playlistFilename = args.shift();
  if (!playlistFilename) {
    console.error("Must provide a playlist file");
    process.exit(1);
  }
  let json: any[] = JSON.parse(readFileSync(playlistFilename, { encoding: 'utf8' }));
  let playlist: PlaylistItem[] = [];
  console.log(json);
  for (let item of json) {
    if (typeof item === "string") {
      item = { source: item };
    }
    let common: { begin?: number, duration?: number } = {};
    if (item.begin && typeof item.begin === "number") {
      common.begin = item.begin;
    }
    if (item.duration && typeof item.duration === "number") {
      common.duration = item.duration;
    }
    try {
      let url = new URL(item.source);
      switch (url.protocol) {
        case 'srt:':
          let qmode = url.searchParams.get("mode");
          let mode: "caller" | "listener" = (qmode == 'caller' || qmode == 'listener') ? qmode : "caller";
          playlist.push({
            source: {
              type: "srt",
              config: {
                ip: url.hostname,
                port: Number.parseInt(url.port, 10),
                mode
              }
            },
            ...common
          })
          break;
        case 'rtmp:':
          let match = url.pathname.match(/\/(?<app>[^/]+)\/(?<stream>[^/]+)/);
          let appInfo : { app?: string, stream?: string } = {};
          if (match) {
            appInfo = { app: match.groups?.app, stream: match.groups?.stream };
          } 
          playlist.push({
            source: {
              type: "rtmp",
              config: {
                // In fact ignore url.hostname as we always listen on 0.0.0.0
                port: Number.parseInt(url.port, 10),
                ...appInfo
              }
            },
            ...common
          })
          break;
        default:
          console.log("Unknown URL format");
          continue;
      }
    } catch (_) {
      if (existsSync(item.source)) {
        if (/\.ts$/.test(item.source)) {
          playlist.push({
            source: {
              type: "fileTs",
              config: {
                fileName: item.source
              }
            },
            ...common
          });
        } else if (/\.mp4$/.test(item.source)) {
          playlist.push({
            source: {
              type: "fileMp4",
              config: {
                fileName: item.source
              }
            },
            ...common
          });
        } else if (/\.(jpe?g|png|gif|webp|tiff?|tga|dds|bmp|ico|hdr|exf|pnm|pam|ppm|pgm|ff|farbfield|avif)$/.test(item.source)) {
          playlist.push({
            source: {
              type: "image",
              config: {
                fileName: item.source
              }
            },
            ...common
          });
        }
      } else {
        console.log("Not a URL and file does not exist: %s", item.source);
        continue;
      }
    }
  }


  go(playlist);
}

async function go(playlist: PlaylistItem[]) {
  const norsk = await Norsk.connect({
    url: `localhost:${process.env.PORT}`,
    onShutdown: () => {
      console.log("Norsk has shutdown");
      process.exit(1);
    }
  });
  let fullResolution = { width: 1280, height: 720 };
  const player = await Playlist.create(norsk, playlist, fullResolution);
  let encode = await norsk.processor.transform.videoEncode(
    {
      id: "encode",
      rungs:
        [
          {
            name: "full",
            width: fullResolution.width,
            height: fullResolution.height,
            frameRate: { frames: 25, seconds: 1 },
            codec: {
              type: "x264",
              keyFrameIntervalMax: 50,
              keyFrameIntervalMin: 50,
              bframes: 0,
              sceneCut: 0,
              tune: "zerolatency",
              bitrateMode: { value: 8000000, mode: "abr" },
            }
          }
        ]
    }
  );
  encode.subscribe([{ source: player.video, sourceSelector: selectVideo }])

  const output = await norsk.duplex.webRtcBrowser({ id: "out" });
  output.subscribe([
    { source: encode, sourceSelector: videoStreamKeys },
    { source: player.audio, sourceSelector: audioStreamKeys }
  ]);
  console.log(output.playerUrl);
  let tsFileOutput = await norsk.output.fileTs({
    fileName: "/tmp/playlist.ts",
    id: "ts_file_output"
  });
  tsFileOutput.subscribe([
    { source: encode, sourceSelector: videoStreamKeys },
    { source: player.audio, sourceSelector: audioStreamKeys }
  ]);

  let audioOutput = await norsk.output.cmafAudio(segmentSettings("audio"));
  let videoOutput = await norsk.output.cmafVideo(segmentSettings("video"));

  let masterOutput = await norsk.output.cmafMaster({ 
    id: "master", 
    playlistName: "master",
    destinations: [{ type: "local" as const, retentionPeriodSeconds: 60 }],
  });

  audioOutput.subscribe([{ source: player.audio, sourceSelector: selectAudio }]);
  videoOutput.subscribe([{ source: encode, sourceSelector: selectVideo }]);
  masterOutput.subscribe([{ source: player.audio, sourceSelector: selectAudio }, { source: encode, sourceSelector: selectVideo }]);
  console.log(masterOutput.playlistUrl);


  player.start();
  setupSwitchListener(player);

}

function segmentSettings(id: string) {
  return {
    id,
    partDurationSeconds: 1.0,
    segmentDurationSeconds: 4.0,
    destinations: [{ type: "local" as const, retentionPeriodSeconds: 60 }],
  };
}

function setupSwitchListener(player: Playlist) {
  const app = express();
  const port = 6792;
  app.use(express.json());
  app.put("/switch", (req, res) => {
    player.switch();
    res.send("");
  });
  app.get("/", (req, res) => {
    res.send(`
  <script>
    function swap() {
      fetch("http://localhost:6792/switch", { method: "PUT" })
    }
  </script>
  <p>
    <button onclick="swap(); return false" style="font-size: 35">Next</button>
  </p>
  <iframe width=1000 height=600 frameBorder="0" src="http://localhost:8080/webRtcBrowser/out/player.html"></iframe>
  `);
  });

  app.listen(port, () => {
    console.log(
      `Hosted switch app listening on http://localhost:${port}/`
    );
  });
}

main();
