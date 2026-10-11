/**
 * The words the game shows: piece type names and the messages the engine sends, keyed by
 * the original's STR resource numbers. The wording is this port's own.
 */
import type { Message } from "../../engine/src/host.ts";

/** Type names by STR number (the engine's typeStrId()). */
export const TYPE_NAMES: Record<number, string> = {
  1: "Army", 2: "Fighter", 3: "Destroyer", 4: "Submarine", 5: "Transport", 6: "Carrier",
  7: "Battleship", 8: "Bomber",
};

/** Type names by piece type number. */
export const PIECE_NAMES = ["Army", "Fighter", "Destroyer", "Submarine", "Carrier", "Transport", "Battleship", "Bomber"];
/** One-letter map symbols by piece type number. */
export const PIECE_LETTERS = ["A", "F", "D", "S", "C", "T", "B", "b"];

const MESSAGES: Record<number, string> = {
  1003: "That move would cost you the ^0.",
  1004: "The Army drowned.",
  1006: "Your ^0 was lost attacking your own city.",
  1007: "You can't move off the edge of the map.",
  1012: "Your ^0 was lost.",
  1013: "",
  1015: "A Fighter ran out of fuel and crashed.",
  1016: "City captured.",
  1018: "That ship is full.",
  1019: "The ^0 couldn't get aboard and was lost.",
  1021: "Day ^0",
  1032: "The attack on the city failed. The Army was destroyed.",
  1033: "That would attack your own ^0.",
  1034: "An Army can't attack from a ship at sea. The Army was lost.",
  1036: "The enemy took one of your cities.",
  1037: "Your city drove off an attack.",
  1042: "A Bomber ran out of fuel and crashed.",
  1043: "The way to the destination is blocked.",
};

/** Messages whose ^0 is a type name (the STR number of the name), from messageB(). */
const NAMED = new Set([1003, 1006, 1012, 1019, 1033]);

/** A message's text, with ^0 (a type name or a number) and ^1 (a number) filled in. */
export function messageText(msg: Message): string {
  const template = MESSAGES[msg.id] ?? `Message ${msg.id}`;
  const s0 = NAMED.has(msg.id) ? (TYPE_NAMES[msg.subst1] ?? `type ${msg.subst1}`) : String(msg.subst1);
  return template.replace("^0", s0).replace("^1", String(msg.subst2));
}
