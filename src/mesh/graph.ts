// Pure graph helpers for the mesh-topology view. No React/BLE imports here
// on purpose — this is plain data in, plain data out, so it's easy to
// reason about (and test) independently of how the graph state gets built.

export type MeshNode = {
  nodeId: string;
  nickname?: string;
  color?: string;
  /** nodeIds this node was last known to be directly connected to. */
  neighbors: string[];
  /** 0 = you, or a peer directly connected to you right now. */
  hopsAway: number;
  lastAnnounceTs: number;
  isDirect: boolean;
  rssi?: number;
};

export type MeshEdge = {
  a: string;
  b: string;
  /** true only if BOTH ends currently declare the other as a neighbor.
   *  Links are eventually consistent — right after a connection comes up,
   *  one side's announce can arrive before the other's, so a "declared by
   *  only one side" edge is expected and shown, just visually distinct. */
  confirmed: boolean;
};

/** One edge per unique unordered pair that at least one side declares.
 *  Neighbor ids that don't correspond to a known node (haven't heard
 *  that node's own announce yet) are dropped rather than fabricating a
 *  placeholder node — that's normal, transient eventual-consistency,
 *  not an error. */
export function computeMeshEdges(nodes: MeshNode[]): MeshEdge[] {
  const knownIds = new Set(nodes.map((n) => n.nodeId));
  const declaresMap = new Map<string, Set<string>>();
  nodes.forEach((n) => declaresMap.set(n.nodeId, new Set(n.neighbors.filter((id) => knownIds.has(id)))));

  const seenPairs = new Set<string>();
  const edges: MeshEdge[] = [];

  nodes.forEach((n) => {
    (declaresMap.get(n.nodeId) ?? new Set()).forEach((neighborId) => {
      const key = [n.nodeId, neighborId].sort().join('|');
      if (seenPairs.has(key)) return;
      seenPairs.add(key);
      const aDeclares = declaresMap.get(n.nodeId)?.has(neighborId) ?? false;
      const bDeclares = declaresMap.get(neighborId)?.has(n.nodeId) ?? false;
      edges.push({ a: n.nodeId, b: neighborId, confirmed: aDeclares && bDeclares });
    });
  });

  return edges;
}

/** Tarjan's articulation-points algorithm: nodeIds whose removal would
 *  split the graph into more connected components than it currently has
 *  — i.e. the sole bridge holding two parts of the mesh together. Runs
 *  over every known edge (confirmed or not) since even an unconfirmed
 *  edge is real evidence of a link, just not yet mutually acknowledged. */
export function findArticulationPoints(nodeIds: string[], edges: MeshEdge[]): Set<string> {
  const adjacency = new Map<string, string[]>();
  nodeIds.forEach((id) => adjacency.set(id, []));
  edges.forEach(({ a, b }) => {
    adjacency.get(a)?.push(b);
    adjacency.get(b)?.push(a);
  });

  const visited = new Set<string>();
  const discovery = new Map<string, number>();
  const low = new Map<string, number>();
  const parent = new Map<string, string | null>();
  const articulationPoints = new Set<string>();
  let timer = 0;

  function dfs(start: string) {
    // Iterative DFS to avoid recursion-depth concerns on larger meshes;
    // mirrors the standard recursive Tarjan's bridge-finding algorithm.
    const stack: { node: string; iter: Iterator<string> }[] = [];
    parent.set(start, null);
    visited.add(start);
    discovery.set(start, timer);
    low.set(start, timer);
    timer++;
    stack.push({ node: start, iter: (adjacency.get(start) ?? [])[Symbol.iterator]() });
    let rootChildren = 0;

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const next = frame.iter.next();

      if (!next.done) {
        const v = next.value;
        if (!visited.has(v)) {
          visited.add(v);
          parent.set(v, frame.node);
          discovery.set(v, timer);
          low.set(v, timer);
          timer++;
          if (frame.node === start) rootChildren++;
          stack.push({ node: v, iter: (adjacency.get(v) ?? [])[Symbol.iterator]() });
        } else if (v !== parent.get(frame.node)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, discovery.get(v)!));
        }
      } else {
        stack.pop();
        const above = stack[stack.length - 1];
        if (above) {
          low.set(above.node, Math.min(low.get(above.node)!, low.get(frame.node)!));
          const isRoot = above.node === start;
          if (!isRoot && low.get(frame.node)! >= discovery.get(above.node)!) {
            articulationPoints.add(above.node);
          }
        }
      }
    }

    if (rootChildren > 1) articulationPoints.add(start);
  }

  nodeIds.forEach((id) => {
    if (!visited.has(id)) dfs(id);
  });

  return articulationPoints;
}
