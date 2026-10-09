import type { Config } from "../config";
import { FakeLightning } from "./fake";
import { LndLightning } from "./lnd";
import type { LightningBackend } from "./types";

export function createLightning(config: Config): LightningBackend {
  switch (config.lnBackend) {
    case "fake":
      return new FakeLightning();
    case "lnd":
      return new LndLightning(config.lnd);
    default:
      throw new Error(`Unknown LN_BACKEND "${config.lnBackend}". Use "fake" or "lnd".`);
  }
}

export type { LightningBackend } from "./types";
export { FakeLightning } from "./fake";
