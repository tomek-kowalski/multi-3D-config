import { ClampToEdgeWrapping, ImageLoader, LinearMipmapLinearFilter, LinearFilter, NoColorSpace, RepeatWrapping, SRGBColorSpace, Texture } from "three";
import type { TextureBudget, TextureLease, TextureRequest, TextureResources, TextureResourceStats } from "./runtimeContracts";

/**
 * Texture ownership (architecture §3):
 * - decoded source images are shared by URL across every scope (pending loads coalesced), kept while
 *   any texture uses them plus a small bounded idle cache;
 * - a resource scope (one per live canvas, one per photo job) owns configured Three textures keyed by
 *   URL + interpretation + sampler + transform: equal requests in a scope get the same texture object
 *   (one upload, one path-tracer layer), base-colour and data interpretations never share one;
 * - leases are counted; an unused texture stays idle (instant re-selection) until the idle budget or
 *   an explicit trim evicts it. Releases are idempotent.
 */

export type ImageSource = TexImageSource | { width: number; height: number; data?: unknown };
export type ImageLoad = (url: string) => Promise<ImageSource>;

interface SourceEntry {
  promise: Promise<ImageSource>;
  refs: number;
  idleSince: number;
}

export interface SourceCache {
  acquire(url: string): Promise<ImageSource>;
  release(url: string): void;
  readonly size: number;
  clear(): void;
}

/** Decoded images shared by URL; at most `maxIdle` unused ones are kept. */
export function createSourceCache(load: ImageLoad, maxIdle = 24, now: () => number = () => Date.now()): SourceCache {
  const entries = new Map<string, SourceEntry>();
  const evictIdle = () => {
    const idle = [...entries.entries()].filter(([, e]) => e.refs === 0).sort((a, b) => a[1].idleSince - b[1].idleSince);
    while (idle.length > maxIdle) entries.delete(idle.shift()![0]);
  };
  return {
    acquire(url) {
      let entry = entries.get(url);
      if (!entry) {
        entry = { promise: load(url), refs: 0, idleSince: now() };
        entries.set(url, entry);
        // A failed load is forgotten, so a later request retries it.
        entry.promise.catch(() => {
          if (entries.get(url) === entry) entries.delete(url);
        });
      }
      entry.refs++;
      return entry.promise;
    },
    release(url) {
      const entry = entries.get(url);
      if (!entry || entry.refs === 0) return;
      entry.refs--;
      if (entry.refs === 0) {
        entry.idleSince = now();
        evictIdle();
      }
    },
    get size() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
  };
}

const defaultLoader = new ImageLoader();
let sharedSources: SourceCache | null = null;

/** The application-wide decoded image cache (browser image loader). */
export function defaultSourceCache(): SourceCache {
  sharedSources ??= createSourceCache((url) => defaultLoader.loadAsync(url));
  return sharedSources;
}

export function textureRequestKey(r: TextureRequest): string {
  const n = (v: number) => (Math.round(v * 1e6) / 1e6).toString();
  return [r.url, r.colorSpace, r.wrap, n(r.repeat[0]), n(r.repeat[1]), n(r.offset[0]), n(r.offset[1]), n(r.rotationRad), r.flipY ? 1 : 0, r.anisotropy, r.mipmaps ? 1 : 0].join("|");
}

/** RGBA8 residency of one texture (a full mip chain adds a third). */
export function estimateTextureBytes(width: number, height: number, mipmaps: boolean): number {
  return Math.round(width * height * 4 * (mipmaps ? 4 / 3 : 1));
}

interface ScopedTexture {
  readonly key: string;
  readonly url: string;
  readonly texture: Texture;
  readonly ready: Promise<Texture>;
  leases: number;
  bytes: number;
  idleSince: number;
  sourceHeld: boolean;
}

/** The scope was disposed before the image arrived: nothing is applied (not a load failure). */
export class TextureScopeDisposedError extends Error {
  constructor() {
    super("texture scope disposed");
    this.name = "TextureScopeDisposedError";
  }
}

export interface TextureResourceOptions {
  readonly sources?: SourceCache;
  /** Idle (unleased) textures are evicted beyond this many bytes; Infinity keeps all until trim(). */
  readonly idleBudgetBytes?: number;
  /** Residency budget of the scope (quality profile); null/undefined: unbounded. */
  readonly budget?: TextureBudget | null;
  readonly now?: () => number;
}

/** Decoded size of an authored texture's image (0 when unknown). */
function imageSize(texture: Texture): [number, number] {
  const image = texture.image as { width?: number; height?: number } | null | undefined;
  return [image?.width ?? 0, image?.height ?? 0];
}

export function createTextureResources(options: TextureResourceOptions = {}): TextureResources {
  const sources = options.sources ?? defaultSourceCache();
  const budget = options.budget ?? null;
  const idleBudget = Math.min(options.idleBudgetBytes ?? Infinity, budget?.maxIdleBytes ?? Infinity);
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, ScopedTexture>();
  const adopted = new Map<string, { texture: Texture; holders: number; bytes: number }>();
  let generation = 0;

  const evict = (entry: ScopedTexture) => {
    entries.delete(entry.key);
    entry.texture.dispose();
    if (entry.sourceHeld) sources.release(entry.url);
    entry.sourceHeld = false;
  };

  const idleEntries = () => [...entries.values()].filter((e) => e.leases === 0).sort((a, b) => a.idleSince - b.idleSince);
  const sum = (list: Iterable<{ bytes: number }>) => [...list].reduce((total, e) => total + e.bytes, 0);
  const activeBytes = () => sum([...entries.values()].filter((e) => e.leases > 0));
  const adoptedBytes = () => sum(adopted.values());

  const trimIdle = (limit: number) => {
    let idleBytes = sum(idleEntries());
    for (const entry of idleEntries()) {
      if (idleBytes <= limit) break;
      idleBytes -= entry.bytes;
      evict(entry);
    }
  };

  /** Makes room for `bytes` by evicting idle textures (oldest first) when the budget requires it. */
  const makeRoom = (bytes: number) => {
    if (!budget) return;
    const idle = sum(idleEntries());
    const excess = activeBytes() + adoptedBytes() + idle + bytes - budget.maxResidentBytes;
    if (excess > 0) trimIdle(Math.max(0, idle - excess));
  };

  const resources: TextureResources = {
    budget,
    canAfford(bytes: number) {
      return !budget || activeBytes() + adoptedBytes() + bytes <= budget.maxResidentBytes;
    },
    acquire(request: TextureRequest): TextureLease {
      const key = textureRequestKey(request);
      let entry = entries.get(key);
      if (!entry) {
        const estimated = estimateTextureBytes(request.width, request.height, request.mipmaps);
        makeRoom(estimated);
        const texture = new Texture();
        texture.name = request.assetId;
        texture.colorSpace = request.colorSpace === "srgb" ? SRGBColorSpace : NoColorSpace;
        texture.wrapS = texture.wrapT = request.wrap === "repeat" ? RepeatWrapping : ClampToEdgeWrapping;
        texture.repeat.set(request.repeat[0], request.repeat[1]);
        texture.offset.set(request.offset[0], request.offset[1]);
        texture.rotation = request.rotationRad;
        texture.flipY = request.flipY;
        texture.anisotropy = request.anisotropy;
        texture.generateMipmaps = request.mipmaps;
        texture.minFilter = request.mipmaps ? LinearMipmapLinearFilter : LinearFilter;
        texture.magFilter = LinearFilter;
        texture.updateMatrix();
        const created: ScopedTexture = {
          key,
          url: request.url,
          texture,
          leases: 0,
          bytes: estimated,
          idleSince: now(),
          sourceHeld: true,
          ready: Promise.resolve(texture),
        };
        const ready = sources.acquire(request.url).then(
          (image) => {
            // Evicted, or the scope disposed meanwhile: nothing may be applied any more.
            if (entries.get(key) !== created) throw new TextureScopeDisposedError();
            texture.image = image;
            texture.needsUpdate = true;
            const w = (image as { width?: number }).width;
            const h = (image as { height?: number }).height;
            if (w && h) created.bytes = estimateTextureBytes(w, h, request.mipmaps);
            return texture;
          },
          (error) => {
            // Failed: forget this entry (a later request retries) and give the source back. The shared
            // decoded-image load is never cancelled for its other consumers.
            if (entries.get(key) === created) {
              entries.delete(key);
              if (created.sourceHeld) sources.release(request.url);
              created.sourceHeld = false;
            }
            throw error;
          },
        );
        (created as { ready: Promise<Texture> }).ready = ready;
        ready.catch(() => {});
        entries.set(key, created);
        entry = created;
      }
      const held = entry;
      held.leases++;
      let released = false;
      return {
        ready: held.ready,
        release() {
          if (released) return;
          released = true;
          held.leases = Math.max(0, held.leases - 1);
          if (held.leases === 0) {
            held.idleSince = now();
            if (idleBudget !== Infinity) trimIdle(idleBudget);
          }
        },
      };
    },
    adopt(source: Texture) {
      const key = source.uuid;
      let entry = adopted.get(key);
      if (!entry) {
        // Same texture source (decoded pixels shared, never copied); own sampler, transform and upload.
        const copy = source.clone();
        const [w, h] = imageSize(source);
        entry = { texture: copy, holders: 0, bytes: estimateTextureBytes(w, h, source.generateMipmaps) };
        adopted.set(key, entry);
      }
      const held = entry;
      const born = generation;
      held.holders++;
      let released = false;
      return {
        texture: held.texture,
        release() {
          if (released || born !== generation) return;
          released = true;
          held.holders--;
          if (held.holders <= 0 && adopted.get(key) === held) {
            adopted.delete(key);
            held.texture.dispose();
          }
        },
      };
    },
    trim(targetResidentBytes: number) {
      let resident = sum(entries.values()) + adoptedBytes();
      for (const entry of idleEntries()) {
        if (resident <= targetResidentBytes) break;
        resident -= entry.bytes;
        evict(entry);
      }
    },
    stats(): TextureResourceStats {
      const all = [...entries.values()];
      const idle = all.filter((e) => e.leases === 0);
      return {
        textures: all.length,
        activeLeases: all.reduce((total, e) => total + e.leases, 0),
        idleTextures: idle.length,
        residentBytes: sum(all) + adoptedBytes(),
        activeBytes: activeBytes(),
        idleBytes: sum(idle),
        adoptedTextures: adopted.size,
        adoptedBytes: adoptedBytes(),
        sources: sources.size,
      };
    },
    dispose() {
      for (const entry of [...entries.values()]) evict(entry);
      adopted.forEach((e) => e.texture.dispose());
      adopted.clear();
      generation++;
    },
  };
  return resources;
}
