/** A player's name with their emoji avatar in front (the avatar is decoration only). */
export function PlayerName({ name, avatar }: { name: string; avatar?: string | null }) {
  return (
    <span className="player-name">
      {avatar && (
        <span className="avatar" aria-hidden="true">
          {avatar}
        </span>
      )}
      <bdi>{name}</bdi>
    </span>
  );
}
