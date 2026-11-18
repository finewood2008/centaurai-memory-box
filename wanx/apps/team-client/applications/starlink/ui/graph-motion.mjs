// Migrated from WANX apps/builder/integration/team-client/starlink/motion.mjs.
import { edgeGeometry } from './graph.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_YAW = 0.24;
const DEFAULT_PITCH = -0.18;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// The simulation works on presentation coordinates. Facts and evidence stay on the graph.
export function stepForces(nodes, edges, held = null, heat = 1) {
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const forces = nodes.map(node => ({
    x: (node.homeX - node.x) * .002,
    y: (node.homeY - node.y) * .002,
    z: ((node.homeZ ?? 0) - (node.z ?? 0)) * .002,
  }));

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      const dx = b.x - a.x || .01;
      const dy = b.y - a.y || .01;
      const dz = (b.z ?? 0) - (a.z ?? 0);
      const distance = Math.max(1, Math.hypot(dx, dy, dz));
      const repel = 2200 / distance ** 3;
      let fx = dx * repel;
      let fy = dy * repel;
      const overlap = Math.max(a.r + 12, a.labelWidth / 2) + Math.max(b.r + 12, b.labelWidth / 2) + 12 - Math.abs(dx);
      const vertical = a.r + b.r + 42 - Math.abs(dy);
      if (overlap > 0 && vertical > 0 && Math.abs(dz) < a.r + b.r + 26) {
        if (overlap < vertical) fx += Math.sign(dx) * overlap * .08;
        else fy += Math.sign(dy) * vertical * .08;
      }
      forces[i].x -= fx;
      forces[i].y -= fy;
      forces[i].z -= dz * repel;
      forces[j].x += fx;
      forces[j].y += fy;
      forces[j].z += dz * repel;
    }
  }

  for (const edge of edges) {
    const i = index.get(edge.s);
    const j = index.get(edge.t);
    if (i === undefined || j === undefined || i === j) continue;
    const a = nodes[i];
    const b = nodes[j];
    if (a.constellation !== b.constellation) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = (b.z ?? 0) - (a.z ?? 0);
    const distance = Math.hypot(dx, dy, dz) || 1;
    const spring = (distance - 165) * .018 / distance;
    forces[i].x += dx * spring;
    forces[i].y += dy * spring;
    forces[i].z += dz * spring;
    forces[j].x -= dx * spring;
    forces[j].y -= dy * spring;
    forces[j].z -= dz * spring;
  }

  nodes.forEach((node, i) => {
    if (node.id === held) {
      node.vx = node.vy = node.vz = 0;
      return;
    }
    const force = forces[i];
    node.vx = ((node.vx || 0) + force.x * heat) * .76;
    node.vy = ((node.vy || 0) + force.y * heat) * .76;
    node.vz = ((node.vz || 0) + force.z * heat) * .76;
    node.x += clamp(node.vx, -8, 8);
    node.y += clamp(node.vy, -8, 8);
    node.z = (node.z ?? 0) + clamp(node.vz, -8, 8);
  });
}

function bounds(points) {
  return {
    left: Math.min(...points.map(point => point.x)),
    right: Math.max(...points.map(point => point.x)),
    top: Math.min(...points.map(point => point.y)),
    bottom: Math.max(...points.map(point => point.y)),
    back: Math.min(...points.map(point => point.z)),
    front: Math.max(...points.map(point => point.z)),
  };
}

function orientation(yaw, pitch) {
  return { cy: Math.cos(yaw), sy: Math.sin(yaw), cp: Math.cos(pitch), sp: Math.sin(pitch) };
}

function project(point, center, rotation, distance) {
  const x = point.x - center.x;
  const y = point.y - center.y;
  const z = point.z - center.z;
  const { cy, sy, cp, sp } = rotation;
  const horizontalDepth = z * cy - x * sy;
  const depth = horizontalDepth * cp + y * sp;
  const perspective = distance / Math.max(distance * .48, distance - depth);
  return {
    x: (x * cy + z * sy) * perspective,
    y: (y * cp - horizontalDepth * sp) * perspective,
    z: depth,
    perspective,
  };
}

export function createGraphMotion({getSvg = () => document.querySelector('#graph-svg'), getZoomOutput} = {}) {
  let pending = 0;
  let frame = 0;
  let state = null;
  let key = null;
  const positions = new Map();
  const raf = fn => globalThis.requestAnimationFrame(fn);
  const cancel = id => { if (id) globalThis.cancelAnimationFrame?.(id); };
  const zoomOutput = svg => getZoomOutput?.() || svg?.parentElement?.querySelector('[data-graph-zoom],#zoom-label');

  function detach() {
    cancel(frame);
    frame = 0;
    if (!state) return;
    state.abort.abort();
    state.resize?.disconnect();
    state.svg.classList.remove('is-dragging', 'has-hover');
    const pointer = state.pointer;
    state.pointer = null;
    if (pointer && pointer.capture.hasPointerCapture(pointer.id)) {
      pointer.capture.releasePointerCapture(pointer.id);
    }
  }

  function reset() {
    const output = zoomOutput(state?.svg || getSvg());
    cancel(pending);
    pending = 0;
    detach();
    state = null;
    key = null;
    positions.clear();
    if (output) output.textContent = '100%';
  }

  function reframe(scene, recenter = false) {
    const { svg, nodes, camera } = scene;
    const width = svg.clientWidth;
    const height = svg.clientHeight;
    if (!width || !height || !nodes.length) return;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    if (recenter) {
      const region = bounds(nodes);
      scene.center = {
        x: (region.left + region.right) / 2,
        y: (region.top + region.bottom) / 2,
        z: (region.back + region.front) / 2,
      };
      const radius = Math.max(...nodes.map(node => Math.hypot(node.x - scene.center.x, node.y - scene.center.y, node.z - scene.center.z)));
      scene.distance = Math.max(440, radius * 3.2);
      scene.region = region;
    }
    scene.rotation = orientation(camera.yaw, camera.pitch);
    const projected = bounds(nodes.map(node => project(node, scene.center, scene.rotation, scene.distance)));
    const scale = Math.min(1.12,
      Math.max(100, width - Math.min(110, width * .24)) / (projected.right - projected.left + 58),
      Math.max(90, height - 94) / (projected.bottom - projected.top + 52));
    scene.viewport = {
      width, height, scale,
      x: width / 2 - (projected.left + projected.right) * scale / 2,
      y: (height - 38) / 2 - (projected.top + projected.bottom) * scale / 2,
    };
  }

  function screenPoint(scene, point) {
    const projected = project(point, scene.center, scene.rotation, scene.distance);
    const { viewport, camera } = scene;
    return {
      ...projected,
      x: viewport.x + camera.panX + projected.x * viewport.scale * camera.zoom,
      y: viewport.y + camera.panY + projected.y * viewport.scale * camera.zoom,
    };
  }

  function paintFloor(scene) {
    const { region, floor } = scene;
    if (!floor.length) return;
    const xPad = Math.max(76, (region.right - region.left) * .15);
    const zPad = Math.max(86, (region.front - region.back) * .23);
    const left = region.left - xPad;
    const right = region.right + xPad;
    const back = region.back - zPad;
    const front = region.front + zPad;
    const y = region.bottom + 58;
    floor.forEach((line, i) => {
      const across = i < 9;
      const t = (i % 9) / 8;
      const x = left + (right - left) * t;
      const z = back + (front - back) * t;
      const a = screenPoint(scene, across ? { x, y, z: back } : { x: left, y, z });
      const b = screenPoint(scene, across ? { x, y, z: front } : { x: right, y, z });
      line.setAttribute('x1', a.x);
      line.setAttribute('y1', a.y);
      line.setAttribute('x2', b.x);
      line.setAttribute('y2', b.y);
    });
  }

  function paint(scene) {
    if (!scene.viewport) return;
    const { nodes, graph, viewport, camera, sizeBy } = scene;
    const points = new Map();
    for (const node of nodes) {
      const point = screenPoint(scene, node);
      const value = sizeBy.counts.get(node.id)?.[sizeBy.metric] ?? 0;
      point.r = Math.sqrt(12 + 110 * value / sizeBy.max) * clamp(viewport.width / 650, .7, 1) * camera.zoom;
      points.set(node.id, point);
    }
    scene.points = points;
    paintFloor(scene);
    const labels = [];
    const namedGroups = new Set();
    const starBoxes = [...points.values()].map(star => ({
      left:star.x-star.r-2,right:star.x+star.r+2,top:star.y-star.r-2,bottom:star.y+star.r+2,
    }));
    const fits = box => box.left >= 5 && box.right <= viewport.width - 5 &&
      box.top >= 5 && box.bottom <= viewport.height - 52;
    const overlaps = (a,b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const available = box => fits(box) && !labels.some(label => overlaps(box,label)) &&
      !starBoxes.some(star => overlaps(box,star));
    for (const anchor of graph.anchors || []) {
      const {x,y} = screenPoint(scene, anchor);
      const {element,width} = scene.anchors.get(anchor.id);
      const half = width / 2 + 4;
      const cx = clamp(x,half,viewport.width-half);
      const cy = clamp(y,19,viewport.height-67);
      const box = [cy,cy-26,cy-52,cy+26,cy+52].map(center => ({
        left:cx-half,right:cx+half,top:center-14,bottom:center+14,center,
      })).find(available);
      element.setAttribute('visibility', box ? 'visible' : 'hidden');
      if (box) {
        element.setAttribute('transform', `translate(${cx} ${box.center})`);
        labels.push(box);
        namedGroups.add(anchor.id);
      }
    }

    const relations = [];
    for (const edge of graph.edges) {
      const element = scene.edges.get(edge.id);
      if (!element) continue;
      const a = points.get(edge.s);
      const b = points.get(edge.t);
      const group = scene.groups.get(JSON.stringify([edge.s, edge.t].sort()));
      const path = edgeGeometry({ id: edge.s, ...a }, { id: edge.t, ...b }, group.indexOf(edge.id), group.length);
      element.querySelectorAll('path').forEach(el => el.setAttribute('d', path.d));
      const label = scene.relationLabels.get(edge.id);
      const emphasized = element.classList.contains('chosen') || scene.hoveredEdge === edge.id || element.contains(document.activeElement);
      element.classList.toggle('is-label-active', emphasized);
      if (label) relations.push({...label, x:path.x, y:path.y, chosen:emphasized});
    }

    // Keep label priority independent of the star-size setting.
    const shownPerGroup = new Map();
    const limit = !graph.anchors || camera.zoom >= 1.8 ? Infinity : camera.zoom >= 1.25 ? 6 : camera.zoom >= .8 ? 3 : 1;
    for (const node of scene.ranked) {
      const element = scene.elements.get(node.id);
      if (!element) continue;
      const { x, y, r } = points.get(node.id);
      element.setAttribute('transform', `translate(${x} ${y})`);
      element.querySelector('.node-star').setAttribute('r', r);
      element.querySelector('.node-star-glow').setAttribute('r', r * 2.05);
      element.querySelector('.node-star-hit').setAttribute('r', Math.max(11, r + 3));
      const name = element.querySelector('.node-name');
      const half = node.labelWidth / 2 + 4;
      const extraLine = (node.lines.length - 1) * 15;
      const sameAsGroup = namedGroups.has(node.constellation) && scene.anchors.get(node.constellation).name === node.name;
      const count = shownPerGroup.get(node.constellation) || 0;
      const candidates = [[0,r+15],[0,-r-7-extraLine],[r+half+5,5-extraLine/2],[-r-half-5,5-extraLine/2]].map(([dx,dy]) => ({
        left:x+dx-half,right:x+dx+half,top:y+dy-12,bottom:y+dy+5+extraLine,dx,dy,
      }));
      let box = count < limit && !sameAsGroup ? candidates.find(available) : null;
      if (!box && node.id === scene.selected) box = candidates.find(fits);
      name.setAttribute('y', box?.dy ?? r + 15);
      name.setAttribute('transform', `translate(${box?.dx ?? 0} 0)`);
      element.classList.toggle('is-label-hidden', !box);
      element.classList.toggle('has-group-name', sameAsGroup);
      if (box) {
        labels.push(box);
        shownPerGroup.set(node.constellation,count+1);
      }
    }

    for (const relation of relations.sort((a,b) => Number(b.chosen)-Number(a.chosen))) {
      const { element,x,y,width,chosen } = relation;
      const candidates = [y,y+21].map(baseline => ({
        left:x-width/2-4,right:x+width/2+4,top:baseline-19,bottom:baseline-3,baseline,
      }));
      const box = candidates.find(available) || (chosen && candidates.find(fits));
      element.setAttribute('visibility', box ? 'visible' : 'hidden');
      if (box) {
        element.setAttribute('transform', `translate(${x} ${box.baseline})`);
        labels.push(box);
      }
    }

    // Moving a captured element would cancel the drag. Sort once the node is released.
    if (!scene.pointer?.node) {
      const depthOrder = [...nodes].sort((a, b) => points.get(a.id).z - points.get(b.id).z).map(node => node.id);
      if (depthOrder.some((id, i) => scene.depthOrder[i] !== id)) {
        const focused = document.activeElement;
        const restoreFocus = scene.nodeLayer.contains(focused);
        for (const id of depthOrder) scene.nodeLayer.append(scene.elements.get(id));
        scene.depthOrder = depthOrder;
        if (restoreFocus) focused.focus({ preventScroll: true });
      }
    }
    const output = zoomOutput(scene.svg);
    if (output) output.textContent = Math.round(camera.zoom * 100) + '%';
  }

  function wake(scene) {
    scene.heat = 1;
    if (frame) return;
    const tick = () => {
      frame = 0;
      if (state !== scene || !scene.svg.isConnected || document.hidden) return;
      stepForces(scene.nodes, scene.graph.edges, scene.pointer?.node?.id, scene.heat);
      paint(scene);
      scene.heat *= .91;
      if (scene.pointer?.node || scene.heat > .015) frame = raf(tick);
    };
    frame = raf(tick);
  }

  function zoomAt(scene, factor, x, y) {
    const { camera, viewport } = scene;
    if (!viewport) return false;
    const next = clamp(camera.zoom * factor, .25, 4);
    const ratio = next / camera.zoom;
    camera.panX = x - viewport.x + (viewport.x + camera.panX - x) * ratio;
    camera.panY = y - viewport.y + (viewport.y + camera.panY - y) * ratio;
    camera.zoom = next;
    paint(scene);
    return true;
  }

  function zoom(factor) {
    if (!state?.svg.isConnected || !state.viewport) return false;
    return zoomAt(state, factor, state.viewport.width / 2, state.viewport.height / 2);
  }

  function fit() {
    if (!state?.svg.isConnected || !state.nodes.length) return false;
    Object.assign(state.camera, { zoom: 1, panX: 0, panY: 0 });
    reframe(state, true);
    paint(state);
    return true;
  }

  function rotate(delta) {
    if (!state?.svg.isConnected || !state.nodes.length) return;
    state.camera.yaw += delta;
    state.rotation = orientation(state.camera.yaw, state.camera.pitch);
    paint(state);
  }

  function mount(svg, graph, sizeBy) {
    if (state?.svg === svg && state.graph === graph && state.nodeLayer === svg.querySelector('.graph-space-nodes')) {
      state.sizeBy = sizeBy;
      state.selected = state.nodeLayer.querySelector('.selected')?.dataset.node;
      state.ranked.sort((a,b) => Number(b.id===state.selected)-Number(a.id===state.selected) ||
        (sizeBy.counts.get(b.id)?.relations ?? 0)-(sizeBy.counts.get(a.id)?.relations ?? 0) || b.degree-a.degree);
      paint(state);
      return;
    }
    const previous = state;
    const sameGraph = previous?.graph === graph;
    detach();
    if (!sameGraph) positions.clear();
    const initial = { yaw: previous?.camera.yaw ?? DEFAULT_YAW, pitch: previous?.camera.pitch ?? DEFAULT_PITCH, zoom: 1, panX: 0, panY: 0 };
    const nodes = graph.nodes.map((node, i) => {
      if (!positions.has(node.id)) {
        // Spread the stable 2D layout along a third axis to make rotation informative.
        const z = Math.sin(i * 2.39996) * clamp(76 + graph.nodes.length * 2.7, 80, 232);
        positions.set(node.id, { ...node, z, homeX: node.x, homeY: node.y, homeZ: z });
      }
      return Object.assign(positions.get(node.id), { r: node.r, labelWidth: node.labelWidth, lines: node.lines });
    });
    const nodeLayer = svg.querySelector('.graph-space-nodes');
    const elements = new Map([...nodeLayer.querySelectorAll('.graph-node')].map(el => [el.dataset.node, el]));
    const edges = new Map([...svg.querySelectorAll('.graph-edge-hit')].map(el => [el.dataset.edge, el.parentElement]));
    const groups = new Map();
    for (const edge of graph.edges) {
      const pair = JSON.stringify([edge.s, edge.t].sort());
      if (!groups.has(pair)) groups.set(pair, []);
      groups.get(pair).push(edge.id);
    }
    const floorLayer = svg.querySelector('.graph-space-floor');
    const floor = nodes.length > 1 ? Array.from({ length: 18 }, () => document.createElementNS(SVG_NS, 'line')) : [];
    floorLayer.replaceChildren(...floor);
    const anchors = new Map([...svg.querySelectorAll('.graph-space-constellation')].map(element => {
      const rect = element.querySelector('rect');
      const width = Math.ceil(element.querySelector('text').getComputedTextLength()) + 18;
      rect.setAttribute('x', -width / 2);
      rect.setAttribute('width', width);
      return [element.dataset.node,{element,width,name:graph.anchors.find(anchor => anchor.id===element.dataset.node).name}];
    }));
    const relationLabels = new Map();
    for (const [id,edge] of edges) {
      const element = edge.querySelector('text');
      if (element) relationLabels.set(id,{element,width:Math.ceil(element.getComputedTextLength())});
    }
    const selected = nodeLayer.querySelector('.selected')?.dataset.node;
    const ranked = [...nodes].sort((a,b) => Number(b.id===selected)-Number(a.id===selected) ||
      (sizeBy.counts.get(b.id)?.relations ?? 0)-(sizeBy.counts.get(a.id)?.relations ?? 0) || b.degree-a.degree);
    const scene = state = {
      svg, graph, nodes, nodeLayer, elements, edges, groups, floor, sizeBy, depthOrder: [],
      anchors, relationLabels, ranked,
      byId: new Map(nodes.map(node => [node.id, node])),
      selected,
      camera: sameGraph ? previous.camera : initial,
      // Polling replaces the SVG children even when the graph is unchanged.
      // Retain the projection, too, so existing drag positions do not jump.
      center: sameGraph ? previous.center : null,
      distance: sameGraph ? previous.distance : null,
      region: sameGraph ? previous.region : null,
      rotation: sameGraph ? previous.rotation : null,
      viewport: sameGraph ? previous.viewport : null,
      abort: new AbortController(), pointer: null, suppress: false, heat: 0, hoveredEdge: null,
    };
    if (!nodes.length) {
      const output = zoomOutput(svg);
      if (output) output.textContent = '100%';
      return;
    }

    const listen = (type, fn, extra = {}) => svg.addEventListener(type, fn, { signal: scene.abort.signal, ...extra });
    if (!scene.viewport) reframe(scene, true);
    paint(scene);
    if (typeof ResizeObserver === 'function') {
      scene.resize = new ResizeObserver(() => {
        if (svg.clientWidth === scene.viewport?.width && svg.clientHeight === scene.viewport?.height) return;
        reframe(scene, !scene.center);
        paint(scene);
      });
      scene.resize.observe(svg);
    }

    listen('pointerdown', event => {
      if (event.button !== 0 || scene.pointer || !scene.viewport) return;
      const target = event.target.closest('.graph-node');
      const node = target ? scene.byId.get(target.dataset.node) : null;
      const capture = event.target.closest('[data-node],[data-edge]') || svg;
      scene.suppress = false;
      scene.pointer = {
        id: event.pointerId, node, capture, x: event.clientX, y: event.clientY,
        origin: node && { x: node.x, y: node.y, z: node.z },
        dragScale: node && scene.points.get(node.id).perspective * scene.viewport.scale * scene.camera.zoom,
        camera: { ...scene.camera }, pan: event.shiftKey, moved: false,
      };
      capture.setPointerCapture(event.pointerId);
    });
    listen('pointermove', event => {
      const pointer = scene.pointer;
      if (!pointer || pointer.id !== event.pointerId) return;
      const dx = event.clientX - pointer.x;
      const dy = event.clientY - pointer.y;
      if (!pointer.moved && Math.hypot(dx, dy) < 4) return;
      pointer.moved = true;
      event.preventDefault();
      svg.classList.add('is-dragging');
      if (pointer.node) {
        const { cy, sy, cp, sp } = scene.rotation;
        const x = dx / pointer.dragScale;
        const y = dy / pointer.dragScale;
        pointer.node.x = pointer.origin.x + x * cy + y * sp * sy;
        pointer.node.y = pointer.origin.y + y * cp;
        pointer.node.z = pointer.origin.z + x * sy - y * sp * cy;
        if (!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) wake(scene);
      } else if (pointer.pan) {
        scene.camera.panX = pointer.camera.panX + dx;
        scene.camera.panY = pointer.camera.panY + dy;
      } else {
        scene.camera.yaw = pointer.camera.yaw + dx * .007;
        scene.camera.pitch = clamp(pointer.camera.pitch + dy * .006, -.66, .66);
        scene.rotation = orientation(scene.camera.yaw, scene.camera.pitch);
      }
      paint(scene);
    });

    const end = event => {
      const pointer = scene.pointer;
      if (!pointer || pointer.id !== event.pointerId) return;
      scene.pointer = null;
      scene.suppress = pointer.moved;
      svg.classList.remove('is-dragging');
      if (pointer.capture.hasPointerCapture(pointer.id)) pointer.capture.releasePointerCapture(pointer.id);
      if (pointer.moved) paint(scene);
    };
    listen('pointerup', end);
    listen('pointercancel', end);
    listen('lostpointercapture', end);
    listen('click', event => {
      if (!scene.suppress || event.detail === 0) return;
      scene.suppress = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true });
    listen('wheel', event => {
      event.preventDefault();
      if (scene.pointer) return;
      const rect = svg.getBoundingClientRect();
      zoomAt(scene, Math.exp(-clamp(event.deltaY, -100, 100) * .003), event.clientX - rect.x, event.clientY - rect.y);
    }, { passive: false });

    let hovered;
    const highlight = id => {
      if (hovered === id) return;
      hovered = id;
      const adjacent = new Set([id]);
      for (const edge of graph.edges) {
        if (edge.s === id) adjacent.add(edge.t);
        if (edge.t === id) adjacent.add(edge.s);
        edges.get(edge.id)?.classList.toggle('is-neighbor', edge.s === id || edge.t === id);
      }
      svg.classList.toggle('has-hover', Boolean(id));
      elements.forEach((el, nodeId) => el.classList.toggle('is-neighbor', adjacent.has(nodeId)));
    };
    listen('pointerover', event => {
      highlight(event.target.closest('.graph-node')?.dataset.node);
      const next = event.target.closest('g')?.querySelector('.graph-edge-hit')?.dataset.edge ?? null;
      if (scene.hoveredEdge !== next) { scene.hoveredEdge = next; paint(scene); }
    });
    listen('pointerleave', () => {
      highlight(null);
      if (scene.hoveredEdge !== null) { scene.hoveredEdge = null; paint(scene); }
    });
    const paintFocusedEdge = event => {
      if (event.target.closest('g')?.querySelector('.graph-edge-hit')) paint(scene);
    };
    listen('focusin', paintFocusedEdge);
    listen('focusout', paintFocusedEdge);
  }

  function schedule(graph, nextKey, sizeBy) {
    if (typeof globalThis.requestAnimationFrame !== 'function') return;
    if (key !== nextKey) {
      reset();
      key = nextKey;
    }
    cancel(pending);
    pending = raf(() => {
      pending = 0;
      const svg = getSvg();
      if (svg) mount(svg, graph, sizeBy);
    });
  }

  return { schedule, reset, zoom, fit, rotate };
}
