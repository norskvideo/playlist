import { AudioGainNode, audioStreamKeys, ImageFileInputSettings, LocalFileInputSettings, Mp4FileInputSettings, Norsk, NorskSettings, PinToKey, ReceiveFromAddress, RtmpServerInputNode, RtmpServerInputSettings, RtpInputSettings, selectAudio, selectVideo, SmoothSwitcherNode, SourceMediaNode, SrtInputNode, SrtInputSettings, StreamKey, StreamKeyOverrideNode, StreamMetadata, videoStreamKeys, WhipInputSettings } from "@id3asnorsk/norsk-sdk";

export type PlaylistItem =
  {
    begin?: number,
    duration?: number,
    source: PlaylistSource,
  };
// Optionally pick which audio etc?

export type PlaylistSource =
  {
    type: "localTsFile",
    config: Pick<LocalFileInputSettings, "fileName">
  }
  |
  {
    type: "localMp4File",
    config: Pick<Mp4FileInputSettings, "fileName">
  }
  |
  {
    type: "srt",
    config: Pick<SrtInputSettings, "mode" | "ip" | "port">
  }
  |
  {
    type: "rtmp",
    config: Pick<RtmpServerInputSettings, "port"> & { app?: string, stream?: string }
  }
  |
  {
    type: "image",
    config: Pick<ImageFileInputSettings, "fileName" | "imageFormat">
  }
  |
  {
    type: "rtp",
    config: Pick<RtpInputSettings, "streams">
  }
  |
  {
    type: "whip",
    config: Pick<WhipInputSettings, never>
  };

type SwitchPins = string;

type AVKind = "video" | "av"
type InitialCreateInfo = {
  node: SourceMediaNode,
  nodeId: string,
  kind: AVKind,
  item: PlaylistItem,
  streamKeyFilter: (stream: StreamKey) => boolean
  closeNode: () => void,
}
type CreatedNodeInfo = InitialCreateInfo & {
  duration: Promise<number | undefined>
}


export class Playlist {
  nextSwitchSource: number = 0;
  playingItems: {
    prev?: PlayingItem,
    current?: PlayingItem,
    next?: PlayingItem,
  } = {};
  playing: undefined | number;

  transitionDuration = 300.0;
  timeouts: NodeJS.Timeout[] = [];
  sourceIndex = 0;

  srtListeners: Map<number, ListenerNode<SrtInputNode>> = new Map();
  rtmpListeners: Map<number, ListenerNode<RtmpServerInputNode>> = new Map()

  private constructor(private norsk: Norsk, public readonly playlist: PlaylistItem[], private switcher: SmoothSwitcherNode<SwitchPins>, private silence: AudioGainNode, public video: StreamKeyOverrideNode, public audio: StreamKeyOverrideNode, transitionDuration?: number) {
    if (transitionDuration) {
      this.transitionDuration = transitionDuration;
    }
  }

  public start() {
    this.update();
  }
  public switch() {
    this.update();
  }

  public static async create(norsk: Norsk, playlist: PlaylistItem[], transitionDuration?: number): Promise<Playlist> {
    const switcher = await norsk.processor.control.smoothSwitcher({
      activeSource: "",
      id: "switcher",
      outputSource: "source",
      outputResolution: { width: 640, height: 480 },
      transitionDurationMs: transitionDuration,
      sampleRate: 48000
    });
    const audio = await norsk.input.audioSignal({
      channelLayout: "stereo",
      sampleFormat: "fltp",
      sampleRate: 48000,
      sourceName: "source",
      id: "audio_signal"
    });
    const silence = await norsk.processor.transform.audioGain({
      id: "silence",
      channelGains: [null, null],
    });;
    silence.subscribe([
      { source: audio, sourceSelector: audioStreamKeys }
    ]);

    let videoStreamKey = await norsk.processor.transform.streamKeyOverride(
      {
        id: "video_stream_key",
        streamKey: {
          programNumber: 1,
          renditionName: "video",
          streamId: 256,
          sourceName: "input",
        },
      }
    );
    let audioStreamKey = await norsk.processor.transform.streamKeyOverride(
      {
        id: "audio_stream_key",
        streamKey: {
          programNumber: 1,
          renditionName: "audio",
          streamId: 257,
          sourceName: "input",
        },
      }
    );

    videoStreamKey.subscribe([
      { source: switcher, sourceSelector: selectVideo },
    ]);
    audioStreamKey.subscribe([
      { source: switcher, sourceSelector: selectAudio },
    ]);

    let ret = new Playlist(norsk, playlist, switcher, silence, videoStreamKey, audioStreamKey, transitionDuration);
    ret.precreateListeners();
    return ret;
  }

  async update() {
    console.log("Update start");
    for (let timeout of this.timeouts) {
      clearTimeout(timeout);
      this.timeouts = [];
    }

    const currentSource = this.sourceIndex++;

    if (currentSource >= this.playlist.length) {
      console.log("Playlist complete");
      process.exit(0);
    }
    let item = this.playlist[currentSource];
    this.playingItems.prev = this.playingItems.current;

    if (this.playingItems.next) {
      console.log("Using pre-started source", this.playingItems.next.index)
      // We already prewarmed this source
      this.playingItems.current = this.playingItems.next;
      this.playingItems.next = undefined;
      // Just need to switch, assuming it's ready
      this.refreshActive()
    } else {
      console.log("Starting up source immediately", currentSource)
      // Need to spin up this source
      let createInfo = await this.createNode(item, currentSource, this.subscribeToNode(currentSource, 'current'));
      let { closeNode } = createInfo;
      let duration = item.duration || (await createInfo.duration);
      // This is set by the callback but we get the info back from the async call...don't ask
      if (this.playingItems.current) {
        this.playingItems.current.duration = duration;
        this.playingItems.current.closeNode = closeNode;
      }
    }
    // TODO duration should apply to prewarmed sources after they are switched to also
    let currentDuration = this.playingItems.current?.duration;
    if (currentDuration) {
      const timeout = setTimeout(() => {
        console.log("Stopping source due to duration", currentSource);
        let close = this.playingItems.current?.closeNode;
        // Switch first, then close after the transition kicks in and finishes
        this.update();
        setTimeout(() => {
          close && close();
        }, 1000);
      }, currentDuration - this.transitionDuration);
      this.timeouts.push(timeout);
    }

    // Spin up the next source already if required. For some network sources, this means we will 
    // start attempting to connect, while some listeners already were started up so their clients could connect as they wished
    // Either way, wiring up the subscriptions to the source switcher will mean we start decoding the 
    // source, particularly the video, allowing us to switch either according to duration/source closing
    // or manual request (for which reason we spin the next source up immediately).
    let next = this.playlist[currentSource + 1];
    if (next && isLive(next.source)) {
      console.log("Prewarming source", next);
      let createInfo = await this.createNode(next, currentSource, this.subscribeToNode(currentSource+1, 'next'));
      let { closeNode } = createInfo;
      let duration = next.duration || (await createInfo.duration);
      // This is set by the callback but we get the info back from the async call...don't ask
      // Also typescript inference bug that asserts .next is undefined even though we know it just got set
      (this.playingItems.next as any as PlayingItem).duration = duration;
      (this.playingItems.next as any as PlayingItem).closeNode = closeNode;
    }

    console.log("Update end");
  }

  subscribeToNode = (sourceIndex: number, nodeType: 'current' | 'next') => {
    return ({ node, kind, item, streamKeyFilter, closeNode }: InitialCreateInfo) => {
      console.log("Subscribing to node: %s", node.id);
      let state: PlayingItem = {
        item,
        silenceSub: undefined,
        sub: undefined,
        ready: false,
        index: sourceIndex,
        closeNode
      };
      state.sub = {
        source: node,
        sourceSelector: (streams: StreamMetadata[]) => {
          let pin = sourceIndex.toString();

          const audio = audioStreamKeys(streams).filter(streamKeyFilter).slice(0, 1);
          const video = videoStreamKeys(streams).filter(streamKeyFilter).slice(0, 1);
          const keys = audio.concat(video);

          // Create a subscription as soon as we have either audio or video - they will sit in a sync
          let res: undefined | PinToKey<string> = undefined;
          if (keys.length >= 1) {
            res = { [pin]: keys };
          }

          // But don't switch until we have both audio/video
          let ready = (kind == "video" || audio.length >= 1) && video.length >= 1;
          state.ready = ready;

          this.refreshActive();
          return res;
        }
      };
      if (kind == "video") {
        state.silenceSub = {
          source: this.silence,
          sourceSelector: (streams: StreamMetadata[]) => {
            let pin = sourceIndex.toString();

            const audio = audioStreamKeys(streams);
            let res: undefined | PinToKey<string> = undefined;
            if (audio.length == 1) {
              res = { [pin]: audio };
            }
            return res;
          }
        }
      }
      this.playingItems[nodeType] = state;
      this.refreshSubs();
    }
  }

  onClose(node: SourceMediaNode) {
    if (this.playingItems.prev?.sub?.source == node) {
      this.playingItems.prev = undefined;
      this.refreshSubs()
    }
  }


  refreshSubs() {
    const subs = (item: PlayingItem | undefined) => [item?.sub, item?.silenceSub].filter((x): x is Exclude<typeof x, undefined> => x != undefined);
    this.switcher.subscribeToPins(
      [this.playingItems.prev, this.playingItems.current, this.playingItems.next].flatMap(subs)
    );
  }


  refreshActive() {
    // console.log("refreshActive", this.playing, this.playingItems.prev?.ready, this.playingItems.current?.ready, this.playingItems.next?.ready)
    const activateSource = (item: PlayingItem) => {
      this.playing = item.index;
      setTimeout(() => { this.switcher.switchSource(item.index.toString()); }, 10);
    };
    if (this.playing !== this.playingItems.current?.index && this.playingItems.current?.ready) {
      console.log("Switching to new source", this.playingItems.current.item);
      activateSource(this.playingItems.current);
    } else if (this.playing === undefined && this.playingItems.prev?.ready) {
      // This should have been started already one assumes, but what the heck
      console.log("Activating previous source which seems to be ready", this.playingItems.prev.item);
      activateSource(this.playingItems.prev);
    }
  }

  // Create the node. Subscription is a callback so it applies synchronously only node creation, not missing any initial frames
  async createNode(item: PlaylistItem, currentSource: number, subscribeNode: (info: InitialCreateInfo) => void): Promise<CreatedNodeInfo> {
    const nodeId = `input-${currentSource}`;

    let streamKeyFilter = (k: StreamKey) => true;
    let commonSettings = {
      sourceName: "source",
      id: nodeId,
      onCreate: (node: SourceMediaNode) => {
        subscribeNode({ item, node, nodeId, kind: nodeKind(item.source), streamKeyFilter, closeNode });
      },
      onClose: () => {
        this.onClose(node);
      }
    };

    let node: SourceMediaNode;
    let durationPromise: Promise<number | undefined> = Promise.resolve(undefined);
    let isStandaloneNode = true;
    switch (item.source.type) {
      case "localTsFile":
        node = await this.norsk.input.localTsFile({
          onEof: () => {
            console.log(`EOF on ${nodeId}`);
            closeNode();
            this.update();
          },
          ...commonSettings,
          ...item.source.config
        });
        break;
      case "localMp4File": {
        let onDuration: (duration?: number) => void;
        durationPromise = new Promise((resolveDuration) => {
          onDuration = (x) => resolveDuration(x);
        });
        node = await this.norsk.input.localMp4File({
          onEof: () => {
            console.log(`EOF on ${nodeId}`);
            closeNode();
            this.update();
          },
          onInfo: (info) => {
            console.log("mp4 info", info);
            onDuration(info.durationMs);
          },
          ...commonSettings,
          ...item.source.config
        });
        break;
      }
      case "srt":
        {
          if (item.source.config.mode == "listener") {
            console.log("Reusing srt listener source");
            isStandaloneNode = false;
            let listener = this.srtListeners.get(item.source.config.port);
            if (!listener || !listener.node) {
              throw new Error(`Didn't find SRT listener on port ${item.source.config.port}`);
            }
            node = listener.node;
            listener.onDisconnect.set(nodeId, (sourceName: string) => {
              console.log(`Disconnect on ${nodeId}`);
              this.update();
              listener?.onDisconnect.delete(nodeId);
            });
            subscribeNode({ item, node, nodeId, kind: nodeKind(item.source), streamKeyFilter, closeNode });
          } else {
            console.log("Creating srt caller source");
            node = await this.norsk.input.srt({
              onConnectionStatusChange: (status) => {
                console.log(`Source disconnected on ${nodeId}`);
                closeNode();
                this.update();
              },
              ...commonSettings,
              ...item.source.config
            });
          }
        }
        break;
      case "rtmp":
        {
          let config = item.source.config;
          let listener = this.rtmpListeners.get(config.port);
          isStandaloneNode = false;
          if (!listener || !listener.node) {
            throw new Error(`Didn't find SRT listener on port ${config.port}`);
          }
          let sourceName: undefined | string = undefined;
          if (config.app && config.stream) {
            sourceName = `${config.app}/${config.stream}`;
          }
          node = listener.node;
          listener.onDisconnect.set(nodeId, (disconnectSourceName: string) => {
            if (disconnectSourceName === sourceName) {
              console.log(`Disconnect on ${nodeId}`);
              this.update();
              listener?.onDisconnect.delete(nodeId);
            }
          });
          streamKeyFilter = (streamKey) => {
            if (sourceName) {
              return streamKey.sourceName == sourceName
            }
            return true;
          }
          subscribeNode({ item, node, nodeId, kind: nodeKind(item.source), streamKeyFilter, closeNode });
          break;
        }
      case "image": {
        node = await this.norsk.input.imageFile({
          ...commonSettings,
          ...item.source.config
        });
        break;
      }
      case "rtp": {
        node = await this.norsk.input.rtp({
          ...commonSettings,
          ...item.source.config
        });
        break;
      }
      case "whip": {
        node = await this.norsk.input.whip({
          ...commonSettings,
          ...item.source.config
        });
        break;
      }
      default:
        const exhaustiveCheck: never = item.source;
        throw new Error(`Unhandled case: ${exhaustiveCheck}`);
    }

    function closeNode() {
      if (isStandaloneNode) {
        console.log("Closing source node (soon)", nodeId);
        setTimeout(() => {
          console.log("Closing source node now", nodeId);
          node.close();
        }, 1000);
      }
    }

    return {
      item: item,
      node,
      nodeId,
      closeNode,
      kind: nodeKind(item.source),
      duration: durationPromise,
      streamKeyFilter
    };
  }

  async precreateListeners() {
    console.log("Spinning up any required listeners");
    for (let item of this.playlist) {
      switch (item.source.type) {
        case "srt":
          {
            let port = item.source.config.port;
            let config = item.source.config;
            if (item.source.config.mode == "listener" && !this.srtListeners.has(port)) {
              console.log(`Creating SRT listener on ${port}`)
              let listener = await ListenerNode.create(async ({ onDisconnect }) =>
                this.norsk.input.srt({
                  onConnectionStatusChange: (status, sourceName) => {
                    console.log(`Source disconnected on ${sourceName}`);
                    onDisconnect(sourceName || "");
                  },
                  sourceName: "source",
                  id: `srt-${port}`,
                  ...config
                })
              );
              this.srtListeners.set(port, listener);
            }
            break;
          }
        case "rtmp":
          let port = item.source.config.port;
          let config = item.source.config;
          if (!this.rtmpListeners.has(port)) {
            console.log(`Creating RTMP listener on ${port}`)
            let listener = await ListenerNode.create(async ({ onDisconnect }) =>
              this.norsk.input.rtmpServer({
                onStream: (app, url, streamId, publishingName) => {
                  let sourceName = `${app}/${publishingName}`;
                  return { accept: true, audioStreamKey: { sourceName, renditionName: "default" }, videoStreamKey: { sourceName, renditionName: "default" } };
                },
                onConnectionStatusChange: (status, streamKeys) => {
                  onDisconnect(streamKeys[0].videoStreamKey.sourceName?.sourceName || "");
                },
                id: `rtmp-${port}`,
                ...config
              })
            );
            this.rtmpListeners.set(port, listener);
            break;
          }
        case "rtp":
          console.log("Pre-creating RTP ingest listener not currently supported");
          break;
        case "whip":
          console.log("Pre-creating WHIP ingest listener not currently supported")
          break;
        default:
          break;
      }
    }
  }

}

type PlayingItem = {
  item: PlaylistItem,
  sub?: ReceiveFromAddress<SwitchPins>,
  silenceSub?: ReceiveFromAddress<SwitchPins>,
  ready: boolean,
  index: number,
  duration?: number,
  closeNode: () => void,
}

class ListenerNode<T extends SourceMediaNode> {
  node: undefined | T;
  onDisconnect: Map<string, (sourceName: string) => void> = new Map();

  static async create<T extends SourceMediaNode>(makeNode: (arg: { onDisconnect: (sourceName: string) => void }) => Promise<T>): Promise<ListenerNode<T>> {
    let node = new ListenerNode<T>()
    await node.make(makeNode);
    return node;
  }

  private async make(makeNode: (arg: { onDisconnect: (sourceName: string) => void }) => Promise<T>): Promise<void> {
    let nodeOnDisconnect = (sourceName: string) => {
      for (let [_, fn] of this.onDisconnect.entries()) {
        fn(sourceName);
      }
    };
    this.node = await makeNode({ onDisconnect: nodeOnDisconnect });
  }

}

function isLive(item: PlaylistSource) {
  switch (item.type) {
    case "image":
    case "localMp4File":
    case "localTsFile":
      return false;
    case "rtmp":
    case "rtp":
    case "srt":
    case "whip":
      return true;
  }
}

function nodeKind(item: PlaylistSource) {
  switch (item.type) {
    case "image":
      return "video";
    default:
      return "av";
  }
}

export const avToPin = <Pins extends string>(pin: Pins) => {
  return (streams: StreamMetadata[]): PinToKey<Pins> => {
    const audio = audioStreamKeys(streams).slice(0, 1);
    const video = videoStreamKeys(streams).slice(0, 1);
    const keys = audio.concat(video);
    if (audio.length >= 1 && video.length >= 1) {
      let o: PinToKey<Pins> = {};
      o[pin] = keys;
      return o;
    }
    return undefined;
  };
};
