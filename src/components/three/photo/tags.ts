import type { WallId } from "@/domain/room/types";

/**
 * What a mesh of the live scene represents, for the photorealistic renderer. The photo scene is built
 * from tagged meshes only (a whitelist), so editing aids — outlines, selection and collision volumes,
 * docking ghosts, highlights, labels — can never appear in a photo, whatever their visibility is.
 *
 * - board: a furniture panel (cabinet panels; bed body and front with their decor);
 * - metal: handles, bed hardware; dark: the dark plate of a recessed grip;
 * - fabric: a mattress; wall / floor: the room; frame, glass, sill, leaf, handle: window and door parts;
 * - loading: the placeholder of a model that is still loading (the photo waits for it);
 * - exterior: the daytime view behind a window, created by the photo scene itself (never tagged in the
 *   live scene).
 */
export type PhotoRole =
  | "board"
  | "metal"
  | "dark"
  | "fabric"
  | "wall"
  | "floor"
  | "frame"
  | "glass"
  | "sill"
  | "leaf"
  | "handle"
  | "loading"
  | "exterior";

export interface PhotoTag {
  readonly role: PhotoRole;
  /** Wall the mesh belongs to (walls and their openings), so it can be hidden for a camera behind it. */
  readonly wall?: WallId;
}

/** `userData` for a tagged mesh. */
export function photoTag(role: PhotoRole, wall?: WallId): { photo: PhotoTag } {
  return { photo: wall ? { role, wall } : { role } };
}

export function readPhotoTag(userData: Record<string, unknown> | undefined): PhotoTag | null {
  const tag = userData?.photo as PhotoTag | undefined;
  return tag && typeof tag.role === "string" ? tag : null;
}
