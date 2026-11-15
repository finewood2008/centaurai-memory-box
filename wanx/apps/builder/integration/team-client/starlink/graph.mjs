// Presentation only: entity names, facts and source evidence remain unchanged.
export function graphVisibility(graph, showIsolated = false) {
  const ids = new Set(graph.nodes.map(n => n.id));
  const edges = graph.edges.filter(e => ids.has(e.s) && ids.has(e.t));
  const connected = new Set(edges.flatMap(e => [e.s, e.t]));
  const isolatedCount = graph.nodes.filter(n => !connected.has(n.id)).length;
  return {nodes: showIsolated ? graph.nodes : graph.nodes.filter(n => connected.has(n.id)), edges, isolatedCount};
}

export function referenceNodes(graph) {
  const names = new Set();
  for (const e of graph.edges) for (const v of e.evidence || [])
    for (const match of (v.excerpt || "").matchAll(/(?:^|[\s>*#-])([CJ]\d{2,3})[*\s]*[｜|]/gim))
      names.add(match[1].toUpperCase());
  return new Set(graph.nodes.filter(n => names.has(n.name.toUpperCase())).map(n => n.id));
}

export function selectGraph(graph, { query = "", type = "all", overview = true, focus = null, members = null } = {}) {
  const references = referenceNodes(graph);
  const needle = query.trim().toLocaleLowerCase();
  let nodes = graph.nodes.filter(n => (!members || members.has(n.id)) && (type === "all" || n.type === type) &&
    (needle || !overview || !references.has(n.id) || n.id === focus));
  if (needle) {
    const matches = new Set(nodes.filter(n => n.name.toLocaleLowerCase().includes(needle)).map(n => n.id));
    const neighbors = new Set(matches);
    graph.edges.forEach(e => {
      if (matches.has(e.s)) neighbors.add(e.t);
      if (matches.has(e.t)) neighbors.add(e.s);
    });
    nodes = nodes.filter(n => neighbors.has(n.id));
  }
  if (focus) {
    const neighbors = new Set([focus]);
    graph.edges.forEach(e => {
      if (e.s === focus) neighbors.add(e.t);
      if (e.t === focus) neighbors.add(e.s);
    });
    nodes = nodes.filter(n => neighbors.has(n.id));
  }
  const ids = new Set(nodes.map(n => n.id));
  return { nodes, edges: graph.edges.filter(e => ids.has(e.s) && ids.has(e.t) && (!focus || e.s === focus || e.t === focus)), referenceCount: references.size };
}

export function describeConstellations(graph) {
  const nodes = [...graph.nodes].sort((a,b) => a.id.localeCompare(b.id));
  const metrics = new Map(nodes.map(n => [n.id, { relations: 0, documents: new Set() }]));
  const references = referenceNodes(graph);
  const groups = new Map(nodes.filter(n => !references.has(n.id)).map(n => [n.id, { members: [n], weight: 0, links: new Map() }]));
  const paused = new Set(nodes.filter(n => n.paused).map(n => n.id));
  const seen = new Set();
  let totalWeight = 0;
  for (const edge of graph.edges) {
    if (seen.has(edge.id) || edge.paused || paused.has(edge.s) || paused.has(edge.t) ||
        !metrics.has(edge.s) || !metrics.has(edge.t)) continue;
    const documents = edge.evidence.map(e => e?.document_id).filter(Boolean);
    if (!documents.length) continue;
    seen.add(edge.id);
    for (const id of new Set([edge.s, edge.t])) {
      const metric = metrics.get(id);
      metric.relations++;
      documents.forEach(doc => metric.documents.add(doc));
    }
    if (edge.s === edge.t || !groups.has(edge.s) || !groups.has(edge.t)) continue;
    for (const [a,b] of [[edge.s,edge.t],[edge.t,edge.s]]) {
      const group = groups.get(a);
      group.links.set(b, (group.links.get(b) || 0) + 1);
      group.weight++;
    }
    totalWeight += 2;
  }
  // Merge adjacent groups only when their ties are stronger than expected from their degree.
  for (;;) {
    let best = 0, merge;
    for (const [id, group] of groups) {
      for (const otherId of [...group.links.keys()].sort()) {
        if (id.localeCompare(otherId) >= 0) continue;
        const gain = group.links.get(otherId) - group.weight * groups.get(otherId).weight / totalWeight;
        if (gain > best + 1e-8) { best = gain; merge = [id, otherId]; }
      }
    }
    if (!merge) break;
    const [a,b] = merge;
    const group = groups.get(a), other = groups.get(b);
    group.members.push(...other.members);
    group.weight += other.weight;
    group.links.delete(b);
    for (const [id,count] of other.links) {
      if (id === a) continue;
      const peer = groups.get(id);
      const combined = (group.links.get(id) || 0) + count;
      group.links.set(id, combined);
      peer.links.delete(b);
      peer.links.set(a, combined);
    }
    groups.delete(b);
  }
  const constellations = [];
  const loose = [];
  for (const [id, {members}] of groups) {
    if (members.length === 1) { loose.push(members[0].id); continue; }
    members.sort((a,b) => metrics.get(b.id).relations - metrics.get(a.id).relations || a.id.localeCompare(b.id));
    constellations.push({ id: 'group-' + id, name: members[0].name, members: new Set(members.map(n => n.id)) });
  }
  constellations.sort((a,b) => b.members.size - a.members.size || a.id.localeCompare(b.id));
  const names = new Map();
  for (const group of constellations) {
    const number = (names.get(group.name) || 0) + 1;
    names.set(group.name, number);
    if (number > 1) group.name += ' ' + number;
  }
  if (loose.length && constellations.length) constellations.push({ id: 'ungrouped', name: '未归组实体', members: new Set(loose) });
  const membership = new Map(constellations.flatMap(group => [...group.members].map(id => [id, group.id])));
  const counts = new Map([...metrics].map(([id,value]) => [id, {relations:value.relations, sources:value.documents.size}]));
  const maxima = {
    relations: Math.max(1, ...[...counts.values()].map(m => m.relations)),
    sources: Math.max(1, ...[...counts.values()].map(m => m.sources)),
  };
  return {constellations, membership, counts, maxima};
}

export function layoutConstellations(graph, constellations) {
  if (constellations.length < 2) return layoutGraph(graph);
  const islands = constellations.map(group => {
    const layout = layoutGraph({
      nodes: graph.nodes.filter(n => group.members.has(n.id)),
      edges: graph.edges.filter(e => group.members.has(e.s) && group.members.has(e.t)),
    });
    const left = Math.min(...layout.nodes.map(n => n.x - Math.max(n.labelWidth / 2,n.r)));
    const top = Math.min(...layout.nodes.map(n => n.y - n.r));
    const width = Math.max(140, Math.max(...layout.nodes.map(n => n.x + Math.max(n.labelWidth / 2,n.r))) - left + 24);
    const height = Math.max(104, Math.max(...layout.nodes.map(n => n.y + n.r + n.lines.length * 15)) - top + 70);
    return {group, nodes:layout.nodes, left, top, width, height};
  });
  const rowWidth = Math.max(...islands.map(g => g.width), Math.sqrt(islands.reduce((sum,g) => sum+g.width*g.height,0) * 2.4));
  let x = 0, y = 0, rowHeight = 0;
  const anchors = [];
  const nodes = [];
  for (const island of islands) {
    if (x && x + island.width > rowWidth) { x = 0; y += rowHeight + 26; rowHeight = 0; }
    const {group, left, top, width, height} = island;
    anchors.push({...group, x:x + width / 2, y:y + 3, z:0});
    nodes.push(...island.nodes.map(n => ({...n, x:n.x-left+x+12, y:n.y-top+y+36, constellation:group.id})));
    x += width + 58;
    rowHeight = Math.max(rowHeight,height);
  }
  return {...graph, nodes:nodes.sort((a,b) => b.degree-a.degree || a.id.localeCompare(b.id)), anchors};
}

export function labelLines(name) {
  const lines = [""];
  let width = 0;
  for (const char of String(name)) {
    const size = /[\u0000-\u007f]/.test(char) ? 0.6 : 1;
    if (width + size > 10) {
      if (lines.length === 2) { lines[1] += "…"; break; }
      lines.push(""); width = 0;
    }
    lines[lines.length - 1] += char; width += size;
  }
  return lines;
}

export function layoutGraph(graph) {
  const degree = new Map(graph.nodes.map(n => [n.id, 0]));
  graph.edges.forEach(e => {
    if (e.s !== e.t) {
      degree.set(e.s, (degree.get(e.s) || 0) + 1);
      degree.set(e.t, (degree.get(e.t) || 0) + 1);
    }
  });
  const nodes = graph.nodes.map(n => ({ ...n, degree: degree.get(n.id), lines: labelLines(n.name) }))
    .sort((a,b) => b.degree - a.degree || a.id.localeCompare(b.id));
  nodes.forEach((n,i) => {
    n.r = Math.min(29, 19 + Math.sqrt(n.degree) * 1.7);
    n.x = 400 + Math.sqrt(i) * 94 * Math.cos(i * 2.39996);
    n.y = 270 + Math.sqrt(i) * 55 * Math.sin(i * 2.39996);
    n.labelWidth = Math.max(...n.lines.map(l => [...l].reduce((w,c) => w + (/[\u0000-\u007f]/.test(c) ? 7.2 : 12), 0)));
  });
  const ids = new Map(nodes.map(n => [n.id,n]));
  const edges = graph.edges.filter(e => ids.has(e.s) && ids.has(e.t));
  // Soft springs and label-aware separation; no wall that piles nodes onto a grid.
  for (let k = 0; k < 360; k++) {
    const forces = new Map(nodes.map(n => [n.id,{ x:(400-n.x)*0.001, y:(270-n.y)*0.009 }]));
    for (let i = 0; i < nodes.length; i++) for (let j = i+1; j < nodes.length; j++) {
      const a=nodes[i], b=nodes[j], dx=a.x-b.x || 0.01, dy=a.y-b.y || 0.01;
      const d=Math.max(1,Math.hypot(dx,dy)), repulsion=3000/(d*d);
      let fx=dx/d*repulsion, fy=dy/d*repulsion;
      const ox=Math.max(a.r+9,a.labelWidth/2)+Math.max(b.r+9,b.labelWidth/2)+16-Math.abs(dx);
      const oy=a.r+b.r+30+8*Math.max(a.lines.length,b.lines.length)-Math.abs(dy);
      if (ox>0 && oy>0) {
        if (ox<oy) fx+=Math.sign(dx)*ox*0.35;
        else fy+=Math.sign(dy)*oy*0.35;
      }
      forces.get(a.id).x+=fx; forces.get(a.id).y+=fy;
      forces.get(b.id).x-=fx; forces.get(b.id).y-=fy;
    }
    edges.forEach(e => {
      if(e.s===e.t) return;
      const a=ids.get(e.s),b=ids.get(e.t),dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1;
      const f=(d-165)*0.025;
      forces.get(a.id).x+=dx/d*f; forces.get(a.id).y+=dy/d*f;
      forces.get(b.id).x-=dx/d*f; forces.get(b.id).y-=dy/d*f;
    });
    const step=0.8*(1-k/480);
    nodes.forEach(n => {
      const f=forces.get(n.id);
      n.x+=Math.max(-9,Math.min(9,f.x))*step;
      n.y+=Math.max(-9,Math.min(9,f.y))*step;
    });
  }
  return { ...graph, nodes, edges };
}

export function edgeGeometry(a,b,index=0,count=1) {
  if (a.id===b.id) {
    const r=a.r+24+index*18;
    return {d:`M${a.x-a.r*.7} ${a.y-a.r*.7}C${a.x-r*2} ${a.y-r*2} ${a.x+r*2} ${a.y-r*2} ${a.x+a.r*.7} ${a.y-a.r*.7}`,x:a.x,y:a.y-r*1.5,angle:0};
  }
  const dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1;
  const bend=(index-(count-1)/2)*32*(a.id<b.id?1:-1);
  const cx=(a.x+b.x)/2-dy/d*bend,cy=(a.y+b.y)/2+dx/d*bend;
  const start=Math.hypot(cx-a.x,cy-a.y)||1,end=Math.hypot(b.x-cx,b.y-cy)||1;
  const sx=a.x+(cx-a.x)/start*(a.r+3),sy=a.y+(cy-a.y)/start*(a.r+3);
  const tx=b.x-(b.x-cx)/end*(b.r+6),ty=b.y-(b.y-cy)/end*(b.r+6);
  let angle=Math.atan2(dy,dx)*180/Math.PI;
  if (angle>90) angle-=180;
  if (angle< -90) angle+=180;
  return {d:`M${sx} ${sy}Q${cx} ${cy} ${tx} ${ty}`,x:(sx+2*cx+tx)/4,y:(sy+2*cy+ty)/4,angle};
}
