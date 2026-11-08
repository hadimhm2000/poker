/**
 * A player's name with their emoji avatar in front (the avatar is decoration only). With a
 * `rank` the player's place on the home's leaderboard follows the name as a small "#3" chip.
 */
export function PlayerName({ name, avatar, rank }: { name: string; avatar?: string | null; rank?: string | null }) {
  return (
    <span className="player-name">
      {avatar && (
        <span className="avatar" aria-hidden="true">
          {avatar}
        </span>
      )}
      <bdi>{name}</bdi>
      {rank && <span className="rank-chip num">{rank}</span>}
    </span>
  );
}
