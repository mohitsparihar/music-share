declare namespace YT {
  const PlayerState: {
    PLAYING: number;
    PAUSED: number;
  };

  type PlayerStateChangeEvent = {
    data: number;
  };

  type VideoData = {
    video_id: string;
    title?: string;
    author?: string;
  };

  type LoadVideoByIdArgs = {
    videoId: string;
    startSeconds?: number;
  };

  type PlaylistArgs = {
    list: string;
    listType: "playlist";
    index?: number;
    startSeconds?: number;
  };

  type PlayerEvents = {
    onReady?: (event: { target: Player }) => void;
    onStateChange?: (event: PlayerStateChangeEvent) => void;
    onError?: (event: { data: number }) => void;
  };

  class Player {
    constructor(
      element: HTMLElement,
      options?: {
        width?: number | string;
        height?: number | string;
        playerVars?: Record<string, unknown>;
        events?: PlayerEvents;
      } & Record<string, unknown>,
    );
    loadVideoById(args: LoadVideoByIdArgs): void;
    cueVideoById(args: LoadVideoByIdArgs): void;
    loadPlaylist(args: PlaylistArgs): void;
    cuePlaylist(args: PlaylistArgs): void;
    playVideo(): void;
    pauseVideo(): void;
    mute(): void;
    unMute(): void;
    isMuted(): boolean;
    seekTo(seconds: number, allowSeekAhead: boolean): void;
    getCurrentTime(): number;
    getDuration(): number;
    getPlaylistIndex(): number;
    getPlayerState(): number;
    getVideoData(): VideoData;
    setPlaybackRate(rate: number): void;
    destroy(): void;
  }
}
