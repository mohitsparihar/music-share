const EMOJI = ["🎶", "🔥", "❤️", "😂", "🙌", "🎉"];

type Props = {
  onSend: (emoji: string) => void;
  disabled?: boolean;
};

export function ReactionDock({ onSend, disabled }: Props) {
  return (
    <div className="reaction-dock">
      {EMOJI.map((emoji) => (
        <button
          key={emoji}
          type="button"
          className="reaction-dock__btn"
          disabled={disabled}
          onClick={() => onSend(emoji)}
          aria-label={`React with ${emoji}`}
        >
          <span className="reaction-dock__emoji" aria-hidden>
            {emoji}
          </span>
        </button>
      ))}
    </div>
  );
}

type FloatingReaction = { id: number; emoji: string; left: number };

type LayerProps = {
  reactions: FloatingReaction[];
};

export function ReactionLayer({ reactions }: LayerProps) {
  return (
    <div className="reaction-layer" aria-hidden>
      {reactions.map((r) => (
        <span
          key={r.id}
          className="reaction-layer__item"
          style={{ left: `${r.left}%` }}
        >
          {r.emoji}
        </span>
      ))}
    </div>
  );
}
