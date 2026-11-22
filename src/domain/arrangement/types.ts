import type { ModuleInstance } from "../modules/types";
import type { RoomConfiguration } from "../room/types";

/** The complete design: the reference room and every placed module, each fully independent. */
export interface Arrangement {
  readonly room: RoomConfiguration;
  readonly modules: readonly ModuleInstance[];
}

export type Side = "left" | "right";
