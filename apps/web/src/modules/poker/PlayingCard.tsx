import type { Card, Rank, Suit } from "@llm-table/poker";

const SUIT_SYMBOL: Record<Suit, string> = {
  h: "♥",
  d: "♦",
  c: "♣",
  s: "♠",
};

const RANK_LABEL: Record<Rank, string> = {
  "2": "2",
  "3": "3",
  "4": "4",
  "5": "5",
  "6": "6",
  "7": "7",
  "8": "8",
  "9": "9",
  T: "10",
  J: "J",
  Q: "Q",
  K: "K",
  A: "A",
};

export type PlayingCardSize = "sm" | "md" | "lg";

export interface PlayingCardProps {
  card?: Card;
  faceDown?: boolean;
  size?: PlayingCardSize;
  className?: string;
}

export function PlayingCard({
  card,
  faceDown = false,
  size = "md",
  className,
}: PlayingCardProps) {
  const classes = [
    "pcard",
    `pcard-${size}`,
    faceDown || !card ? "pcard-back" : "pcard-face",
    card && (card.suit === "h" || card.suit === "d") ? "pcard-red" : "pcard-black",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  if (faceDown || !card) {
    return (
      <div className={classes} aria-label="Face-down card">
        <div className="pcard-back-inner">
          <div className="pcard-back-pattern" />
        </div>
      </div>
    );
  }

  const rank = RANK_LABEL[card.rank];
  const suit = SUIT_SYMBOL[card.suit];

  return (
    <div className={classes} aria-label={`${rank} of ${card.suit}`}>
      <div className="pcard-corner pcard-corner-tl">
        <span className="pcard-rank">{rank}</span>
        <span className="pcard-suit">{suit}</span>
      </div>
      <div className="pcard-center" aria-hidden="true">
        {suit}
      </div>
      <div className="pcard-corner pcard-corner-br">
        <span className="pcard-rank">{rank}</span>
        <span className="pcard-suit">{suit}</span>
      </div>
    </div>
  );
}
