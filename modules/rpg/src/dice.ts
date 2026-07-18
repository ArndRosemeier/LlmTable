/** Inclusive integer roll in [1, sides]. */
export function rollDie(sides: number): number {
  if (!Number.isInteger(sides) || sides < 2) {
    throw new Error(`Invalid die sides: ${sides}`);
  }
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return (buffer[0]! % sides) + 1;
}

export function rollD20(): number {
  return rollDie(20);
}
