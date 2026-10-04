import type { GardenSnapshot } from '../core/models';
export interface GardenRepository { load(): GardenSnapshot; save(snapshot: GardenSnapshot): void; }
