import {
  AnywayNodeId,
  Link,
  MessagePriority,
  MetricReading,
  Route,
  RouteHop,
} from './model';

const MIN_LINK_SCORE = 0.01;
const MAX_SEARCH_EXPANSIONS = 512;

export interface RouteMessageProfile {
  priority: MessagePriority;
  sizeBytes: number;
  prefersLowLatency?: boolean;
  prefersHighThroughput?: boolean;
  /** Battery saver/SOS policy: prefer cheap ready links without disabling failover. */
  prefersLowEnergy?: boolean;
}

export interface LinkScoreBreakdown {
  availability: number;
  reliability: number;
  stability: number;
  signal: number;
  latency: number;
  throughput: number;
  energy: number;
  congestion: number;
  freshness: number;
  total: number;
  cost: number;
}

interface ScoreWeights {
  reliability: number;
  stability: number;
  signal: number;
  latency: number;
  throughput: number;
  energy: number;
  congestion: number;
  freshness: number;
}

const WEIGHTS: Record<MessagePriority, ScoreWeights> = {
  normal: {
    reliability: 0.22,
    stability: 0.16,
    signal: 0.1,
    latency: 0.1,
    throughput: 0.1,
    energy: 0.14,
    congestion: 0.1,
    freshness: 0.08,
  },
  important: {
    reliability: 0.3,
    stability: 0.2,
    signal: 0.1,
    latency: 0.12,
    throughput: 0.08,
    energy: 0.06,
    congestion: 0.08,
    freshness: 0.06,
  },
  sos: {
    reliability: 0.3,
    stability: 0.18,
    signal: 0.08,
    latency: 0.05,
    throughput: 0.02,
    energy: 0.25,
    congestion: 0.06,
    freshness: 0.06,
  },
};

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function reading(
  metric: MetricReading | undefined,
  normalize: (value: number) => number,
  unknownValue: number,
): number {
  if (metric?.value === undefined || metric.provenance === 'unknown') return unknownValue;
  const confidence = metric.provenance === 'measured' ? 1 : 0.75;
  return clamp(normalize(metric.value) * confidence + unknownValue * (1 - confidence));
}

function activeAvailability(link: Link): number {
  if (link.state === 'active') return 1;
  if (link.state === 'degraded') return 0.55;
  return 0;
}

/** Dynamic per-message link score; no transport receives a fixed priority. */
export function scoreLink(
  link: Link,
  profile: RouteMessageProfile,
  now = Date.now(),
): LinkScoreBreakdown {
  const availability = activeAvailability(link);
  const success = reading(link.metrics.successRatio, (value) => value, 0.65);
  const loss = reading(link.metrics.packetLossRatio, (value) => 1 - value, 0.65);
  const reliability = clamp((success + loss) / 2);
  const stability = reading(link.metrics.stabilityRatio, (value) => value, 0.6);
  const signal = reading(link.metrics.rssiDbm, (value) => (value + 105) / 65, 0.55);
  const latency = reading(
    link.metrics.latencyMs,
    (value) => 1 / (1 + Math.max(0, value) / 250),
    0.55,
  );
  const throughput = reading(
    link.metrics.throughputBytesPerSecond,
    (value) => Math.log10(Math.max(1, value)) / 7,
    0.5,
  );
  const energy = reading(link.metrics.energyCost, (value) => 1 - value, 0.55);
  const congestion = reading(link.metrics.congestionRatio, (value) => 1 - value, 0.65);
  const ageMs = Math.max(0, now - (link.lastActivityAt ?? link.lastStateChangeAt));
  const freshness = clamp(1 / (1 + ageMs / 60_000), 0.2, 1);

  const weights = { ...WEIGHTS[profile.priority] };
  if (profile.prefersLowLatency) weights.latency += 0.08;
  if (profile.prefersLowEnergy) weights.energy += 0.18;
  if (profile.prefersHighThroughput || profile.sizeBytes > 64 * 1024) {
    weights.throughput += 0.1;
  }
  const weightTotal = Object.values(weights).reduce((sum, value) => sum + value, 0);
  const weighted =
    (reliability * weights.reliability +
      stability * weights.stability +
      signal * weights.signal +
      latency * weights.latency +
      throughput * weights.throughput +
      energy * weights.energy +
      congestion * weights.congestion +
      freshness * weights.freshness) /
    weightTotal;
  const total = clamp(weighted * availability, MIN_LINK_SCORE, 1);

  return {
    availability,
    reliability,
    stability,
    signal,
    latency,
    throughput,
    energy,
    congestion,
    freshness,
    total,
    cost: -Math.log(total),
  };
}

interface DirectedEdge {
  link: Link;
  from: AnywayNodeId;
  to: AnywayNodeId;
}

interface SearchState {
  node: AnywayNodeId;
  visited: AnywayNodeId[];
  hops: RouteHop[];
  cost: number;
  reliability: number;
  latencyMs?: number;
  throughputBytesPerSecond?: number;
  energyCost: number;
}

export interface RouteSearchOptions {
  maxHops?: number;
  maxCandidates?: number;
  now?: number;
}

export interface RouteSelection {
  primary?: Route;
  /** Routes to transmit concurrently. More than one is reserved for SOS. */
  selected: Route[];
  /** Ranked failover paths, not sent concurrently for non-SOS traffic. */
  alternatives: Route[];
  candidates: Route[];
  multipath: boolean;
}

function directedEdges(links: readonly Link[]): DirectedEdge[] {
  const result: DirectedEdge[] = [];
  for (const link of links) {
    if (activeAvailability(link) === 0) continue;
    result.push({ link, from: link.from, to: link.to });
    if (link.direction === 'duplex') {
      result.push({ link, from: link.to, to: link.from });
    }
  }
  return result;
}

function addOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined || right === undefined) return undefined;
  return left + right;
}

function minOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function routeFromState(
  state: SearchState,
  source: AnywayNodeId,
  destination: AnywayNodeId,
  computedAt: number,
): Route {
  const fingerprint = state.hops
    .map((hop) => `${hop.from}>${hop.to}@${hop.linkId}`)
    .join('|');
  return {
    id: `${source}>${destination}:${fingerprint}`,
    source,
    destination,
    hops: state.hops,
    score: clamp(Math.exp(-state.cost)),
    metrics: {
      reliability: clamp(state.reliability),
      estimatedLatencyMs: state.latencyMs,
      bottleneckThroughputBytesPerSecond: state.throughputBytesPerSecond,
      normalizedEnergyCost: clamp(state.energyCost),
      hopCount: state.hops.length,
    },
    computedAt,
  };
}

/** Bounded best-first search that preserves parallel links between two nodes. */
export function findRoutes(
  source: AnywayNodeId,
  destination: AnywayNodeId,
  links: readonly Link[],
  profile: RouteMessageProfile,
  options: RouteSearchOptions = {},
): Route[] {
  if (source === destination) return [];
  const now = options.now ?? Date.now();
  const maxHops = Math.max(1, Math.min(options.maxHops ?? 8, 16));
  const maxCandidates = Math.max(1, Math.min(options.maxCandidates ?? 8, 32));
  const adjacency = new Map<AnywayNodeId, DirectedEdge[]>();
  for (const edge of directedEdges(links)) {
    const current = adjacency.get(edge.from) ?? [];
    current.push(edge);
    adjacency.set(edge.from, current);
  }

  const queue: SearchState[] = [
    {
      node: source,
      visited: [source],
      hops: [],
      cost: 0,
      reliability: 1,
      latencyMs: 0,
      energyCost: 0,
    },
  ];
  const routes: Route[] = [];
  const fingerprints = new Set<string>();
  let expansions = 0;

  while (
    queue.length > 0 &&
    routes.length < maxCandidates &&
    expansions < MAX_SEARCH_EXPANSIONS
  ) {
    queue.sort((left, right) => left.cost - right.cost);
    const state = queue.shift();
    if (!state) break;
    if (state.node === destination) {
      const route = routeFromState(state, source, destination, now);
      const fingerprint = route.hops.map((hop) => `${hop.linkId}:${hop.to}`).join('|');
      if (!fingerprints.has(fingerprint)) {
        fingerprints.add(fingerprint);
        routes.push(route);
      }
      continue;
    }
    if (state.hops.length >= maxHops) continue;

    for (const edge of adjacency.get(state.node) ?? []) {
      if (state.visited.includes(edge.to)) continue;
      expansions += 1;
      const scored = scoreLink(edge.link, profile, now);
      if (scored.availability === 0) continue;
      const latencyValue = edge.link.metrics.latencyMs?.value;
      const throughputValue = edge.link.metrics.throughputBytesPerSecond?.value;
      const energyValue = edge.link.metrics.energyCost?.value;
      const hopPenalty = profile.priority === 'sos' ? 0.08 : 0.14;
      queue.push({
        node: edge.to,
        visited: [...state.visited, edge.to],
        hops: [
          ...state.hops,
          {
            from: edge.from,
            to: edge.to,
            linkId: edge.link.id,
            transportId: edge.link.transportId,
            transportKind: edge.link.transportKind,
            linkScore: scored.total,
          },
        ],
        cost: state.cost + scored.cost + hopPenalty,
        reliability: state.reliability * scored.reliability * scored.stability,
        latencyMs: addOptional(state.latencyMs, latencyValue),
        throughputBytesPerSecond: minOptional(
          state.throughputBytesPerSecond,
          throughputValue,
        ),
        energyCost: state.energyCost + (energyValue ?? 0.5) / maxHops,
      });
      if (expansions >= MAX_SEARCH_EXPANSIONS) break;
    }
  }

  return routes.sort((left, right) => right.score - left.score);
}

function sharesLink(left: Route, right: Route): boolean {
  const links = new Set(left.hops.map((hop) => hop.linkId));
  return right.hops.some((hop) => links.has(hop.linkId));
}

/**
 * Normal/important messages use one route with ranked fallback. SOS may use up
 * to three preferably link-disjoint paths, relying on message-id deduplication.
 */
export function selectRoutes(
  source: AnywayNodeId,
  destination: AnywayNodeId,
  links: readonly Link[],
  profile: RouteMessageProfile,
  options: RouteSearchOptions & { maxSosPaths?: number } = {},
): RouteSelection {
  const candidates = findRoutes(source, destination, links, profile, options);
  const primary = candidates[0];
  if (!primary) {
    return { selected: [], alternatives: [], candidates: [], multipath: false };
  }

  if (profile.priority !== 'sos') {
    return {
      primary,
      selected: [primary],
      alternatives: candidates.slice(1),
      candidates,
      multipath: false,
    };
  }

  const maxSosPaths = Math.max(1, Math.min(options.maxSosPaths ?? 3, 4));
  const selected: Route[] = [primary];
  const deferred: Route[] = [];
  for (const candidate of candidates.slice(1)) {
    const firstHopAlreadyUsed = selected.some(
      (route) => route.hops[0]?.to === candidate.hops[0]?.to,
    );
    const overlaps = selected.some((route) => sharesLink(route, candidate));
    if (!firstHopAlreadyUsed && !overlaps && selected.length < maxSosPaths) {
      selected.push(candidate);
    } else {
      deferred.push(candidate);
    }
  }
  if (selected.length < maxSosPaths) {
    for (const candidate of deferred) {
      if (selected.length >= maxSosPaths) break;
      if (!selected.some((route) => route.hops[0]?.to === candidate.hops[0]?.to)) {
        selected.push(candidate);
      }
    }
  }

  const selectedIds = new Set(selected.map((route) => route.id));
  return {
    primary,
    selected,
    alternatives: candidates.filter((route) => !selectedIds.has(route.id)),
    candidates,
    multipath: selected.length > 1,
  };
}

export interface OpportunisticRelayCandidate {
  nodeId: AnywayNodeId;
  link: Link;
  score: number;
}

/**
 * DTN fallback when no end-to-end route exists. The message store can offer a
 * bounded number of fresh neighbors; SOS gets controlled replication.
 */
export function selectOpportunisticRelays(
  localNodeId: AnywayNodeId,
  links: readonly Link[],
  profile: RouteMessageProfile,
  excludedNodes: ReadonlySet<AnywayNodeId>,
  now = Date.now(),
): OpportunisticRelayCandidate[] {
  const bestByNode = new Map<AnywayNodeId, OpportunisticRelayCandidate>();
  for (const edge of directedEdges(links)) {
    if (edge.from !== localNodeId || excludedNodes.has(edge.to)) continue;
    const score = scoreLink(edge.link, profile, now).total;
    const previous = bestByNode.get(edge.to);
    if (!previous || score > previous.score) {
      bestByNode.set(edge.to, { nodeId: edge.to, link: edge.link, score });
    }
  }
  const limit = profile.priority === 'sos' ? 3 : 1;
  return [...bestByNode.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}
