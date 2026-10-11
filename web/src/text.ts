/**
 * The words the game shows. They come from the owner's copy of the game (its STR resources,
 * extracted with the artwork); messages use the original's numbering and substitutions.
 */
import type { Message } from "../../engine/src/host.ts";
import { pCargo, pStrength, pType } from "../../engine/src/piece.ts";
import { Mem } from "../../engine/src/mem.ts";

/** Type names by piece type number (the STR numbers are typeStrId()). */
const TYPE_STR = [1, 2, 3, 4, 6, 5, 7, 8];

/** Messages whose ^0 is a type name (the STR number of the name), from messageB(). */
const NAMED = new Set([1003, 1006, 1012, 1019, 1033]);

export class Words {
  private readonly strings: Record<string, string>;

  constructor(strings: Record<string, string>) {
    this.strings = strings;
  }

  str(id: number): string {
    return this.strings[id] ?? "";
  }

  /** Fill in ^0, ^1, ... in order. */
  format(id: number, ...subst: (string | number)[]): string {
    return this.str(id).replace(/\^(\d)/g, (_s, d: string) => String(subst[Number(d)] ?? ""));
  }

  typeName(type: number): string {
    return this.str(TYPE_STR[type] ?? 9);
  }

  /** A message's text: ^0 is a type name or a number, ^1 a number. */
  message(msg: Message): string {
    const s0 = NAMED.has(msg.id) ? this.str(msg.subst1) : msg.subst1;
    return this.format(msg.id, s0, msg.subst2);
  }

  /**
   * Message line 1 for the piece being moved (the human controller, CODE 5 + 0x5522):
   * moves left and strength, with fuel for aircraft and the load of Carriers and Transports.
   */
  pieceStatus(m: Mem, p: number, moves: number): string {
    const type = pType(m, p), s = pStrength(m, p);
    if (type === 1 || type === 7) return this.format(1017, moves, s, pCargo(m, p));
    if (type === 4) return this.format(1020, moves, s, pCargo(m, p), this.typeName(1));
    if (type === 5) return this.format(1020, moves, s, pCargo(m, p), this.typeName(0));
    return this.format(1008, moves, s);
  }
}
