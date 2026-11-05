// Adapter registry: source type -> fetch(config) => RawJob[].
// Single backbone: hiring.cafe (always) + Craigslist & SimplyHired (the "Local" tier). The former
// aggregator adapters (RSS / public APIs / RefereeAI / scrape) were removed — hiring.cafe covers them.
import type { RawJob, SourceConfig } from "../types.ts";
import { craigslistAdapter } from "./craigslist.ts";
import { hiringCafeAdapter, hiringCafeOrgAdapter } from "./hiringcafe.ts";
import { simplyHiredAdapter } from "./simplyhired.ts";
import { atsAdapter } from "./ats.ts";
import { remoteBoardsAdapter } from "./remoteBoards.ts";

type Adapter = (cfg: SourceConfig) => Promise<RawJob[]>;

const registry: Record<string, Adapter> = {
  hiringcafe: hiringCafeAdapter,
  hcorg: hiringCafeOrgAdapter,
  craigslist: craigslistAdapter,
  simplyhired: simplyHiredAdapter,
  ats: atsAdapter,               // direct Greenhouse/Lever/Ashby boards (free public JSON)
  remoteboards: remoteBoardsAdapter, // opt-in RemoteOK + WeWorkRemotely feeds
};

export function getAdapter(type: string): Adapter | undefined {
  return registry[type];
}

export const SUPPORTED_TYPES = Object.keys(registry);
