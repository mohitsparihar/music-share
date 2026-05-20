import type { TrackMetadata } from "../../shared/protocol";

type Props = {
  metadata: TrackMetadata | null;
  currentVideoId: string | null;
};

export function NowPlayingCard({ metadata, currentVideoId }: Props) {
  const thumbnail = metadata?.thumbnailUrl
    ?? (currentVideoId ? `https://i.ytimg.com/vi/${currentVideoId}/hqdefault.jpg` : undefined);

  return (
    <div className="now-playing">
      {thumbnail ? <img className="now-playing__thumb" src={thumbnail} alt="" /> : null}
      <div className="now-playing__text">
        <p className="eyebrow">Now playing</p>
        <h3>{metadata?.title ?? "Loading track…"}</h3>
        {metadata?.author ? <p className="meta-line">{metadata.author}</p> : null}
      </div>
    </div>
  );
}
