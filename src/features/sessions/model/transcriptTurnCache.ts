import type { Block } from "./session";
import {
  groupMonoChatTurns,
  groupMonoTurnItems,
  groupTurnItems,
  groupTurns,
  monoTurnRuns,
  type TurnItem,
} from "./transcriptActivity";

/** Reuse unchanged history while immutable updates replace the live blocks. */
export class TranscriptTurnCache {
  private blocks: Block[] | undefined;
  private managed = false;
  private inlineWork = false;
  private turns: Block[][] = [];
  private items = new WeakMap<Block[], Map<string, TurnItem[]>>();

  group(blocks: Block[], managed = false, inlineWork = false): Block[][] {
    if (
      this.blocks === blocks &&
      this.managed === managed &&
      this.inlineWork === inlineWork
    )
      return this.turns;
    const before = this.blocks;
    const tail = blocks[blocks.length - 1];
    const oldTail = before?.[before.length - 1];
    const lastTurn = this.turns[this.turns.length - 1];
    // The common streaming update replaces only the final answer. Keep all
    // historical groups without regrouping and allocating them on every chunk.
    // Structural edits and Mono boundaries still use the full grouping rules.
    if (
      before && before.length === blocks.length &&
      this.managed === managed && this.inlineWork === inlineWork &&
      tail?.role === "assistant" && oldTail?.role === "assistant" &&
      tail.id === oldTail.id && !tail.internal && !oldTail.internal &&
      !tail.monoHabit && !oldTail.monoHabit &&
      lastTurn?.[lastTurn.length - 1] === oldTail &&
      blocks.every((block, index) => index === blocks.length - 1 || block === before[index])
    ) {
      this.blocks = blocks;
      if (tail !== oldTail) {
        this.turns = this.turns.slice();
        this.turns[this.turns.length - 1] = [...lastTurn.slice(0, -1), tail];
      }
      return this.turns;
    }
    const previous = new Map(this.turns.map((turn) => [turn[0].id, turn]));
    const grouped = inlineWork
      ? groupMonoChatTurns(blocks, managed)
      : groupTurns(blocks, managed);
    const next = grouped.map((turn) => {
      const before = previous.get(turn[0].id);
      return before &&
        before.length === turn.length &&
        turn.every((block, index) => block === before[index])
        ? before
        : turn;
    });
    this.blocks = blocks;
    this.managed = managed;
    this.inlineWork = inlineWork;
    if (
      next.length !== this.turns.length ||
      next.some((turn, index) => turn !== this.turns[index])
    )
      this.turns = next;
    return this.turns;
  }

  turnItems(
    turn: Block[],
    settled: boolean,
    {
      managed = false,
      inlineWork = false,
      undeliveredMessageIds,
    }: {
      managed?: boolean;
      inlineWork?: boolean;
      undeliveredMessageIds?: ReadonlySet<string>;
    } = {},
  ): TurnItem[] {
    let variants = this.items.get(turn);
    const undelivered =
      inlineWork && undeliveredMessageIds?.size
        ? turn
            .filter((block) => undeliveredMessageIds?.has(block.id))
            .map((block) => block.id)
        : [];
    const key = JSON.stringify([settled, managed, inlineWork, undelivered]);
    const previous = variants?.get(key);
    if (previous) return previous;
    const visible = (blocks: Block[]) =>
      blocks.filter(
        (block) => !block.orchestration && (managed || !block.internal),
      );
    // Each run in a merged Mono turn folds on its own: an earlier answer is
    // not narration for the work that the next run went on to do.
    const items = inlineWork
      ? monoTurnRuns(turn).flatMap((run, index, runs) =>
          groupMonoTurnItems(visible(run), {
            live: !settled && index === runs.length - 1,
            undeliveredMessageIds,
          }),
        )
      : groupTurnItems(visible(turn), { settled });
    if (!variants) {
      variants = new Map();
      this.items.set(turn, variants);
    }
    variants.set(key, items);
    return items;
  }
}
